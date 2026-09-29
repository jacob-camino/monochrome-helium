// The publisher adds entries only after uploading and checking actual artifacts.
export const PLATFORMS = ['macos', 'windows', 'linux'];
const FORMATS = {macos: ['.dmg', '.zip'], windows: ['.exe', '.msi', '.zip'], linux: ['.AppImage', '.deb', '.rpm', '.tar.xz']};
const VERSION = /^\d+(?:\.\d+){1,3}(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/;
const HASH = /^[a-fA-F0-9]{64}$/;
export function validArtifact(value, version) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const {platform, arch, filename, url, sha256, size} = value;
  if (!PLATFORMS.includes(platform) || !['arm64', 'x64'].includes(arch)) return null;
  if (typeof filename !== 'string' || filename.length > 180 || !/^[Ss]till[-_][a-zA-Z0-9._-]+$/.test(filename)) return null;
  const extension = FORMATS[platform].find(ext => filename.endsWith(ext));
  if (!extension || typeof sha256 !== 'string' || !HASH.test(sha256)) return null;
  if (!Number.isSafeInteger(size) || size < 1 || size > 20 * 1024 ** 3) return null;
  if (typeof url !== 'string' || url.length > 2048) return null;
  let target;
  try { target = new URL(url); } catch { return null; }
  if (target.protocol !== 'https:' || target.username || target.password || target.hash || target.search || target.port) return null;
  if (!target.hostname.includes('.') || target.hostname === 'localhost' || target.hostname.endsWith('.localhost') || /^\d+(\.\d+){3}$/.test(target.hostname) || target.hostname.startsWith('[')) return null;
  let basename;
  try { basename = decodeURIComponent(target.pathname.slice(target.pathname.lastIndexOf('/') + 1)); } catch { return null; }
  if (basename !== filename) return null;
  return {platform, arch, filename, url: target.href, sha256: sha256.toLowerCase(), size, version, format: extension.slice(1)};
}
export function parseReleases(input) {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.releases) || input.releases.length > 100) throw new Error('Unsupported release manifest.');
  const releases = [];
  for (const release of input.releases) {
    if (!release || typeof release.version !== 'string' || release.version.length > 40 || !VERSION.test(release.version)) continue;
    if (typeof release.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(release.publishedAt) || !Number.isFinite(Date.parse(release.publishedAt))) continue;
    if (new Date(release.publishedAt).toISOString().replace('.000Z', 'Z') !== release.publishedAt.replace('.000Z', 'Z') || Date.parse(release.publishedAt) > Date.now()) continue;
    if (!Array.isArray(release.artifacts) || release.artifacts.length > 30) continue;
    const artifacts = release.artifacts.map(artifact => validArtifact(artifact, release.version)).filter(Boolean);
    releases.push({publishedAt: release.publishedAt, artifacts});
  }
  releases.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const artifacts = new Map();
  for (const release of releases) for (const artifact of release.artifacts) {
    const key = artifact.platform + ':' + artifact.arch + ':' + artifact.format;
    if (!artifacts.has(key)) artifacts.set(key, artifact);
  }
  if (input.releases.length && !artifacts.size) throw new Error('No usable release artifacts.');
  return [...artifacts.values()];
}
export function formatSize(bytes) { return bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(1) + ' GB' : Math.max(0.1, bytes / 1024 ** 2).toFixed(1) + ' MB'; }
export function architectureLabel(platform, arch) { return platform === 'macos' ? arch === 'arm64' ? 'Apple silicon' : 'Intel' : arch === 'arm64' ? 'ARM64' : 'x64'; }
