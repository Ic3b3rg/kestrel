#!/usr/bin/env python3
"""Run one explicit synthetic probe through the OpenAI Responses API."""

from __future__ import annotations

import argparse
from datetime import date
import json
import os
from pathlib import Path
import socket
from typing import Any, Callable
import urllib.error
import urllib.request

import harness
import openai_responses_adapter as openai_adapter
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
DEFAULT_PROFILE = HERE / "fixtures" / "profiles" / "openai_platform_responses.json"
EXPECTED_ORIGIN = "https://api.openai.com"
EXPECTED_PATH = "/v1/responses"


class TransportFailure(RuntimeError):
    def __init__(self, message: str, *, delivered: bool) -> None:
        super().__init__(message)
        self.delivered = delivered


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


Transport = Callable[[str, dict[str, str], bytes, float, int], tuple[int, dict[str, str], bytes]]


def run_probe(
    request: dict[str, Any],
    profile: dict[str, Any],
    *,
    env: dict[str, str] | None = None,
    transport: Transport | None = None,
    today: date | None = None,
) -> dict[str, Any]:
    env = dict(os.environ) if env is None else env
    mapped = openai_adapter.build_request(request, profile)
    _validate_profile(profile)
    require_current_attestation(profile, today=today)
    api_key = require_env(env, "OPENAI_API_KEY")
    project_id = require_env(env, "OPENAI_PROJECT_ID")
    if require_env(env, "KESTREL_OPENAI_CREDENTIAL_ATTESTATION") != "project_service_account":
        raise PreflightError("The OpenAI credential must be attested as a Project service account")
    data_policy_digest = require_sha256_attestation(env, "KESTREL_OPENAI_DATA_POLICY_ATTESTATION_SHA256")
    cap = cost_gate(request, profile, mapped, require_env(env, "KESTREL_PROBE_COST_CAP_USD"))

    url = profile["surface"]["https_origin"] + profile["surface"]["path"]
    headers = {
        "Authorization": f"Bearer {api_key}",
        "OpenAI-Project": project_id,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "kestrel-model-provider-conformance/1",
    }
    body = json.dumps(mapped, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    send = transport or _http_transport
    timeout = float(profile["limits"]["timeout_seconds"])
    max_response_bytes = int(profile["limits"]["max_response_bytes"])

    try:
        status, response_headers, response_body = send(url, headers, body, timeout, max_response_bytes)
    except TransportFailure as error:
        result = openai_adapter.normalize_transport_failure(
            request, profile, delivered=error.delivered, message=str(error)[:240]
        )
    else:
        request_id = _header(response_headers, "x-request-id")
        payload = _decode_json_object(response_body)
        if not 200 <= status < 300:
            result = openai_adapter.normalize_http_error(
                request, profile, status, payload or {}, request_id=request_id
            )
        elif payload is None:
            result = openai_adapter.normalize_response(
                request, profile, {"status": "completed", "output": []}, request_id=request_id
            )
        else:
            result = openai_adapter.normalize_response(request, profile, payload, request_id=request_id)

    cost = finish_cost_evidence(cap, result, profile)
    matrix = strict_conformance_matrix(
        result,
        cost,
        privileged_channel_mapped=mapped.get("instructions") == request["policy_instruction"]["text"],
        tools_forbidden_at_boundary=mapped.get("tools") == [] and mapped.get("tool_choice") == "none",
        provider_state_disabled=mapped.get("store") is False
        and mapped.get("background") is False
        and mapped.get("prompt_cache_options") == {"mode": "explicit"},
        exact_egress_verified=True,
        target_and_route_attested=result.get("validation", {}).get("target_and_route_match_profile") is True,
        data_policy_attested=True,
    )
    return {
        "evidence_version": "kestrel.model-provider-conformance-evidence/1",
        "generated_at": generated_at(),
        "surface": {
            "kind": "openai_platform_responses",
            "origin": EXPECTED_ORIGIN,
            "path": EXPECTED_PATH,
            "redirects_allowed": False,
            "synthetic_input_only": True,
        },
        "authentication": {
            "kind": "project_service_account_api_key",
            "credential_present": True,
            "credential_value_removed": True,
            "project_scope_digest": harness.sha256_json({"project_id": project_id}),
            "operator_attestation": "project_service_account",
        },
        "capture": {"model_requests": 1, "sdk_retry_attempts": 0, "raw_response_removed": True},
        "cost": cost,
        "data_policy": {
            "status": "operator_attestation_bound",
            "attestation_digest": data_policy_digest,
            "synthetic_input_only": True,
        },
        "normalized_result": result,
        "conformance_matrix": matrix,
    }


def _validate_profile(profile: dict[str, Any]) -> None:
    surface = profile.get("surface") if isinstance(profile.get("surface"), dict) else {}
    if surface.get("api_family") != "openai-responses":
        raise PreflightError("Unexpected OpenAI API family")
    if surface.get("https_origin") != EXPECTED_ORIGIN or surface.get("path") != EXPECTED_PATH:
        raise PreflightError("The OpenAI origin or path is not allowlisted")
    if profile.get("connection", {}).get("auth_kind") != "project_service_account_api_key":
        raise PreflightError("Unexpected OpenAI credential kind")
    if profile.get("target", {}).get("version_policy") != "exact-snapshot-id":
        raise PreflightError("The OpenAI target is not pinned by the evidence profile")


def _http_transport(
    url: str, headers: dict[str, str], body: bytes, timeout: float, max_response_bytes: int
) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), _bounded_read(response, max_response_bytes)
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), _bounded_read(error, max_response_bytes)
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as error:
        raise TransportFailure("OpenAI transport ended without a terminal HTTP response", delivered=True) from error


def _bounded_read(stream: Any, limit: int) -> bytes:
    body = stream.read(limit + 1)
    if len(body) > limit:
        raise TransportFailure("OpenAI response exceeded the evidence byte limit", delivered=True)
    return body


def _decode_json_object(body: bytes) -> dict[str, Any] | None:
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _header(headers: dict[str, str], name: str) -> str | None:
    wanted = name.lower()
    for key, value in headers.items():
        if key.lower() == wanted and isinstance(value, str):
            return value
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="send exactly one billable model request")
    parser.add_argument("--request", type=Path, default=DEFAULT_REQUEST)
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    args = parser.parse_args()
    if not args.execute:
        parser.error("refusing to call OpenAI without explicit --execute")
    request = json.loads(args.request.read_text())
    profile = json.loads(args.profile.read_text())
    print(json.dumps(run_probe(request, profile), ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
