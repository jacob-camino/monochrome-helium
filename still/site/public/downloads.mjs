import {PLATFORMS, parseReleases, formatSize, architectureLabel} from './releases.mjs';
const status = document.getElementById('release-status');
function element(name, className, text) { const node = document.createElement(name); if (className) node.className = className; if (text) node.textContent = text; return node; }
export function renderDownloads(artifacts, unavailable = false) {
  document.getElementById('development-status').textContent = unavailable ? 'Build availability below' : artifacts.length ? 'Published builds available below' : 'In development · preparing the first release';
  for (const platform of PLATFORMS) {
    const container = document.querySelector(`[data-platform="${platform}"] .platform-content`);
    container.replaceChildren();
    const files = artifacts.filter(artifact => artifact.platform === platform);
    if (!files.length) {
      container.append(element('p', 'pending', unavailable ? 'Information unavailable' : 'Build pending'), element('p', 'pending-note', unavailable ? 'Please try again later.' : 'No download available yet.'));
      continue;
    }
    const list = element('ul', 'artifacts');
    for (const artifact of files) {
      const item = element('li', 'artifact');
      const link = element('a', 'download-link', 'Download for ' + architectureLabel(platform, artifact.arch));
      link.href = artifact.url;
      link.setAttribute('download', artifact.filename);
      link.setAttribute('referrerpolicy', 'no-referrer');
      link.setAttribute('data-download', artifact.filename);
      const meta = element('p', 'artifact-meta', artifact.format.toUpperCase() + ' · ' + formatSize(artifact.size) + ' · ' + artifact.version);
      const details = element('details');
      details.append(element('summary', '', 'SHA-256 checksum'), element('code', '', artifact.sha256));
      item.append(link, meta, details); list.append(item);
    }
    container.append(list);
  }
  status.textContent = unavailable ? 'Download information could not be loaded. Please try again later.' : artifacts.length ? 'Available builds are listed below. Other platforms will appear as their builds are ready.' : 'No release has been published yet. Downloads will appear here as each platform is ready.';
}
try {
  const response = await fetch('/still/releases.json', {cache: 'no-store', signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error('Manifest unavailable.');
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error('Manifest too large.');
  renderDownloads(parseReleases(JSON.parse(text)));
} catch { renderDownloads([], true); }
