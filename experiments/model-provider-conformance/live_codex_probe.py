#!/usr/bin/env python3
"""Run one synthetic conformance probe through Codex App Server.

The process uses the Codex-managed ChatGPT OAuth session. It emits only a
sanitized evidence document: account identity, raw event bodies, local paths,
and current quota consumption are never printed.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Any

import harness


HERE = Path(__file__).resolve().parent
DEFAULT_REQUEST = HERE / "fixtures" / "review_request.json"
DEFAULT_PROFILE = HERE / "fixtures" / "profiles" / "openai_codex_subscription.json"


class ProtocolError(RuntimeError):
    """Safe, bounded failure from the local App Server protocol."""


class JsonLineClient:
    """Small synchronous JSON-line client for Codex App Server stdio."""

    _EOF = object()

    def __init__(self, command: list[str], *, env: dict[str, str] | None = None) -> None:
        self._process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            env=env,
        )
        if self._process.stdin is None or self._process.stdout is None:
            raise ProtocolError("Codex App Server stdio was unavailable")
        self._in = self._process.stdin
        self._out = self._process.stdout
        self._incoming: queue.Queue[Any] = queue.Queue()
        self._pending: dict[Any, dict[str, Any]] = {}
        self._next_id = 1
        self.notifications: list[dict[str, Any]] = []
        self.denied_server_requests: list[str] = []
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        try:
            for line in self._out:
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    self._incoming.put(ProtocolError("App Server emitted a non-JSON line"))
                    continue
                if isinstance(message, dict):
                    self._incoming.put(message)
                else:
                    self._incoming.put(ProtocolError("App Server emitted a non-object JSON message"))
        finally:
            self._incoming.put(self._EOF)

    def _send(self, message: dict[str, Any]) -> None:
        if self._process.poll() is not None:
            raise ProtocolError("Codex App Server exited before the request was sent")
        self._in.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
        self._in.flush()

    def notify(self, method: str, params: Any | None = None) -> None:
        message: dict[str, Any] = {"method": method}
        if params is not None:
            message["params"] = params
        self._send(message)

    def request(self, method: str, params: Any, timeout: float) -> dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        self._send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout

        while True:
            if request_id in self._pending:
                return self._response_result(method, self._pending.pop(request_id))
            message = self._receive(deadline)
            if "method" in message and "id" in message:
                self._deny_server_request(message)
            elif "method" in message:
                self.notifications.append(message)
            elif "id" in message:
                response_id = message["id"]
                if response_id == request_id:
                    return self._response_result(method, message)
                self._pending[response_id] = message

    def wait_for_notification(self, method: str, timeout: float) -> dict[str, Any]:
        for notification in self.notifications:
            if notification.get("method") == method:
                return notification

        deadline = time.monotonic() + timeout
        while True:
            message = self._receive(deadline)
            if "method" in message and "id" in message:
                self._deny_server_request(message)
            elif "method" in message:
                self.notifications.append(message)
                if message.get("method") == method:
                    return message
            elif "id" in message:
                self._pending[message["id"]] = message

    def _receive(self, deadline: float) -> dict[str, Any]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProtocolError("Timed out waiting for Codex App Server")
        try:
            message = self._incoming.get(timeout=remaining)
        except queue.Empty as error:
            raise ProtocolError("Timed out waiting for Codex App Server") from error
        if message is self._EOF:
            raise ProtocolError("Codex App Server closed its output")
        if isinstance(message, Exception):
            raise message
        return message

    def _deny_server_request(self, message: dict[str, Any]) -> None:
        method = str(message.get("method", "unknown"))
        self.denied_server_requests.append(method)
        self._send(
            {
                "id": message["id"],
                "error": {
                    "code": -32601,
                    "message": "Kestrel conformance probe denies all server-initiated requests",
                },
            }
        )

    @staticmethod
    def _response_result(method: str, response: dict[str, Any]) -> dict[str, Any]:
        error = response.get("error")
        if isinstance(error, dict):
            code = error.get("code")
            message = str(error.get("message", "unknown error"))[:240]
            raise ProtocolError(f"{method} failed ({code}): {message}")
        result = response.get("result")
        if not isinstance(result, dict):
            raise ProtocolError(f"{method} returned a non-object result")
        return result

    def close(self) -> None:
        if self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=3)

    def __enter__(self) -> "JsonLineClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


def sanitize_account(raw: Any) -> dict[str, Any]:
    """Keep authentication evidence while dropping account identity and tier."""

    response = raw if isinstance(raw, dict) else {}
    account = response.get("account") if isinstance(response.get("account"), dict) else response
    account_type = account.get("type") if isinstance(account, dict) else None
    plan_type = account.get("planType") if isinstance(account, dict) else None
    return {
        "authenticated": account_type in {"chatgpt", "apiKey"},
        "type": account_type,
        "plan_type_present": isinstance(plan_type, str) and bool(plan_type),
        "requires_openai_auth": response.get("requiresOpenaiAuth") is True,
        "identity_fields_removed": True,
    }


def sanitize_initialize(raw: Any) -> dict[str, Any]:
    """Retain compatibility facts without publishing paths or OS versions."""

    response = raw if isinstance(raw, dict) else {}
    return {
        "platform_family": response.get("platformFamily"),
        "platform_os": response.get("platformOs"),
        "user_agent_present": isinstance(response.get("userAgent"), str),
        "local_paths_removed": True,
    }


def prepare_isolated_codex_home(source: Path, target: Path) -> None:
    """Copy only the OAuth material into a private, disposable Codex home."""

    source_auth = source / "auth.json"
    if not source_auth.is_file():
        raise ProtocolError("Codex OAuth auth.json is unavailable for an isolated probe")
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    target.chmod(0o700)
    target_auth = target / "auth.json"
    shutil.copyfile(source_auth, target_auth)
    target_auth.chmod(0o600)


def account_record(raw: Any) -> dict[str, Any]:
    response = raw if isinstance(raw, dict) else {}
    account = response.get("account")
    return account if isinstance(account, dict) else response


def summarize_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Summarize protocol controls without retaining event payloads."""

    method_counts: Counter[str] = Counter()
    item_type_counts: Counter[str] = Counter()
    raw_completion = False
    terminal_status: Any = None
    hook_event_count = 0
    mcp_startup_status_event_count = 0
    remote_control_status_event_count = 0
    for event in events:
        method = event.get("method")
        if isinstance(method, str):
            method_counts[method] += 1
        params = event.get("params") if isinstance(event.get("params"), dict) else {}
        if method == "item/completed":
            item = params.get("item") if isinstance(params.get("item"), dict) else {}
            item_type = item.get("type")
            if isinstance(item_type, str):
                item_type_counts[item_type] += 1
        if isinstance(method, str) and "rawresponse" in method.replace("_", "").lower() and "completed" in method.lower():
            raw_completion = True
        if isinstance(method, str) and method.startswith("hook/"):
            hook_event_count += 1
        if isinstance(method, str) and method.startswith("mcpServer/startupStatus/"):
            mcp_startup_status_event_count += 1
        if isinstance(method, str) and method.startswith("remoteControl/status/"):
            remote_control_status_event_count += 1
        if method == "turn/completed":
            turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
            terminal_status = turn.get("status")
    return {
        "total": len(events),
        "method_counts": dict(sorted(method_counts.items())),
        "item_type_counts": dict(sorted(item_type_counts.items())),
        "raw_response_completion_observed": raw_completion,
        "terminal_turn_status": terminal_status,
        "ambient_runtime_activity": {
            "observed": any((hook_event_count, mcp_startup_status_event_count, remote_control_status_event_count)),
            "hook_event_count": hook_event_count,
            "mcp_startup_status_event_count": mcp_startup_status_event_count,
            "remote_control_status_event_count": remote_control_status_event_count,
        },
        "payloads_removed": True,
    }


def select_model_evidence(catalog: Any, requested_id: str) -> dict[str, Any]:
    data = catalog.get("data") if isinstance(catalog, dict) else None
    if not isinstance(data, list):
        raise ProtocolError("model/list returned no model catalog")
    for model in data:
        if not isinstance(model, dict) or model.get("id") != requested_id:
            continue
        return {
            "id": model.get("id"),
            "model": model.get("model"),
            "is_default": model.get("isDefault") is True,
            "hidden": model.get("hidden") is True,
            "default_reasoning_effort": model.get("defaultReasoningEffort"),
            "input_modalities": model.get("inputModalities", []),
        }
    raise ProtocolError(f"Requested model {requested_id!r} is absent from the subscription catalog")


def _codex_version() -> str:
    completed = subprocess.run(
        ["codex", "--version"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=10,
    )
    return completed.stdout.strip()


def run_probe(request: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    validation_errors = harness.validate_model_request(request)
    if validation_errors:
        raise ProtocolError("Neutral request fixture failed local validation")
    if shutil.which("codex") is None:
        raise ProtocolError("The codex executable is unavailable")

    timeout = float(profile.get("limits", {}).get("timeout_seconds", 120))
    started_at = time.monotonic()
    configured_codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    with (
        tempfile.TemporaryDirectory(prefix="kestrel-model-probe-") as probe_dir,
        tempfile.TemporaryDirectory(prefix="kestrel-codex-home-") as isolated_home,
    ):
        prepare_isolated_codex_home(configured_codex_home, Path(isolated_home))
        isolated_env = os.environ.copy()
        isolated_env["CODEX_HOME"] = isolated_home
        with JsonLineClient(["codex", "app-server", "--stdio"], env=isolated_env) as client:
            initialized = client.request(
                "initialize",
                {
                    "clientInfo": {
                        "name": "kestrel-model-provider-conformance",
                        "title": "Kestrel model provider conformance",
                        "version": "1",
                    },
                    "capabilities": {"experimentalApi": True},
                },
                timeout=10,
            )
            client.notify("initialized")
            account = client.request("account/read", {"refreshToken": False}, timeout=15)
            if account_record(account).get("type") != "chatgpt":
                raise ProtocolError("Codex is not authenticated with a ChatGPT subscription")
            rate_limits = client.request("account/rateLimits/read", None, timeout=15)
            catalog = client.request("model/list", {"includeHidden": False}, timeout=15)
            selected_model = select_model_evidence(catalog, profile["target"]["requested_id"])

            thread_params = harness.build_codex_thread_start(request, profile, probe_dir)
            thread_response = client.request("thread/start", thread_params, timeout=20)
            thread = thread_response.get("thread")
            if not isinstance(thread, dict) or not isinstance(thread.get("id"), str):
                raise ProtocolError("thread/start returned no thread identifier")

            remaining = max(1.0, timeout - (time.monotonic() - started_at))
            client.request(
                "turn/start",
                harness.build_codex_turn_start(request, thread["id"]),
                timeout=min(20.0, remaining),
            )
            remaining = max(1.0, timeout - (time.monotonic() - started_at))
            client.wait_for_notification("turn/completed", timeout=remaining)

            events = list(client.notifications)
            result = harness.normalize_codex_events(request, profile, events)
            result["resolved_target"] = {
                "model": thread_response.get("model"),
                "model_provider": thread_response.get("modelProvider"),
                "service_tier": thread_response.get("serviceTier"),
            }
            matrix = harness.codex_subscription_conformance_matrix(
                result,
                account=account_record(account),
                thread_ephemeral=thread_params["ephemeral"],
            )
            return {
                "evidence_version": "kestrel.model-provider-conformance-evidence/1",
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "surface": {
                    "kind": "codex_app_server_chatgpt_subscription",
                    "cli_version": _codex_version(),
                    "app_server": sanitize_initialize(initialized),
                    "synthetic_input_only": True,
                    "empty_ephemeral_working_directory": True,
                    "isolated_codex_home": True,
                    "global_config_plugins_hooks_and_history_copied": False,
                },
                "authentication": sanitize_account(account),
                "selected_model": selected_model,
                "quota_shape": harness.sanitize_codex_rate_limits(rate_limits),
                "thread_controls": {
                    "approval_policy": thread_params["approvalPolicy"],
                    "sandbox": thread_params["sandbox"],
                    "ephemeral": thread_params["ephemeral"],
                    "provider_fallback_allowed": thread_params["allowProviderModelFallback"],
                    "dynamic_tools_count": len(thread_params["dynamicTools"]),
                    "environments_count": len(thread_params["environments"]),
                    "selected_capability_roots_count": len(thread_params["selectedCapabilityRoots"]),
                    "experimental_raw_events_requested": thread_params["experimentalRawEvents"],
                    "server_requests_denied": sorted(client.denied_server_requests),
                },
                "event_summary": summarize_events(events),
                "normalized_result": result,
                "conformance_matrix": matrix,
            }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, default=DEFAULT_REQUEST)
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    args = parser.parse_args()

    request = json.loads(args.request.read_text())
    profile = json.loads(args.profile.read_text())
    evidence = run_probe(request, profile)
    print(json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
