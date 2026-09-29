import {normalizePage, unknown} from './bounds.mjs';
let worker, pending, idleTimer;
const DEADLINE_MS = 90000;
const IDLE_MS = 60000;

function terminate(reason) {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = undefined;
  if (pending) {
    clearTimeout(pending.timer);
    pending.respond(unknown(reason));
    pending = undefined;
  }
}

function classify(page, respond) {
  if (pending) { respond(unknown('busy')); return; }
  clearTimeout(idleTimer);
  if (!worker) {
    worker = new Worker(chrome.runtime.getURL('worker.mjs'), {type: 'module'});
    worker.onerror = event => {
      const detail = event.message;
      const reply = pending?.respond;
      if (pending) clearTimeout(pending.timer);
      pending = undefined;
      terminate('worker_error');
      reply?.(unknown('worker_error', detail));
    };
    worker.onmessage = ({data}) => {
      if (!pending || data.id !== pending.id) return;
      const {respond, timer} = pending;
      clearTimeout(timer);
      pending = undefined;
      respond(data.result);
      if (data.result.reason === 'inference_error') terminate('inference_error');
      else idleTimer = setTimeout(() => terminate('idle'), IDLE_MS);
    };
  }
  const id = crypto.randomUUID();
  pending = {id, respond, timer: setTimeout(() => terminate('timeout'), DEADLINE_MS)};
  worker.postMessage({id, page: normalizePage(page)});
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'inference' || sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL('background.mjs')) return false;
  if (message.type === 'cancel') { terminate('cancelled'); respond({cancelled: true}); return false; }
  if (message.type !== 'classify') return false;
  classify(message.page, respond);
  return true;
});
