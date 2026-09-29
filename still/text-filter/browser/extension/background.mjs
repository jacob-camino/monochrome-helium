import {normalizePage, unknown} from './bounds.mjs';
import {extractPage} from './extract.mjs';
let creating;
let busy = false;
let consentGeneration = 0;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  if ((await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url],
  })).length) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['WORKERS'],
      justification: 'Run explicitly requested local text inference in a cancellable worker.',
    }).finally(() => { creating = undefined; });
  }
  await creating;
}

async function route(message) {
  if (message.type === 'status') {
    const {enabled = false} = await chrome.storage.session.get('enabled');
    return {enabled, busy, experimental: true, blocksPages: false};
  }
  if (message.type === 'enable') {
    const enabled = message.enabled === true;
    if (!enabled) ++consentGeneration;
    await chrome.storage.session.set({enabled});
    if (!enabled) {
      const contexts = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']});
      if (contexts.length) await chrome.runtime.sendMessage({target: 'inference', type: 'cancel'});
    }
    return {enabled};
  }
  if (!['classify', 'classify-active-tab'].includes(message.type)) return unknown('invalid_request');
  if (!(await chrome.storage.session.get('enabled')).enabled) return unknown('disabled');
  if (busy) return unknown('busy');
  busy = true;
  const generation = consentGeneration;
  try {
    let page = message.page;
    if (message.type === 'classify-active-tab') {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      if (!tab?.id || !/^https?:/.test(tab.url || '')) return unknown('unsupported_page');
      const [result] = await chrome.scripting.executeScript({
        target: {tabId: tab.id}, func: extractPage,
      });
      page = result?.result;
    }
    page = normalizePage(page);
    if (!page.text.trim() && !page.title.trim()) return unknown('insufficient_evidence');
    await ensureOffscreen();
    if (generation !== consentGeneration ||
        !(await chrome.storage.session.get('enabled')).enabled) return unknown('cancelled');
    return await chrome.runtime.sendMessage({target: 'inference', type: 'classify', page});
  } catch (error) {
    return unknown('runtime_error', error.message);
  } finally { busy = false; }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'prototype' || sender.id !== chrome.runtime.id ||
      !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  route(message).then(respond, error => respond(unknown('runtime_error', error.message)));
  return true;
});
