#!/usr/bin/env python3
"""Plan locally; publish immutable Tigris artifacts only with --publish."""

from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import copy
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request

HERE = Path(__file__).resolve().parent
DEFAULT_MANIFEST = HERE.parent / "site/public/releases.json"
DEFAULT_ENDPOINT = "https://t3.storage.dev"
ENDPOINTS = (DEFAULT_ENDPOINT, "https://fly.storage.tigris.dev")
MAX_SIZE = 5 * 1024**3  # Single PutObject; larger artifacts need multipart support.
MAX_MANIFEST = 4 * 1024**2
CHUNK = 1024**2
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+){1,3}(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?")


class PublishError(Exception):
    """Safe, purpose-written diagnostic; never raw credential/HTTP/SDK output."""


def validate_manifest(manifest):
    try:
        result = subprocess.run(
            ["node", str(HERE / "validate-manifest.mjs")],
            input=json.dumps(manifest), text=True, capture_output=True, timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise PublishError("Node.js is required to run the download page validator.") from None
    if result.returncode:
        raise PublishError("Release manifest does not satisfy the download page schema.")


def read_manifest(path):
    if path.is_symlink():
        raise PublishError("The manifest must be a regular file, not a symlink.")
    try:
        with path.open("rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise PublishError("The manifest must be a regular file.")
            raw = source.read(MAX_MANIFEST + 1)
        if len(raw) > MAX_MANIFEST:
            raise PublishError("Release manifest exceeds the size limit.")
        manifest = json.loads(raw)
    except (OSError, ValueError):
        raise PublishError("Cannot read the existing release manifest as JSON.") from None
    validate_manifest(manifest)
    return raw, manifest


def public_base(value):
    try:
        url = urlsplit(value)
        host = url.hostname or ""
        if (url.scheme != "https" or not host or "." not in host or
                url.username is not None or url.password is not None or
                url.port is not None or url.query or url.fragment or
                host == "localhost" or host.endswith(".localhost") or
                not re.fullmatch(r"[A-Za-z0-9.-]+", host) or url.path not in ("", "/")):
            raise ValueError()
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError()
    except ValueError:
        raise PublishError("Public base must be the bucket's HTTPS DNS origin, without credentials, path, port, query, or fragment.") from None
    return value.rstrip("/")


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def artifact_hashes(path):
    try:
        with path.open("rb") as source:
            before = os.fstat(source.fileno())
            if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_SIZE:
                raise PublishError("Artifact must be a nonempty regular file no larger than 5 GiB.")
            sha256, md5 = hashlib.sha256(), hashlib.md5(usedforsecurity=False)
            size = 0
            while chunk := source.read(CHUNK):
                size += len(chunk)
                if size > MAX_SIZE:
                    raise PublishError("Artifact grew beyond the 5 GiB limit during hashing.")
                sha256.update(chunk)
                md5.update(chunk)
            if fingerprint(before) != fingerprint(os.fstat(source.fileno())) or size != before.st_size:
                raise PublishError("Artifact changed during hashing; finish packaging before publishing.")
    except OSError:
        raise PublishError("Cannot read the artifact file.") from None
    return size, sha256.hexdigest(), base64.b64encode(md5.digest()).decode("ascii"), fingerprint(before)


def format_suffix(filename):
    return ".tar.xz" if filename.endswith(".tar.xz") else Path(filename).suffix


def add_artifact(manifest, version, artifact):
    updated = copy.deepcopy(manifest)
    release = next((item for item in updated["releases"] if item["version"] == version), None)
    if release is None:
        release = {"version": version, "publishedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"), "artifacts": []}
        updated["releases"].append(release)
    slot = (artifact["platform"], artifact["arch"], format_suffix(artifact["filename"]))
    for existing in release["artifacts"]:
        if (existing["platform"], existing["arch"], format_suffix(existing["filename"])) == slot:
            if existing == artifact:
                return updated, False
            raise PublishError("This release already contains a different artifact for that platform, architecture, and format; use a new version.")
    release["artifacts"].append(artifact)
    validate_manifest(updated)
    return updated, True


@dataclass(frozen=True)
class Plan:
    path: Path
    manifest_path: Path
    version: str
    bucket: str
    endpoint: str
    key: str
    artifact: dict
    content_md5: str
    file_fingerprint: tuple
    manifest_changes: bool

    def summary(self):
        return {"bucket": self.bucket, "endpoint": self.endpoint, "key": self.key,
                "version": self.version, "artifact": self.artifact,
                "manifestChanges": self.manifest_changes}


def make_plan(path, *, manifest_path=DEFAULT_MANIFEST, version, platform, arch,
              bucket, base_url, endpoint=DEFAULT_ENDPOINT):
    if not isinstance(version, str) or len(version) > 40 or not VERSION.fullmatch(version):
        raise PublishError("Version must match the download page version format.")
    if platform not in ("macos", "windows", "linux") or arch not in ("arm64", "x64"):
        raise PublishError("Unsupported platform or architecture.")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket) or ".." in bucket:
        raise PublishError("Bucket must be an existing S3 DNS-style bucket name.")
    if endpoint not in ENDPOINTS:
        raise PublishError("Endpoint must be the canonical or legacy Tigris HTTPS endpoint.")
    base_url = public_base(base_url)
    path, manifest_path = Path(path).absolute(), Path(manifest_path).absolute()
    _, manifest = read_manifest(manifest_path)
    size, sha256, content_md5, file_fingerprint = artifact_hashes(path)
    filename = path.name
    key = f"{version}/{platform}/{arch}/{sha256}/{filename}"
    artifact = {"platform": platform, "arch": arch, "filename": filename,
                "url": f"{base_url}/{key}", "sha256": sha256, "size": size}
    _, changed = add_artifact(manifest, version, artifact)
    return Plan(path, manifest_path, version, bucket, endpoint, key, artifact,
                content_md5, file_fingerprint, changed)


def s3_client(endpoint):
    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        raise PublishError("Publishing requires boto3; install still/release/requirements.txt first.") from None
    try:
        # The SDK resolves environment/profile/role credentials. No credential CLI flags.
        return boto3.session.Session().client(
            "s3", endpoint_url=endpoint, region_name="auto",
            config=Config(signature_version="s3v4", connect_timeout=20, read_timeout=120,
                          retries={"mode": "standard", "max_attempts": 3},
                          request_checksum_calculation="when_required",
                          response_checksum_validation="when_required"),
        )
    except Exception:
        raise PublishError("Cannot initialize Tigris SDK credentials/configuration.") from None


def error_matches(error, codes, status):
    response = getattr(error, "response", {})
    return (response.get("Error", {}).get("Code") in codes or
            response.get("ResponseMetadata", {}).get("HTTPStatusCode") == status)


def upload_immutable(plan, client):
    try:
        head = client.head_object(Bucket=plan.bucket, Key=plan.key)
    except Exception as error:
        if not error_matches(error, ("404", "NoSuchKey", "NotFound"), 404):
            raise PublishError("Cannot check the existing Tigris object; no overwrite attempted.") from None
    else:
        if head.get("ContentLength") != plan.artifact["size"]:
            raise PublishError("An existing immutable object has a different size; it was preserved.")
        return "existing"
    try:
        with plan.path.open("rb") as source:
            if fingerprint(os.fstat(source.fileno())) != plan.file_fingerprint:
                raise PublishError("Artifact changed after planning; no upload attempted.")
            client.put_object(
                Bucket=plan.bucket, Key=plan.key, Body=source,
                ContentLength=plan.artifact["size"], ContentMD5=plan.content_md5,
                ContentType="application/octet-stream",
                ContentDisposition=f'attachment; filename="{plan.artifact["filename"]}"',
                CacheControl="public, max-age=31536000, immutable",
                Metadata={"sha256": plan.artifact["sha256"]}, IfNoneMatch="*",
            )
            if fingerprint(os.fstat(source.fileno())) != plan.file_fingerprint:
                raise PublishError("Artifact changed during upload; manifest left unchanged.")
    except PublishError:
        raise
    except Exception as error:
        if error_matches(error, ("PreconditionFailed", "412"), 412):
            return "existing"  # Another writer won; public bytes must still match.
        raise PublishError("Tigris upload failed; manifest left unchanged. Existing objects were not overwritten.") from None
    return "uploaded"


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise PublishError("Public download redirects; supply the final stable HTTPS base URL.")


def verify_public(artifact, opener=None):
    opener = opener or build_opener(NoRedirects())
    request = Request(artifact["url"], headers={"Accept-Encoding": "identity", "Cache-Control": "no-cache"})
    try:
        with opener.open(request, timeout=60) as response:
            if response.status != 200 or response.headers.get("Content-Encoding", "identity") != "identity":
                raise PublishError("Public download did not return an unencoded HTTP 200 artifact.")
            length = response.headers.get("Content-Length")
            if length is not None and (not length.isdigit() or int(length) != artifact["size"]):
                raise PublishError("Public download size does not match the local artifact.")
            sha256, size = hashlib.sha256(), 0
            while chunk := response.read(min(CHUNK, artifact["size"] - size + 1)):
                size += len(chunk)
                if size > artifact["size"]:
                    raise PublishError("Public download exceeds the expected artifact size.")
                sha256.update(chunk)
            if size != artifact["size"] or sha256.hexdigest() != artifact["sha256"]:
                raise PublishError("Public download bytes do not match the local SHA-256 and size.")
    except PublishError:
        raise
    except Exception:
        raise PublishError("Public HTTPS download verification failed; manifest left unchanged.") from None


@contextmanager
def manifest_lock(path):
    lock = path.with_name(path.name + ".publish.lock")
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise PublishError("Another publisher holds the manifest lock; retry after it finishes.") from None
    try:
        os.close(descriptor)
        yield
    finally:
        lock.unlink()


def atomic_manifest_write(path, original, manifest):
    temporary = None
    try:
        if path.is_symlink() or path.read_bytes() != original:
            raise PublishError("Manifest changed during publication; refusing to replace it.")
        mode = stat.S_IMODE(path.stat().st_mode)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".releases-", suffix=".json.tmp", delete=False) as output:
            temporary = Path(output.name)
            json.dump(manifest, output, indent=2, ensure_ascii=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
            os.fchmod(output.fileno(), mode)
        if path.is_symlink() or path.read_bytes() != original:
            raise PublishError("Manifest changed during publication; refusing to replace it.")
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def publish(plan, client=None, verifier=verify_public):
    # The lock serializes cooperating publishers, including across atomic renames.
    with manifest_lock(plan.manifest_path):
        original, current = read_manifest(plan.manifest_path)
        updated, changed = add_artifact(current, plan.version, plan.artifact)
        outcome = upload_immutable(plan, client if client is not None else s3_client(plan.endpoint))
        verifier(plan.artifact)
        if changed:
            atomic_manifest_write(plan.manifest_path, original, updated)
        return {"object": outcome, "manifestUpdated": changed}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--platform", required=True, choices=("macos", "windows", "linux"))
    parser.add_argument("--arch", required=True, choices=("arm64", "x64"))
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--public-base-url", required=True)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, choices=ENDPOINTS)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--publish", action="store_true", help="upload, verify public bytes, then update local manifest")
    action.add_argument("--dry-run", action="store_true", help="default: local plan only, no network or manifest writes")
    args = parser.parse_args(argv)
    try:
        plan = make_plan(args.artifact, version=args.version, platform=args.platform,
                         arch=args.arch, bucket=args.bucket, base_url=args.public_base_url,
                         endpoint=args.endpoint, manifest_path=args.manifest)
        result = {"mode": "publish" if args.publish else "dry-run", **plan.summary()}
        if args.publish:
            result.update(publish(plan))
        print(json.dumps(result, indent=2))
        return 0
    except PublishError as error:
        print(f"Publication stopped: {error}", file=sys.stderr)
    except OSError:
        print("Publication stopped: local file operation failed; inspect the manifest before retrying.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
