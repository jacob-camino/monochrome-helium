import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReleases, validArtifact} from '../public/releases.mjs';
const artifact = {platform: 'macos', arch: 'arm64', filename: 'Still-0.1.0-macos-arm64.dmg', url: 'https://downloads.example.com/Still-0.1.0-macos-arm64.dmg', sha256: 'a'.repeat(64), size: 456123456};
const release = {version: '0.1.0', publishedAt: '2026-01-01T00:00:00Z', artifacts: [artifact]};
const manifest = releases => ({schemaVersion: 1, releases});
test('empty release manifest has no downloads', () => assert.deepEqual(parseReleases(manifest([])), []));
test('valid fields expose only the newest artifact per platform/architecture/format', () => {
  const newer = {...release, version: '0.2.0', publishedAt: '2026-02-01T00:00:00Z', artifacts: [{...artifact, filename: 'Still-0.2.0-macos-arm64.dmg', url: 'https://downloads.example.com/Still-0.2.0-macos-arm64.dmg'}]};
  const result = parseReleases(manifest([release, newer, newer]));
  assert.equal(result.length, 1); assert.equal(result[0].version, '0.2.0');
  assert.equal(result[0].format, 'dmg');
});
test('unsafe URLs, malformed fields, and platform mismatches never become links', () => {
  const bad = [
    {url: 'javascript:alert(1)'}, {url: 'http://downloads.example.com/' + artifact.filename},
    {url: 'https://user:password@downloads.example.com/' + artifact.filename},
    {url: 'https://downloads.example.com/' + artifact.filename + '?temporary=1'},
    {url: 'https://downloads.example.com/' + artifact.filename + '#fragment'},
    {url: 'https://127.0.0.1/' + artifact.filename}, {url: 'https://localhost/' + artifact.filename},
    {url: 'https://downloads.example.com/different.dmg'}, {url: 'https://downloads.example.com/%E0'},
    {filename: '<img src=x onerror=alert(1)>.dmg'}, {filename: 'Still-../../evil.dmg'},
    {sha256: 'bad'}, {sha256: null}, {size: '1000'}, {size: 0}, {size: -1}, {size: Infinity},
    {size: Number.MAX_SAFE_INTEGER + 1}, {platform: 'windows'}, {arch: 'unknown'}, {platform: '__proto__'}
  ];
  for (const patch of bad) assert.equal(validArtifact({...artifact, ...patch}, '0.1.0'), null, JSON.stringify(patch));
});
test('invalid metadata fails closed, including impossible and future dates', () => {
  for (const value of [null, {}, {schemaVersion: 2, releases: []}, manifest(Array(101).fill(release)), manifest([{...release, version: '<script>'}]), manifest([{...release, publishedAt: '2026-02-31T00:00:00Z'}]), manifest([{...release, publishedAt: '2999-01-01T00:00:00Z'}]), manifest([{...release, artifacts: [{...artifact, sha256: 'invalid'}]}])]) assert.throws(() => parseReleases(value));
});
test('mixed valid and invalid artifacts retain only valid files', () => {
  const result = parseReleases(manifest([{...release, artifacts: [artifact, {...artifact, url: 'javascript:alert(1)'}]}]));
  assert.equal(result.length, 1);
});
