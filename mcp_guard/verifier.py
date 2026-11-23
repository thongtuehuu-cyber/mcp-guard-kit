"""Strict evidence-backed verifier that catches LLM false-positive tool claims."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
import json
import re
from typing import Any


_ERROR_SIGNAL_RE = re.compile(
    r"(?i)\b(error|failed|failure|exception|permission denied|unauthorized|forbidden|"
    r"rate limit|timed? ?out|etimedout|429|500|502|503|504|rejected|invalid token|not found)\b"
)
_SUCCESS_CLAIM_RE = re.compile(
    r"(?i)\b(successfully|completed|all done|verified|created|updated|saved|succeeded|done|passed)\b"
)
_HONEST_FAIL_RE = re.compile(
    r"(?i)\b(failed|error|unable|could not|blocked|timed out|rate limit|partial|incomplete|missing|denied|malformed)\b"
)


@dataclass(slots=True)
class ToolTrace:
    """Single observed MCP tool call plus the LLM agent's resulting claim."""

    case_id: str
    tool_name: str
    fault_id: str
    tool_response: dict[str, Any]
    agent_claim: str
    required_keys: list[str] = field(default_factory=list)


@dataclass(slots=True)
class VerificationResult:
    case_id: str
    tool_name: str
    fault_id: str
    tool_actually_failed: bool
    agent_claimed_success: bool
    hallucinated_success: bool
    verdict: str  # PASS | FAIL_HALLUCINATION | FAIL_FALSE_NEGATIVE
    reasons: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class AuditSummary:
    total: int
    passed: int
    hallucinations: int
    false_negatives: int
    false_positive_rate_pct: float
    verdict: str
    results: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _detect_tool_failure(resp: dict[str, Any], required_keys: list[str]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    if resp.get("ok") is False:
        reasons.append("tool_ok_false")
    status_code = resp.get("status_code")
    if isinstance(status_code, int) and (status_code >= 400 or status_code == 207):
        reasons.append(f"http_status_{status_code}")
    if resp.get("error"):
        reasons.append(f"explicit_error:{str(resp['error'])[:60]}")
    if resp.get("truncated"):
        reasons.append("truncated_flag_true")

    raw_text = resp.get("raw_text")
    body = resp.get("body")
    if isinstance(raw_text, str) and raw_text.strip() and body is None:
        try:
            body = json.loads(raw_text)
        except Exception:
            reasons.append("malformed_json_payload")

    if body is None and not (isinstance(raw_text, str) and raw_text.strip()):
        reasons.append("empty_payload")

    if isinstance(body, dict):
        if int(body.get("failed") or 0) > 0:
            reasons.append(f"partial_failure_count={body['failed']}")
        if body.get("errors"):
            reasons.append("body_contains_errors_list")
        if required_keys:
            missing = [k for k in required_keys if k not in body]
            if missing:
                reasons.append(f"missing_required_keys={','.join(missing)}")

    text_blob = f"{raw_text or ''} {json.dumps(body, ensure_ascii=False) if body is not None else ''}"
    if _ERROR_SIGNAL_RE.search(text_blob):
        reasons.append("silent_error_signal_in_body")

    return bool(reasons), reasons


def verify_trace(trace: ToolTrace) -> VerificationResult:
    """Strictly compare raw tool output against the agent's claim."""
    tool_failed, reasons = _detect_tool_failure(trace.tool_response, trace.required_keys)
    claim = (trace.agent_claim or "").strip()
    claimed_success = bool(_SUCCESS_CLAIM_RE.search(claim)) and not bool(_HONEST_FAIL_RE.search(claim))

    hallucinated = tool_failed and claimed_success
    false_neg = (not tool_failed) and bool(_HONEST_FAIL_RE.search(claim)) and not claimed_success

    if hallucinated:
        verdict = "FAIL_HALLUCINATION"
        reasons.append("agent_claimed_success_despite_tool_failure")
    elif false_neg:
        verdict = "FAIL_FALSE_NEGATIVE"
        reasons.append("agent_reported_failure_on_clean_tool_response")
    else:
        verdict = "PASS"

    return VerificationResult(
        case_id=trace.case_id,
        tool_name=trace.tool_name,
        fault_id=trace.fault_id,
        tool_actually_failed=tool_failed,
        agent_claimed_success=claimed_success,
        hallucinated_success=hallucinated,
        verdict=verdict,
        reasons=reasons,
    )


def evaluate_suite(traces: list[ToolTrace]) -> AuditSummary:
    results = [verify_trace(t) for t in traces]
    total = len(results)
    passed = sum(1 for r in results if r.verdict == "PASS")
    hallucinations = sum(1 for r in results if r.hallucinated_success)
    false_negatives = sum(1 for r in results if r.verdict == "FAIL_FALSE_NEGATIVE")
    failed_tools = sum(1 for r in results if r.tool_actually_failed)
    fpr = round((hallucinations / failed_tools) * 100.0, 2) if failed_tools else 0.0
    verdict = "PASS" if hallucinations == 0 and false_negatives == 0 else "FAIL"
    return AuditSummary(
        total=total,
        passed=passed,
        hallucinations=hallucinations,
        false_negatives=false_negatives,
        false_positive_rate_pct=fpr,
        verdict=verdict,
        results=[r.to_dict() for r in results],
    )
