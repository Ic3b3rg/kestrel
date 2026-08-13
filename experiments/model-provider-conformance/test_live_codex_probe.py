import json
import stat
import tempfile
import unittest
from pathlib import Path

import harness
import live_codex_probe


class CodexEvidenceSanitizationTests(unittest.TestCase):
    def test_published_live_evidence_is_sanitized_and_fail_closed(self):
        evidence_path = Path(__file__).resolve().parent / "evidence" / "openai-codex-subscription-2026-08-13.json"
        evidence = json.loads(evidence_path.read_text())
        root = evidence_path.parent.parent
        request = json.loads((root / "fixtures" / "review_request.json").read_text())
        profile = json.loads((root / "fixtures" / "profiles" / "openai_codex_subscription.json").read_text())

        self.assertEqual("chatgpt", evidence["authentication"]["type"])
        self.assertEqual(2, evidence["capture"]["total_model_calls_during_development"])
        self.assertEqual(1, evidence["capture"]["published_isolated_model_calls"])
        self.assertEqual("succeeded", evidence["normalized_result"]["terminal_state"])
        self.assertTrue(evidence["normalized_result"]["validation"]["local_schema_valid"])
        self.assertEqual(1, evidence["normalized_result"]["attempts"][0]["physical_completions_observed"])
        self.assertEqual(harness.sha256_json(request), evidence["normalized_result"]["request_digest"])
        self.assertEqual(
            harness.sha256_json(profile), evidence["normalized_result"]["profile_snapshot"]["digest"]
        )
        self.assertFalse(evidence["conformance_matrix"]["overall"]["pass"])
        serialized = json.dumps(evidence)
        self.assertNotIn("prolite", serialized)
        self.assertNotIn("/Users/", serialized)
        self.assertNotIn("26.5.1", serialized)
        self.assertNotIn("@", serialized)

    def test_sanitizes_initialize_response_without_local_paths_or_os_version(self):
        raw = {
            "codexHome": "/Users/private/.codex",
            "platformFamily": "unix",
            "platformOs": "macos",
            "userAgent": "codex/0.146.0 (Mac OS 26.5.1; arm64)",
        }

        sanitized = live_codex_probe.sanitize_initialize(raw)

        self.assertEqual("unix", sanitized["platform_family"])
        self.assertEqual("macos", sanitized["platform_os"])
        self.assertTrue(sanitized["user_agent_present"])
        serialized = json.dumps(sanitized)
        self.assertNotIn("/Users/private", serialized)
        self.assertNotIn("26.5.1", serialized)

    def test_isolated_codex_home_copies_only_the_oauth_file(self):
        with tempfile.TemporaryDirectory() as source_dir, tempfile.TemporaryDirectory() as target_dir:
            source = Path(source_dir)
            target = Path(target_dir)
            (source / "auth.json").write_text('{"tokens":"synthetic"}')
            (source / "config.toml").write_text('[mcp_servers.private]\nenabled = true\n')
            (source / "AGENTS.md").write_text("private instructions")

            live_codex_probe.prepare_isolated_codex_home(source, target)

            self.assertEqual(["auth.json"], sorted(path.name for path in target.iterdir()))
            self.assertEqual('{"tokens":"synthetic"}', (target / "auth.json").read_text())
            self.assertEqual(0o600, stat.S_IMODE((target / "auth.json").stat().st_mode))

    def test_sanitizes_account_without_identity_or_subscription_tier(self):
        raw = {
            "account": {
                "type": "chatgpt",
                "email": "operator@example.test",
                "planType": "prolite",
            },
            "requiresOpenaiAuth": True,
        }

        sanitized = live_codex_probe.sanitize_account(raw)

        self.assertEqual("chatgpt", sanitized["type"])
        self.assertTrue(sanitized["authenticated"])
        self.assertTrue(sanitized["plan_type_present"])
        serialized = json.dumps(sanitized)
        self.assertNotIn("operator@example.test", serialized)
        self.assertNotIn("prolite", serialized)

    def test_event_summary_retains_control_signals_but_not_content(self):
        events = [
            {
                "method": "item/completed",
                "params": {
                    "item": {
                        "id": "msg-sensitive-id",
                        "type": "agentMessage",
                        "text": "synthetic model content",
                    }
                },
            },
            {
                "method": "rawResponse/completed",
                "params": {
                    "responseId": "resp-sensitive-id",
                    "usage": {"inputTokens": 12},
                },
            },
            {
                "method": "turn/completed",
                "params": {"turn": {"id": "turn-sensitive-id", "status": "completed"}},
            },
            {"method": "hook/started", "params": {"hookName": "private-hook-name"}},
            {"method": "mcpServer/startupStatus/updated", "params": {"server": "private-server-name"}},
        ]

        summary = live_codex_probe.summarize_events(events)

        self.assertEqual(5, summary["total"])
        self.assertEqual(1, summary["method_counts"]["item/completed"])
        self.assertEqual({"agentMessage": 1}, summary["item_type_counts"])
        self.assertTrue(summary["raw_response_completion_observed"])
        self.assertEqual("completed", summary["terminal_turn_status"])
        self.assertTrue(summary["ambient_runtime_activity"]["observed"])
        self.assertEqual(1, summary["ambient_runtime_activity"]["hook_event_count"])
        self.assertEqual(1, summary["ambient_runtime_activity"]["mcp_startup_status_event_count"])
        serialized = json.dumps(summary)
        self.assertNotIn("synthetic model content", serialized)
        self.assertNotIn("sensitive-id", serialized)
        self.assertNotIn("private-hook-name", serialized)
        self.assertNotIn("private-server-name", serialized)

    def test_selected_model_evidence_is_bounded(self):
        catalog = {
            "data": [
                {
                    "id": "gpt-5.6-sol",
                    "model": "gpt-5.6-sol",
                    "displayName": "GPT-5.6 Codex",
                    "isDefault": True,
                    "hidden": False,
                    "defaultReasoningEffort": "medium",
                    "inputModalities": ["text", "image"],
                    "description": "long mutable prose not needed as evidence",
                },
                {"id": "another-model", "model": "another-model"},
            ]
        }

        selected = live_codex_probe.select_model_evidence(catalog, "gpt-5.6-sol")

        self.assertEqual("gpt-5.6-sol", selected["id"])
        self.assertEqual(["text", "image"], selected["input_modalities"])
        self.assertNotIn("description", selected)
        self.assertNotIn("another-model", json.dumps(selected))


if __name__ == "__main__":
    unittest.main()
