// Use the page's exact rules; the publisher additionally refuses partial validity.
import {readFileSync} from 'node:fs';
import {parseReleases, validArtifact} from '../site/public/releases.mjs';

try {
  const manifest = JSON.parse(readFileSync(0, 'utf8'));
  parseReleases(manifest);
  const versions = new Set();
  for (const release of manifest.releases) {
    if (!release || versions.has(release.version) || !Array.isArray(release.artifacts) || !release.artifacts.length) throw new Error();
    versions.add(release.version);
    const validated = parseReleases({schemaVersion: 1, releases: [release]});
    if (validated.length !== release.artifacts.length) throw new Error();
    for (const artifact of release.artifacts) if (!validArtifact(artifact, release.version)) throw new Error();
  }
  process.stdout.write('valid\n');
} catch {
  // Do not echo untrusted manifest contents or exception text.
  process.stderr.write('Release manifest does not satisfy the download page schema.\n');
  process.exitCode = 1;
}
