# Experimental local text runtime

This is an isolated Manifest V3 extension prototype. It is disabled by default,
requires consent for each browser session, and only classifies a tab after an
explicit click. It never blocks or redirects pages. It is not included in
Still's blocking extension or enabled in the browser.

The implementation uses a service worker, a standard offscreen document, and one
dedicated inference worker. Qwen's text-only model sessions run through the WASM
backend. A second concurrent request returns UNKNOWN; a job has a 90-second
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

The test launches a fresh temporary Chrome profile using Playwright's
`chromiumSandbox: true`. It uses only authored cases from `../cases.json` and an
in-memory DOM privacy fixture; browser networking is offline during inference.
It checks consent, extraction exclusions, concurrency, cancellation, storage,
and actual browser command-line flags. The separate failure test omits runtime
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

## Observed runtime and limits

Qwen was exercised in Chrome for Testing 151.0.7922.34 on this Apple Silicon
machine. Three short authored cases took 6.3–6.6 seconds each in the first
single-threaded WASM run; subsequent runs during other local work took 7.6–8.3
seconds. Loading took approximately 1.8–2.0 seconds. The parent's separate native
CPU evaluation measured a 658 ms median using four threads; that is not browser
WASM timing. These are runtime smoke checks, not controlled real-world accuracy
or performance benchmarks. Larger
pages and other machines may be slower. The Qwen files total about 666 MB;
the bundled WASM binary adds about 27 MB. Memory use is not measured here.

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
- Single-threaded WASM avoids requiring SharedArrayBuffer or changes to document
  isolation headers. WebGPU and multithreaded acceleration are not validated.

References: [Transformers.js local model configuration](https://huggingface.co/docs/transformers.js/custom_usage),
[Chrome offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen),
[extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy).
