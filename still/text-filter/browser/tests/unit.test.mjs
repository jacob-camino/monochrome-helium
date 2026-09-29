import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePage, unknown} from '../extension/bounds.mjs';
test('input boundary strips URL secrets and bounds every field', () => {
  const result = normalizePage({
    url: 'https://name:password@example.test/path?token=private#secret',
    title: 'x'.repeat(300), text: 'y'.repeat(4000), formValue: 'ignored',
  });
  assert.equal(result.url, 'https://example.test/path');
  assert.equal(result.title.length, 256);
  assert.equal(result.text.length, 3000);
  assert.deepEqual(Object.keys(result), ['url', 'title', 'text']);
});
test('malformed inputs never become instructions or executable fields', () => {
  assert.deepEqual(normalizePage(null), {url: '', title: '', text: ''});
  assert.deepEqual(normalizePage({url: 'javascript:alert(1)', title: {}, text: []}),
    {url: '', title: '', text: ''});
});
test('all unknown/error responses take no blocking action', () => {
  for (const reason of ['disabled', 'busy', 'timeout', 'cancelled', 'inference_error']) {
    const result = unknown(reason);
    assert.equal(result.decision, 'UNKNOWN');
    assert.equal(result.action, 'none');
  }
});
