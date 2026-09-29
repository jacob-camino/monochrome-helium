import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, readFile} from 'node:fs/promises';
import {extname, join, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const modulePath = process.env.STILL_PLAYWRIGHT_MODULE;
const {chromium} = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'playwright');
const root = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const results = fileURLToPath(new URL('../test-results/', import.meta.url));
await mkdir(results, {recursive: true});
const types = {'.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml'};
const server = createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://local.test').pathname);
    if (pathname === '/still') pathname = '/still/';
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(root, '.' + pathname.replace(/^\/still\//, '/'));
    if (!file.startsWith(root + sep) && file !== root) throw new Error('Invalid path');
    const content = await readFile(file);
    response.writeHead(200, {'content-type': types[extname(file)] || 'application/octet-stream'}); response.end(content);
  } catch { response.writeHead(404); response.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/still/`;
let browser;
try {
  browser = await chromium.launch({headless: true, executablePath: process.env.STILL_CHROMIUM});
  const context = await browser.newContext({reducedMotion: 'reduce'});
  const errors = [], externalRequests = [];
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(new URL(url).origin)) externalRequests.push(request.url()); });
  for (const [name, width, height] of [['desktop', 1440, 1000], ['tablet', 768, 1024], ['mobile', 390, 844], ['small-mobile', 320, 720]]) {
    await page.setViewportSize({width, height});
    await page.goto(url);
    await page.getByText('No release has been published yet.', {exact: false}).waitFor();
    assert.equal(await page.locator('[data-download]').count(), 0);
    assert.equal(await page.getByText('Build pending', {exact: true}).count(), 3);
    assert.equal(await page.locator('h1').innerText(), 'still.');
    assert.equal(await page.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), true);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ': horizontal overflow');
    await page.screenshot({path: join(results, name + '.png'), fullPage: true});
  }
  assert.equal(externalRequests.length, 0, 'Page must not request external assets');
  await page.goto(url.slice(0, -1));
  await page.getByText('No release has been published yet.', {exact: false}).waitFor();
  assert.equal(await page.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), true);
  const artifact = {platform: 'macos', arch: 'arm64', filename: 'Still-0.1.0-macos-arm64.dmg', url: 'https://downloads.example.com/Still-0.1.0-macos-arm64.dmg', sha256: 'a'.repeat(64), size: 456123456};
  await page.route('**/releases.json', route => route.fulfill({json: {schemaVersion: 1, releases: [{version: '0.1.0', publishedAt: '2026-01-01T00:00:00Z', artifacts: [artifact, {...artifact, platform: 'windows', filename: 'Still-0.1.0.exe', url: 'javascript:alert(1)'}]}]}}));
  await page.goto(url);
  await page.getByRole('link', {name: 'Download for Apple silicon'}).waitFor();
  assert.equal(await page.locator('#development-status').innerText(), 'Published builds available below');
  assert.equal(await page.locator('[data-download]').count(), 1);
  assert.equal(await page.locator('[data-download]').getAttribute('href'), artifact.url);
  assert.equal(await page.getByText('Build pending', {exact: true}).count(), 2);
  await page.getByText('SHA-256 checksum').click();
  assert.equal(await page.locator('code').innerText(), artifact.sha256);
  await page.unroute('**/releases.json');
  await page.route('**/releases.json', route => route.fulfill({status: 200, body: '{ invalid json', contentType: 'application/json'}));
  await page.goto(url);
  await page.getByText('Download information could not be loaded.', {exact: false}).waitFor();
  assert.equal(await page.locator('[data-download]').count(), 0);
  assert.equal(await page.getByText('Information unavailable', {exact: true}).count(), 3);
  assert.deepEqual(errors, []);
  console.log('PASS: four responsive viewports, loaded preview, zero external asset requests, empty/valid/invalid release states, checksum display, and no page errors.');
  console.log('Screenshots: ' + results);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
