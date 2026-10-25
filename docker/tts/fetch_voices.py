"""Build step: download the pinned Piper voices and verify every byte.

Run once in the Dockerfile (network at BUILD time only — the running sidecar
never fetches anything). Each file is checked against the sha256 pinned in
voices.json; any mismatch fails the image build.
"""
from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
from pathlib import Path

BASE = "https://huggingface.co/rhasspy/piper-voices/resolve"


def fetch(url: str, dest: Path, sha256: str) -> None:
    h = hashlib.sha256()
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as resp, tmp.open("wb") as out:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            out.write(chunk)
    if h.hexdigest() != sha256:
        tmp.unlink(missing_ok=True)
        sys.exit(f"sha256 mismatch for {url}: {h.hexdigest()} != {sha256}")
    tmp.rename(dest)


def main(manifest: str, out_dir: str) -> None:
    spec = json.loads(Path(manifest).read_text())
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for v in spec["voices"]:
        stem = f"{BASE}/{spec['revision']}/{v['path']}/{v['id']}"
        fetch(f"{stem}.onnx", out / f"{v['id']}.onnx", v["onnx_sha256"])
        fetch(f"{stem}.onnx.json", out / f"{v['id']}.onnx.json", v["json_sha256"])
        print(f"ok {v['id']}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
