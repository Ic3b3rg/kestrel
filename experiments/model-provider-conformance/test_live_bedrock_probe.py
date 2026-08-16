import json
from datetime import date
import unittest
from pathlib import Path

import harness
import live_bedrock_probe


HERE = Path(__file__).resolve().parent


def load_fixture(name):
    return json.loads((HERE / name).read_text())


class BedrockLiveProbeTests(unittest.TestCase):
    def setUp(self):
        self.request = load_fixture("fixtures/review_request.json")
        self.profile = load_fixture("fixtures/profiles/bedrock_runtime_converse.json")
        self.env = {
            "KESTREL_EXPECTED_AWS_ACCOUNT_ID": "123456789012",
            "KESTREL_EXPECTED_AWS_ROLE_NAME": "kestrel-conformance",
            "KESTREL_AWS_DATA_POLICY_ATTESTATION": "invocation_logging_disabled_synthetic_only",
            "KESTREL_AWS_DATA_POLICY_ATTESTATION_SHA256": "sha256:" + "b" * 64,
            "KESTREL_PROBE_COST_CAP_USD": "0.10",
        }
        self.today = date(2026, 8, 16)

    def test_published_preflight_is_bound_to_current_request_profile_and_mapping(self):
        evidence = load_fixture("evidence/bedrock-preflight-2026-08-16.json")
        mapped = harness.build_bedrock_converse_request(self.request, self.profile)

        self.assertFalse(evidence["live_request_sent"])
        self.assertEqual(harness.sha256_json(self.request), evidence["synthetic_request_digest"])
        self.assertEqual(harness.sha256_json(self.profile), evidence["profile_digest"])
        self.assertEqual(harness.sha256_json(mapped), evidence["mapped_request_digest"])
        self.assertEqual(
            [], evidence["local_discovery"]["recognized_credential_or_scope_environment_names_present"]
        )

    def live_context(
        self,
        converse,
        *,
        identity=None,
        runtime_endpoint="https://bedrock-runtime.eu-west-1.amazonaws.com",
        logging_configuration=None,
        destination_regions=None,
    ):
        identity = identity or {
            "Account": "123456789012",
            "Arn": "arn:aws:sts::123456789012:assumed-role/kestrel-conformance/probe-session",
        }
        regions = destination_regions or self.profile["route"]["approved_processing_regions"]
        model_id = self.profile["target"]["requested_id"].removeprefix("eu.")
        inference_profile = {
            "inferenceProfileId": self.profile["target"]["requested_id"],
            "status": "ACTIVE",
            "type": "SYSTEM_DEFINED",
            "models": [
                {"modelArn": f"arn:aws:bedrock:{region}::foundation-model/{model_id}"}
                for region in regions
            ],
        }
        return live_bedrock_probe.LiveContext(
            identity=identity,
            control_endpoint="https://bedrock.eu-west-1.amazonaws.com",
            runtime_endpoint=runtime_endpoint,
            logging_configuration={} if logging_configuration is None else logging_configuration,
            inference_profile=inference_profile,
            converse=converse,
        )

    def test_one_shot_probe_verifies_role_route_and_sanitizes_identity(self):
        calls = []

        def live_session(profile):
            def converse(mapped):
                calls.append((profile, mapped))
                return {
                    "output": {
                        "message": {
                            "role": "assistant",
                            "content": [
                                {
                                    "text": json.dumps(
                                        {
                                            "summary": "Boundary probe",
                                            "risk_level": "low",
                                            "score": 1.5,
                                            "finding_count": 0,
                                            "reviewable": True,
                                            "concepts": [{"name": "retry policy", "changed": True}],
                                        }
                                    )
                                }
                            ],
                        }
                    },
                    "stopReason": "end_turn",
                    "usage": {"inputTokens": 40, "outputTokens": 20, "totalTokens": 60},
                    "ResponseMetadata": {"RequestId": "aws_req_test", "RetryAttempts": 0},
                }

            return self.live_context(converse)

        evidence = live_bedrock_probe.run_probe(
            self.request, self.profile, env=self.env, live_session=live_session, today=self.today
        )

        self.assertEqual(1, len(calls))
        _, mapped = calls[0]
        self.assertNotIn("toolConfig", mapped)
        self.assertEqual("json_schema", mapped["outputConfig"]["textFormat"]["type"])
        self.assertEqual("succeeded", evidence["normalized_result"]["terminal_state"])
        self.assertEqual(1, evidence["capture"]["logical_model_invocations"])
        self.assertEqual(1, evidence["capture"]["physical_model_deliveries"])
        self.assertTrue(evidence["data_policy"]["model_invocation_logging_disabled"])
        self.assertTrue(evidence["route_attestation"]["destination_set_matches_profile"])
        self.assertTrue(evidence["conformance_matrix"]["overall"]["pass"])
        self.assertEqual("within_cap", evidence["cost"]["preflight_status"])
        serialized = json.dumps(evidence)
        self.assertNotIn("123456789012", serialized)
        self.assertNotIn("probe-session", serialized)

    def test_fails_before_model_call_for_principal_or_route_mismatch(self):
        model_calls = 0

        def must_not_invoke(_mapped):
            nonlocal model_calls
            model_calls += 1
            raise AssertionError("model must not be invoked")

        def wrong_principal(_profile):
            return self.live_context(
                must_not_invoke,
                identity={
                    "Account": "999999999999",
                    "Arn": "arn:aws:sts::999999999999:assumed-role/wrong/session",
                },
            )

        with self.assertRaises(live_bedrock_probe.PreflightError):
            live_bedrock_probe.run_probe(
                self.request,
                self.profile,
                env=self.env,
                live_session=wrong_principal,
                today=self.today,
            )
        self.assertEqual(0, model_calls)

        def wrong_route(_profile):
            return self.live_context(must_not_invoke, runtime_endpoint="https://attacker.invalid")

        with self.assertRaises(live_bedrock_probe.PreflightError):
            live_bedrock_probe.run_probe(
                self.request, self.profile, env=self.env, live_session=wrong_route, today=self.today
            )
        self.assertEqual(0, model_calls)

    def test_fails_before_model_call_for_logging_or_inference_profile_drift(self):
        model_calls = 0

        def must_not_invoke(_mapped):
            nonlocal model_calls
            model_calls += 1
            raise AssertionError("model must not be invoked")

        def logging_enabled(_profile):
            return self.live_context(
                must_not_invoke,
                logging_configuration={"loggingConfig": {"textDataDeliveryEnabled": True}},
            )

        with self.assertRaises(live_bedrock_probe.PreflightError):
            live_bedrock_probe.run_probe(
                self.request, self.profile, env=self.env, live_session=logging_enabled, today=self.today
            )

        def route_drift(_profile):
            return self.live_context(must_not_invoke, destination_regions=["eu-west-1"])

        with self.assertRaises(live_bedrock_probe.PreflightError):
            live_bedrock_probe.run_probe(
                self.request, self.profile, env=self.env, live_session=route_drift, today=self.today
            )
        self.assertEqual(0, model_calls)

    def test_post_delivery_transport_failure_is_not_retried(self):
        calls = 0

        def interrupted_session(_profile):
            def converse(_mapped):
                nonlocal calls
                calls += 1
                raise live_bedrock_probe.BedrockTransportFailure("synthetic interruption", delivered=True)

            return self.live_context(converse)

        evidence = live_bedrock_probe.run_probe(
            self.request,
            self.profile,
            env=self.env,
            live_session=interrupted_session,
            today=self.today,
        )

        self.assertEqual(1, calls)
        result = evidence["normalized_result"]
        self.assertEqual("outcome_unknown", result["terminal_state"])
        self.assertEqual("never", result["error"]["retryability"])
        self.assertFalse(evidence["conformance_matrix"]["overall"]["pass"])


if __name__ == "__main__":
    unittest.main()
