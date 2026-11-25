"""Command-line interface for MCP Guard Kit."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Sequence

from .benchmark import run_empirical_benchmark
from .runner import render_html_report, render_markdown_report, render_sarif_report, run_builtin_chaos_suite
from .verifier import ToolTrace, evaluate_suite


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="mcp-guard",
        description="Fault-Injection & Anti-Hallucination Verifier for MCP Servers & AI Agents.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_demo = sub.add_parser("audit", help="Run built-in 10-case MCP chaos suite")
    p_demo.add_argument("--simulate-lying-agent", action="store_true", help="Simulate an LLM lying on 33% of tool failures")
    p_demo.add_argument("--md-out", type=Path, help="Write Markdown audit report to path")
    p_demo.add_argument("--html-out", type=Path, help="Write self-contained HTML audit report to path")
    p_demo.add_argument("--sarif-out", type=Path, help="Write SARIF 2.1.0 Code Scanning report to path")
    p_demo.add_argument("--json", action="store_true", help="Print JSON summary to stdout")

    p_ver = sub.add_parser("verify", help="Verify recorded MCP tool traces JSON file")
    p_ver.add_argument("trace_file", type=Path, help="JSON list of {case_id, tool_name, fault_id, tool_response, agent_claim}")
    p_ver.add_argument("--md-out", type=Path, help="Write Markdown report")
    p_ver.add_argument("--html-out", type=Path, help="Write HTML report")
    p_ver.add_argument("--sarif-out", type=Path, help="Write SARIF 2.1.0 Code Scanning report")
    p_ver.add_argument("--json", action="store_true", help="Print JSON summary")

    p_bench = sub.add_parser("benchmark", help="Run reproducible Naive HTTP-200 vs MCP Guard empirical benchmark")
    p_bench.add_argument("--trials", type=int, default=60, help="Total trials to evaluate (default: 60)")
    p_bench.add_argument("--seed", type=int, default=42, help="Deterministic RNG seed (default: 42)")
    p_bench.add_argument("--json-out", type=Path, help="Write benchmark JSON trace to path")
    p_bench.add_argument("--json", action="store_true", help="Print JSON report to stdout")

    args = parser.parse_args(argv)
    if args.cmd == "benchmark":
        bench = run_empirical_benchmark(trials=args.trials, seed=args.seed)
        payload = bench.to_dict()
        if args.json_out:
            args.json_out.parent.mkdir(parents=True, exist_ok=True)
            args.json_out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print(
                f"Benchmark ({bench.trials} trials, {bench.faulted_trials} faulted, seed={bench.seed}):\n"
                f"- Naive HTTP-200 Verifier slipped failures: {bench.naive_slipped_failures}/{bench.faulted_trials} ({bench.naive_slip_rate_pct}% missed)\n"
                f"- MCP Guard Verifier caught failures: {bench.faulted_trials - bench.mcp_guard_slipped_failures}/{bench.faulted_trials} ({bench.mcp_guard_catch_rate_pct}% caught, {bench.mcp_guard_false_alarms} false alarms)"
            )
        return 0 if bench.mcp_guard_slipped_failures == 0 else 2

    if args.cmd == "audit":
        summary = run_builtin_chaos_suite(simulate_lying_agent=args.simulate_lying_agent)
    else:
        raw = json.loads(args.trace_file.read_text(encoding="utf-8"))
        traces = [ToolTrace(**item) for item in raw]
        summary = evaluate_suite(traces)

    if args.md_out:
        args.md_out.parent.mkdir(parents=True, exist_ok=True)
        args.md_out.write_text(render_markdown_report(summary), encoding="utf-8")
    if args.html_out:
        args.html_out.parent.mkdir(parents=True, exist_ok=True)
        args.html_out.write_text(render_html_report(summary), encoding="utf-8")
    if getattr(args, "sarif_out", None):
        args.sarif_out.parent.mkdir(parents=True, exist_ok=True)
        args.sarif_out.write_text(json.dumps(render_sarif_report(summary), indent=2), encoding="utf-8")

    if args.json:
        print(json.dumps(summary.to_dict(), indent=2))
    else:
        print(render_markdown_report(summary))

    return 0 if summary.verdict == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
