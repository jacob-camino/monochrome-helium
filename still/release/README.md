# Still artifact publisher

`publish.py` creates a local plan by default. It reads the finished artifact,
computes its actual size and SHA-256, and checks the prospective release with
the **same `releases.mjs` module used by the download page**. Dry runs need
Python 3.10+ and Node.js, and make no network requests or file changes.

Run from the repository root, substituting an actual finished artifact and
an existing bucket/public base URL:

```sh
python3 still/release/publish.py /path/to/Still-0.1.0-macos-arm64.dmg \
  --version 0.1.0 --platform macos --arch arm64 \
  --bucket your-existing-bucket \
  --public-base-url https://your-bucket.t3.tigrisfiles.io \
  --dry-run
```

The example describes the expected arguments; it is not a claim that this
artifact or bucket exists. Formats and version syntax are documented in
[`../site/README.md`](../site/README.md). The public base must be the HTTPS
origin serving the bucket root, such as `https://downloads.example.com`.
Path prefixes are rejected to avoid discrepancies between object keys and URLs.

## Publishing

Install the declared SDK dependency in an isolated environment when ready:

```sh
python3 -m venv still/release/.venv
still/release/.venv/bin/python -m pip install -r still/release/requirements.txt
```

Use that environment's Python and replace `--dry-run` with `--publish` to
perform the upload. Authentication uses the standard boto3 credential chain
(environment, AWS profile, or role). There are no credential arguments or
embedded credentials. The tool does not print SDK/HTTP exception contents.

The default S3 endpoint is `https://t3.storage.dev`, region `auto`.
`--endpoint https://fly.storage.tigris.dev` supports existing Fly configurations.
These reach the same Tigris service. The explicit endpoint takes precedence
over SDK endpoint environment variables. The public download base is separate
and must be supplied explicitly. [Fly's Tigris endpoint and public bucket documentation](https://docs.fly.io/tigris/)

The publisher requires an already public bucket or an already working public
custom domain. It never creates buckets, changes ACLs, authenticates a Fly
session, changes DNS, or deploys the website.

## Publication order and immutability

1. Validate existing metadata and the candidate artifact. This publisher
   refuses malformed existing entries instead of silently dropping them.
2. Check the content-addressed object key, relative to the bucket root:
   `version/platform/arch/sha256/filename`.
3. Upload only if absent, using `PutObject` with `IfNoneMatch="*"` and
   `ContentMD5`. Existing objects are preserved, including a concurrent
   writer's object. A failed conditional write never falls back to an
   unconditional overwrite. Files use an attachment disposition and an
   immutable one-year cache header.
4. Fetch the **entire public HTTPS URL without credentials** and verify its
   byte count and SHA-256 against the local plan. Redirects, partial responses,
   content encoding, missing bytes, and hash mismatches stop publication.
   Object metadata and ETags are not used as substitutes for this check.
5. Only after verification, atomically replace the local canonical
   `still/site/public/releases.json`, preserving all other entries. No
   website staging or deployment happens automatically.

Conditional writes are supported by Tigris and boto3's standard S3 API.
[Tigris conditional write support](https://www.tigrisdata.com/features/)
[Boto3 `put_object` reference](https://docs.aws.amazon.com/boto3/latest/reference/services/s3/client/put_object.html)

The tool does not overwrite or delete any remote object. A verification or
local-write failure can leave an uploaded object without a manifest entry;
retrying verifies that existing object and completes the local update.
An exact duplicate is a verified no-op. A different artifact for the same
version/platform/architecture/format is rejected; use a new version instead.
Additional platforms, architectures, or formats append to an existing release.

A lock file serializes cooperating local publisher processes, and a manifest
byte comparison detects outside edits before replacement. A hard-killed
publisher may leave `releases.json.publish.lock`; remove that specific lock
only after confirming no publisher is running. Do not manually edit the
manifest while a publish is running. `--manifest` supports an explicit alternate
manifest for release preparation; the default is always the canonical one.

This focused version handles a single `PutObject`, with a **5 GiB artifact
limit**. It does not implement multipart uploads, signing, notarization,
malware scanning, or an updater. Hash verification establishes byte identity;
it does not establish code-signing trust or executable quality.

After a successful real publication, stage the site explicitly with
`python3 still/site/copy-site.py --site-root /path/to/site-checkout`. Deployment
remains a separate step.

## Tests

```sh
python3 -m unittest discover -s still/release/tests -v
```

Tests use temporary fixture files, the real page validator, an in-memory S3
fake, and in-memory public HTTP responses. They test hash/size planning,
schema validation, immutable conflicts, duplicates, verification failures,
concurrent local changes, and failed atomic replacement. They require neither
boto3 nor credentials. **No live Tigris upload has been exercised yet.**
