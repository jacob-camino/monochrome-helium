# Still local text-filter evaluation

Experimental, separate from the browser's working domain blocker. Nothing in
this directory is automatically installed or enabled for normal browsing.

The requested approach is a small local language model classifying page purpose
from URL, title, and a bounded text sample. No image classifier or cloud service
is used. The model has no tools or access to the block/allow lists. An ambiguous
or malformed result is UNKNOWN, not authority to change a user's rules.

Two open Apache-2.0 candidates were tested on this Mac with
`@huggingface/transformers` 4.3.0, ONNX CPU inference, four intra-op threads, and
remote model access disabled. The model files are pinned to repository commits
and LFS weights are checked against published SHA-256 hashes during download.
Downloads occur only in the explicit preparation script, before inference.

| Candidate | Evaluation assets | Median inference | Outcome on 32 authored cases |
| --- | --- | --- | --- |
| SmolLM2-135M, INT8 | About 140 MB including tokenizer | 117 ms | 31 malformed replies; the remaining reply was a false block |
| Qwen3.5-0.8B, Q4 ONNX, text only | About 666 MB including tokenizer | 658 ms | 28 expected labels; one false block, one missed block, two ambiguous pages labeled ALLOW |

These are **small smoke checks with one prompt**, not real-world accuracy
measurements or evidence that a model cannot improve through tuning. Results
and exact revisions are in `smoke-results.json`; cases and prompt are available
for inspection. No adult websites were visited. Invalid output does not receive
credit just because the runtime converts it to UNKNOWN.

Qwen incorrectly blocked a recovery-support page and accepted an adult-page
example containing misleading instructions. This makes it unsuitable for
unqualified automatic blocking. Domain rules should remain authoritative, and
model results must never create permanent bans or override explicit exceptions.
Further work needs prompt/fine-tuning evaluation with held-out pages, medical
and educational examples, multilingual material, and adversarial text.

Text-only analysis cannot classify pages that offer no informative text, and
it runs after the page response arrives. It cannot guarantee that all adult
content is stopped before loading. The production feature needs clear pending,
unavailable, and exception behavior, plus browser memory/latency validation.

## Reproduce locally

```sh
npm ci --no-audit --no-fund
python3 fetch-model.py qwen
python3 fetch-model.py smol
node evaluate.mjs qwen
node evaluate.mjs smol
```

The fetch commands require network access. The evaluation commands load only
local files; `env.allowRemoteModels` is false. Model downloads and machine-local
results are ignored by Git. Browser runtime experiments live separately under
`browser/` when available and do not modify the normal blocker.

Model sources: [SmolLM2](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct),
[SmolLM2 ONNX conversion](https://huggingface.co/onnx-community/SmolLM2-135M-Instruct-ONNX),
[Qwen3.5](https://huggingface.co/Qwen/Qwen3.5-0.8B),
[Qwen3.5 ONNX conversion](https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX-OPT).
These model licenses permit redistribution subject to their notices; model
assets are not part of the current Still distribution.
