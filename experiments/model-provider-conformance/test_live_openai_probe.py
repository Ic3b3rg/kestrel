import json
from datetime import date
import unittest
from pathlib import Path

import harness
import live_openai_probe
import openai_responses_adapter as openai_adapter


HERE = Path(__file__).resolve().parent


def load_fixture(name):
    return json.loads((HERE / name).read_text())


class OpenAILiveProbeTests(unittest.TestCase):
    def setUp(self):
        self.request = load_fixture("fixtures/review_request.json")
        self.profile = load_fixture("fixtures/profiles/openai_platform_responses.json")
        self.env = {
            "OPENAI_API_KEY": "sk-synthetic-never-send",
            "OPENAI_PROJECT_ID": "proj_synthetic",
            "KESTREL_OPENAI_CREDENTIAL_ATTESTATION": "project_service_account",
            "KESTREL_OPENAI_DATA_POLICY_ATTESTATION_SHA256": "sha256:" + "a" * 64,
            "KESTREL_PROBE_COST_CAP_USD": "0.10",
        }
        self.today = date(2026, 8, 16)

    def test_published_preflight_is_bound_to_current_request_profile_and_mapping(self):
        evidence = load_fixture("evidence/openai-platform-preflight-2026-08-16.json")
        mapped = openai_adapter.build_request(self.request, self.profile)

        self.assertFalse(evidence["live_request_sent"])
        self.assertEqual(harness.sha256_json(self.request), evidence["synthetic_request_digest"])
        self.assertEqual(harness.sha256_json(self.profile), evidence["profile_digest"])
        self.assertEqual(harness.sha256_json(mapped), evidence["mapped_request_digest"])
        self.assertEqual([], evidence["local_discovery"]["recognized_openai_credential_environment_names_present"])

    def test_published_two_surface_matrix_is_explicitly_blocked_on_live_evidence(self):
        matrix = load_fixture("evidence/two-surface-matrix-2026-08-16.json")
        bedrock_profile = load_fixture("fixtures/profiles/bedrock_runtime_converse.json")

        self.assertEqual(harness.sha256_json(self.request), matrix["synthetic_request_digest"])
        self.assertEqual(
            harness.sha256_json(self.profile),
            matrix["surfaces"]["openai_platform_responses"]["profile_digest"],
        )
        self.assertEqual(
            harness.sha256_json(bedrock_profile),
            matrix["surfaces"]["amazon_bedrock_converse"]["profile_digest"],
        )
        self.assertIn("blocked", matrix["overall"])

    def test_one_shot_probe_is_stateless_capped_and_sanitized(self):
        calls = []

        def transport(url, headers, body, timeout, max_response_bytes):
            calls.append((url, headers, json.loads(body), timeout, max_response_bytes))
            response = {
                "id": "resp_test",
                "status": "completed",
                "model": "gpt-5.6-luna",
                "service_tier": "default",
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": json.dumps(
                                    {
                                        "summary": "Boundary probe",
                                        "risk_level": "low",
                                        "score": 1.5,
                                        "finding_count": 0,
                                        "reviewable": True,
                                        "concepts": [{"name": "retry policy", "changed": True}],
                                    }
                                ),
                            }
                        ],
                    }
                ],
                "usage": {"input_tokens": 40, "output_tokens": 20, "total_tokens": 60},
            }
            return 200, {"x-request-id": "req_test"}, json.dumps(response).encode()

        evidence = live_openai_probe.run_probe(
            self.request, self.profile, env=self.env, transport=transport, today=self.today
        )

        self.assertEqual(1, len(calls))
        url, headers, mapped, timeout, max_response_bytes = calls[0]
        self.assertEqual("https://api.openai.com/v1/responses", url)
        self.assertEqual("Bearer sk-synthetic-never-send", headers["Authorization"])
        self.assertEqual("proj_synthetic", headers["OpenAI-Project"])
        self.assertFalse(mapped["store"])
        self.assertEqual([], mapped["tools"])
        self.assertEqual(120, timeout)
        self.assertEqual(1048576, max_response_bytes)
        self.assertEqual("succeeded", evidence["normalized_result"]["terminal_state"])
        self.assertEqual(1, evidence["capture"]["model_requests"])
        self.assertEqual("within_cap", evidence["cost"]["preflight_status"])
        self.assertEqual("estimated_from_provider_usage", evidence["cost"]["post_call_status"])
        self.assertTrue(evidence["conformance_matrix"]["overall"]["pass"])
        self.assertEqual(
            "sha256:" + "a" * 64, evidence["data_policy"]["attestation_digest"]
        )
        serialized = json.dumps(evidence)
        self.assertNotIn("sk-synthetic-never-send", serialized)
        self.assertNotIn("proj_synthetic", serialized)

    def test_fails_closed_before_transport_for_wrong_origin_or_cost_cap(self):
        called = False

        def transport(*_args):
            nonlocal called
            called = True
            raise AssertionError("transport must not run")

        wrong_origin = json.loads(json.dumps(self.profile))
        wrong_origin["surface"]["https_origin"] = "https://example.test"
        with self.assertRaises(live_openai_probe.PreflightError):
            live_openai_probe.run_probe(
                self.request, wrong_origin, env=self.env, transport=transport, today=self.today
            )

        expired = json.loads(json.dumps(self.profile))
        expired["attestation"]["expires_on"] = "2026-08-15"
        with self.assertRaises(live_openai_probe.PreflightError):
            live_openai_probe.run_probe(
                self.request, expired, env=self.env, transport=transport, today=self.today
            )

        low_cap = self.env | {"KESTREL_PROBE_COST_CAP_USD": "0.0000001"}
        with self.assertRaises(live_openai_probe.PreflightError):
            live_openai_probe.run_probe(
                self.request, self.profile, env=low_cap, transport=transport, today=self.today
            )
        self.assertFalse(called)

    def test_post_delivery_transport_failure_is_not_retried(self):
        calls = 0

        def transport(*_args):
            nonlocal calls
            calls += 1
            raise live_openai_probe.TransportFailure("synthetic interruption", delivered=True)

        evidence = live_openai_probe.run_probe(
            self.request, self.profile, env=self.env, transport=transport, today=self.today
        )

        self.assertEqual(1, calls)
        result = evidence["normalized_result"]
        self.assertEqual("outcome_unknown", result["terminal_state"])
        self.assertEqual("never", result["error"]["retryability"])
        self.assertEqual("pending_unknown_usage", evidence["cost"]["post_call_status"])
        self.assertFalse(evidence["conformance_matrix"]["overall"]["pass"])


if __name__ == "__main__":
    unittest.main()
