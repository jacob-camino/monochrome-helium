import {AutoModelForCausalLM, AutoTokenizer, env} from './vendor/transformers.mjs';
import {messagesForPage, parseDecision} from './policy.mjs';
import {normalizePage, unknown} from './bounds.mjs';
import {modelAlias} from './model-config.mjs';

const root = new URL('./', import.meta.url);
const originalFetch = globalThis.fetch.bind(globalThis);
// Defense in depth alongside connect-src 'self': no model/runtime fetch may
// leave this extension, even if a library default changes.
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, root);
  if (url.protocol !== root.protocol || url.host !== root.host) {
    return Promise.reject(new Error('External inference fetch refused'));
  }
  return originalFetch(input, init);
};
env.fetch = globalThis.fetch;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('models/', root).href;
env.useBrowserCache = false;
env.useWasmCache = false; // Avoid blob workers/factories and their extra CSP permissions.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('vendor/ort-wasm-simd-threaded.jsep.mjs', root).href,
  wasm: new URL('vendor/ort-wasm-simd-threaded.jsep.wasm', root).href,
};
let runtime;
async function load() {
  if (!runtime) runtime = (async () => {
    const started = performance.now();
    const tokenizer = await AutoTokenizer.from_pretrained(modelAlias, {local_files_only: true});
    const model = await AutoModelForCausalLM.from_pretrained(modelAlias, {
      local_files_only: true, device: 'wasm',
      dtype: modelAlias === 'smol' ? 'q8' : {embed_tokens: 'q4', decoder_model_merged: 'q4'},
    });
    return {tokenizer, model, loadMs: Math.round(performance.now() - started)};
  })();
  return runtime;
}

let running = false;
self.onmessage = async ({data}) => {
  if (running) { self.postMessage({id: data.id, result: unknown('busy')}); return; }
  running = true;
  try {
    const cold = !runtime;
    const {tokenizer, model, loadMs} = await load();
    const input = tokenizer.apply_chat_template(messagesForPage(normalizePage(data.page)), {
      tokenize: true, return_dict: true, add_generation_prompt: true, enable_thinking: false,
    });
    const inputTokens = input.input_ids.dims.at(-1);
    if (inputTokens > 2048) {
      self.postMessage({id: data.id, result: unknown('input_token_limit')});
      return;
    }
    const started = performance.now();
    const output = await model.generate({...input, max_new_tokens: 5, do_sample: false});
    const raw = tokenizer.decode(output.tolist()[0].slice(inputTokens), {skip_special_tokens: true});
    self.postMessage({id: data.id, result: {
      decision: parseDecision(raw), raw: raw.slice(0, 64), action: 'none', experimental: true,
      model: modelAlias, device: 'wasm', threads: 1, inputTokens, cold,
      loadMs: cold ? loadMs : 0, inferenceMs: Math.round(performance.now() - started),
    }});
  } catch (error) {
    runtime = undefined;
    self.postMessage({id: data.id, result: unknown('inference_error', error.message)});
  } finally { running = false; }
};
