// Only the repository's authored cases and a synthetic DOM privacy fixture.
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {extractPage} from '../extension/extract.mjs';
const runtime = process.env.STILL_PLAYWRIGHT
  ? await import(pathToFileURL(process.env.STILL_PLAYWRIGHT)) : await import('playwright-core');
const {chromium} = runtime;
const alias = process.argv[2] || 'qwen';
const binary = process.env.STILL_CHROMIUM;
if (!binary) throw new Error('Set STILL_CHROMIUM to Chrome for Testing.');
if (!['qwen', 'smol'].includes(alias)) throw new Error('usage: node tests/runtime.mjs qwen|smol');
const extension = fileURLToPath(new URL('../dist/' + alias, import.meta.url));
const cases = JSON.parse(await readFile(new URL('../../cases.json', import.meta.url)));
const profile = await mkdtemp(join(tmpdir(), 'still-local-text-'));
let context;
const report = {alias, experimental: true, sandboxEnabled: true, offline: true, cases: [], checks: []};
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: binary, headless: true, chromiumSandbox: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--disable-background-networking', '--disable-component-update', '--no-default-browser-check'],
  });
  await context.setOffline(true);
  const network = [];
  context.on('request', request => {
    if (/^https?:/.test(request.url())) network.push(request.url());
  });
  const serviceWorker = context.serviceWorkers()[0] ||
    await context.waitForEvent('serviceworker', {timeout: 20000});
  const extensionId = new URL(serviceWorker.url()).hostname;
  const panel = await context.newPage();
  panel.on('console', message => {
    if (message.type() === 'error') console.error('panel:', message.text());
  });
  await panel.goto('chrome-extension://' + extensionId + '/panel.html');
  await panel.waitForFunction(() => !!document.querySelector('#enabled'));
  const send = message => panel.evaluate(message =>
    chrome.runtime.sendMessage({target: 'prototype', ...message}), message);
  assert.equal((await send({type: 'status'})).enabled, false);
  assert.equal((await send({type: 'classify', page: cases[0]})).reason, 'disabled');
  assert.equal(await serviceWorker.evaluate(async () =>
    (await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})).length), 0);
  report.checks.push('disabled by default; no worker/model load before opt-in');

  const fixture = await context.newPage();
  await fixture.goto('about:blank');
  // The extractor intentionally ignores non-HTTP(S) pages. This routed fixture
  // is supplied entirely by the test and is never fetched from the network.
  await context.route('https://fixture.example/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Chromium source</title><body><main>' + cases[1].text +
      '</main><form><input value="FORM_CANARY"><p>FORM_CANARY</p></form>' +
      '<div contenteditable>EDIT_CANARY</div><div hidden>HIDDEN_CANARY</div>' +
      '<div style="display:none">DISPLAY_CANARY</div><div style="opacity:0">OPACITY_CANARY</div>' +
      '<div aria-hidden="true">ARIA_CANARY</div><script type="application/json">SCRIPT_CANARY</script>',
  }));
  await fixture.goto('https://fixture.example/page?secret=QUERY_CANARY#FRAGMENT_CANARY');
  const extracted = await fixture.evaluate(extractPage);
  assert.equal(extracted.url, 'https://fixture.example/page');
  assert.equal(extracted.text, cases[1].text);
  assert(!JSON.stringify(extracted).includes('CANARY'));
  report.checks.push('isolated extractor excludes form/editable/hidden/script content and URL secrets');
  await fixture.close();
  await context.unrouteAll();
  network.length = 0;

  assert.equal((await send({type: 'enable', enabled: true})).enabled, true);
  const chosen = ['ordinary-code', 'adult-videos', 'health'];
  const cold = cases.find(c => c.id === chosen[0]);
  const concurrent = await panel.evaluate(async page => Promise.all([
    chrome.runtime.sendMessage({target: 'prototype', type: 'classify', page}),
    chrome.runtime.sendMessage({target: 'prototype', type: 'classify', page}),
  ]), cold);
  assert.equal(concurrent.filter(r => r.reason === 'busy').length, 1);
  const first = concurrent.find(r => r.reason !== 'busy');
  report.cases.push({id: cold.id, expected: cold.expected, ...first});
  console.log(JSON.stringify(report.cases.at(-1)));
  assert.equal(first.action, 'none');
  assert.equal(first.reason, undefined, 'real local inference failed: ' + JSON.stringify(first));
  for (const id of chosen.slice(1)) {
    const fixture = cases.find(c => c.id === id);
    const result = await send({type: 'classify', page: fixture});
    report.cases.push({id, expected: fixture.expected, ...result});
    console.log(JSON.stringify(report.cases.at(-1)));
    assert.equal(result.reason, undefined, 'local inference failed: ' + JSON.stringify(result));
    assert.equal(result.action, 'none');
  }
  assert.equal((await send({type: 'classify', page: cases.find(c => c.id === 'empty')})).reason,
    'insufficient_evidence');
  report.checks.push('local WASM model completes; one active inference; blank input fails open');
  const cancelled = await panel.evaluate(async page => {
    const pending = chrome.runtime.sendMessage({target: 'prototype', type: 'classify', page});
    await new Promise(resolve => setTimeout(resolve, 50));
    await chrome.runtime.sendMessage({target: 'prototype', type: 'enable', enabled: false});
    return pending;
  }, cold);
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal(cancelled.action, 'none');
  assert.equal((await send({type: 'status'})).busy, false);
  report.checks.push('opting out during inference terminates worker and fails open');
  await send({type: 'enable', enabled: true});
  assert.deepEqual(network, [], 'unexpected external inference request');
  report.checks.push('inference completed with browser network offline and no HTTP(S) requests');
  const session = await serviceWorker.evaluate(() => chrome.storage.session.get(null));
  assert.deepEqual(session, {enabled: true});
  assert.deepEqual(await serviceWorker.evaluate(() => chrome.storage.local.get(null)), {});
  report.checks.push('no page text or model decisions persisted');
  await send({type: 'enable', enabled: false});
  assert.equal((await send({type: 'classify', page: cold})).reason, 'disabled');
  report.checks.push('opt-out stops worker and disables further requests');
  const versionPage = await context.newPage();
  await versionPage.goto('chrome://version');
  const command = await versionPage.locator('#command_line').textContent();
  assert(!command.includes('--no-sandbox'));
  assert(!command.includes('--disable-web-security'));
  const cdp = await context.newCDPSession(panel);
  report.browser = (await cdp.send('Browser.getVersion')).product;
  await versionPage.close();
  report.checks.push('no --no-sandbox or --disable-web-security browser flags');
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  await rm(profile, {recursive: true, force: true});
  const results = new URL('../results/', import.meta.url);
  await mkdir(results, {recursive: true});
  await writeFile(new URL(alias + '-runtime.json', results), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
