import assert from 'node:assert/strict';
import {cp, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
if (!process.env.STILL_CHROMIUM) throw new Error('Set STILL_CHROMIUM.');
const temporary = await mkdtemp(join(tmpdir(), 'still-local-text-failure-'));
const extension = join(temporary, 'extension');
await cp(fileURLToPath(new URL('../extension', import.meta.url)), extension, {recursive: true});
// Deliberately omit all vendor/model assets: this must fail open without a
// fallback download, rather than turning a load failure into a BLOCK.
let context;
try {
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    executablePath: process.env.STILL_CHROMIUM, headless: true, chromiumSandbox: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--disable-background-networking', '--disable-component-update'],
  });
  await context.setOffline(true);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const panel = await context.newPage();
  await panel.goto('chrome-extension://' + new URL(worker.url()).hostname + '/panel.html');
  const [fixture] = JSON.parse(await readFile(new URL('../../cases.json', import.meta.url)));
  const result = await panel.evaluate(async page => {
    await chrome.runtime.sendMessage({target: 'prototype', type: 'enable', enabled: true});
    return chrome.runtime.sendMessage({target: 'prototype', type: 'classify', page});
  }, fixture);
  assert.equal(result.decision, 'UNKNOWN');
  assert.equal(result.action, 'none');
  assert(['worker_error', 'inference_error'].includes(result.reason), JSON.stringify(result));
  assert.equal((await panel.evaluate(() =>
    chrome.runtime.sendMessage({target: 'prototype', type: 'status'}))).busy, false);
  console.log('PASS: missing local runtime/model assets fail open with ' + result.reason +
    ' in an offline, sandbox-enabled browser.');
} finally {
  if (context) await context.close();
  await rm(temporary, {recursive: true, force: true});
}
