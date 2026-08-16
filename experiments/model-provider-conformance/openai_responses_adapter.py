#!/usr/bin/env python3
"""OpenAI Responses adapter for the neutral Review First boundary."""

from __future__ import annotations

from typing import Any

import harness


def build_request(request: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    """Map the neutral request to one stateless OpenAI Responses call."""

    harness.require_valid_model_request(request)
    schema_name = request["output_schema"]["id"].replace(".", "_").replace("/", "_").replace("-", "_")
    return {
        "model": profile["target"]["requested_id"],
        "instructions": request["policy_instruction"]["text"],
        "input": [
            {"role": "user", "content": [{"type": "input_text", "text": block["text"]}]}
            for block in request["input_blocks"]
        ],
        "max_output_tokens": request["generation"]["max_output_tokens"],
        "store": False,
        "background": False,
        "stream": False,
        "tools": [],
        "tool_choice": "none",
        "parallel_tool_calls": False,
        "prompt_cache_options": {"mode": "explicit"},
        "truncation": "disabled",
        "reasoning": {"effort": profile["generation"]["reasoning_effort"]},
        "service_tier": profile["route"]["service_tier"],
        "text": {
            "format": {
                "type": "json_schema",
                "name": schema_name,
                "description": "Kestrel synthetic Review First conformance output",
                "strict": True,
                "schema": request["output_schema"]["schema"],
            }
        },
    }


def normalize_response(
    request: dict[str, Any],
    profile: dict[str, Any],
    response: dict[str, Any],
    *,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Normalize a non-streaming OpenAI Responses object."""

    harness.require_valid_model_request(request)
    result = harness.new_model_result(request, profile)
    response_id = response.get("id")
    if isinstance(response_id, str):
        result["provider_request_ids"].append({"name": "openai.response_id", "value": response_id[:256]})
    if isinstance(request_id, str):
        result["provider_request_ids"].append({"name": "openai.x_request_id", "value": request_id[:256]})

    model = response.get("model")
    service_tier = response.get("service_tier")
    result["resolved_target"] = {
        key: value
        for key, value in {"model": model, "service_tier": service_tier}.items()
        if isinstance(value, str)
    }
    result["usage"] = _normalize_usage(response.get("usage"))
    result["attempts"] = [_accepted_attempt()]
    result["validation"] = {
        "native_output_schema_requested": True,
        "local_schema_valid": False,
        "schema_errors": [],
        "forbidden_tool_absent": True,
        "forbidden_item_types": [],
        "target_and_route_match_profile": model == profile["target"]["requested_id"]
        and service_tier == profile["route"]["service_tier"],
    }

    status = response.get("status")
    incomplete = response.get("incomplete_details")
    incomplete_reason = incomplete.get("reason") if isinstance(incomplete, dict) else None
    result["stop"] = {"category": _stop_category(status, incomplete_reason), "raw": incomplete_reason or status}
    if status in {"completed", "incomplete"} and not result["validation"]["target_and_route_match_profile"]:
        result["error"] = harness.model_error(
            "attestation_stale", "validation", "accepted", "never", "OpenAI resolved outside the approved profile"
        )
        return result
    if status == "incomplete":
        result["terminal_state"] = "filtered" if incomplete_reason == "content_filter" else "incomplete"
        result["error"] = harness.model_error(
            "policy_denied" if incomplete_reason == "content_filter" else "malformed_response",
            "validation",
            "accepted",
            "never",
            "OpenAI filtered the response" if incomplete_reason == "content_filter" else "OpenAI output was incomplete",
        )
        return result
    if status != "completed":
        result["error"] = harness.model_error(
            "provider_internal", "response_headers", "accepted", "operator_only", "OpenAI response did not complete"
        )
        return result

    text_blocks, refusals, unexpected_items, malformed_content = _collect_output(response.get("output"))
    if unexpected_items:
        result["validation"]["forbidden_tool_absent"] = False
        result["validation"]["forbidden_item_types"] = sorted(set(unexpected_items))
        result["error"] = harness.model_error(
            "policy_denied", "validation", "accepted", "never", "OpenAI returned forbidden tool activity"
        )
        return result
    if refusals and not text_blocks and not malformed_content:
        result["terminal_state"] = "refused"
        result["stop"] = {"category": "refusal", "raw": "refusal"}
        result["error"] = harness.model_error(
            "policy_denied", "validation", "accepted", "never", "OpenAI refused the request"
        )
        return result
    if malformed_content or refusals or len(text_blocks) != 1:
        result["error"] = harness.model_error(
            "malformed_response", "validation", "accepted", "never", "Expected exactly one OpenAI output-text block"
        )
        return result
    return harness.finish_structured_result(result, request, text_blocks[0])


def normalize_transport_failure(
    request: dict[str, Any], profile: dict[str, Any], *, delivered: bool, message: str
) -> dict[str, Any]:
    harness.require_valid_model_request(request)
    result = harness.new_model_result(request, profile)
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
    result["error"] = harness.model_error(
        "stream_interrupted" if delivered else "transport",
        "response_headers" if delivered else "connect",
        "possibly_accepted" if delivered else "not_sent",
        "never" if delivered else "safe_automatic",
        message,
    )
    return result


def normalize_http_error(
    request: dict[str, Any],
    profile: dict[str, Any],
    status: int,
    body: Any,
    *,
    request_id: str | None = None,
) -> dict[str, Any]:
    harness.require_valid_model_request(request)
    result = harness.new_model_result(request, profile)
    error = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), dict) else {}
    code = error.get("code")[:128] if isinstance(error.get("code"), str) else None
    category = _http_error_category(status, code)
    if isinstance(request_id, str):
        result["provider_request_ids"] = [{"name": "openai.x_request_id", "value": request_id[:256]}]
    result["attempts"] = [{**_accepted_attempt(), "delivery": "rejected_before_inference"}]
    retryability = "operator_only" if category in {"rate_limited", "overloaded", "provider_internal"} else "never"
    result["error"] = harness.model_error(
        category,
        "response_headers",
        "rejected_before_inference",
        retryability,
        f"OpenAI request failed with HTTP {status}",
    )
    result["error"]["provider"] = {"http_status": status, "code": code}
    return result


def _accepted_attempt() -> dict[str, Any]:
    return {
        "attempt": 1,
        "delivery": "accepted",
        "physical_deliveries": 1,
        "sdk_retry_attempts": 0,
        "sdk_retries_controlled": True,
    }


def _collect_output(output: Any) -> tuple[list[str], int, list[str], list[str]]:
    text_blocks: list[str] = []
    refusals = 0
    unexpected_items: list[str] = []
    malformed_content: list[str] = []
    for item in output if isinstance(output, list) else []:
        if not isinstance(item, dict):
            malformed_content.append("non_object_output_item")
            continue
        item_type = item.get("type")
        if item_type == "reasoning":
            continue
        if item_type != "message":
            unexpected_items.append(str(item_type))
            continue
        content = item.get("content")
        if not isinstance(content, list):
            malformed_content.append("message_without_content")
            continue
        for block in content:
            if not isinstance(block, dict):
                malformed_content.append("non_object_content")
            elif block.get("type") == "output_text" and isinstance(block.get("text"), str):
                text_blocks.append(block["text"])
            elif block.get("type") == "refusal" and isinstance(block.get("refusal"), str):
                refusals += 1
            else:
                malformed_content.append(str(block.get("type")))
    return text_blocks, refusals, unexpected_items, malformed_content


def _normalize_usage(usage: Any) -> dict[str, Any]:
    normalized = harness.empty_usage()
    if not isinstance(usage, dict):
        return normalized
    for field in ("input_tokens", "output_tokens", "total_tokens"):
        if isinstance(usage.get(field), int):
            normalized[field] = usage[field]
    input_details = usage.get("input_tokens_details")
    if isinstance(input_details, dict):
        if isinstance(input_details.get("cached_tokens"), int):
            normalized["cached_input_read_tokens"] = input_details["cached_tokens"]
        if isinstance(input_details.get("cache_write_tokens"), int):
            normalized["cache_write_tokens"] = input_details["cache_write_tokens"]
    output_details = usage.get("output_tokens_details")
    if isinstance(output_details, dict) and isinstance(output_details.get("reasoning_tokens"), int):
        normalized["reasoning_output_tokens"] = output_details["reasoning_tokens"]
    normalized["count_source"] = "provider_reported"
    normalized["reconciliation_status"] = "provider_reported"
    return normalized


def _stop_category(status: Any, incomplete_reason: Any) -> str:
    if status == "completed":
        return "end_turn"
    return {"max_output_tokens": "length_limit", "content_filter": "filter"}.get(incomplete_reason, "unknown")


def _http_error_category(status: int, code: str | None) -> str:
    if status == 401:
        return "auth"
    if status == 403:
        return "permission"
    if status == 404:
        return "target_unavailable"
    if status in {408, 504}:
        return "timeout"
    if status == 429:
        return "quota_exhausted" if code == "insufficient_quota" else "rate_limited"
    if status in {502, 503}:
        return "overloaded"
    if status >= 500:
        return "provider_internal"
    if status in {400, 409, 413, 422}:
        return "invalid_request"
    return "unknown"
