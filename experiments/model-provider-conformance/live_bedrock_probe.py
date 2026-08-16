#!/usr/bin/env python3
"""Run one explicit synthetic probe through Amazon Bedrock Converse."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date
import json
import os
from pathlib import Path
from typing import Any, Callable

import harness
from probe_support import (
    PreflightError,
    cost_gate,
    finish_cost_evidence,
    generated_at,
    require_current_attestation,
    require_env,
    require_sha256_attestation,
    strict_conformance_matrix,
)


HERE = Path(__file__).resolve().parent
DEFAULT_REQUEST = HERE / "fixtures" / "review_request.json"
DEFAULT_PROFILE = HERE / "fixtures" / "profiles" / "bedrock_runtime_converse.json"
EXPECTED_REGION = "eu-west-1"
EXPECTED_ORIGIN = "https://bedrock-runtime.eu-west-1.amazonaws.com"
EXPECTED_CONTROL_ORIGIN = "https://bedrock.eu-west-1.amazonaws.com"


class BedrockTransportFailure(RuntimeError):
    def __init__(self, message: str, *, delivered: bool) -> None:
        super().__init__(message)
        self.delivered = delivered


class BedrockServiceFailure(RuntimeError):
    def __init__(self, code: str, status: int | None, request_id: str | None, retry_attempts: int) -> None:
        super().__init__("Bedrock returned a typed service error")
        self.code = code
        self.status = status
        self.request_id = request_id
        self.retry_attempts = retry_attempts


Converse = Callable[[dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class LiveContext:
    identity: dict[str, Any]
    control_endpoint: str
    runtime_endpoint: str
    logging_configuration: dict[str, Any]
    inference_profile: dict[str, Any]
    converse: Converse


LiveSession = Callable[[dict[str, Any]], LiveContext]


def run_probe(
    request: dict[str, Any],
    profile: dict[str, Any],
    *,
    env: dict[str, str] | None = None,
    live_session: LiveSession | None = None,
    today: date | None = None,
) -> dict[str, Any]:
    env = dict(os.environ) if env is None else env
    mapped = harness.build_bedrock_converse_request(request, profile)
    _validate_profile(profile)
    require_current_attestation(profile, today=today)
    expected_account = require_env(env, "KESTREL_EXPECTED_AWS_ACCOUNT_ID")
    expected_role = require_env(env, "KESTREL_EXPECTED_AWS_ROLE_NAME")
    policy_attestation = require_env(env, "KESTREL_AWS_DATA_POLICY_ATTESTATION")
    if policy_attestation != "invocation_logging_disabled_synthetic_only":
        raise PreflightError("Bedrock invocation logging must be reviewed before this synthetic probe")
    data_policy_digest = require_sha256_attestation(env, "KESTREL_AWS_DATA_POLICY_ATTESTATION_SHA256")
    cap = cost_gate(request, profile, mapped, require_env(env, "KESTREL_PROBE_COST_CAP_USD"))

    create_session = live_session or _boto_live_session
    context = create_session(profile)
    role = _verified_role(context.identity, expected_account, expected_role)
    if context.control_endpoint != EXPECTED_CONTROL_ORIGIN or context.runtime_endpoint != EXPECTED_ORIGIN:
        raise PreflightError("A resolved Bedrock endpoint is not allowlisted")
    if not _model_invocation_logging_disabled(context.logging_configuration):
        raise PreflightError("Bedrock model invocation logging is enabled")
    route_attestation = _verified_inference_profile(context.inference_profile, profile)

    try:
        response = context.converse(mapped)
    except BedrockServiceFailure as error:
        result = harness.normalize_bedrock_service_error(
            request,
            profile,
            code=error.code,
            status=error.status,
            request_id=error.request_id,
            retry_attempts=error.retry_attempts,
        )
    except BedrockTransportFailure as error:
        result = harness.normalize_bedrock_transport_failure(
            request, profile, delivered=error.delivered, message=str(error)[:240]
        )
    else:
        result = harness.normalize_bedrock_response(request, profile, response)

    cost = finish_cost_evidence(cap, result, profile)
    matrix = strict_conformance_matrix(
        result,
        cost,
        privileged_channel_mapped=mapped.get("system")
        == [{"text": request["policy_instruction"]["text"]}],
        tools_forbidden_at_boundary="toolConfig" not in mapped and "cachePoint" not in json.dumps(mapped),
        provider_state_disabled="cachePoint" not in json.dumps(mapped),
        exact_egress_verified=True,
        target_and_route_attested=route_attestation["destination_set_matches_profile"],
        data_policy_attested=True,
    )
    return {
        "evidence_version": "kestrel.model-provider-conformance-evidence/1",
        "generated_at": generated_at(),
        "surface": {
            "kind": "amazon_bedrock_runtime_converse",
            "origin": EXPECTED_ORIGIN,
            "control_origin": EXPECTED_CONTROL_ORIGIN,
            "request_region": EXPECTED_REGION,
            "redirects_allowed": False,
            "synthetic_input_only": True,
        },
        "authentication": {
            "kind": "aws_sigv4_role",
            "principal_verified": True,
            "principal_scope_digest": harness.sha256_json(role),
            "identity_values_removed": True,
        },
        "capture": {
            "identity_requests": 1,
            "data_policy_requests": 1,
            "inference_profile_requests": 1,
            "logical_model_invocations": 1,
            "physical_model_deliveries": result.get("attempts", [{}])[0].get("physical_deliveries"),
            "raw_response_removed": True,
        },
        "cost": cost,
        "data_policy": {
            "operator_attestation": "invocation_logging_disabled_synthetic_only",
            "model_invocation_logging_checked": True,
            "model_invocation_logging_disabled": True,
            "logging_destination_details_removed": True,
            "attestation_digest": data_policy_digest,
            "synthetic_input_only": True,
        },
        "route_attestation": route_attestation,
        "normalized_result": result,
        "conformance_matrix": matrix,
    }


def _validate_profile(profile: dict[str, Any]) -> None:
    surface = profile.get("surface") if isinstance(profile.get("surface"), dict) else {}
    route = profile.get("route") if isinstance(profile.get("route"), dict) else {}
    if surface.get("api_family") != "bedrock-runtime-converse":
        raise PreflightError("Unexpected Bedrock API family")
    if surface.get("https_origin") != EXPECTED_ORIGIN or route.get("request_region") != EXPECTED_REGION:
        raise PreflightError("The Bedrock origin or request region is not allowlisted")
    if profile.get("connection", {}).get("auth_kind") != "aws_sigv4_default_chain":
        raise PreflightError("Unexpected Bedrock credential kind")
    if profile.get("target", {}).get("version_policy") != "dated-model-through-eu-geographic-inference-profile":
        raise PreflightError("The Bedrock target is not pinned by the evidence profile")


def _verified_role(identity: Any, expected_account: str, expected_role: str) -> dict[str, str]:
    if not isinstance(identity, dict):
        raise PreflightError("STS returned no caller identity")
    account = identity.get("Account")
    arn = identity.get("Arn")
    if account != expected_account or not isinstance(arn, str):
        raise PreflightError("AWS caller account does not match the disposable evidence scope")
    prefix = f"arn:aws:sts::{expected_account}:assumed-role/{expected_role}/"
    if not arn.startswith(prefix) or len(arn) == len(prefix):
        raise PreflightError("AWS caller is not the expected disposable assumed role")
    return {"account_id": expected_account, "role_name": expected_role, "principal_kind": "assumed_role"}


def _model_invocation_logging_disabled(response: Any) -> bool:
    if not isinstance(response, dict):
        return False
    configuration = response.get("loggingConfig")
    if configuration is None:
        return True
    if not isinstance(configuration, dict):
        return False
    return not any(bool(value) for value in configuration.values())


def _verified_inference_profile(snapshot: Any, profile: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(snapshot, dict):
        raise PreflightError("Bedrock returned no inference profile")
    expected_id = profile["target"]["requested_id"]
    if (
        snapshot.get("inferenceProfileId") != expected_id
        or snapshot.get("status") != "ACTIVE"
        or snapshot.get("type") != "SYSTEM_DEFINED"
    ):
        raise PreflightError("The Bedrock inference profile identity or status drifted")
    models = snapshot.get("models")
    if not isinstance(models, list) or not models:
        raise PreflightError("The Bedrock inference profile returned no routed models")
    expected_model = expected_id.removeprefix("eu.")
    regions: set[str] = set()
    for model in models:
        arn = model.get("modelArn") if isinstance(model, dict) else None
        parts = arn.split(":", 5) if isinstance(arn, str) else []
        if len(parts) != 6 or parts[0:3] != ["arn", "aws", "bedrock"]:
            raise PreflightError("The Bedrock inference profile returned an invalid model ARN")
        if parts[4] or parts[5] != f"foundation-model/{expected_model}":
            raise PreflightError("The Bedrock inference profile resolved to a different model")
        regions.add(parts[3])
    approved = set(profile["route"]["approved_processing_regions"])
    if regions != approved:
        raise PreflightError("The Bedrock inference profile destination set drifted")
    return {
        "inference_profile_id": expected_id,
        "status": "ACTIVE",
        "type": "SYSTEM_DEFINED",
        "destination_regions": sorted(regions),
        "destination_set_matches_profile": True,
    }


def _boto_live_session(profile: dict[str, Any]) -> LiveContext:
    try:
        import boto3
        from botocore.config import Config
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as error:
        raise PreflightError("Boto3 and Botocore are required only for an explicit Bedrock probe") from error

    timeout = int(profile["limits"]["timeout_seconds"])
    config = Config(
        **harness.bedrock_botocore_options(),
        connect_timeout=min(10, timeout),
        read_timeout=timeout,
        ignore_configured_endpoint_urls=True,
        proxies={},
    )
    session = boto3.Session(region_name=profile["route"]["request_region"])
    try:
        identity = session.client("sts", config=config).get_caller_identity()
        control = session.client("bedrock", config=config)
        logging_configuration = control.get_model_invocation_logging_configuration()
        inference_profile = control.get_inference_profile(
            inferenceProfileIdentifier=profile["target"]["requested_id"]
        )
    except (BotoCoreError, ClientError) as error:
        raise PreflightError("AWS identity or control-plane preflight failed; no model request was sent") from error
    runtime = session.client("bedrock-runtime", config=config)

    def converse(mapped: dict[str, Any]) -> dict[str, Any]:
        try:
            return runtime.converse(modelId=profile["target"]["requested_id"], **mapped)
        except ClientError as error:
            response = error.response if isinstance(error.response, dict) else {}
            metadata = response.get("ResponseMetadata") if isinstance(response.get("ResponseMetadata"), dict) else {}
            error_record = response.get("Error") if isinstance(response.get("Error"), dict) else {}
            raise BedrockServiceFailure(
                str(error_record.get("Code", "Unknown")),
                metadata.get("HTTPStatusCode") if isinstance(metadata.get("HTTPStatusCode"), int) else None,
                metadata.get("RequestId") if isinstance(metadata.get("RequestId"), str) else None,
                metadata.get("RetryAttempts") if isinstance(metadata.get("RetryAttempts"), int) else 0,
            ) from error
        except BotoCoreError as error:
            raise BedrockTransportFailure(
                "Bedrock transport ended without a terminal service response", delivered=True
            ) from error

    return LiveContext(
        identity=identity,
        control_endpoint=str(control.meta.endpoint_url).rstrip("/"),
        runtime_endpoint=str(runtime.meta.endpoint_url).rstrip("/"),
        logging_configuration=logging_configuration,
        inference_profile=inference_profile,
        converse=converse,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="send exactly one billable model request")
    parser.add_argument("--request", type=Path, default=DEFAULT_REQUEST)
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    args = parser.parse_args()
    if not args.execute:
        parser.error("refusing to call Bedrock without explicit --execute")
    request = json.loads(args.request.read_text())
    profile = json.loads(args.profile.read_text())
    print(json.dumps(run_probe(request, profile), ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
