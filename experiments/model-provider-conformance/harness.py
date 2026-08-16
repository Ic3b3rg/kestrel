#!/usr/bin/env python3
"""Disposable conformance helpers for ``kestrel.model-inference/v1``.

The module deliberately keeps provider-specific request shapes inside adapter
functions.  It uses only the Python standard library for deterministic tests;
the optional Bedrock live runner is added separately and may use Boto3.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


CONTRACT_VERSION = "kestrel.model-inference/v1"
SCHEMA_ID = "kestrel.review-json-schema/1"

_ALLOWED_SCHEMA_TYPES = {"object", "array", "string", "number", "integer", "boolean"}
_SCHEMA_KEYS = {
    "object": {"type", "properties", "required", "additionalProperties"},
    "array": {"type", "items"},
    "string": {"type", "enum"},
    "number": {"type"},
    "integer": {"type"},
    "boolean": {"type"},
}
_FORBIDDEN_CALLER_FIELDS = {
    "base_url",
    "extra_body",
    "headers",
    "model",
    "provider",
    "retry_count",
    "tools",
}
_REQUEST_FIELDS = {
    "budget",
    "contract_version",
    "deadline_at",
    "generation",
    "input_blocks",
    "logical_deduplication_key",
    "model_call_id",
    "output_schema",
    "policy_instruction",
    "profile_attestation_digest",
    "profile_id",
    "project_id",
    "purpose",
    "requirements",
    "review_revision_id",
}
_FORBIDDEN_CODEX_ITEM_TYPES = {
    "commandExecution",
    "dynamicToolCall",
    "fileChange",
    "mcpToolCall",
    "multiAgentToolCall",
    "webSearch",
}


def sha256_json(value: Any) -> str:
    """Return a deterministic digest for a JSON-compatible value."""

    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def validate_schema_definition(schema: Any, path: str = "$schema") -> list[str]:
    """Validate the deliberately small ``kestrel.review-json-schema/1`` subset."""

    if not isinstance(schema, dict):
        return [f"{path}: expected a schema object"]

    schema_type = schema.get("type")
    if schema_type not in _ALLOWED_SCHEMA_TYPES:
        return [f"{path}: unsupported or missing schema type"]

    errors: list[str] = []
    unknown = set(schema) - _SCHEMA_KEYS[schema_type]
    for key in sorted(unknown):
        errors.append(f"{path}: unsupported schema keyword '{key}'")

    if schema_type == "object":
        properties = schema.get("properties")
        required = schema.get("required")
        if not isinstance(properties, dict) or not properties:
            errors.append(f"{path}: object properties must be a non-empty object")
            properties = {}
        if schema.get("additionalProperties") is not False:
            errors.append(f"{path}: additionalProperties must be false")
        if not isinstance(required, list) or any(not isinstance(name, str) for name in required):
            errors.append(f"{path}: required must be a string array")
            required = []
        if len(required) != len(set(required)):
            errors.append(f"{path}: required contains duplicate names")
        property_names = set(properties)
        required_names = set(required)
        if property_names != required_names:
            errors.append(f"{path}: every declared property must be required")
        for name, child in properties.items():
            if not isinstance(name, str) or not name:
                errors.append(f"{path}: property names must be non-empty strings")
                continue
            errors.extend(validate_schema_definition(child, f"{path}.properties.{name}"))

    elif schema_type == "array":
        if "items" not in schema:
            errors.append(f"{path}: array items schema is required")
        else:
            errors.extend(validate_schema_definition(schema["items"], f"{path}.items"))

    elif schema_type == "string" and "enum" in schema:
        enum = schema["enum"]
        if (
            not isinstance(enum, list)
            or not enum
            or any(not isinstance(item, str) for item in enum)
            or len(enum) != len(set(enum))
        ):
            errors.append(f"{path}: enum must contain unique strings")

    return errors


def validate_instance(schema: dict[str, Any], value: Any, path: str = "$") -> list[str]:
    """Strictly validate a completed model value against the supported subset."""

    schema_errors = validate_schema_definition(schema)
    if schema_errors:
        return [f"{path}: cannot validate against an unsupported schema"] + schema_errors

    schema_type = schema["type"]
    errors: list[str] = []

    if schema_type == "object":
        if not isinstance(value, dict):
            return [f"{path}: expected object"]
        properties = schema["properties"]
        for name in schema["required"]:
            if name not in value:
                errors.append(f"{path}: missing required property '{name}'")
        for name in sorted(set(value) - set(properties)):
            errors.append(f"{path}: unknown property '{name}'")
        for name in properties.keys() & value.keys():
            errors.extend(validate_instance(properties[name], value[name], f"{path}.{name}"))
        return errors

    if schema_type == "array":
        if not isinstance(value, list):
            return [f"{path}: expected array"]
        for index, item in enumerate(value):
            errors.extend(validate_instance(schema["items"], item, f"{path}[{index}]"))
        return errors

    if schema_type == "string":
        if not isinstance(value, str):
            return [f"{path}: expected string"]
        if "enum" in schema and value not in schema["enum"]:
            errors.append(f"{path}: value is not in the fixed enum")
        return errors

    if schema_type == "number":
        return [] if isinstance(value, (int, float)) and not isinstance(value, bool) else [f"{path}: expected number"]

    if schema_type == "integer":
        return [] if isinstance(value, int) and not isinstance(value, bool) else [f"{path}: expected integer"]

    if schema_type == "boolean":
        return [] if isinstance(value, bool) else [f"{path}: expected boolean"]

    return [f"{path}: unsupported schema type"]


def validate_model_request(request: Any) -> list[str]:
    """Validate the neutral request and reject provider escape hatches."""

    if not isinstance(request, dict):
        return ["$: expected request object"]

    errors: list[str] = []
    for field in sorted(set(request) & _FORBIDDEN_CALLER_FIELDS):
        errors.append(f"$: forbidden caller field '{field}'")
    for field in sorted(set(request) - _REQUEST_FIELDS):
        if field not in _FORBIDDEN_CALLER_FIELDS:
            errors.append(f"$: unknown request field '{field}'")
    for field in sorted(_REQUEST_FIELDS - set(request)):
        errors.append(f"$: missing required field '{field}'")

    if request.get("contract_version") != CONTRACT_VERSION:
        errors.append(f"$.contract_version: expected '{CONTRACT_VERSION}'")

    policy = request.get("policy_instruction")
    if not isinstance(policy, dict) or not isinstance(policy.get("text"), str) or not policy.get("text"):
        errors.append("$.policy_instruction: non-empty text and digest are required")
    elif not isinstance(policy.get("digest"), str) or not policy["digest"]:
        errors.append("$.policy_instruction: non-empty text and digest are required")

    blocks = request.get("input_blocks")
    if not isinstance(blocks, list) or not blocks:
        errors.append("$.input_blocks: at least one text block is required")
    else:
        for index, block in enumerate(blocks):
            if not isinstance(block, dict) or set(block) != {"type", "text", "provenance"}:
                errors.append(f"$.input_blocks[{index}]: exact text block fields are required")
                continue
            if block.get("type") != "text" or not isinstance(block.get("text"), str):
                errors.append(f"$.input_blocks[{index}]: only text input is supported")

    output_schema = request.get("output_schema")
    if not isinstance(output_schema, dict) or output_schema.get("id") != SCHEMA_ID:
        errors.append(f"$.output_schema.id: expected '{SCHEMA_ID}'")
    elif set(output_schema) != {"id", "digest", "schema"}:
        errors.append("$.output_schema: exact id, digest, and schema fields are required")
    else:
        errors.extend(validate_schema_definition(output_schema.get("schema")))

    generation = request.get("generation")
    max_tokens = generation.get("max_output_tokens") if isinstance(generation, dict) else None
    if set(generation or {}) != {"max_output_tokens"} or not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or max_tokens <= 0:
        errors.append("$.generation.max_output_tokens: expected a positive integer")

    requirements = request.get("requirements")
    expected_requirements = {
        "local_schema_validation": "hard_requirement",
        "privileged_instruction_channel": "hard_requirement",
        "stateless": "hard_requirement",
        "structured_output_native": "hard_requirement",
        "tools": "forbidden",
    }
    if requirements != expected_requirements:
        errors.append("$.requirements: Review First V1 hard requirements must match exactly")

    return errors


def require_valid_model_request(request: dict[str, Any]) -> None:
    """Raise when a provider adapter receives an invalid neutral request."""

    _raise_for_invalid_request(request)


def new_model_result(request: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    """Create the common loss-aware result envelope for an adapter."""

    return _base_result(request, profile)


def finish_structured_result(
    result: dict[str, Any], request: dict[str, Any], text: str
) -> dict[str, Any]:
    """Parse and locally validate one provider-native structured text block."""

    return _finish_structured_result(result, request, text)


def empty_usage() -> dict[str, Any]:
    """Create a usage record that explicitly preserves missing provider data."""

    return _empty_usage()


def model_error(category: str, phase: str, delivery: str, retryability: str, message: str) -> dict[str, Any]:
    """Create the stable, bounded error envelope shared by adapters."""

    return _error(category, phase, delivery, retryability, message)


def build_codex_thread_start(request: dict[str, Any], profile: dict[str, Any], cwd: str) -> dict[str, Any]:
    """Map a neutral request to Codex App Server thread configuration.

    ``ephemeral`` prevents local thread persistence, while the empty probe cwd
    and read-only sandbox contain any unexpected tool activity.  These controls
    do not prove that tools were absent from the upstream model request.
    """

    _raise_for_invalid_request(request)
    return {
        "model": profile["target"]["requested_id"],
        "cwd": cwd,
        "allowProviderModelFallback": False,
        "approvalPolicy": "never",
        "sandbox": "read-only",
        "ephemeral": True,
        "dynamicTools": [],
        "environments": [],
        "runtimeWorkspaceRoots": [],
        "selectedCapabilityRoots": [],
        "experimentalRawEvents": True,
        "baseInstructions": "Return only the structured result requested by the user. Do not use tools.",
        "developerInstructions": request["policy_instruction"]["text"],
        "serviceName": "kestrel_model_provider_conformance",
    }


def build_codex_turn_start(request: dict[str, Any], thread_id: str) -> dict[str, Any]:
    _raise_for_invalid_request(request)
    return {
        "threadId": thread_id,
        "input": [{"type": "text", "text": block["text"]} for block in request["input_blocks"]],
        "effort": "low",
        "summary": "none",
        "outputSchema": request["output_schema"]["schema"],
    }


def normalize_codex_events(
    request: dict[str, Any], profile: dict[str, Any], events: list[dict[str, Any]]
) -> dict[str, Any]:
    """Normalize a bounded Codex App Server event transcript."""

    _raise_for_invalid_request(request)
    agent_texts: list[str] = []
    forbidden_items: list[str] = []
    raw_completions: list[dict[str, Any]] = []
    latest_thread_usage: dict[str, Any] | None = None
    terminal_turn: dict[str, Any] | None = None

    for event in events:
        method = event.get("method")
        params = event.get("params") if isinstance(event.get("params"), dict) else {}
        if method == "item/completed":
            item = params.get("item") if isinstance(params.get("item"), dict) else {}
            item_type = item.get("type")
            if item_type == "agentMessage" and isinstance(item.get("text"), str):
                agent_texts.append(item["text"])
            if item_type in _FORBIDDEN_CODEX_ITEM_TYPES:
                forbidden_items.append(str(item_type))
        elif method == "thread/tokenUsage/updated":
            token_usage = params.get("tokenUsage")
            if isinstance(token_usage, dict):
                latest_thread_usage = token_usage.get("last") or token_usage.get("total")
        elif _is_raw_codex_completion(method, params):
            raw_completions.append(params)
        elif method == "turn/completed":
            turn = params.get("turn")
            if isinstance(turn, dict):
                terminal_turn = turn

    response_ids = [
        {"name": "openai.response_id", "value": item["responseId"]}
        for item in raw_completions
        if isinstance(item.get("responseId"), str)
    ]
    exact_usage = raw_completions[-1].get("usage") if raw_completions else None
    usage = _normalize_camel_usage(exact_usage if isinstance(exact_usage, dict) else latest_thread_usage)
    result = _base_result(request, profile)
    result["provider_request_ids"] = response_ids
    result["usage"] = usage
    result["attempts"] = [
        {
            "attempt": 1,
            "delivery": "possibly_accepted",
            "physical_completions_observed": len(raw_completions),
            "physical_deliveries_proven": False,
            "sdk_retries_controlled": False,
        }
    ]
    result["validation"] = {
        "native_output_schema_requested": True,
        "local_schema_valid": False,
        "schema_errors": [],
        "forbidden_tool_absent": not forbidden_items,
        "forbidden_item_types": sorted(set(forbidden_items)),
    }

    if terminal_turn is None:
        result["terminal_state"] = "outcome_unknown"
        result["error"] = _error(
            "stream_interrupted", "stream", "possibly_accepted", "never", "No terminal turn event was observed"
        )
        return result

    if forbidden_items:
        result["terminal_state"] = "failed"
        result["error"] = _error(
            "policy_denied", "validation", "accepted", "never", "The Codex runtime executed a forbidden tool item"
        )
        return result

    turn_status = terminal_turn.get("status")
    if turn_status == "interrupted":
        result["terminal_state"] = "outcome_unknown"
        result["error"] = _error("cancelled", "stream", "possibly_accepted", "never", "Turn was interrupted")
        return result
    if turn_status != "completed":
        result["terminal_state"] = "failed"
        result["error"] = _error("unknown", "stream", "possibly_accepted", "never", "Codex turn failed")
        return result

    if not agent_texts:
        result["terminal_state"] = "failed"
        result["error"] = _error(
            "malformed_response", "validation", "accepted", "never", "Completed turn had no final agent message"
        )
        return result

    return _finish_structured_result(result, request, agent_texts[-1])


def build_bedrock_converse_request(request: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    """Map the neutral request to Bedrock Runtime Converse."""

    _raise_for_invalid_request(request)
    schema_name = request["output_schema"]["id"].replace(".", "_").replace("/", "_").replace("-", "_")
    return {
        "system": [{"text": request["policy_instruction"]["text"]}],
        "messages": [
            {
                "role": "user",
                "content": [{"text": block["text"]} for block in request["input_blocks"]],
            }
        ],
        "inferenceConfig": {"maxTokens": request["generation"]["max_output_tokens"]},
        "outputConfig": {
            "textFormat": {
                "type": "json_schema",
                "structure": {
                    "jsonSchema": {
                        "name": schema_name,
                        "description": "Kestrel synthetic Review First conformance output",
                        "schema": json.dumps(
                            request["output_schema"]["schema"],
                            ensure_ascii=False,
                            separators=(",", ":"),
                            sort_keys=True,
                        ),
                    }
                },
            }
        },
    }


def normalize_bedrock_response(
    request: dict[str, Any], profile: dict[str, Any], response: dict[str, Any]
) -> dict[str, Any]:
    """Normalize a Boto3 Converse response without losing AWS metadata."""

    _raise_for_invalid_request(request)
    result = _base_result(request, profile)
    metadata = response.get("ResponseMetadata") if isinstance(response.get("ResponseMetadata"), dict) else {}
    retries = metadata.get("RetryAttempts", 0)
    retries = retries if isinstance(retries, int) and retries >= 0 else 0
    request_id = metadata.get("RequestId")
    result["provider_request_ids"] = (
        [{"name": "aws.request_id", "value": request_id[:256]}] if isinstance(request_id, str) else []
    )
    result["usage"] = _normalize_bedrock_usage(response.get("usage"))
    result["attempts"] = [
        {
            "attempt": 1,
            "delivery": "accepted",
            "physical_deliveries": 1 + retries,
            "sdk_retry_attempts": retries,
            "sdk_retries_controlled": retries == 0,
        }
    ]
    result["validation"] = {
        "native_output_schema_requested": True,
        "local_schema_valid": False,
        "schema_errors": [],
        "forbidden_tool_absent": True,
        "forbidden_item_types": [],
    }

    stop_reason = response.get("stopReason")
    result["stop"] = {"category": _bedrock_stop_category(stop_reason), "raw": stop_reason}
    if stop_reason in {"max_tokens", "model_context_window_exceeded"}:
        result["terminal_state"] = "incomplete"
        result["error"] = _error("malformed_response", "validation", "accepted", "never", "Bedrock output was truncated")
        return result
    if stop_reason in {"content_filtered", "guardrail_intervened"}:
        result["terminal_state"] = "filtered"
        result["error"] = _error("policy_denied", "validation", "accepted", "never", "Bedrock filtered the response")
        return result
    if stop_reason in {"tool_use", "malformed_tool_use"}:
        result["terminal_state"] = "failed"
        result["validation"]["forbidden_tool_absent"] = False
        result["validation"]["forbidden_item_types"] = [str(stop_reason)]
        result["error"] = _error("policy_denied", "validation", "accepted", "never", "Bedrock returned forbidden tool activity")
        return result
    if stop_reason == "malformed_model_output":
        result["terminal_state"] = "failed"
        result["error"] = _error(
            "malformed_response", "validation", "accepted", "never", "Bedrock reported malformed model output"
        )
        return result
    if stop_reason not in {"end_turn", "stop_sequence"}:
        result["terminal_state"] = "failed"
        result["error"] = _error("unknown", "validation", "accepted", "never", "Unknown Bedrock stop reason")
        return result

    content_blocks = _bedrock_content_blocks(response)
    forbidden_content = sorted(
        {
            key
            for block in content_blocks
            if isinstance(block, dict)
            for key in block
            if key in {"toolUse", "toolResult"}
        }
    )
    if forbidden_content:
        result["terminal_state"] = "failed"
        result["validation"]["forbidden_tool_absent"] = False
        result["validation"]["forbidden_item_types"] = forbidden_content
        result["error"] = _error(
            "policy_denied", "validation", "accepted", "never", "Bedrock returned forbidden tool content"
        )
        return result
    if (
        len(content_blocks) != 1
        or not isinstance(content_blocks[0], dict)
        or set(content_blocks[0]) != {"text"}
        or not isinstance(content_blocks[0].get("text"), str)
    ):
        result["terminal_state"] = "failed"
        result["error"] = _error(
            "malformed_response", "validation", "accepted", "never", "Expected exactly one Bedrock text block"
        )
        return result
    return _finish_structured_result(result, request, content_blocks[0]["text"])


def normalize_bedrock_service_error(
    request: dict[str, Any],
    profile: dict[str, Any],
    *,
    code: str,
    status: int | None,
    request_id: str | None,
    retry_attempts: int,
) -> dict[str, Any]:
    """Normalize a Bedrock service exception and expose any hidden SDK attempts."""

    _raise_for_invalid_request(request)
    result = _base_result(request, profile)
    retry_attempts = retry_attempts if isinstance(retry_attempts, int) and retry_attempts >= 0 else 0
    result["provider_request_ids"] = (
        [{"name": "aws.request_id", "value": request_id[:256]}] if isinstance(request_id, str) else []
    )
    possibly_accepted = code in {"InternalServerException", "ModelErrorException", "ModelTimeoutException"}
    delivery = "possibly_accepted" if possibly_accepted else "rejected_before_inference"
    category = _bedrock_error_category(code, status)
    result["attempts"] = [
        {
            "attempt": 1,
            "delivery": delivery,
            "physical_deliveries": 1 + retry_attempts,
            "sdk_retry_attempts": retry_attempts,
            "sdk_retries_controlled": retry_attempts == 0,
        }
    ]
    result["terminal_state"] = "outcome_unknown" if possibly_accepted else "failed"
    if possibly_accepted:
        retryability = "never"
    elif category in {"rate_limited", "overloaded", "provider_internal", "target_unavailable"}:
        retryability = "operator_only"
    else:
        retryability = "never"
    result["error"] = _error(
        category,
        "response_headers",
        delivery,
        retryability,
        "Bedrock returned a typed service error",
    )
    result["error"]["provider"] = {"http_status": status, "code": code[:128]}
    return result


def normalize_bedrock_transport_failure(
    request: dict[str, Any], profile: dict[str, Any], *, delivered: bool, message: str
) -> dict[str, Any]:
    """Record a Bedrock transport failure without replaying an ambiguous call."""

    _raise_for_invalid_request(request)
    result = _base_result(request, profile)
    result["attempts"] = [
        {
            "attempt": 1,
            "delivery": "possibly_accepted" if delivered else "not_sent",
            "physical_deliveries": 1 if delivered else 0,
            "sdk_retry_attempts": 0,
            "sdk_retries_controlled": True,
        }
    ]
    result["terminal_state"] = "outcome_unknown" if delivered else "failed"
    result["error"] = _error(
        "stream_interrupted" if delivered else "transport",
        "response_headers" if delivered else "connect",
        "possibly_accepted" if delivered else "not_sent",
        "never" if delivered else "safe_automatic",
        message,
    )
    return result


def bedrock_botocore_options() -> dict[str, Any]:
    """Boto3 client options that cap one SDK call at one physical attempt."""

    return {"retries": {"total_max_attempts": 1, "mode": "standard"}}


def sanitize_codex_rate_limits(raw: Any) -> dict[str, Any]:
    """Retain quota shape while removing live consumption and reset details."""

    if not isinstance(raw, dict):
        return {"rate_limits": None, "rate_limit_buckets": []}

    def sanitize_bucket(bucket: Any) -> dict[str, Any] | None:
        if not isinstance(bucket, dict):
            return None

        def sanitize_window(window: Any) -> dict[str, Any] | None:
            if not isinstance(window, dict):
                return None
            duration = window.get("windowDurationMins")
            return {
                "window_duration_minutes": duration if isinstance(duration, (int, float)) else None,
                "has_usage_percentage": isinstance(window.get("usedPercent"), (int, float)),
                "has_reset_timestamp": isinstance(window.get("resetsAt"), (int, float)),
            }

        return {
            "limit_id": bucket.get("limitId"),
            "limit_name": bucket.get("limitName"),
            "plan_type_present": isinstance(bucket.get("planType"), str),
            "primary": sanitize_window(bucket.get("primary")),
            "secondary": sanitize_window(bucket.get("secondary")),
            "rate_limit_reached_type": bucket.get("rateLimitReachedType"),
            "has_credit_balance": "credits" in bucket,
        }

    buckets = raw.get("rateLimitsByLimitId")
    sanitized_buckets = []
    if isinstance(buckets, dict):
        for key in sorted(buckets):
            bucket = sanitize_bucket(buckets[key])
            if bucket is not None:
                sanitized_buckets.append(bucket)

    reset_credits = raw.get("rateLimitResetCredits")
    return {
        "rate_limits": sanitize_bucket(raw.get("rateLimits")),
        "rate_limit_buckets": sanitized_buckets,
        "reset_credits_available_count_exposed": isinstance(reset_credits, dict)
        and isinstance(reset_credits.get("availableCount"), int),
        "reset_credit_details_exposed": isinstance(reset_credits, dict) and reset_credits.get("credits") is not None,
    }


def codex_subscription_conformance_matrix(
    normalized_result: dict[str, Any], *, account: Any, thread_ephemeral: bool
) -> dict[str, dict[str, Any]]:
    """Separate live success from Review First profile certification."""

    account = account if isinstance(account, dict) else {}
    validation = normalized_result.get("validation") if isinstance(normalized_result.get("validation"), dict) else {}
    attempts = normalized_result.get("attempts") if isinstance(normalized_result.get("attempts"), list) else []
    first_attempt = attempts[0] if attempts and isinstance(attempts[0], dict) else {}

    matrix: dict[str, dict[str, Any]] = {
        "surface_identified_as_codex_not_platform_api": {
            "pass": True,
            "evidence": "The profile records codex-app-server-v2 and chatgpt-codex as distinct surface facts.",
        },
        "chatgpt_subscription_auth": {
            "pass": account.get("type") == "chatgpt",
            "evidence": f"account/read type={account.get('type')!r}, planType present={bool(account.get('planType'))}",
        },
        "ephemeral_local_thread": {
            "pass": bool(thread_ephemeral),
            "evidence": "thread/start used ephemeral=true; this proves local non-persistence only.",
        },
        "live_structured_output_and_local_validation": {
            "pass": normalized_result.get("terminal_state") == "succeeded"
            and validation.get("native_output_schema_requested") is True
            and validation.get("local_schema_valid") is True,
            "evidence": "turn/start used outputSchema and the completed JSON was validated again by the harness.",
        },
        "no_forbidden_tool_activity_observed": {
            "pass": validation.get("forbidden_tool_absent") is True,
            "evidence": "No command, file-change, MCP, dynamic-tool, multi-agent, or web-search item appeared in the transcript.",
        },
        "provider_request_id_exposed": {
            "pass": bool(normalized_result.get("provider_request_ids")),
            "evidence": "An upstream response identifier was emitted, not merely the local turn id.",
        },
        "provider_request_id_and_usage_on_supported_contract": {
            "pass": False,
            "evidence": "Exact response IDs and per-completion usage require experimentalRawEvents; the generated protocol marks rawResponse/completed internal-only.",
        },
        "tools_disabled_at_request_boundary": {
            "pass": False,
            "evidence": "The documented app-server thread/turn API has no all-tools-disabled control; absence of a tool call is not absence of tool schemas.",
        },
        "sdk_retries_disabled_or_fully_debited": {
            "pass": first_attempt.get("sdk_retries_controlled") is True
            and first_attempt.get("physical_deliveries_proven") is True,
            "evidence": "The built-in OpenAI provider retry policy cannot be overridden, and app-server does not prove every delivery to this client.",
        },
        "provider_application_state_disabled": {
            "pass": False,
            "evidence": "ephemeral=true controls local thread materialization; it is not a documented upstream store=false guarantee.",
        },
        "per_call_money_reconciled": {
            "pass": False,
            "evidence": "ChatGPT subscription quota exposes windows and token activity, not a provider-reported monetary amount for this call.",
        },
        "account_data_policy_attested": {
            "pass": False,
            "evidence": "account/read exposes auth and plan type, not training/retention/residency settings; separate workspace evidence is required.",
        },
    }
    required = [entry["pass"] for name, entry in matrix.items() if name != "surface_identified_as_codex_not_platform_api"]
    matrix["overall"] = {
        "pass": all(required),
        "evidence": "Every hard Review First profile control must pass; a successful model turn alone is insufficient.",
    }
    return matrix


def _raise_for_invalid_request(request: dict[str, Any]) -> None:
    errors = validate_model_request(request)
    if errors:
        raise ValueError("invalid model request: " + "; ".join(errors))


def _base_result(request: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    return {
        "contract_version": request["contract_version"],
        "adapter_version": profile["adapter_version"],
        "model_call_id": request["model_call_id"],
        "request_digest": sha256_json(request),
        "profile_snapshot": {
            "profile_id": profile["profile_id"],
            "digest": sha256_json(profile),
        },
        "requested_target": profile.get("target", {}),
        "resolved_target": {},
        "terminal_state": "failed",
        "stop": {"category": "unknown", "raw": None},
        "output_blocks": [],
        "structured_value": None,
        "provider_request_ids": [],
        "usage": _empty_usage(),
        "attempts": [],
        "validation": {},
        "limitations": list(profile.get("known_limitations", [])),
        "error": None,
    }


def _finish_structured_result(result: dict[str, Any], request: dict[str, Any], text: str) -> dict[str, Any]:
    result["output_blocks"] = [{"type": "structured_text", "text": text}]
    try:
        value = json.loads(text)
    except (TypeError, json.JSONDecodeError):
        result["terminal_state"] = "failed"
        result["error"] = _error(
            "malformed_response", "validation", "accepted", "never", "Provider output was not valid JSON"
        )
        return result

    schema_errors = validate_instance(request["output_schema"]["schema"], value)
    result["structured_value"] = value
    result["validation"]["schema_errors"] = schema_errors
    result["validation"]["local_schema_valid"] = not schema_errors
    if schema_errors:
        result["terminal_state"] = "failed"
        result["error"] = _error(
            "malformed_response", "validation", "accepted", "never", "Provider JSON failed local validation"
        )
        return result

    result["terminal_state"] = "succeeded"
    result["stop"] = result.get("stop") or {"category": "end_turn", "raw": "completed"}
    if result["stop"].get("category") == "unknown":
        result["stop"] = {"category": "end_turn", "raw": "completed"}
    result["error"] = None
    return result


def _is_raw_codex_completion(method: Any, params: dict[str, Any]) -> bool:
    normalized_method = "".join(character for character in method.lower() if character.isalnum()) if isinstance(method, str) else ""
    if normalized_method.endswith("rawresponsecompleted"):
        return True
    return "responseId" in params and "usage" in params and "turnId" in params


def _normalize_camel_usage(usage: Any) -> dict[str, Any]:
    normalized = _empty_usage()
    if not isinstance(usage, dict):
        return normalized
    mapping = {
        "inputTokens": "input_tokens",
        "outputTokens": "output_tokens",
        "totalTokens": "total_tokens",
        "cachedInputTokens": "cached_input_read_tokens",
        "cacheWriteInputTokens": "cache_write_tokens",
        "reasoningOutputTokens": "reasoning_output_tokens",
    }
    for source, target in mapping.items():
        if isinstance(usage.get(source), int):
            normalized[target] = usage[source]
    normalized["count_source"] = "provider_reported"
    normalized["reconciliation_status"] = "provider_reported"
    return normalized


def _normalize_bedrock_usage(usage: Any) -> dict[str, Any]:
    normalized = _empty_usage()
    if not isinstance(usage, dict):
        return normalized
    mapping = {
        "inputTokens": "input_tokens",
        "outputTokens": "output_tokens",
        "totalTokens": "total_tokens",
        "cacheReadInputTokens": "cached_input_read_tokens",
        "cacheWriteInputTokens": "cache_write_tokens",
    }
    for source, target in mapping.items():
        if isinstance(usage.get(source), int):
            normalized[target] = usage[source]
    normalized["count_source"] = "provider_reported"
    normalized["reconciliation_status"] = "provider_reported"
    return normalized


def _empty_usage() -> dict[str, Any]:
    return {
        "input_tokens": None,
        "output_tokens": None,
        "total_tokens": None,
        "cached_input_read_tokens": None,
        "cache_write_tokens": None,
        "reasoning_output_tokens": None,
        "count_source": "unavailable",
        "reconciliation_status": "unknown",
    }


def _bedrock_content_blocks(response: dict[str, Any]) -> list[Any]:
    output = response.get("output")
    message = output.get("message") if isinstance(output, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    return content if isinstance(content, list) else []


def _bedrock_stop_category(stop_reason: Any) -> str:
    return {
        "end_turn": "end_turn",
        "stop_sequence": "end_turn",
        "max_tokens": "length_limit",
        "model_context_window_exceeded": "context_limit",
        "content_filtered": "filter",
        "guardrail_intervened": "filter",
        "tool_use": "forbidden_tool",
        "malformed_tool_use": "forbidden_tool",
        "malformed_model_output": "malformed_response",
    }.get(stop_reason, "unknown")


def _bedrock_error_category(code: str, status: int | None) -> str:
    mapped = {
        "AccessDeniedException": "permission",
        "ExpiredTokenException": "auth",
        "IncompleteSignature": "auth",
        "InternalFailure": "provider_internal",
        "InternalServerException": "provider_internal",
        "InvalidAction": "invalid_request",
        "InvalidClientTokenId": "auth",
        "InvalidSignatureException": "auth",
        "ModelErrorException": "provider_internal",
        "ModelNotReadyException": "target_unavailable",
        "ModelTimeoutException": "timeout",
        "ResourceNotFoundException": "target_unavailable",
        "ServiceQuotaExceededException": "quota_exhausted",
        "ServiceUnavailableException": "overloaded",
        "ThrottlingException": "rate_limited",
        "UnrecognizedClientException": "auth",
        "ValidationException": "invalid_request",
    }.get(code)
    if mapped is not None:
        return mapped
    if status == 429:
        return "rate_limited"
    if status in {502, 503}:
        return "overloaded"
    if isinstance(status, int) and status >= 500:
        return "provider_internal"
    return "unknown"


def _error(category: str, phase: str, delivery: str, retryability: str, message: str) -> dict[str, Any]:
    return {
        "category": category,
        "phase": phase,
        "delivery": delivery,
        "retryability": retryability,
        "retry_after": None,
        "message_safe": str(message)[:240],
    }
