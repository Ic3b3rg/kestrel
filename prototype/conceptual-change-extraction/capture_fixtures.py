#!/usr/bin/env python3
"""Capture immutable public GitHub inputs for the throwaway prototype."""

from __future__ import annotations

import base64
import datetime as dt
import json
import subprocess
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
CASES = (
    ("small-behavior", "cli/cli", 14094),
    ("large-cross-cutting", "cli/cli", 14104),
    ("docs-only", "github/docs", 40756),
)
MANIFEST_NAMES = (
    "go.mod",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "mix.exs",
)


def gh(path: str) -> Any:
    result = subprocess.run(
        [
            "gh",
            "api",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "X-GitHub-Api-Version: 2026-03-10",
            path,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def decoded_content(payload: dict[str, Any], limit: int) -> dict[str, Any]:
    raw = base64.b64decode(payload.get("content", "")).decode("utf-8", "replace")
    return {
        "path": payload.get("path"),
        "sha": payload.get("sha"),
        "source_chars": len(raw),
        "truncated": len(raw) > limit,
        "content": raw[:limit],
    }


def capture(slug: str, repo: str, number: int) -> dict[str, Any]:
    pull = gh(f"repos/{repo}/pulls/{number}")
    head = pull["head"]["sha"]
    base = pull["base"]["sha"]
    files = gh(f"repos/{repo}/pulls/{number}/files?per_page=100")
    issue_comments = gh(f"repos/{repo}/issues/{number}/comments?per_page=100")
    review_comments = gh(f"repos/{repo}/pulls/{number}/comments?per_page=100")
    reviews = gh(f"repos/{repo}/pulls/{number}/reviews?per_page=100")
    checks = gh(f"repos/{repo}/commits/{head}/check-runs?per_page=100")
    statuses = gh(f"repos/{repo}/commits/{head}/status")
    repository = gh(f"repos/{repo}")
    languages = gh(f"repos/{repo}/languages")
    root_tree = gh(f"repos/{repo}/git/trees/{base}")

    try:
        readme = decoded_content(gh(f"repos/{repo}/readme?ref={base}"), 16_000)
    except subprocess.CalledProcessError:
        readme = None

    root_names = {entry["path"] for entry in root_tree.get("tree", [])}
    manifests = []
    for name in MANIFEST_NAMES:
        if name not in root_names:
            continue
        manifests.append(decoded_content(gh(f"repos/{repo}/contents/{name}?ref={base}"), 24_000))

    normalized_files = [
        {
            "path": item["filename"],
            "status": item["status"],
            "additions": item["additions"],
            "deletions": item["deletions"],
            "changes": item["changes"],
            "blob_url": item["blob_url"],
            "raw_url": item["raw_url"],
            "patch": item.get("patch"),
        }
        for item in files
    ]

    return {
        "fixture_version": 1,
        "case": slug,
        "captured_at": dt.datetime.now(dt.UTC).isoformat(),
        "source": {
            "repository": repo,
            "pull_number": number,
            "url": pull["html_url"],
            "state": pull["state"],
            "draft": pull["draft"],
            "merged": pull["merged"],
            "author": pull["user"]["login"],
            "title": pull["title"],
            "body": pull.get("body") or "",
            "base_sha": base,
            "head_sha": head,
            "base_ref": pull["base"]["ref"],
            "head_ref": pull["head"]["ref"],
            "additions": pull["additions"],
            "deletions": pull["deletions"],
            "changed_files": pull["changed_files"],
        },
        "files": normalized_files,
        "conversation_comments": [
            {
                "id": item["id"],
                "author": item["user"]["login"],
                "association": item["author_association"],
                "body": item.get("body") or "",
                "created_at": item["created_at"],
                "url": item["html_url"],
            }
            for item in issue_comments
        ],
        "review_comments": [
            {
                "id": item["id"],
                "author": item["user"]["login"],
                "association": item["author_association"],
                "path": item["path"],
                "line": item.get("line"),
                "original_line": item.get("original_line"),
                "side": item.get("side"),
                "body": item.get("body") or "",
                "created_at": item["created_at"],
                "url": item["html_url"],
            }
            for item in review_comments
        ],
        "reviews": [
            {
                "id": item["id"],
                "author": item["user"]["login"],
                "association": item["author_association"],
                "state": item["state"],
                "body": item.get("body") or "",
                "submitted_at": item.get("submitted_at"),
                "url": item["html_url"],
            }
            for item in reviews
        ],
        "test_evidence": {
            "check_runs": [
                {
                    "id": item["id"],
                    "name": item["name"],
                    "status": item["status"],
                    "conclusion": item.get("conclusion"),
                    "started_at": item.get("started_at"),
                    "completed_at": item.get("completed_at"),
                    "details_url": item.get("details_url"),
                    "app": (item.get("app") or {}).get("slug"),
                }
                for item in checks.get("check_runs", [])
            ],
            "commit_status": {
                "state": statuses.get("state"),
                "statuses": [
                    {
                        "id": item["id"],
                        "context": item["context"],
                        "state": item["state"],
                        "target_url": item.get("target_url"),
                        "description": item.get("description"),
                    }
                    for item in statuses.get("statuses", [])
                ],
            },
        },
        "repository_context": {
            "id": repository["id"],
            "description": repository.get("description"),
            "default_branch": repository["default_branch"],
            "primary_language": repository.get("language"),
            "languages": languages,
            "topics": repository.get("topics", []),
            "root_tree": [
                {"path": item["path"], "mode": item["mode"], "type": item["type"], "sha": item["sha"]}
                for item in root_tree.get("tree", [])
            ],
            "readme": readme,
            "manifests": manifests,
        },
        "capture_coverage": {
            "files_returned": len(normalized_files),
            "files_without_patch": sum(1 for item in normalized_files if item["patch"] is None),
            "patch_chars": sum(len(item["patch"] or "") for item in normalized_files),
            "full_changed_sources_captured": False,
            "note": "Changed-file patches and shallow root context only; no full checkout.",
        },
    }


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for slug, repo, number in CASES:
        payload = capture(slug, repo, number)
        destination = FIXTURES / f"{slug}.json"
        destination.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
        source = payload["source"]
        print(f"captured {repo}#{number} {source['base_sha'][:7]}..{source['head_sha'][:7]} -> {destination}")


if __name__ == "__main__":
    main()
