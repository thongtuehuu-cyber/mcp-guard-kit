"""Reproducible empirical benchmark comparing naive HTTP-200 status checks vs MCP Guard Kit."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from .faults import FAULT_CATALOG, FaultInjector
from .verifier import _detect_tool_failure


@dataclass(slots=True)
class BenchmarkReport:
    trials: int
    seed: int
    faulted_trials: int
    clean_trials: int
    naive_slipped_failures: int
    naive_slip_rate_pct: float
    naive_catch_rate_pct: float
    mcp_guard_slipped_failures: int
    mcp_guard_false_alarms: int
    mcp_guard_catch_rate_pct: float
    per_fault: dict[str, dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def naive_http_200_verifier(resp: dict[str, Any]) -> bool:
    """Typical LLM tool-wrapper check: assumes success if status==200 and ok is not False and no top-level error."""
    if resp.get("ok") is False:
        return False
    if resp.get("error"):
        return False
    status_code = resp.get("status_code")
    if isinstance(status_code, int) and status_code >= 400:
        return False
    return True


def run_empirical_benchmark(*, trials: int = 60, seed: int = 42) -> BenchmarkReport:
    """Evaluate Naive HTTP-200 vs MCP Guard verifier deterministically over real FaultInjector cases."""
    injector = FaultInjector(seed=seed)
    fault_ids = list(FAULT_CATALOG.keys())
    clean_count = max(1, trials // 5)
    fault_trials = max(len(fault_ids), trials - clean_count)
    actual_total = fault_trials + clean_count

    per_fault: dict[str, dict[str, Any]] = {
        fid: {"trials": 0, "naive_slipped": 0, "mcp_guard_caught": 0} for fid in fault_ids
    }
    naive_slipped = 0
    guard_slipped = 0
    guard_false_alarms = 0

    for i in range(fault_trials):
        fid = fault_ids[i % len(fault_ids)]
        resp = injector.inject(fid, payload={"tool": "mcp_bench", "trial": i})
        req_keys = ["id", "status"] if fid == "schema_drift" else []

        naive_thinks_ok = naive_http_200_verifier(resp)
        guard_failed, _ = _detect_tool_failure(resp, req_keys)

        per_fault[fid]["trials"] += 1
        if naive_thinks_ok:
            naive_slipped += 1
            per_fault[fid]["naive_slipped"] += 1
        if guard_failed:
            per_fault[fid]["mcp_guard_caught"] += 1
        else:
            guard_slipped += 1

    for j in range(clean_count):
        clean_resp = {
            "ok": True,
            "status_code": 200,
            "body": {"id": f"rec-{j}", "status": "active", "count": j + 1},
        }
        guard_failed, _ = _detect_tool_failure(clean_resp, ["id", "status"])
        if guard_failed:
            guard_false_alarms += 1

    naive_slip_pct = round((naive_slipped / fault_trials) * 100.0, 1) if fault_trials else 0.0
    naive_catch_pct = round(100.0 - naive_slip_pct, 1)
    guard_catch_pct = round(((fault_trials - guard_slipped) / fault_trials) * 100.0, 1) if fault_trials else 100.0

    return BenchmarkReport(
        trials=actual_total,
        seed=seed,
        faulted_trials=fault_trials,
        clean_trials=clean_count,
        naive_slipped_failures=naive_slipped,
        naive_slip_rate_pct=naive_slip_pct,
        naive_catch_rate_pct=naive_catch_pct,
        mcp_guard_slipped_failures=guard_slipped,
        mcp_guard_false_alarms=guard_false_alarms,
        mcp_guard_catch_rate_pct=guard_catch_pct,
        per_fault=per_fault,
    )
