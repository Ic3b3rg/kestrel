#!/usr/bin/env python3
"""Shared, provider-neutral safety helpers for disposable live probes."""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
import json
import re
from typing import Any

import harness


MILLION = Decimal("1000000")


class PreflightError(RuntimeError):
    """A safe failure raised before model inference is attempted."""


def generated_at() -> str:
    return datetime.now(timezone.utc).isoformat()


def require_env(env: dict[str, str], name: str) -> str:
    value = env.get(name)
    if not isinstance(value, str) or not value.strip():
        raise PreflightError(f"Required environment variable {name} is absent")
    return value.strip()


def require_sha256_attestation(env: dict[str, str], name: str) -> str:
    digest = require_env(env, name)
    if re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is None:
        raise PreflightError(f"Required environment variable {name} is not a SHA-256 evidence digest")
    return digest


def require_current_attestation(profile: dict[str, Any], *, today: date | None = None) -> None:
    attestation = profile.get("attestation") if isinstance(profile.get("attestation"), dict) else {}
    try:
        expires_on = date.fromisoformat(str(attestation["expires_on"]))
    except (KeyError, ValueError) as error:
        raise PreflightError("The evidence profile has no valid attestation expiry") from error
    if expires_on < (today or datetime.now(timezone.utc).date()):
        raise PreflightError("The evidence profile attestation has expired")


def cost_gate(
    request: dict[str, Any], profile: dict[str, Any], mapped: dict[str, Any], operator_cap_text: str
) -> dict[str, Any]:
    """Reserve a conservative byte-as-token upper-bound before delivery."""

    limits = profile.get("limits") if isinstance(profile.get("limits"), dict) else {}
    if limits.get("logical_attempts") != 1 or limits.get("physical_attempts") != 1:
        raise PreflightError("Live evidence profiles must permit exactly one logical and physical attempt")
    requested_output = request.get("generation", {}).get("max_output_tokens")
    if not isinstance(requested_output, int) or requested_output > limits.get("max_output_tokens", 0):
        raise PreflightError("The neutral output budget exceeds the profile limit")

    currencies = {
        request.get("budget", {}).get("currency"),
        limits.get("currency"),
        profile.get("pricing", {}).get("currency"),
    }
    if currencies != {"USD"}:
        raise PreflightError("The request, profile, and price snapshot must all use USD")

    pricing = profile.get("pricing") if isinstance(profile.get("pricing"), dict) else {}
    input_price = _positive_decimal(pricing.get("input_per_million_tokens"), "input token price")
    output_price = _positive_decimal(pricing.get("output_per_million_tokens"), "output token price")
    serialized = json.dumps(mapped, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    input_token_upper_bound = len(serialized)
    input_price, output_price = _long_context_prices(pricing, input_token_upper_bound, input_price, output_price)
    worst_case = (
        Decimal(input_token_upper_bound) * input_price
        + Decimal(requested_output) * output_price
    ) / MILLION

    caps = {
        "request": _positive_decimal(request.get("budget", {}).get("money"), "request money cap"),
        "profile": _positive_decimal(limits.get("reserved_cost"), "profile reserved cost"),
        "operator": _positive_decimal(operator_cap_text, "operator cost cap"),
    }
    if any(worst_case > cap for cap in caps.values()):
        raise PreflightError("Worst-case probe cost exceeds a configured hard cap")

    return {
        "preflight_status": "within_cap",
        "currency": "USD",
        "worst_case_reserved": _money(worst_case),
        "operator_hard_cap": _money(caps["operator"]),
        "request_hard_cap": _money(caps["request"]),
        "profile_hard_cap": _money(caps["profile"]),
        "input_token_upper_bound": input_token_upper_bound,
        "output_token_limit": requested_output,
        "input_bound_method": "serialized_request_utf8_bytes_as_token_upper_bound",
        "price_snapshot_digest": harness.sha256_json(pricing),
        "price_source": pricing.get("source"),
        "price_retrieved_on": pricing.get("retrieved_on"),
    }


def post_call_cost(usage: Any, profile: dict[str, Any]) -> str | None:
    """Estimate cost from provider-reported token dimensions; never call it an invoice."""

    if not isinstance(usage, dict):
        return None
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    if not isinstance(input_tokens, int) or not isinstance(output_tokens, int):
        return None
    cached = usage.get("cached_input_read_tokens")
    cache_write = usage.get("cache_write_tokens")
    cached = cached if isinstance(cached, int) and cached >= 0 else 0
    cache_write = cache_write if isinstance(cache_write, int) and cache_write >= 0 else 0
    uncached = max(0, input_tokens - cached - cache_write)
    pricing = profile["pricing"]
    input_price = _positive_decimal(pricing["input_per_million_tokens"], "input price")
    output_price = _positive_decimal(pricing["output_per_million_tokens"], "output price")
    input_price, output_price = _long_context_prices(pricing, input_tokens, input_price, output_price)
    total = Decimal(uncached) * input_price
    total += Decimal(output_tokens) * output_price
    if cached:
        total += Decimal(cached) * _positive_decimal(
            pricing["cached_input_per_million_tokens"], "cached input price"
        )
    if cache_write:
        total += Decimal(cache_write) * _positive_decimal(
            pricing["cache_write_per_million_tokens"], "cache write price"
        )
    return _money(total / MILLION)


def finish_cost_evidence(
    preflight: dict[str, Any], result: dict[str, Any], profile: dict[str, Any]
) -> dict[str, Any]:
    evidence = dict(preflight)
    estimate = post_call_cost(result.get("usage"), profile)
    if estimate is not None:
        evidence["post_call_status"] = "estimated_from_provider_usage"
        evidence["post_call_estimate"] = estimate
        evidence["billing_reconciliation"] = "not_returned_by_inference_surface"
    elif result.get("terminal_state") == "outcome_unknown":
        evidence["post_call_status"] = "pending_unknown_usage"
        evidence["post_call_estimate"] = None
        evidence["billing_reconciliation"] = "reservation_retained"
    else:
        evidence["post_call_status"] = "provider_usage_unavailable"
        evidence["post_call_estimate"] = None
        evidence["billing_reconciliation"] = "requires_external_billing_evidence"
    return evidence


def strict_conformance_matrix(
    result: dict[str, Any],
    cost: dict[str, Any],
    *,
    privileged_channel_mapped: bool,
    tools_forbidden_at_boundary: bool,
    provider_state_disabled: bool,
    exact_egress_verified: bool,
    target_and_route_attested: bool,
    data_policy_attested: bool,
) -> dict[str, dict[str, Any]]:
    validation = result.get("validation") if isinstance(result.get("validation"), dict) else {}
    attempts = result.get("attempts") if isinstance(result.get("attempts"), list) else []
    attempt = attempts[0] if attempts and isinstance(attempts[0], dict) else {}
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
    matrix = {
        "live_terminal_success": {
            "pass": result.get("terminal_state") == "succeeded",
            "evidence": "The one-shot live result must terminate as succeeded.",
        },
        "privileged_instruction_channel": {
            "pass": privileged_channel_mapped,
            "evidence": "Policy instructions are mapped separately from untrusted user text.",
        },
        "native_schema_and_local_validation": {
            "pass": validation.get("native_output_schema_requested") is True
            and validation.get("local_schema_valid") is True,
            "evidence": "The native schema request is checked again by the local subset validator.",
        },
        "tools_forbidden": {
            "pass": tools_forbidden_at_boundary and validation.get("forbidden_tool_absent") is True,
            "evidence": "No tool schema is sent and no tool output is accepted.",
        },
        "provider_application_state_disabled": {
            "pass": provider_state_disabled,
            "evidence": "The exact adapter mapping disables response state and prompt-cache state.",
        },
        "exact_egress": {
            "pass": exact_egress_verified,
            "evidence": "The runner rejects endpoint overrides, redirects, and ambient proxies.",
        },
        "target_and_route_attested": {
            "pass": target_and_route_attested,
            "evidence": "The resolved target and approved route are checked for drift.",
        },
        "single_physical_delivery": {
            "pass": attempt.get("physical_deliveries") == 1
            and attempt.get("sdk_retries_controlled") is True,
            "evidence": "Exactly one physical model delivery is observed and SDK retries are disabled.",
        },
        "provider_correlation_id": {
            "pass": bool(result.get("provider_request_ids")),
            "evidence": "At least one provider-native request or response identifier is retained.",
        },
        "provider_reported_usage": {
            "pass": usage.get("count_source") == "provider_reported",
            "evidence": "Input and output usage comes from the provider response.",
        },
        "preflight_and_post_call_cost": {
            "pass": cost.get("preflight_status") == "within_cap"
            and cost.get("post_call_status") == "estimated_from_provider_usage",
            "evidence": "A hard local reservation precedes delivery and reported usage is repriced afterward.",
        },
        "data_policy_attested": {
            "pass": data_policy_attested,
            "evidence": "A separate account-policy evidence digest is bound to this capture.",
        },
    }
    matrix["overall"] = {
        "pass": all(entry["pass"] for entry in matrix.values()),
        "evidence": "Every hard Review First conformance control must pass on the same live capture.",
    }
    return matrix


def _positive_decimal(value: Any, label: str) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise PreflightError(f"Invalid {label}") from error
    if not parsed.is_finite() or parsed <= 0:
        raise PreflightError(f"Invalid {label}")
    return parsed


def _long_context_prices(
    pricing: dict[str, Any], input_tokens: int, input_price: Decimal, output_price: Decimal
) -> tuple[Decimal, Decimal]:
    threshold = pricing.get("long_context_threshold_input_tokens")
    if not isinstance(threshold, int) or input_tokens <= threshold:
        return input_price, output_price
    return (
        input_price * _positive_decimal(pricing.get("long_context_input_multiplier"), "long-context input multiplier"),
        output_price
        * _positive_decimal(pricing.get("long_context_output_multiplier"), "long-context output multiplier"),
    )


def _money(value: Decimal) -> str:
    return format(value.quantize(Decimal("0.00000001")), "f")
