import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import publish as publisher


class S3Error(Exception):
    def __init__(self, code, status):
        super().__init__("do-not-print-private-sdk-details")
        self.response = {"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}}


class FakeS3:
    def __init__(self, data=None, put_error=None):
        self.data = data
        self.put_error = put_error
        self.puts = []

    def head_object(self, **kwargs):
        if self.data is None:
            raise S3Error("NoSuchKey", 404)
        return {"ContentLength": len(self.data)}

    def put_object(self, **kwargs):
        self.puts.append({key: value for key, value in kwargs.items() if key != "Body"})
        if self.put_error:
            raise self.put_error
        self.data = kwargs["Body"].read()


class Response(io.BytesIO):
    def __init__(self, data, *, headers=None, status=200):
        super().__init__(data)
        self.headers = headers if headers is not None else {"Content-Length": str(len(data))}
        self.status = status


class Opener:
    def __init__(self, data, **kwargs):
        self.data, self.kwargs = data, kwargs

    def open(self, request, timeout):
        assert request.full_url.startswith("https://")
        assert not request.has_header("Authorization")
        assert request.get_header("Accept-encoding") == "identity"
        return Response(self.data, **self.kwargs)


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manifest = self.root / "releases.json"
        self.manifest.write_text('{"schemaVersion":1,"releases":[]}\n')
        self.original = self.manifest.read_bytes()
        self.path = self.root / "Still-0.1.0-macos-arm64.dmg"
        self.data = b"test fixture, not a browser executable\x00\xff"
        self.path.write_bytes(self.data)

    def plan(self, **changes):
        arguments = {"version": "0.1.0", "platform": "macos", "arch": "arm64",
                     "bucket": "still-artifacts", "base_url": "https://downloads.example.com",
                     "manifest_path": self.manifest}
        arguments.update(changes)
        return publisher.make_plan(self.path, **arguments)

    def verify(self, artifact):
        publisher.verify_public(artifact, Opener(self.data))

    def assert_unchanged(self):
        self.assertEqual(self.manifest.read_bytes(), self.original)
        self.assertFalse(self.manifest.with_name("releases.json.publish.lock").exists())

    def test_plan_and_default_cli_are_local_with_real_hashes(self):
        plan = self.plan()
        digest = hashlib.sha256(self.data).hexdigest()
        self.assertEqual(plan.artifact["sha256"], digest)
        self.assertEqual(plan.artifact["size"], len(self.data))
        self.assertEqual(plan.key, f"0.1.0/macos/arm64/{digest}/{self.path.name}")
        with patch.object(publisher, "s3_client", side_effect=AssertionError("network must not start")):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                status = publisher.main([str(self.path), "--version", "0.1.0", "--platform", "macos",
                                         "--arch", "arm64", "--bucket", "still-artifacts",
                                         "--public-base-url", "https://downloads.example.com",
                                         "--manifest", str(self.manifest)])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output.getvalue())["mode"], "dry-run")
        self.assert_unchanged()

    def test_reuses_site_schema_for_formats_fields_and_existing_manifest(self):
        for arguments in ({"version": "../bad"}, {"platform": "windows"}, {"arch": "i386"},
                          {"base_url": "http://downloads.example.com"},
                          {"base_url": "https://key:secret@downloads.example.com"},
                          {"base_url": "https://downloads.example.com?secret=1"},
                          {"base_url": "https://downloads.example.com/mismatched-key-prefix"},
                          {"base_url": "https://127.0.0.1"},
                          {"endpoint": "https://untrusted.example.com"}):
            with self.subTest(arguments=arguments), self.assertRaises(publisher.PublishError):
                self.plan(**arguments)
        self.path = self.root / "Other-0.1.0.dmg"
        self.path.write_bytes(self.data)
        with self.assertRaises(publisher.PublishError):
            self.plan()
        self.assert_unchanged()
        self.manifest.write_text('{"schemaVersion":1,"releases":[{"version":"broken"}]}')
        with self.assertRaises(publisher.PublishError):
            self.plan()

    def test_publish_conditionally_creates_and_commits_only_after_verification(self):
        plan, client = self.plan(), FakeS3()
        observed = []

        def verify_before_commit(artifact):
            self.assertEqual(client.data, self.data)
            self.assertEqual(self.manifest.read_bytes(), self.original)
            self.verify(artifact)
            observed.append(True)

        result = publisher.publish(plan, client, verify_before_commit)
        self.assertEqual(result, {"object": "uploaded", "manifestUpdated": True})
        self.assertEqual(observed, [True])
        self.assertEqual(client.puts[0]["IfNoneMatch"], "*")
        self.assertEqual(client.puts[0]["ContentMD5"], plan.content_md5)
        self.assertNotIn("ACL", client.puts[0])
        self.assertEqual(json.loads(self.manifest.read_text())["releases"][0]["artifacts"], [plan.artifact])
        publisher.validate_manifest(json.loads(self.manifest.read_text()))

    def test_existing_object_and_exact_manifest_duplicate_are_idempotent(self):
        client = FakeS3(self.data)
        publisher.publish(self.plan(), client, self.verify)
        first = self.manifest.read_bytes()
        plan = self.plan()
        self.assertFalse(plan.manifest_changes)
        result = publisher.publish(plan, client, self.verify)
        self.assertEqual(result, {"object": "existing", "manifestUpdated": False})
        self.assertEqual(client.puts, [])
        self.assertEqual(self.manifest.read_bytes(), first)

    def test_same_version_slot_conflict_refuses_replacement(self):
        publisher.publish(self.plan(), FakeS3(self.data), self.verify)
        first = self.manifest.read_bytes()
        self.path.write_bytes(b"different fixture")
        with self.assertRaisesRegex(publisher.PublishError, "use a new version"):
            self.plan()
        self.assertEqual(self.manifest.read_bytes(), first)

    def test_other_architecture_appends_without_replacing_existing(self):
        publisher.publish(self.plan(), FakeS3(self.data), self.verify)
        first = json.loads(self.manifest.read_text())["releases"][0]
        publisher.publish(self.plan(arch="x64"), FakeS3(self.data), self.verify)
        release = json.loads(self.manifest.read_text())["releases"][0]
        self.assertEqual(release["artifacts"][0], first["artifacts"][0])
        self.assertEqual(release["publishedAt"], first["publishedAt"])
        self.assertEqual(len(release["artifacts"]), 2)

    def test_s3_failure_and_bad_existing_objects_never_mutate_manifest(self):
        for client in (FakeS3(put_error=S3Error("AccessDenied", 403)), FakeS3(b"wrong size"),
                       FakeS3(b"x" * len(self.data)),
                       FakeS3(put_error=S3Error("ConditionalRequestConflict", 409))):
            with self.subTest(client=client), self.assertRaises(publisher.PublishError) as caught:
                publisher.publish(self.plan(), client,
                                  lambda artifact: publisher.verify_public(artifact, Opener(client.data)))
            self.assertNotIn("do-not-print-private-sdk-details", str(caught.exception))
            self.assert_unchanged()

    def test_public_failure_after_upload_leaves_object_and_manifest_untouched(self):
        client = FakeS3()
        with self.assertRaises(publisher.PublishError):
            publisher.publish(self.plan(), client,
                              lambda artifact: publisher.verify_public(artifact, Opener(b"wrong public bytes")))
        self.assertEqual(client.data, self.data)
        self.assertEqual(len(client.puts), 1)
        self.assert_unchanged()

    def test_empty_and_oversize_artifacts_fail_locally(self):
        for size in (0, publisher.MAX_SIZE + 1):
            with self.path.open("wb") as artifact:
                artifact.truncate(size)
            with self.subTest(size=size), self.assertRaises(publisher.PublishError):
                self.plan()
            self.assert_unchanged()

    def test_concurrent_object_creation_preserved_then_verified(self):
        client = FakeS3(put_error=S3Error("PreconditionFailed", 412))
        result = publisher.publish(self.plan(), client, self.verify)
        self.assertEqual(result["object"], "existing")
        self.assertEqual(client.puts[0]["IfNoneMatch"], "*")

    def test_changed_artifact_and_manifest_are_not_silently_published(self):
        plan = self.plan()
        self.path.write_bytes(b"changed")
        with self.assertRaisesRegex(publisher.PublishError, "changed after planning"):
            publisher.publish(plan, FakeS3(), self.verify)
        self.assert_unchanged()
        self.path.write_bytes(self.data)
        external_edit = b'{"schemaVersion": 1, "releases": []}\n'

        def edit_manifest(artifact):
            self.verify(artifact)
            self.manifest.write_bytes(external_edit)

        with self.assertRaisesRegex(publisher.PublishError, "Manifest changed"):
            publisher.publish(self.plan(), FakeS3(), edit_manifest)
        self.assertEqual(self.manifest.read_bytes(), external_edit)

    def test_failed_atomic_replace_leaves_original_and_removes_temporary(self):
        with patch.object(publisher.os, "replace", side_effect=OSError("test disk error")):
            with self.assertRaises(OSError):
                publisher.publish(self.plan(), FakeS3(), self.verify)
        self.assert_unchanged()
        self.assertEqual(list(self.root.glob(".releases-*")), [])

    def test_lock_prevents_competing_publication(self):
        with publisher.manifest_lock(self.manifest):
            with self.assertRaisesRegex(publisher.PublishError, "Another publisher"):
                publisher.publish(self.plan(), FakeS3(), self.verify)
        self.assert_unchanged()

    def test_public_verification_rejects_partial_extra_wrong_encoded_or_redirected_bytes(self):
        artifact = self.plan().artifact
        cases = [(self.data[:-1], {}), (self.data + b"extra", {"headers": {}}),
                 (b"x" * len(self.data), {}), (self.data, {"status": 206}),
                 (self.data, {"headers": {"Content-Encoding": "gzip"}})]
        for data, kwargs in cases:
            with self.subTest(kwargs=kwargs), self.assertRaises(publisher.PublishError):
                publisher.verify_public(artifact, Opener(data, **kwargs))
        with self.assertRaises(publisher.PublishError):
            publisher.NoRedirects().redirect_request(None, None, 302, "", {}, "http://example.com")
        self.assert_unchanged()


if __name__ == "__main__":
    unittest.main()
