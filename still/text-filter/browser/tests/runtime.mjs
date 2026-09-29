// Only the repository's authored cases and a synthetic DOM privacy fixture.
import assert from 'node:assert/strict';
import {cp, mkdtemp, readFile, rm, mkdir, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir, loadavg, cpus, totalmem} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {extractPage} from '../extension/extract.mjs';
const runtime = process.env.STILL_PLAYWRIGHT
  ? await import(pathToFileURL(process.env.STILL_PLAYWRIGHT)) : await import('playwright-core');
const {chromium} = runtime;
const alias = process.argv[2] || 'qwen';
const runtimeMode = process.argv[3] || 'wasm1';
const missingAccelerator = process.argv[4] === 'missing-accelerator';
const binary = process.env.STILL_CHROMIUM;
if (!binary) throw new Error('Set STILL_CHROMIUM to Chrome for Testing.');
if (!['qwen', 'smol'].includes(alias) || !['wasm1', 'wasm4', 'webgpu'].includes(runtimeMode)) {
  throw new Error('usage: node tests/runtime.mjs qwen|smol [wasm1|wasm4|webgpu]');
}
const bundle = alias + (runtimeMode === 'wasm1' ? '' : '-' + runtimeMode);
let extension = fileURLToPath(new URL('../dist/' + bundle, import.meta.url));
const cases = JSON.parse(await readFile(new URL('../../cases.json', import.meta.url)));
const profile = await mkdtemp(join(tmpdir(), 'still-local-text-'));
if (missingAccelerator) {
  assert.equal(runtimeMode, 'webgpu', 'missing-accelerator only supports the WebGPU bundle');
  // Omit the local GPU factory only. The real model and WASM fallback remain
  // present; the application must recover without a download or changed CSP.
  const source = extension;
  extension = join(profile, 'extension');
  await cp(source, extension, {recursive: true, mode: constants.COPYFILE_FICLONE,
    filter: path => !path.endsWith('/ort-wasm-simd-threaded.asyncify.mjs')});
}
let context;
const report = {alias, runtimeMode, missingAccelerator, experimental: true, sandboxEnabled: true, offline: true,
  measuredAt: new Date().toISOString(), environment: {platform: process.platform,
    arch: process.arch, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), loadAverage: loadavg()},
  cases: [], checks: []};
const run = promisify(execFile);
let memoryTimer, memorySampling = false;
// Resident sizes include every process belonging to this temporary browser.
// Shared pages may be counted more than once; this is not model-only memory.
async function sampleMemory() {
  if (memorySampling) return;
  memorySampling = true;
  try {
    const {stdout} = await run('ps', ['-axo', 'pid,ppid,rss,command']);
    const rows = stdout.split('\n').map(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return match && {pid: +match[1], parent: +match[2], bytes: +match[3] * 1024,
        command: match[4]};
    }).filter(Boolean);
    const ids = new Set(rows.filter(row => row.command.includes('--user-data-dir=' + profile))
      .map(row => row.pid));
    let previous;
    do {
      previous = ids.size;
      for (const row of rows) if (ids.has(row.parent)) ids.add(row.pid);
    } while (ids.size > previous);
    const bytes = rows.filter(row => ids.has(row.pid)).reduce((sum, row) => sum + row.bytes, 0);
    if (bytes) {
      report.memory ??= {metric: 'sum of browser-process RSS, shared pages may be double-counted',
        samplingIntervalMs: 500, beforeModelBytes: bytes, peakBytes: bytes, samples: 0};
      report.memory.peakBytes = Math.max(report.memory.peakBytes, bytes);
      report.memory.samples++;
    }
  } catch (error) { report.memoryError = error.message; }
  finally { memorySampling = false; }
}
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
  await sampleMemory();
  memoryTimer = setInterval(sampleMemory, 500);
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
  assert.equal(first.requestedRuntime, runtimeMode);
  if (runtimeMode === 'wasm4' && !first.fallbackReason) {
    assert.equal(first.crossOriginIsolated, true);
    assert(first.threads > 1 && first.threads <= 4);
  }
  if (runtimeMode === 'webgpu' && !first.fallbackReason) assert.equal(first.device, 'webgpu');
  if (missingAccelerator) {
    assert.equal(first.device, 'wasm');
    assert.equal(first.threads, 1);
    assert(first.fallbackReason, 'accelerator failure must be reported');
    report.checks.push('missing local GPU factory recovers through a fresh single-thread WASM worker');
  }
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
  report.checks.push('local model completes; requested runtime or explicit WASM fallback; one active inference; blank input fails open');
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
  clearInterval(memoryTimer);
  await sampleMemory();
  if (context) await context.close();
  await rm(profile, {recursive: true, force: true});
  const results = new URL('../results/', import.meta.url);
  await mkdir(results, {recursive: true});
  await writeFile(new URL(bundle + (missingAccelerator ? '-fallback' : '') + '-runtime.json', results),
    JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
