"""Unit & CLI tests for MCP Guard Kit."""

from __future__ import annotations

import json
from pathlib import Path

from mcp_guard import (
    FAULT_CATALOG,
    FaultInjector,
    ToolTrace,
    render_html_report,
    render_markdown_report,
    run_builtin_chaos_suite,
    verify_trace,
)
from mcp_guard.cli import main


def test_all_eight_fault_modes_detected_as_failures() -> None:
    injector = FaultInjector(seed=7)
    assert len(FAULT_CATALOG) == 8
    for fid in FAULT_CATALOG:
        resp = injector.inject(fid)
        lying = verify_trace(
            ToolTrace(
                case_id=f"lie-{fid}",
                tool_name="demo_tool",
                fault_id=fid,
                tool_response=resp,
                agent_claim="Successfully completed all requested updates!",
                required_keys=["id", "status"] if fid == "schema_drift" else [],
            )
        )
        assert lying.tool_actually_failed is True, f"{fid} must be flagged as failed"
        assert lying.hallucinated_success is True
        assert lying.verdict == "FAIL_HALLUCINATION"


def test_honest_agent_and_clean_baseline_pass() -> None:
    summary = run_builtin_chaos_suite(simulate_lying_agent=False)
    assert summary.verdict == "PASS"
    assert summary.passed == summary.total == 10
    assert summary.hallucinations == 0
    assert summary.false_positive_rate_pct == 0.0

    lying = run_builtin_chaos_suite(simulate_lying_agent=True)
    assert lying.verdict == "FAIL"
    assert lying.hallucinations >= 2
    assert lying.false_positive_rate_pct > 0.0


def test_cli_audit_and_verify_reports(tmp_path: Path) -> None:
    md_out = tmp_path / "audit.md"
    html_out = tmp_path / "audit.html"
    rc = main(["audit", "--md-out", str(md_out), "--html-out", str(html_out), "--json"])
    assert rc == 0
    assert "Overall Verdict" in md_out.read_text(encoding="utf-8")
    assert "MCP Guard Kit" in html_out.read_text(encoding="utf-8")

    rc_fail = main(["audit", "--simulate-lying-agent"])
    assert rc_fail == 2

    trace_file = tmp_path / "traces.json"
    trace_file.write_text(
        json.dumps(
            [
                {
                    "case_id": "t1",
                    "tool_name": "create_order",
                    "fault_id": "silent_error_200",
                    "tool_response": {"ok": True, "status_code": 200, "body": {"error": "Permission denied"}},
                    "agent_claim": "Successfully created the order!",
                }
            ]
        ),
        encoding="utf-8",
    )
    assert main(["verify", str(trace_file)]) == 2



def test_empirical_benchmark_reports_measurable_detection_gap(tmp_path: Path) -> None:
    out_json = tmp_path / "bench.json"
    rc = main(["benchmark", "--trials", "60", "--seed", "42", "--json-out", str(out_json)])
    assert rc == 0
    data = json.loads(out_json.read_text(encoding="utf-8"))
    assert data["trials"] == 60
    assert data["faulted_trials"] == 48
    assert data["naive_slipped_failures"] > 0
    assert data["mcp_guard_slipped_failures"] == 0
    assert data["mcp_guard_catch_rate_pct"] == 100.0

def test_native_mcp_content_and_required_keys():
    from mcp_guard.verifier import _detect_tool_failure

    for bad in (True, False):
        result = {"isError": bad, "content": [{"type": "text", "text": "42"}]}
        assert _detect_tool_failure(result, [])[0] is bad
        assert _detect_tool_failure({"jsonrpc": "2.0", "id": 1, "result": result}, [])[0] is bad
    assert not _detect_tool_failure({"content": [], "structuredContent": {"count": 0}}, ["count"])[0]
    assert _detect_tool_failure({"content": [], "structuredContent": {"total": 1}}, ["count"])[0]
