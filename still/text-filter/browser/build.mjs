import {cp, mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const parent = fileURLToPath(new URL('../', import.meta.url));
const alias = process.argv[2] || 'qwen';
if (!['qwen', 'smol'].includes(alias)) throw new Error('usage: node build.mjs qwen|smol');
const dist = join(root, 'dist', alias);
const modelRoot = join(parent, 'models', alias);
const assets = JSON.parse(await readFile(join(modelRoot, 'asset-manifest.json')));
for (const asset of assets.files) {
  if (!asset.path || asset.path.split('/').includes('..') || asset.path.startsWith('/')) throw new Error('Unsafe asset path');
  if ((await stat(join(modelRoot, asset.path))).size !== asset.size) throw new Error('Incomplete asset: ' + asset.path);
}
await mkdir(join(dist, 'vendor'), {recursive: true});
await cp(join(root, 'extension'), dist, {recursive: true});
await cp(join(parent, 'policy.mjs'), join(dist, 'policy.mjs'));
await cp(join(parent, 'node_modules/@huggingface/transformers/dist/transformers.min.js'),
  join(dist, 'vendor/transformers.mjs'));
await cp(join(parent, 'node_modules/@huggingface/transformers/LICENSE'),
  join(dist, 'vendor/transformers.LICENSE'));
for (const name of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  await cp(join(parent, 'node_modules/onnxruntime-web/dist', name), join(dist, 'vendor', name));
}
await mkdir(join(dist, 'models', alias), {recursive: true});
await cp(modelRoot, join(dist, 'models', alias), {recursive: true, mode: constants.COPYFILE_FICLONE});
await writeFile(join(dist, 'model-config.mjs'), 'export const modelAlias = ' + JSON.stringify(alias) + ';\n');
await writeFile(join(dist, 'build-manifest.json'), JSON.stringify({
  model: alias, repository: assets.repository, revision: assets.revision,
  runtime: '@huggingface/transformers 4.3.0', modelBytes: assets.files.reduce((n, f) => n + f.size, 0),
  experimental: true, blocksPages: false,
}, null, 2) + '\n');
console.log(dist);
