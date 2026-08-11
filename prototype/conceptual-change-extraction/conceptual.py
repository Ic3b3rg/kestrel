"""Pure transformation logic for the throwaway conceptual extraction prototype."""

from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import PurePosixPath
from typing import Any, Iterable


MODEL_CONTEXT_BUDGET_CHARS = 120_000
DOC_SUFFIXES = {".md", ".mdx", ".rst", ".adoc"}
RISK_LEVELS = {"Critical", "High", "Medium", "Low"}
CLAIM_BASES = {"Deterministic", "Model Judgment"}
EVIDENCE_SUFFICIENCY = {"Sufficient", "Limited"}
BEHAVIOR_VERBS = {
    "adapt",
    "attach",
    "build",
    "deliver",
    "evaluate",
    "exercise",
    "expose",
    "fail",
    "fetch",
    "interpret",
    "invoke",
    "observe",
    "read",
    "report",
    "resolve",
    "retry",
    "route",
    "send",
    "wait",
}
STOPWORDS = {
    "a",
    "an",
    "and",
    "as",
    "at",
    "for",
    "from",
    "in",
    "into",
    "of",
    "on",
    "or",
    "the",
    "through",
    "to",
    "with",
}


def digest(value: str, length: int = 12) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def tokenize(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", value.lower())
        if len(token) > 1 and token not in STOPWORDS
    }


def jaccard(left: set[str], right: set[str]) -> float:
    if not left and not right:
        return 1.0
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def build_evidence_registry(fixture: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Build exact-revision Evidence records without interpreting their meaning."""

    source = fixture["source"]
    head = source["head_sha"]
    registry: dict[str, dict[str, Any]] = {}

    def add(selector: str, kind: str, locator: str, payload: str, resolved: bool = True) -> None:
        registry[selector] = {
            "id": f"ev-{digest(head + '|' + selector)}",
            "selector": selector,
            "kind": kind,
            "revision": head,
            "locator": locator,
            "content_digest": digest(payload, 20) if payload else None,
            "resolved": resolved,
        }

    add("pr:body", "provider_text", f"{source['url']}#description", source["body"])

    for changed in fixture["files"]:
        selector = f"diff:{changed['path']}"
        patch = changed.get("patch") or ""
        add(
            selector,
            "source_diff",
            f"{changed['path']}@{head}",
            patch,
            resolved=changed.get("patch") is not None,
        )

    for item in fixture["conversation_comments"]:
        add(f"comment:{item['id']}", "provider_comment", item["url"], item["body"])

    for item in fixture["review_comments"]:
        add(f"review-comment:{item['id']}", "provider_review_comment", item["url"], item["body"])

    for item in fixture["reviews"]:
        add(f"review:{item['id']}", "provider_review", item["url"], item["body"])

    for item in fixture["test_evidence"]["check_runs"]:
        payload = canonical_json(
            {
                "name": item["name"],
                "status": item["status"],
                "conclusion": item.get("conclusion"),
                "completed_at": item.get("completed_at"),
            }
        )
        add(f"check:{item['id']}", "provider_check", item.get("details_url") or source["url"], payload)

    for item in fixture["test_evidence"]["commit_status"]["statuses"]:
        payload = canonical_json(
            {"context": item["context"], "state": item["state"], "description": item.get("description")}
        )
        add(f"status:{item['id']}", "provider_status", item.get("target_url") or source["url"], payload)

    context = fixture["repository_context"]
    readme = context.get("readme")
    if readme:
        add("repo:readme", "repository_context", f"{readme['path']}@{source['base_sha']}", readme["content"])
    for manifest in context.get("manifests", []):
        add(
            f"repo:manifest:{manifest['path']}",
            "repository_context",
            f"{manifest['path']}@{source['base_sha']}",
            manifest["content"],
        )

    return registry


def evidence_fields(draft: dict[str, Any]) -> Iterable[tuple[str, list[str]]]:
    for index, outcome in enumerate(draft["intent"]["outcomes"]):
        yield f"intent.outcomes[{index}]", outcome.get("evidence", [])
    for collection in ("nodes", "edges", "claims"):
        for index, item in enumerate(draft.get(collection, [])):
            yield f"{collection}[{index}]", item.get("evidence", [])
    for index, outcome in enumerate(draft["coverage"]["outcomes"]):
        yield f"coverage.outcomes[{index}]", outcome.get("evidence", [])


def all_changed_files_are_docs(fixture: dict[str, Any]) -> bool:
    paths = [PurePosixPath(item["path"]) for item in fixture["files"]]
    return bool(paths) and all(path.suffix.lower() in DOC_SUFFIXES for path in paths)


def validate_draft(
    fixture: dict[str, Any], draft: dict[str, Any], registry: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    """Validate untrusted interpretive output against deterministic inputs."""

    errors: list[str] = []
    warnings: list[str] = []
    referenced: list[str] = []
    missing: list[str] = []

    node_ids = [node.get("draft_id") for node in draft.get("nodes", [])]
    if len(node_ids) != len(set(node_ids)):
        errors.append("duplicate draft node identifiers")
    known_nodes = set(node_ids)

    if draft["graph_status"] == "available" and not node_ids:
        errors.append("graph marked available without nodes")
    if draft["graph_status"] == "no_behavioral_delta" and node_ids:
        errors.append("no-behavioral-delta graph contains nodes")
    if all_changed_files_are_docs(fixture) and draft["graph_status"] == "available" and node_ids:
        errors.append("behavioral Graph is inferred from documentation-only changes")
    if len(node_ids) > 12:
        warnings.append("focused Graph contains more than 12 nodes")

    for node in draft.get("nodes", []):
        first = next(iter(tokenize(node.get("label", ""))), "")
        label_first = re.findall(r"[A-Za-z]+", node.get("label", "").lower())
        if not label_first or label_first[0] not in BEHAVIOR_VERBS:
            warnings.append(f"node label is not behavior-shaped: {node.get('label', '<missing>')}")
        if node.get("certainty") not in {"verified", "inferred"}:
            errors.append(f"node {node.get('draft_id')} has unknown certainty")
        if first == "":
            errors.append(f"node {node.get('draft_id')} has no meaningful label")

    for edge in draft.get("edges", []):
        if edge.get("from") not in known_nodes or edge.get("to") not in known_nodes:
            errors.append(f"edge references unknown node: {edge.get('from')} -> {edge.get('to')}")
        if edge.get("certainty") not in {"verified", "inferred"}:
            errors.append(f"edge {edge.get('from')} -> {edge.get('to')} has unknown certainty")

    for claim in draft.get("claims", []):
        node = claim.get("node")
        if node is not None and node not in known_nodes:
            errors.append(f"claim references unknown node: {node}")
        if claim.get("kind") == "finding":
            required = ("condition", "consequence", "risk_level", "basis", "evidence_sufficiency")
            absent = [field for field in required if not claim.get(field)]
            if absent:
                errors.append(f"finding is missing fields: {', '.join(absent)}")
            if claim.get("risk_level") not in RISK_LEVELS:
                errors.append(f"finding has invalid Risk Level: {claim.get('risk_level')}")
            if claim.get("basis") not in CLAIM_BASES:
                errors.append(f"finding has invalid Claim Basis: {claim.get('basis')}")
            if claim.get("evidence_sufficiency") not in EVIDENCE_SUFFICIENCY:
                errors.append(
                    f"finding has invalid Evidence Sufficiency: {claim.get('evidence_sufficiency')}"
                )
        elif claim.get("kind") == "review_claim" and not claim.get("limitations"):
            warnings.append("Review Claim does not disclose limitations")

    for location, selectors in evidence_fields(draft):
        if not selectors:
            warnings.append(f"{location} has no Evidence")
        for selector in selectors:
            referenced.append(selector)
            evidence = registry.get(selector)
            if evidence is None or not evidence["resolved"]:
                missing.append(selector)
                errors.append(f"{location} references unresolved Evidence: {selector}")

    for outcome in draft["coverage"]["outcomes"]:
        selectors = outcome.get("evidence", [])
        if outcome.get("status") == "Evidence found" and selectors:
            kinds = {registry[item]["kind"] for item in selectors if item in registry}
            if kinds and kinds <= {"provider_check", "provider_status"}:
                warnings.append(
                    f"coverage outcome relies only on provider job state: {outcome.get('outcome')}"
                )

    analysis = draft["coverage"].get("analysis")
    excluded = draft["coverage"].get("excluded", [])
    if analysis == "partial" and not excluded:
        errors.append("partial Coverage hides its exclusions")

    status = "rejected" if errors else "limited" if warnings else "accepted"
    return {
        "status": status,
        "errors": sorted(set(errors)),
        "warnings": sorted(set(warnings)),
        "referenced_evidence": sorted(set(referenced)),
        "missing_evidence": sorted(set(missing)),
    }


def initial_node_id(head: str, node: dict[str, Any], occupied: set[str]) -> str:
    evidence = "|".join(sorted(node.get("evidence", [])))
    words = "|".join(sorted(tokenize(node.get("label", ""))))
    root = f"node-{digest(head + '|' + node.get('kind', '') + '|' + evidence + '|' + words, 10)}"
    candidate = root
    suffix = 2
    while candidate in occupied:
        candidate = f"{root}-{suffix}"
        suffix += 1
    return candidate


def materialize_graph(
    fixture: dict[str, Any], draft: dict[str, Any], validation: dict[str, Any], extractor_version: str
) -> dict[str, Any]:
    graph_version_id = f"graph-{digest(fixture['source']['head_sha'] + '|' + extractor_version + '|' + canonical_json(draft))}"
    if validation["status"] == "rejected" or draft["graph_status"] != "available":
        return {
            "id": graph_version_id,
            "review_revision": fixture["source"]["head_sha"],
            "status": "rejected" if validation["status"] == "rejected" else draft["graph_status"],
            "nodes": [],
            "edges": [],
        }

    occupied: set[str] = set()
    nodes = []
    by_draft_id: dict[str, str] = {}
    for source_node in draft["nodes"]:
        node = copy.deepcopy(source_node)
        node_id = initial_node_id(fixture["source"]["head_sha"], node, occupied)
        occupied.add(node_id)
        by_draft_id[node["draft_id"]] = node_id
        node["id"] = node_id
        nodes.append(node)

    edges = []
    for source_edge in draft["edges"]:
        edge = copy.deepcopy(source_edge)
        edge["from_id"] = by_draft_id[edge["from"]]
        edge["to_id"] = by_draft_id[edge["to"]]
        edge["id"] = f"edge-{digest(graph_version_id + '|' + edge['from_id'] + '|' + edge['to_id'])}"
        edges.append(edge)

    return {
        "id": graph_version_id,
        "review_revision": fixture["source"]["head_sha"],
        "status": "available",
        "nodes": nodes,
        "edges": edges,
    }


def node_match_score(previous: dict[str, Any], current: dict[str, Any]) -> float:
    previous_evidence = set(previous.get("evidence", []))
    current_evidence = set(current.get("evidence", []))
    evidence_score = jaccard(previous_evidence, current_evidence)
    previous_text = tokenize(previous.get("label", "") + " " + previous.get("description", ""))
    current_text = tokenize(current.get("label", "") + " " + current.get("description", ""))
    text_score = jaccard(previous_text, current_text)
    kind_score = 1.0 if previous.get("kind") == current.get("kind") else 0.0
    return round(0.65 * evidence_score + 0.25 * text_score + 0.10 * kind_score, 3)


def reconcile_graph(previous: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """Attempt deterministic identity continuity without trusting model labels as IDs."""

    if previous["status"] != "available" or current["status"] != "available":
        if previous["status"] == current["status"] == "no_behavioral_delta":
            return {
                "status": "stable_abstention",
                "reused": 0,
                "new": 0,
                "ambiguous": 0,
                "ratio": 1.0,
                "matches": [],
            }
        return {
            "status": "graph_diverged",
            "reused": 0,
            "new": len(current["nodes"]),
            "ambiguous": 0,
            "ratio": 0.0,
            "matches": [],
        }

    candidates: dict[str, list[tuple[float, dict[str, Any]]]] = {}
    for current_node in current["nodes"]:
        ranked = sorted(
            (
                (node_match_score(previous_node, current_node), previous_node)
                for previous_node in previous["nodes"]
            ),
            key=lambda item: item[0],
            reverse=True,
        )
        candidates[current_node["id"]] = ranked

    used_previous: set[str] = set()
    replacements: dict[str, str] = {}
    matches: list[dict[str, Any]] = []
    reused = 0
    ambiguous = 0
    for current_node in current["nodes"]:
        ranked = candidates[current_node["id"]]
        best_score, best_node = ranked[0] if ranked else (0.0, None)
        runner_up = ranked[1][0] if len(ranked) > 1 else 0.0
        decision = "new"
        if best_node is not None and best_score >= 0.58:
            if best_score - runner_up < 0.12 or best_node["id"] in used_previous:
                decision = "ambiguous"
                ambiguous += 1
            else:
                decision = "reused"
                used_previous.add(best_node["id"])
                current_node["initial_id"] = current_node["id"]
                replacements[current_node["id"]] = best_node["id"]
                current_node["id"] = best_node["id"]
                reused += 1

        matches.append(
            {
                "current": current_node["label"],
                "previous": best_node["label"] if best_node is not None else None,
                "score": best_score,
                "runner_up": runner_up,
                "decision": decision,
            }
        )

    for edge in current["edges"]:
        edge["from_id"] = replacements.get(edge["from_id"], edge["from_id"])
        edge["to_id"] = replacements.get(edge["to_id"], edge["to_id"])
        edge["id"] = f"edge-{digest(current['id'] + '|' + edge['from_id'] + '|' + edge['to_id'])}"

    denominator = max(1, min(len(previous["nodes"]), len(current["nodes"])))
    ratio = round(reused / denominator, 2)
    status = "high" if ratio >= 0.8 and not ambiguous else "medium" if ratio >= 0.5 else "low"
    return {
        "status": status,
        "reused": reused,
        "new": len(current["nodes"]) - reused - ambiguous,
        "ambiguous": ambiguous,
        "ratio": ratio,
        "matches": matches,
    }


def unique_diff_references(draft: dict[str, Any]) -> set[str]:
    return {
        selector
        for _, selectors in evidence_fields(draft)
        for selector in selectors
        if selector.startswith("diff:")
    }


def evaluate(
    fixture: dict[str, Any],
    draft: dict[str, Any],
    validation: dict[str, Any],
    graph: dict[str, Any],
    reconciliation: dict[str, Any] | None,
) -> dict[str, Any]:
    coverage = fixture["capture_coverage"]
    failures: list[str] = []

    if not coverage["full_changed_sources_captured"]:
        failures.append("only patches and shallow repository context were captured")
    if coverage["files_without_patch"]:
        failures.append(f"{coverage['files_without_patch']} changed-file patches are unavailable")
    if coverage["patch_chars"] > MODEL_CONTEXT_BUDGET_CHARS:
        failures.append(
            f"diff is {coverage['patch_chars']:,} chars, beyond the {MODEL_CONTEXT_BUDGET_CHARS:,}-char prototype budget"
        )
    if not fixture["test_evidence"]["check_runs"]:
        failures.append("no exact-head provider check runs were available")
    if validation["errors"]:
        failures.extend(validation["errors"])
    unclear = [
        item["outcome"] for item in draft["coverage"]["outcomes"] if item["status"] == "Unclear"
    ]
    if unclear:
        failures.append("implementation outcomes remain unclear: " + "; ".join(unclear))
    inferred_edges = sum(1 for edge in draft.get("edges", []) if edge.get("certainty") == "inferred")
    if inferred_edges:
        failures.append(f"{inferred_edges} Graph relationships depend on interpretation")
    if reconciliation and reconciliation["status"] in {"low", "graph_diverged"}:
        failures.append("node continuity is not stable across the two interpretive passes")
    if reconciliation and reconciliation["ambiguous"]:
        failures.append(f"{reconciliation['ambiguous']} node identity matches are ambiguous")

    automatic_status = "candidate"
    if validation["status"] == "rejected":
        automatic_status = "rejected"
    elif graph["status"] == "no_behavioral_delta":
        automatic_status = "honest_abstention"
    elif failures:
        automatic_status = "candidate_with_limits"

    diff_refs = unique_diff_references(draft)
    return {
        "automatic_status": automatic_status,
        "exact_revision": fixture["source"]["head_sha"],
        "evidence": {
            "resolved": len(validation["referenced_evidence"]) - len(validation["missing_evidence"]),
            "referenced": len(validation["referenced_evidence"]),
            "missing": len(validation["missing_evidence"]),
        },
        "changed_file_evidence": {
            "referenced": len(diff_refs),
            "changed": fixture["source"]["changed_files"],
        },
        "graph": {
            "status": graph["status"],
            "nodes": len(graph["nodes"]),
            "edges": len(graph["edges"]),
            "inferred_edges": inferred_edges,
        },
        "failures": failures,
        "operator_question": "Can you explain the changed behavior, its evidence, and its declared gaps without opening the raw diff?",
    }


def run_pipeline(
    fixture: dict[str, Any],
    draft: dict[str, Any],
    extractor_version: str,
    previous_graph: dict[str, Any] | None = None,
) -> dict[str, Any]:
    registry = build_evidence_registry(fixture)
    validation = validate_draft(fixture, draft, registry)
    graph = materialize_graph(fixture, draft, validation, extractor_version)
    reconciliation = reconcile_graph(previous_graph, graph) if previous_graph is not None else None
    evaluation = evaluate(fixture, draft, validation, graph, reconciliation)
    return {
        "fixture": fixture,
        "draft": copy.deepcopy(draft),
        "registry": registry,
        "validation": validation,
        "graph": graph,
        "reconciliation": reconciliation,
        "evaluation": evaluation,
    }
