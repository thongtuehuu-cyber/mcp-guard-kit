"""Build local, apply-checked README patches pinned to public upstream commits."""

import argparse
import difflib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from zipfile import ZipFile, ZIP_DEFLATED

import requests


PROJECT = "https://github.com/thongtuehuu-cyber/mcp-guard-kit"
TEXT = "Python CLI for verifying MCP tool results and benchmarking silent failures with reproducible fixtures."
BADGE = f"![GitHub Repo stars](https://img.shields.io/github/stars/thongtuehuu-cyber/mcp-guard-kit)"
TARGETS = [
    ("punkpeye/awesome-mcp-devtools", "## Testing Tools", f"- [MCP Guard Kit]({PROJECT}) 🐍 - {TEXT}", False),
    ("Christian-Sidak/awesome-mcp-tools", "## Testing and Debugging", f"- [MCP Guard Kit]({PROJECT}) - {TEXT} {BADGE}", True),
    ("cleder/awesome-python-testing", "## LLM & MCP Testing", f"- [mcp-guard-kit]({PROJECT}) - {TEXT}", True),
    ("kyrolabs/awesome-agents", "## Testing and Evaluation", f"- [MCP Guard Kit]({PROJECT}): {TEXT} {BADGE}", False),
]


def build(output):
    session = requests.Session()
    session.headers["User-Agent"] = "MCPGuard-Directory-Preparation"
    manifest = []
    files = {}
    for repo, heading, entry, alphabetical in TARGETS:
        commit = session.get(f"https://api.github.com/repos/{repo}/commits/HEAD", timeout=10)
        commit.raise_for_status()
        sha = commit.json()["sha"]
        raw = f"https://raw.githubusercontent.com/{repo}/{sha}/"
        r = session.get(raw + "README.md", timeout=12)
        r.raise_for_status()
        original = r.content.decode("utf-8")
        lines = original.splitlines(keepends=True)
        start = next(i for i, line in enumerate(lines) if line.rstrip() == heading)
        end = next((i for i in range(start+1, len(lines)) if lines[i].startswith("#")), len(lines))
        if PROJECT.lower() in original.lower():
            raise ValueError(f"{repo} already lists the project")
        entries = [i for i in range(start+1, end) if lines[i].startswith(("- [", "* ["))]
        if not entries:
            raise ValueError(f"No matching list under {repo} {heading}")
        pos = entries[-1]+1
        if alphabetical:
            pos = next((i for i in entries if lines[i].split("]",1)[0].lower() > entry.split("]",1)[0].lower()), pos)
        eol = "\r\n" if lines[start].endswith("\r\n") else "\n"
        modified = lines[:pos] + [entry + eol] + lines[pos:]
        patch = "".join(difflib.unified_diff(lines, modified, "a/README.md", "b/README.md"))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "README.md").write_bytes(r.content)
            subprocess.run(["git", "apply", "--check", "-"], input=patch.encode(), cwd=root, check=True)
        guidelines = ""
        for name in ("CONTRIBUTING.md", "contributing.md", ".github/CONTRIBUTING.md"):
            guide = session.get(raw + name, timeout=10)
            if guide.ok:
                guidelines = f"https://github.com/{repo}/blob/{sha}/{name}"
                break
        slug = repo.replace("/", "--")
        files[f"{slug}/README.patch"] = patch
        files[f"{slug}/PULL_REQUEST.md"] = (
            f"# Add MCP Guard Kit to {heading.lstrip('# ')}\n\n"
            f"I maintain [MCP Guard Kit]({PROJECT}). It checks MCP tool responses in Python. "
            "A 60-trial seeded fixture benchmark reproduces 48 injected failures. The README entry links "
            "to the open-source project and its runnable examples.\n\n"
            f"Proposed change: one entry under {heading.lstrip('# ')}.\n"
        )
        manifest.append({"repository": repo, "commit": sha, "section": heading, "guidelines": guidelines,
                         "apply_check": "passed", "submission": "local draft"})
    files["manifest.json"] = json.dumps(manifest, indent=2)
    files["server-directories.md"] = ("The project is a verifier. The punkpeye/awesome-mcp-servers directory "
                                      "lists server implementations; its Tutorials section can link to the n8n "
                                      "walkthrough once the walkthrough has a public URL. Use the development-tools "
                                      "directory for the currently public verifier.\n")
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", ZIP_DEFLATED) as z:
        for name, content in files.items():
            z.writestr(name, content)
    print(f"{len(manifest)} apply-checked proposals: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    build(parser.parse_args().output)
