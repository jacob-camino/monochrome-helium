export function normalizePage(page = {}) {
  page = page && typeof page === 'object' ? page : {};
  const string = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
  let url = '';
  try {
    const parsed = new URL(string(page.url, 4096));
    if (['http:', 'https:'].includes(parsed.protocol)) {
      // Never include URL credentials, query values, or fragment tokens.
      url = (parsed.origin + parsed.pathname).slice(0, 512);
    }
  } catch {}
  return {url, title: string(page.title, 256), text: string(page.text, 3000)};
}

export function unknown(reason, detail = '') {
  return {decision: 'UNKNOWN', reason, detail: String(detail).slice(0, 512),
    action: 'none', experimental: true};
}
