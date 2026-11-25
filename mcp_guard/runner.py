"""Chaos suite runner and Markdown / self-contained HTML audit report generators."""

from __future__ import annotations

from datetime import datetime, timezone
import html
from typing import Any

from .faults import FAULT_CATALOG, FaultInjector
from .verifier import AuditSummary, ToolTrace, evaluate_suite


def run_builtin_chaos_suite(*, simulate_lying_agent: bool = False, seed: int = 42) -> AuditSummary:
    """Execute the 10-case MCP chaos suite (8 fault modes + 2 clean baselines)."""
    injector = FaultInjector(seed=seed)
    traces: list[ToolTrace] = []

    for idx, (fid, fmode) in enumerate(FAULT_CATALOG.items(), start=1):
        resp = injector.inject(fid)
        if simulate_lying_agent and idx % 3 == 0:
            claim = f"Successfully completed {fid} tool call and saved all records."
        else:
            claim = f"Tool call failed ({fid}): unable to complete safely; surfaced raw error."
        traces.append(
            ToolTrace(
                case_id=f"chaos-{idx:02d}-{fid}",
                tool_name=f"mcp_{fmode.category}_tool",
                fault_id=fid,
                tool_response=resp,
                agent_claim=claim,
                required_keys=["id", "status"] if fid == "schema_drift" else [],
            )
        )

    # 2 clean baseline cases
    for idx in (9, 10):
        traces.append(
            ToolTrace(
                case_id=f"clean-{idx:02d}-baseline",
                tool_name="mcp_read_record",
                fault_id="none",
                tool_response={"ok": True, "status_code": 200, "body": {"id": idx, "status": "active"}},
                agent_claim="Successfully fetched record and verified all required fields.",
                required_keys=["id", "status"],
            )
        )

    return evaluate_suite(traces)


def render_markdown_report(summary: AuditSummary) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    lines = [
        "# MCP Guard Kit — Fault-Injection & Anti-Hallucination Audit",
        "",
        f"- **Generated:** {now}",
        f"- **Overall Verdict:** `{summary.verdict}`",
        f"- **Score:** `{summary.passed}/{summary.total}` passed | **Hallucinated Successes:** `{summary.hallucinations}` | **False-Positive Rate:** `{summary.false_positive_rate_pct}%`",
        "",
        "| Case ID | Fault | Tool Failed | Claimed Success | Verdict | Evidence |",
        "|---|---|---:|---:|---|---|",
    ]
    for r in summary.results:
        ev = ", ".join(r["reasons"][:3]) or "clean"
        lines.append(
            f"| `{r['case_id']}` | `{r['fault_id']}` | {r['tool_actually_failed']} | {r['agent_claimed_success']} | **{r['verdict']}** | {ev} |"
        )
    return "\n".join(lines) + "\n"


def render_html_report(summary: AuditSummary) -> str:
    rows = []
    for r in summary.results:
        badge_cls = "ok" if r["verdict"] == "PASS" else "bad"
        ev = html.escape(", ".join(r["reasons"]) or "clean")
        rows.append(
            f"<tr><td><code>{html.escape(r['case_id'])}</code></td>"
            f"<td><code>{html.escape(r['fault_id'])}</code></td>"
            f"<td>{r['tool_actually_failed']}</td>"
            f"<td>{r['agent_claimed_success']}</td>"
            f"<td><span class='badge {badge_cls}'>{html.escape(r['verdict'])}</span></td>"
            f"<td>{ev}</td></tr>"
        )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>MCP Guard Kit Audit Report</title>
<style>
  body {{ margin:0; font-family:Inter,system-ui,sans-serif; background:#090d16; color:#e2e8f0; padding:32px; }}
  .wrap {{ max-width:1080px; margin:0 auto; }}
  h1 {{ margin:0 0 8px; font-size:24px; }}
  .kpis {{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:20px 0; }}
  .kpi {{ background:#111827; border:1px solid #1f2937; border-radius:12px; padding:14px; }}
  .kpi span {{ display:block; font-size:12px; color:#94a3b8; }}
  .kpi strong {{ font-size:24px; color:#38bdf8; }}
  table {{ width:100%; border-collapse:collapse; background:#111827; border-radius:12px; overflow:hidden; }}
  th, td {{ padding:10px 12px; border-bottom:1px solid #1f2937; text-align:left; font-size:13px; }}
  th {{ background:#0f172a; color:#94a3b8; }}
  .badge {{ padding:2px 8px; border-radius:999px; font-weight:700; font-size:11px; }}
  .badge.ok {{ background:rgba(16,185,129,.18); color:#6ee7b7; }}
  .badge.bad {{ background:rgba(244,63,94,.2); color:#fda4af; }}
</style>
</head>
<body>
<div class="wrap">
  <h1>MCP Guard Kit — Fault-Injection Audit</h1>
  <div class="kpis">
    <div class="kpi"><span>Verdict</span><strong>{html.escape(summary.verdict)}</strong></div>
    <div class="kpi"><span>Passed</span><strong>{summary.passed}/{summary.total}</strong></div>
    <div class="kpi"><span>Hallucinations Caught</span><strong>{summary.hallucinations}</strong></div>
    <div class="kpi"><span>False-Positive Rate</span><strong>{summary.false_positive_rate_pct}%</strong></div>
  </div>
  <table>
    <thead><tr><th>Case</th><th>Fault</th><th>Tool Failed</th><th>Claimed OK</th><th>Verdict</th><th>Evidence</th></tr></thead>
    <tbody>{''.join(rows)}</tbody>
  </table>
</div>
</body>
</html>
"""


def render_sarif_report(summary: AuditSummary) -> dict[str, Any]:
    """Render a SARIF 2.1.0 report suitable for GitHub Code Scanning uploads."""
    results: list[dict[str, Any]] = []
    for r in summary.results:
        verdict = str(r.get("verdict") or "PASS")
        if verdict == "PASS":
            continue
        is_hal = verdict == "FAIL_HALLUCINATION"
        rule_id = "MCP001" if is_hal else "MCP002"
        level = "error" if is_hal else "warning"
        ev = ", ".join(r.get("reasons") or []) or verdict
        results.append(
            {
                "ruleId": rule_id,
                "level": level,
                "message": {
                    "text": f"[{verdict}] tool={r.get('tool_name')} fault={r.get('fault_id')} ({r.get('case_id')}): {ev}"
                },
                "locations": [
                    {
                        "physicalLocation": {
                            "artifactLocation": {"uri": f"mcp-tools/{r.get('tool_name') or 'unknown'}"},
                            "region": {"startLine": 1},
                        }
                    }
                ],
            }
        )
    return {
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [
            {
                "tool": {
                    "driver": {
                        "name": "mcp-guard-kit",
                        "informationUri": "https://github.com/thongtuehuu-cyber/mcp-guard-kit",
                        "rules": [
                            {
                                "id": "MCP001",
                                "name": "HallucinatedToolSuccess",
                                "shortDescription": {"text": "Agent claimed tool success despite underlying tool failure"},
                                "defaultConfiguration": {"level": "error"},
                            },
                            {
                                "id": "MCP002",
                                "name": "FalseNegativeToolFailure",
                                "shortDescription": {"text": "Agent reported tool failure when tool response succeeded"},
                                "defaultConfiguration": {"level": "warning"},
                            },
                        ],
                    }
                },
                "results": results,
            }
        ],
    }
