#!/usr/bin/env python3
"""Interactive in-memory shell for the throwaway conceptual pipeline."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import textwrap
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

from conceptual import run_pipeline


HERE = Path(__file__).resolve().parent
STAGES = ("INPUT", "EVIDENCE", "DRAFT", "VALIDATE", "GRAPH", "STABILITY", "VERDICT")
BOLD = "\x1b[1m"
DIM = "\x1b[2m"
RESET = "\x1b[0m"
GREEN = "\x1b[32m"
YELLOW = "\x1b[33m"
RED = "\x1b[31m"
CYAN = "\x1b[36m"


@dataclass
class UIState:
    case_index: int = 0
    run_index: int = 0
    stage_index: int = 0
    node_index: int = 0
    verdicts: dict[str, str] = field(default_factory=dict)
    message: str = "Advance one stage at a time; nothing is persisted."


def load_experiment() -> tuple[list[str], dict[str, list[dict[str, Any]]]]:
    specification = json.loads((HERE / "recorded_runs.json").read_text())
    results: dict[str, list[dict[str, Any]]] = {}
    order = list(specification["cases"])
    for case in order:
        fixture = json.loads((HERE / "fixtures" / f"{case}.json").read_text())
        previous_graph = None
        results[case] = []
        for draft in specification["cases"][case]:
            result = run_pipeline(
                fixture,
                draft,
                specification["extractor_version"],
                previous_graph=previous_graph,
            )
            results[case].append(result)
            previous_graph = result["graph"]
    return order, results


def wrap(value: str, width: int, prefix: str = "") -> list[str]:
    available = max(20, width - len(prefix))
    parts = textwrap.wrap(value, width=available, break_long_words=False, break_on_hyphens=False) or [""]
    return [prefix + parts[0], *(" " * len(prefix) + item for item in parts[1:])]


def shortened(value: str, length: int = 7) -> str:
    return value[:length]


def status_color(status: str) -> str:
    if status in {"accepted", "available", "candidate", "high", "stable_abstention", "honest_abstention"}:
        return GREEN
    if status in {"limited", "candidate_with_limits", "medium", "no_behavioral_delta"}:
        return YELLOW
    return RED


def add_title(lines: list[str], title: str) -> None:
    lines.extend(["", f"{BOLD}{title}{RESET}"])


def render_input(result: dict[str, Any], lines: list[str], width: int) -> None:
    fixture = result["fixture"]
    source = fixture["source"]
    capture = fixture["capture_coverage"]
    lines.extend(wrap(source["title"], width, f"{BOLD}PR{RESET}  "))
    lines.append(f"{DIM}{source['url']}{RESET}")
    lines.append(
        f"state={source['state']} draft={source['draft']} merged={source['merged']}  "
        f"files={source['changed_files']}  +{source['additions']} -{source['deletions']}"
    )
    add_title(lines, "Untrusted exact-revision input")
    lines.append(
        f"diff patches {capture['files_returned']}/{source['changed_files']} · "
        f"{capture['patch_chars']:,} chars · missing {capture['files_without_patch']}"
    )
    lines.append(
        f"comments {len(fixture['conversation_comments'])} · review comments {len(fixture['review_comments'])} · "
        f"reviews {len(fixture['reviews'])} · checks {len(fixture['test_evidence']['check_runs'])}"
    )
    context = fixture["repository_context"]
    lines.append(
        f"repository context: {context['primary_language']} · {len(context['root_tree'])} root entries · "
        f"README={'yes' if context.get('readme') else 'no'} · manifests={len(context['manifests'])}"
    )
    lines.extend(wrap(f"Limit: {capture['note']}", width, f"{YELLOW}! {RESET}"))


def render_evidence(result: dict[str, Any], lines: list[str], width: int) -> None:
    registry = result["registry"]
    counts = Counter(item["kind"] for item in registry.values())
    add_title(lines, f"Deterministic Evidence registry · {len(registry)} records")
    for kind, count in sorted(counts.items()):
        lines.append(f"{kind:<25} {count:>3}")
    add_title(lines, "Sample resolvable locators")
    for item in list(registry.values())[:6]:
        marker = f"{GREEN}✓{RESET}" if item["resolved"] else f"{RED}×{RESET}"
        lines.extend(wrap(f"{marker} {item['id']}  {item['locator']}", width))
    lines.append(f"{DIM}Registry creation records provenance; it does not infer what an artifact proves.{RESET}")


def render_draft(result: dict[str, Any], lines: list[str], width: int) -> None:
    draft = result["draft"]
    lines.extend(wrap(draft["overview"], width, f"{BOLD}Overview{RESET}  "))
    add_title(lines, "Change Intent")
    lines.extend(wrap(draft["intent"]["statement"], width))
    for outcome in draft["intent"]["outcomes"]:
        lines.extend(wrap(outcome["text"], width, "  • "))
    add_title(lines, "Interpretive draft")
    lines.append(
        f"graph_status={draft['graph_status']} · concepts={len(draft['concepts'])} · "
        f"nodes={len(draft['nodes'])} · edges={len(draft['edges'])} · claims={len(draft['claims'])}"
    )
    for concept in draft["concepts"]:
        lines.append(f"  · {concept}")
    if draft["limitations"]:
        lines.extend(wrap(draft["limitations"][0], width, f"{YELLOW}Limit{RESET}  "))


def render_validation(result: dict[str, Any], lines: list[str], width: int) -> None:
    validation = result["validation"]
    color = status_color(validation["status"])
    add_title(lines, "Closed-schema validation")
    lines.append(
        f"status={color}{BOLD}{validation['status']}{RESET} · referenced Evidence="
        f"{len(validation['referenced_evidence'])} · unresolved={len(validation['missing_evidence'])}"
    )
    if validation["errors"]:
        lines.append(f"{RED}{BOLD}Errors{RESET}")
        for error in validation["errors"]:
            lines.extend(wrap(error, width, "  × "))
    if validation["warnings"]:
        lines.append(f"{YELLOW}{BOLD}Warnings{RESET}")
        for warning in validation["warnings"][:5]:
            lines.extend(wrap(warning, width, "  ! "))
    if not validation["errors"] and not validation["warnings"]:
        lines.append(f"{GREEN}All referenced artifacts resolve to the captured head; no structural violations found.{RESET}")


def render_graph(result: dict[str, Any], state: UIState, lines: list[str], width: int) -> None:
    graph = result["graph"]
    color = status_color(graph["status"])
    add_title(lines, "Focused behavioral Graph")
    lines.append(
        f"status={color}{BOLD}{graph['status']}{RESET} · version={graph['id']} · "
        f"nodes={len(graph['nodes'])} · edges={len(graph['edges'])}"
    )
    if not graph["nodes"]:
        if graph["status"] == "rejected":
            lines.append(f"{RED}No Graph is publishable from this interpretive pass.{RESET}")
        else:
            lines.append(f"{YELLOW}No behavioral delta is published; Change Intent and Coverage remain available.{RESET}")
        return

    state.node_index %= len(graph["nodes"])
    selected = graph["nodes"][state.node_index]
    for index, node in enumerate(graph["nodes"]):
        cursor = f"{CYAN}›{RESET}" if index == state.node_index else " "
        certainty = "V" if node["certainty"] == "verified" else "I"
        lines.extend(wrap(f"{cursor} [{certainty}] {node['label']}  {DIM}{node['id']}{RESET}", width))
    lines.extend(wrap(selected["description"], width, f"{BOLD}Selected{RESET}  "))
    lines.append(f"Evidence: {', '.join(selected['evidence'])}")
    inferred = sum(1 for edge in graph["edges"] if edge["certainty"] == "inferred")
    lines.append(f"Relationships: {len(graph['edges'])} total · {inferred} inferred")
    findings = [claim for claim in result["draft"]["claims"] if claim["kind"] == "finding"]
    if findings:
        finding = findings[0]
        lines.extend(
            wrap(
                f"{finding['risk_level']} · {finding['basis']} · {finding['evidence_sufficiency']} — {finding['statement']}",
                width,
                f"{RED}Finding{RESET}  ",
            )
        )


def render_stability(result: dict[str, Any], lines: list[str], width: int) -> None:
    reconciliation = result["reconciliation"]
    add_title(lines, "Identity continuity across interpretive passes")
    if reconciliation is None:
        lines.append("Run A is the baseline. Press r to inspect Run B and its reconciliation against A.")
        lines.append(
            f"{DIM}Initial IDs are revision-bound fingerprints, not durable semantic identity claims.{RESET}"
        )
        return
    color = status_color(reconciliation["status"])
    lines.append(
        f"status={color}{BOLD}{reconciliation['status']}{RESET} · reused={reconciliation['reused']} · "
        f"new={reconciliation['new']} · ambiguous={reconciliation['ambiguous']} · ratio={reconciliation['ratio']:.0%}"
    )
    for match in reconciliation["matches"][:7]:
        marker = {"reused": f"{GREEN}reuse{RESET}", "ambiguous": f"{YELLOW}ambiguous{RESET}", "new": f"{RED}new{RESET}"}[match["decision"]]
        previous = match["previous"] or "—"
        lines.extend(
            wrap(
                f"{marker:<18} {match['score']:.2f}  {previous}  →  {match['current']}",
                width,
            )
        )
    lines.append(
        f"{DIM}A reused ID requires unique evidence/text overlap; ambiguous matches never silently reuse identity.{RESET}"
    )


def render_verdict(result: dict[str, Any], state: UIState, case: str, lines: list[str], width: int) -> None:
    evaluation = result["evaluation"]
    evidence = evaluation["evidence"]
    files = evaluation["changed_file_evidence"]
    color = status_color(evaluation["automatic_status"])
    add_title(lines, "Mechanical result — not the Operator verdict")
    lines.append(
        f"status={color}{BOLD}{evaluation['automatic_status']}{RESET} · Evidence "
        f"{evidence['resolved']}/{evidence['referenced']} resolved · changed-file Evidence "
        f"{files['referenced']}/{files['changed']}"
    )
    for failure in evaluation["failures"][:6]:
        lines.extend(wrap(failure, width, f"{YELLOW}! {RESET}"))
    add_title(lines, "Operator judgment")
    lines.extend(wrap(evaluation["operator_question"], width))
    verdict = state.verdicts.get(case, "pending")
    lines.append(f"Current in-memory verdict: {BOLD}{verdict}{RESET}")
    lines.append("Press u = useful, f = fails, c = unclear. Compare both runs before deciding.")


def render_frame(
    order: list[str], results: dict[str, list[dict[str, Any]]], state: UIState
) -> str:
    width, height = shutil.get_terminal_size((110, 36))
    case = order[state.case_index]
    result = results[case][state.run_index]
    source = result["fixture"]["source"]
    stage = STAGES[state.stage_index]
    lines = [
        f"{BOLD}PROTOTYPE — Conceptual change extraction{RESET}",
        f"case {state.case_index + 1}/{len(order)} {BOLD}{case}{RESET} · run {result['draft']['run']} · "
        f"stage {state.stage_index + 1}/{len(STAGES)} {BOLD}{stage}{RESET}",
        f"{DIM}{source['repository']}#{source['pull_number']} · {shortened(source['base_sha'])}..{shortened(source['head_sha'])} · "
        f"Operator verdict={state.verdicts.get(case, 'pending')}{RESET}",
    ]

    renderer = {
        "INPUT": render_input,
        "EVIDENCE": render_evidence,
        "DRAFT": render_draft,
        "VALIDATE": render_validation,
        "GRAPH": lambda current, output, size: render_graph(current, state, output, size),
        "STABILITY": render_stability,
        "VERDICT": lambda current, output, size: render_verdict(current, state, case, output, size),
    }[stage]
    renderer(result, lines, width)

    footer = [
        "",
        f"{DIM}{state.message}{RESET}",
        f"{BOLD}[a]{RESET} advance  {BOLD}[b]{RESET} back  {BOLD}[r]{RESET} run A/B  "
        f"{BOLD}[n/p]{RESET} case  {BOLD}[j/k]{RESET} node  {BOLD}[u/f/c]{RESET} verdict  {BOLD}[q]{RESET} quit",
    ]
    available = max(8, height - len(footer))
    if len(lines) > available:
        hidden = len(lines) - available + 1
        lines = lines[: available - 1] + [f"{DIM}… {hidden} more lines hidden by terminal height{RESET}"]
    return "\n".join(lines + footer)


def update_state(state: UIState, action: str, order: list[str], results: dict[str, list[dict[str, Any]]]) -> bool:
    action = action.strip().lower()[:1]
    case = order[state.case_index]
    if action == "q":
        return False
    if action == "a":
        state.stage_index = min(len(STAGES) - 1, state.stage_index + 1)
        state.message = f"Advanced to {STAGES[state.stage_index]}."
    elif action == "b":
        state.stage_index = max(0, state.stage_index - 1)
        state.message = f"Returned to {STAGES[state.stage_index]}."
    elif action == "r":
        state.run_index = (state.run_index + 1) % len(results[case])
        state.node_index = 0
        state.message = f"Showing recorded interpretive run {results[case][state.run_index]['draft']['run']}."
    elif action in {"n", "p"}:
        delta = 1 if action == "n" else -1
        state.case_index = (state.case_index + delta) % len(order)
        state.run_index = 0
        state.stage_index = 0
        state.node_index = 0
        state.message = f"Loaded {order[state.case_index]} at its captured exact revision."
    elif action in {"j", "k"}:
        graph = results[case][state.run_index]["graph"]
        if graph["nodes"]:
            state.node_index = (state.node_index + (1 if action == "j" else -1)) % len(graph["nodes"])
            state.message = f"Selected {graph['nodes'][state.node_index]['label']}."
        else:
            state.message = "This pass has no publishable Graph nodes."
    elif action in {"u", "f", "c"}:
        state.verdicts[case] = {"u": "useful", "f": "fails", "c": "unclear"}[action]
        state.message = f"Recorded in memory only: {case} = {state.verdicts[case]}."
    else:
        state.message = "Unknown key; state unchanged."
    return True


def interactive(order: list[str], results: dict[str, list[dict[str, Any]]]) -> None:
    state = UIState()
    while True:
        sys.stdout.write("\x1b[2J\x1b[H")
        sys.stdout.write(render_frame(order, results, state) + "\n> ")
        sys.stdout.flush()
        try:
            action = input()
        except (EOFError, KeyboardInterrupt):
            action = "q"
        if not update_state(state, action, order, results):
            break
    sys.stdout.write("\x1b[2J\x1b[H")
    print(f"{BOLD}Prototype session ended; no state was persisted.{RESET}")
    for case in order:
        print(f"- {case}: {state.verdicts.get(case, 'pending')}")


def report(order: list[str], results: dict[str, list[dict[str, Any]]]) -> None:
    print("PROTOTYPE REPORT — mechanical signals only")
    for case in order:
        source = results[case][0]["fixture"]["source"]
        print(f"\n{case}: {source['repository']}#{source['pull_number']} {shortened(source['head_sha'])}")
        for result in results[case]:
            validation = result["validation"]
            graph = result["graph"]
            evaluation = result["evaluation"]
            reconciliation = result["reconciliation"]
            stability = reconciliation["status"] if reconciliation else "baseline"
            print(
                f"  run {result['draft']['run']}: validation={validation['status']} "
                f"graph={graph['status']}({len(graph['nodes'])}n/{len(graph['edges'])}e) "
                f"stability={stability} result={evaluation['automatic_status']}"
            )
            for failure in evaluation["failures"]:
                print(f"    - {failure}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", action="store_true", help="print every case without entering the TUI")
    args = parser.parse_args()
    order, results = load_experiment()
    if args.report:
        report(order, results)
    else:
        interactive(order, results)


if __name__ == "__main__":
    main()
