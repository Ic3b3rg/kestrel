import copy
import json
import unittest
from pathlib import Path

import harness


HERE = Path(__file__).resolve().parent


def load_request():
    return json.loads((HERE / "fixtures" / "review_request.json").read_text())


def valid_value():
    return {
        "summary": "Boundary probe",
        "risk_level": "low",
        "score": 1.5,
        "finding_count": 0,
        "reviewable": True,
        "concepts": [{"name": "retry policy", "changed": True}],
    }


class ReviewSchemaSubsetTests(unittest.TestCase):
    def setUp(self):
        self.schema = load_request()["output_schema"]["schema"]

    def test_accepts_the_exact_supported_shape_subset(self):
        self.assertEqual([], harness.validate_schema_definition(self.schema))
        self.assertEqual([], harness.validate_instance(self.schema, valid_value()))

    def test_rejects_unknown_and_missing_properties_locally(self):
        with_unknown = valid_value() | {"provider_hint": "openai"}
        missing_required = valid_value()
        del missing_required["reviewable"]

        self.assertIn("$: unknown property 'provider_hint'", harness.validate_instance(self.schema, with_unknown))
        self.assertIn("$: missing required property 'reviewable'", harness.validate_instance(self.schema, missing_required))

    def test_rejects_bool_as_integer_and_an_unknown_enum_value(self):
        wrong = valid_value()
        wrong["finding_count"] = True
        wrong["risk_level"] = "critical"

        errors = harness.validate_instance(self.schema, wrong)

        self.assertIn("$.finding_count: expected integer", errors)
        self.assertIn("$.risk_level: value is not in the fixed enum", errors)

    def test_rejects_schema_features_outside_the_kestrel_subset(self):
        cases = []

        union_schema = copy.deepcopy(self.schema)
        union_schema["properties"]["summary"] = {"anyOf": [{"type": "string"}, {"type": "null"}]}
        cases.append(union_schema)

        optional_schema = copy.deepcopy(self.schema)
        optional_schema["required"].remove("score")
        cases.append(optional_schema)

        permissive_schema = copy.deepcopy(self.schema)
        permissive_schema["additionalProperties"] = True
        cases.append(permissive_schema)

        default_schema = copy.deepcopy(self.schema)
        default_schema["properties"]["score"]["default"] = 0
        cases.append(default_schema)

        remote_ref_schema = copy.deepcopy(self.schema)
        remote_ref_schema["properties"]["summary"] = {"$ref": "https://example.com/schema.json"}
        cases.append(remote_ref_schema)

        for schema in cases:
            with self.subTest(schema=schema):
                self.assertTrue(harness.validate_schema_definition(schema))


class NeutralBoundaryTests(unittest.TestCase):
    def test_rejects_caller_supplied_provider_escape_hatches(self):
        for field in ("provider", "model", "base_url", "tools", "extra_body", "headers", "retry_count"):
            request = load_request()
            request[field] = "forbidden"
            with self.subTest(field=field):
                self.assertIn(f"$: forbidden caller field '{field}'", harness.validate_model_request(request))

    def test_request_fixture_is_valid_and_digest_is_stable(self):
        request = load_request()

        self.assertEqual([], harness.validate_model_request(request))
        self.assertEqual(harness.sha256_json(request), harness.sha256_json(copy.deepcopy(request)))


class CodexAppServerAdapterTests(unittest.TestCase):
    def setUp(self):
        self.request = load_request()
        self.profile = {
            "profile_id": "openai-codex-subscription-evidence",
            "adapter_version": "codex-app-server/0.146.0",
            "target": {"requested_id": "gpt-5.6-sol"},
            "auth": {"kind": "chatgpt_oauth_subscription"},
            "known_limitations": ["tools_not_disableable", "built_in_retries_not_disableable"],
        }

    def test_maps_policy_and_input_to_separate_app_server_fields(self):
        thread = harness.build_codex_thread_start(self.request, self.profile, "/empty/probe")
        turn = harness.build_codex_turn_start(self.request, "thr_test")

        self.assertEqual(self.request["policy_instruction"]["text"], thread["developerInstructions"])
        self.assertEqual("/empty/probe", thread["cwd"])
        self.assertTrue(thread["ephemeral"])
        self.assertEqual("read-only", thread["sandbox"])
        self.assertEqual("never", thread["approvalPolicy"])
        self.assertFalse(thread["allowProviderModelFallback"])
        self.assertEqual([], thread["dynamicTools"])
        self.assertEqual([], thread["environments"])
        self.assertEqual([], thread["selectedCapabilityRoots"])
        self.assertEqual(self.request["output_schema"]["schema"], turn["outputSchema"])
        self.assertEqual([{"type": "text", "text": self.request["input_blocks"][0]["text"]}], turn["input"])

    def test_normalizes_success_with_response_id_exact_usage_and_local_validation(self):
        events = [
            {
                "method": "item/completed",
                "params": {
                    "item": {"id": "msg_1", "type": "agentMessage", "text": json.dumps(valid_value())}
                },
            },
            {
                "method": "rawResponseItem/completed",
                "params": {
                    "threadId": "thr_test",
                    "turnId": "turn_test",
                    "item": {"type": "message"},
                },
            },
            {
                "method": "rawResponse/completed",
                "params": {
                    "threadId": "thr_test",
                    "turnId": "turn_test",
                    "responseId": "resp_test",
                    "usage": {
                        "inputTokens": 30,
                        "cachedInputTokens": 4,
                        "cacheWriteInputTokens": 0,
                        "outputTokens": 20,
                        "reasoningOutputTokens": 5,
                        "totalTokens": 50,
                    },
                },
            },
            {
                "method": "turn/completed",
                "params": {"turn": {"id": "turn_test", "status": "completed", "items": [], "error": None}},
            },
        ]

        result = harness.normalize_codex_events(self.request, self.profile, events)

        self.assertEqual("succeeded", result["terminal_state"])
        self.assertEqual(valid_value(), result["structured_value"])
        self.assertTrue(result["validation"]["local_schema_valid"])
        self.assertEqual([{"name": "openai.response_id", "value": "resp_test"}], result["provider_request_ids"])
        self.assertEqual(4, result["usage"]["cached_input_read_tokens"])
        self.assertEqual(1, result["attempts"][0]["physical_completions_observed"])

    def test_rejects_tool_activity_even_if_the_turn_completed(self):
        events = [
            {
                "method": "item/completed",
                "params": {"item": {"id": "cmd_1", "type": "commandExecution", "status": "completed"}},
            },
            {
                "method": "item/completed",
                "params": {"item": {"id": "msg_1", "type": "agentMessage", "text": json.dumps(valid_value())}},
            },
            {
                "method": "turn/completed",
                "params": {"turn": {"id": "turn_test", "status": "completed", "items": [], "error": None}},
            },
        ]

        result = harness.normalize_codex_events(self.request, self.profile, events)

        self.assertEqual("failed", result["terminal_state"])
        self.assertEqual("policy_denied", result["error"]["category"])
        self.assertFalse(result["validation"]["forbidden_tool_absent"])

    def test_marks_missing_terminal_event_as_outcome_unknown_without_retry(self):
        result = harness.normalize_codex_events(self.request, self.profile, [])

        self.assertEqual("outcome_unknown", result["terminal_state"])
        self.assertEqual("possibly_accepted", result["error"]["delivery"])
        self.assertEqual("never", result["error"]["retryability"])

    def test_sanitizes_subscription_quota_without_publishing_live_consumption(self):
        raw = {
            "rateLimits": {
                "limitId": "codex",
                "planType": "prolite",
                "primary": {"usedPercent": 37, "windowDurationMins": 300, "resetsAt": 123456},
                "secondary": None,
                "credits": 12.5,
            },
            "rateLimitsByLimitId": {
                "codex": {
                    "limitId": "codex",
                    "primary": {"usedPercent": 37, "windowDurationMins": 300, "resetsAt": 123456},
                }
            },
            "rateLimitResetCredits": {"availableCount": 2, "credits": [{"id": "secretish-id"}]},
        }

        sanitized = harness.sanitize_codex_rate_limits(raw)

        self.assertEqual("codex", sanitized["rate_limits"]["limit_id"])
        self.assertEqual(300, sanitized["rate_limits"]["primary"]["window_duration_minutes"])
        serialized = json.dumps(sanitized)
        self.assertNotIn("37", serialized)
        self.assertNotIn("123456", serialized)
        self.assertNotIn("secretish-id", serialized)
        self.assertNotIn("12.5", serialized)
        self.assertNotIn("prolite", serialized)

    def test_subscription_matrix_does_not_confuse_a_successful_call_with_certification(self):
        normalized = {
            "terminal_state": "succeeded",
            "provider_request_ids": [{"name": "openai.response_id", "value": "resp_test"}],
            "attempts": [
                {
                    "physical_completions_observed": 1,
                    "physical_deliveries_proven": False,
                    "sdk_retries_controlled": False,
                }
            ],
            "validation": {
                "native_output_schema_requested": True,
                "local_schema_valid": True,
                "forbidden_tool_absent": True,
            },
        }

        matrix = harness.codex_subscription_conformance_matrix(
            normalized,
            account={"type": "chatgpt", "planType": "prolite"},
            thread_ephemeral=True,
        )

        self.assertTrue(matrix["chatgpt_subscription_auth"]["pass"])
        self.assertTrue(matrix["live_structured_output_and_local_validation"]["pass"])
        self.assertFalse(matrix["provider_request_id_and_usage_on_supported_contract"]["pass"])
        self.assertFalse(matrix["tools_disabled_at_request_boundary"]["pass"])
        self.assertFalse(matrix["sdk_retries_disabled_or_fully_debited"]["pass"])
        self.assertFalse(matrix["provider_application_state_disabled"]["pass"])
        self.assertFalse(matrix["per_call_money_reconciled"]["pass"])
        self.assertFalse(matrix["account_data_policy_attested"]["pass"])
        self.assertFalse(matrix["overall"]["pass"])


class BedrockConverseAdapterTests(unittest.TestCase):
    def setUp(self):
        self.request = load_request()
        self.profile = json.loads(
            (HERE / "fixtures" / "profiles" / "bedrock_runtime_converse.json").read_text()
        )

    def test_maps_the_same_neutral_request_without_tools_or_provider_fields(self):
        mapped = harness.build_bedrock_converse_request(self.request, self.profile)

        self.assertEqual([{"text": self.request["policy_instruction"]["text"]}], mapped["system"])
        self.assertEqual("user", mapped["messages"][0]["role"])
        self.assertEqual(256, mapped["inferenceConfig"]["maxTokens"])
        self.assertNotIn("toolConfig", mapped)
        self.assertNotIn("additionalModelRequestFields", mapped)
        schema_record = mapped["outputConfig"]["textFormat"]["structure"]["jsonSchema"]
        self.assertEqual("json_schema", mapped["outputConfig"]["textFormat"]["type"])
        self.assertEqual(self.request["output_schema"]["schema"], json.loads(schema_record["schema"]))

    def test_normalizes_success_and_exposes_sdk_retry_count(self):
        response = {
            "output": {"message": {"role": "assistant", "content": [{"text": json.dumps(valid_value())}]}},
            "stopReason": "end_turn",
            "usage": {
                "inputTokens": 31,
                "outputTokens": 19,
                "totalTokens": 50,
                "cacheReadInputTokens": 3,
                "cacheWriteInputTokens": 2,
            },
            "metrics": {"latencyMs": 123},
            "ResponseMetadata": {
                "RequestId": "aws-request-test",
                "HTTPStatusCode": 200,
                "RetryAttempts": 0,
            },
        }

        result = harness.normalize_bedrock_response(self.request, self.profile, response)

        self.assertEqual("succeeded", result["terminal_state"])
        self.assertEqual(valid_value(), result["structured_value"])
        self.assertEqual([{"name": "aws.request_id", "value": "aws-request-test"}], result["provider_request_ids"])
        self.assertEqual(1, result["attempts"][0]["physical_deliveries"])
        self.assertEqual(3, result["usage"]["cached_input_read_tokens"])
        self.assertEqual(2, result["usage"]["cache_write_tokens"])

    def test_maps_token_limit_to_incomplete_and_tool_use_to_policy_failure(self):
        base = {
            "output": {"message": {"role": "assistant", "content": [{"text": "{}"}]}},
            "usage": {},
            "ResponseMetadata": {"RequestId": "req", "RetryAttempts": 0},
        }

        truncated = harness.normalize_bedrock_response(self.request, self.profile, base | {"stopReason": "max_tokens"})
        tool_use = harness.normalize_bedrock_response(self.request, self.profile, base | {"stopReason": "tool_use"})

        self.assertEqual("incomplete", truncated["terminal_state"])
        self.assertEqual("failed", tool_use["terminal_state"])
        self.assertEqual("policy_denied", tool_use["error"]["category"])

    def test_boto_client_config_disables_automatic_retries(self):
        self.assertEqual(
            {"retries": {"total_max_attempts": 1, "mode": "standard"}},
            harness.bedrock_botocore_options(),
        )


if __name__ == "__main__":
    unittest.main()
