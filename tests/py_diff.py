"""Run each (code, inputs) case with the real Python interpreter and report stdout + error.

Reads a JSON list of {"code": str, "inputs": [str]} on stdin and writes a JSON list of
{"stdout": str, "error": {"type", "line", "msg"} | null} to stdout.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

cases = json.load(sys.stdin)
out = []
with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, "prog.py")
    for c in cases:
        with open(path, "w", encoding="utf-8") as f:
            f.write(c["code"])
        stdin = "".join(v + "\n" for v in c["inputs"])
        p = subprocess.run([sys.executable, "-I", path], input=stdin, capture_output=True, text=True, timeout=10)
        err = None
        if p.returncode != 0:
            lines = [l for l in p.stderr.strip().split("\n") if l.strip()]
            last = lines[-1] if lines else ""
            m = re.match(r"^(\w+(?:Error|Exception)?): ?(.*)$", last)
            lines_no = re.findall(r'File "[^"]*", line (\d+)', p.stderr)
            err = {
                "type": m.group(1) if m else last,
                "msg": m.group(2) if m else "",
                "line": int(lines_no[-1]) if lines_no else None,
            }
        out.append({"stdout": p.stdout, "error": err})
json.dump(out, sys.stdout)
