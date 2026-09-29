# Experimental local text runtime

This is an isolated Manifest V3 extension prototype. It is disabled by default,
requires consent for each browser session, and only classifies a tab after an
explicit click. It never blocks or redirects pages. It is not included in
Still's blocking extension or enabled in the browser.

The implementation uses a service worker, a standard offscreen document, and one
dedicated inference worker. Qwen's text-only model sessions can use single-thread
WASM, four-thread WASM, or WebGPU. Single-thread WASM remains the default build.
A second concurrent request returns UNKNOWN; a job has a 90-second
deadline; opting out terminates its worker; idle model memory is released after
60 seconds. Errors and unknown results take no blocking action. Domain rules in
Still's separate blocking extension remain independent.

## Build and test

Use the parent directory's pinned, checksum-verified model downloads and installed
Transformers.js 4.3.0 package. Building performs no network requests.

```sh
npm ci --ignore-scripts
node build.mjs qwen
npm test
export STILL_CHROMIUM="/path/to/Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
npm run test:runtime -- qwen
npm run test:failure
```

The unpacked extension is written to `dist/qwen/`. It contains all model and
runtime files. Generated model bundles and runtime reports are ignored by Git.
`build.mjs smol` is supported for runtime comparisons, but the parent evaluation
found Smol unsuitable for the classification instructions.

Build and test an accelerated variant explicitly:

```sh
node build.mjs qwen wasm4
npm run test:runtime -- qwen wasm4
node build.mjs qwen webgpu
npm run test:runtime -- qwen webgpu
npm run test:runtime -- qwen webgpu missing-accelerator
```

These bundles are written to `dist/qwen-wasm4/` and `dist/qwen-webgpu/`.
The last command tests a temporary copy with the GPU factory omitted, requiring
real inference through the packaged single-thread fallback. No model download
or change to browser flags is involved.

The test launches a fresh temporary Chrome profile using Playwright's
`chromiumSandbox: true`. It uses only authored cases from `../cases.json` and an
in-memory DOM privacy fixture; browser networking is offline during inference.
It checks consent, extraction exclusions, concurrency, cancellation, storage,
and actual browser command-line flags. It records case timings, machine load,
and sampled aggregate RSS for the temporary browser process tree. The separate failure test omits runtime
and model assets and checks that the result is UNKNOWN without blocking.

## Data boundary

The extractor limits visible text to 3,000 characters, title to 256, and URL to
512. It excludes form subtrees, input controls, contenteditable content, script
and style elements, hidden content, and embedded frames. URL credentials, query,
and fragment are stripped. Text scanning also has a node/time budget. It does
not read input values, images, cookies, or browsing history.

The model receives page data as a JSON object in a user message, with a separate
fixed system policy. This is **not** a defense proven to stop prompt injection:
visible page text can still contain adversarial instructions. Neither page text
nor decisions are persisted; session storage contains only the opt-in boolean.

Remote models are disabled, all model calls use `local_files_only`, and fetches
are restricted to this extension's origin. The extension CSP permits local WASM
compilation using `wasm-unsafe-eval`; it does not permit JavaScript
`unsafe-eval`, remote scripts, or blob workers. No page CSP, browser sandbox,
site isolation, or Helium security setting is changed.

The four-thread variant opts only this extension into cross-origin isolation
using `cross_origin_opener_policy: same-origin` and
`cross_origin_embedder_policy: require-corp`. It requests at most four threads
only when isolation and SharedArrayBuffer are available. WebGPU uses the
browser's normally available adapter, without enabling unsafe GPU features.
Unavailable acceleration falls back to single-thread WASM. A backend failure
retries once in a fresh worker, preserving the original job deadline and opt-out
cancellation path; results explicitly report the fallback. If the fallback also
fails, the result is UNKNOWN with no action.

## Observed runtime and limits

Qwen was exercised in Chrome for Testing 151.0.7922.34 on this Apple Silicon
machine (15 logical CPUs, 24 GiB RAM) on September 29, 2026. Each run used the
same three short authored cases, with 168–178 input tokens and at most five
output tokens. All three produced the expected labels in each run.

| Browser runtime | Cold model load | First inference | Subsequent two inferences | Sampled browser RSS, before / peak |
| --- | --- | --- | --- | --- |
| Four-thread WASM | 1.40 s | 2.81 s | 2.39 s / 2.33 s | 1.04 / 3.59 GB |
| WebGPU | 1.80 s | 1.15 s | 132 ms / 129 ms | 0.92 / 2.52 GB |
| Single-thread fallback after a missing GPU factory | 1.51 s | 7.21 s | 6.84 s / 7.07 s | 0.92 / 3.17 GB |

These were sequential smoke checks under other machine activity, with
one-minute load averages of roughly 13, 14, and 18. The Still build's independent
process and log records confirm an eight-job compile throughout these runs;
other local builds were also active. They are not controlled performance or
accuracy benchmarks.
RSS was sampled every 500 ms and sums all processes belonging to the test
browser; shared pages can be counted twice, GPU allocations are not separately
measured, and brief peaks can be missed. The model's download size is not its
runtime memory cost. Cold-load timing for the fallback excludes the failed GPU
attempt. Larger pages and other machines may be slower.

Earlier single-thread WASM runs took 6.3–8.3 seconds per case. The parent's
separate native CPU evaluation measured a 658 ms median using four threads;
that is not browser WASM timing. The Qwen files total about 666 MB. The WASM
bundle adds about 28 MB, and the WebGPU variant packages a further 27 MB runtime
while retaining WASM for fallback. No model or classifier policy changed for
the acceleration experiment.

The parent's 32-case CPU evaluation found a false block of recovery support and
a missed block under prompt injection. This prototype therefore remains
diagnostic-only; its successful runtime checks do not qualify it for automatic
page blocking. It cannot reliably classify image-only pages, inaccessible frame
content, or content absent from the bounded visible-text sample.

Integration details discovered during testing:

- Use the self-contained `transformers.min.js` distribution. The
  `transformers.web.js` distribution has bare package imports and needs bundling.
- Set both WASM factory and binary URLs to packaged files, and disable
  `useWasmCache`; the default cache can create blob factory URLs rejected by this
  intentionally strict extension CSP.
- Multithreaded WASM works with extension-only isolation and same-origin worker
  modules. It does not need blob workers or relaxed CSP.
- WebGPU works with the packaged asyncify factory/binary; the single-thread
  fallback uses the packaged jsep factory/binary in a fresh worker.

References: [Transformers.js local model configuration](https://huggingface.co/docs/transformers.js/custom_usage),
[Chrome offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen),
[extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy),
[extension cross-origin isolation](https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation),
[ONNX Runtime threading and backend configuration](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html).
