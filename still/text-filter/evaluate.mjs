import { AutoModelForCausalLM, AutoTokenizer, env } from '@huggingface/transformers';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { messagesForPage, parseDecision } from './policy.mjs';

const alias = process.argv[2];
if (!['smol', 'qwen'].includes(alias)) throw new Error('usage: node evaluate.mjs smol|qwen');
// Network access is disabled for model loading and tokenization.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;
const root = new URL('.', import.meta.url);
const modelPath = fileURLToPath(new URL(`models/${alias}/`, root));
const assets = JSON.parse(await readFile(new URL(`models/${alias}/asset-manifest.json`, root)));
const started = performance.now();
const tokenizer = await AutoTokenizer.from_pretrained(modelPath, {local_files_only: true});
const model = await AutoModelForCausalLM.from_pretrained(modelPath, {
  local_files_only: true,
  dtype: alias === 'smol' ? 'q8' : {embed_tokens: 'q4', decoder_model_merged: 'q4'},
  device: 'cpu',
  session_options: {intraOpNumThreads: 4, interOpNumThreads: 1},
});
const loadMs = performance.now() - started;
const cases = JSON.parse(await readFile(new URL('cases.json', root)));
const results = [];
try {
  for (const test of cases) {
    const input = tokenizer.apply_chat_template(messagesForPage(test), {
      tokenize: true, return_dict: true, add_generation_prompt: true,
      enable_thinking: false,
    });
    const start = performance.now();
    const output = await model.generate({...input, max_new_tokens: 5, do_sample: false});
    const raw = tokenizer.decode(output.tolist()[0].slice(input.input_ids.dims.at(-1)), {skip_special_tokens: true});
    const decision = parseDecision(raw);
    const validOutput = ['BLOCK', 'ALLOW', 'UNKNOWN'].includes(raw.trim().toUpperCase());
    const result = {id: test.id, expected: test.expected, decision, validOutput, raw, ms: Math.round(performance.now() - start)};
    results.push(result);
    console.log(JSON.stringify(result));
  }
} finally {
  await model.dispose();
}
const correct = results.filter(x => x.validOutput && x.decision === x.expected).length;
const falseBlocks = results.filter(x => x.expected !== 'BLOCK' && x.decision === 'BLOCK').map(x => x.id);
const missedBlocks = results.filter(x => x.expected === 'BLOCK' && x.decision !== 'BLOCK').map(x => x.id);
const ms = results.map(x => x.ms).sort((a, b) => a - b);
const report = {
  note: 'Small authored smoke set, not a measured real-world accuracy benchmark or a release qualification.',
  repository: assets.repository, revision: assets.revision,
  runtime: '@huggingface/transformers 4.3.0', device: 'cpu', loadMs,
  correct, total: results.length, falseBlocks, missedBlocks,
  invalidOutputs: results.filter(x => !x.validOutput).map(x => x.id),
  medianMs: ms[Math.floor(ms.length / 2)], results,
};
await mkdir(new URL('results/', root), {recursive: true});
await writeFile(new URL(`results/${alias}.json`, root), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({alias, correct, total: results.length, falseBlocks, missedBlocks, medianMs: report.medianMs}));
