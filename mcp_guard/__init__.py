"""MCP Guard Kit — Fault-Injection & Anti-Hallucination Verifier for MCP Servers & AI Agents."""

from .benchmark import BenchmarkReport, naive_http_200_verifier, run_empirical_benchmark
from .faults import FAULT_CATALOG, FaultMode, FaultInjector
from .verifier import ToolTrace, VerificationResult, AuditSummary, verify_trace, evaluate_suite
from .runner import run_builtin_chaos_suite, render_markdown_report, render_html_report

__version__ = "1.1.0"

__all__ = [
    "__version__",
    "FAULT_CATALOG",
    "FaultMode",
    "FaultInjector",
    "ToolTrace",
    "VerificationResult",
    "AuditSummary",
    "BenchmarkReport",
    "naive_http_200_verifier",
    "run_empirical_benchmark",
    "verify_trace",
    "evaluate_suite",
    "run_builtin_chaos_suite",
    "render_markdown_report",
    "render_html_report",
]
