#!/usr/bin/env python3
"""Download pinned, checksum-verified evaluation assets; never used at inference."""

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

MODELS = {
    "smol": ("onnx-community/SmolLM2-135M-Instruct-ONNX", ["onnx/model_quantized.onnx"]),
    "qwen": ("onnx-community/Qwen3.5-0.8B-ONNX-OPT", [
        "onnx/embed_tokens_q4.onnx", "onnx/embed_tokens_q4.onnx_data",
        "onnx/decoder_model_merged_q4.onnx", "onnx/decoder_model_merged_q4.onnx_data",
    ]),
}
ROOT = Path(__file__).resolve().parent


def get_json(url):
    result = subprocess.run(["curl", "-fLsS", "--retry", "3", "--max-time", "90", url],
                            check=True, capture_output=True)
    return json.loads(result.stdout)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    alias = sys.argv[1] if len(sys.argv) == 2 else ""
    if alias not in MODELS:
        raise SystemExit("usage: python3 fetch-model.py smol|qwen")
    repo, weights = MODELS[alias]
    dest = ROOT / "models" / alias
    dest.mkdir(parents=True, exist_ok=True)
    manifest_path = dest / "asset-manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    else:
        metadata = get_json(f"https://huggingface.co/api/models/{repo}")
        revision = metadata["sha"]
        entries = get_json(f"https://huggingface.co/api/models/{repo}/tree/{revision}?recursive=true")
        wanted = {"config.json", "generation_config.json", "tokenizer_config.json",
                  "tokenizer.json", "special_tokens_map.json", "chat_template.jinja",
                  "README.md", "LICENSE", *weights}
        files = [entry for entry in entries if entry["type"] == "file" and entry["path"] in wanted]
        if not set(weights).issubset({entry["path"] for entry in files}):
            raise RuntimeError("Repository is missing expected weight files")
        if sum(entry["size"] for entry in files) > 900_000_000:
            raise RuntimeError("Unexpectedly large download")
        manifest = {"repository": repo, "revision": revision, "files": files}
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    for entry in manifest["files"]:
        relative = Path(entry["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError("Invalid asset path")
        path = dest / relative
        expected = entry.get("lfs", {}).get("oid")
        if path.exists() and path.stat().st_size == entry["size"]:
            if not expected or digest(path) == expected:
                print(f"cached {alias}/{relative}", flush=True)
                continue
        if shutil.disk_usage(ROOT).free < 15 * 1024**3:
            raise RuntimeError("Preserving 15 GiB free for the browser build")
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".part")
        url = f"https://huggingface.co/{repo}/resolve/{manifest['revision']}/{relative.as_posix()}"
        print(f"fetch {alias}/{relative} ({entry['size']:,} bytes)", flush=True)
        subprocess.run(["curl", "-fL", "--retry", "3", "--max-time", "1800", "-o", str(temporary), url], check=True)
        if temporary.stat().st_size != entry["size"]:
            raise RuntimeError(f"Incorrect size: {relative}")
        if expected and digest(temporary) != expected:
            raise RuntimeError(f"Incorrect SHA256: {relative}")
        temporary.replace(path)
    print(f"Ready: {dest}; inference may now run offline.", flush=True)


if __name__ == "__main__":
    main()
