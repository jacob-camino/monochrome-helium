// Self-contained for chrome.scripting.executeScript's isolated world.
export function extractPage() {
  const page = {url: location.href, title: document.title.slice(0, 256), text: ''};
  if (!['http:', 'https:'].includes(location.protocol) || !document.body) return page;
  const parsed = new URL(location.href);
  page.url = (parsed.origin + parsed.pathname).slice(0, 512);
  const ignored = 'script,style,noscript,template,iframe,object,embed,canvas,svg,form,input,textarea,select,option,[contenteditable],[role="textbox"],[hidden],[inert],[aria-hidden="true"]';
  const started = performance.now();
  let visited = 0;
  const walker = document.createTreeWalker(document.body,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // Return to the caller immediately once the scan budget expires.
        if (++visited > 10000 || performance.now() - started > 50) return NodeFilter.FILTER_ACCEPT;
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches(ignored)) return NodeFilter.FILTER_REJECT;
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility !== 'visible' ||
              Number(style.opacity) === 0 || style.contentVisibility === 'hidden') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP;
        }
        const parent = node.parentElement;
        if (!parent || parent.closest(ignored) || !parent.checkVisibility({
          opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true,
        })) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
  const parts = [];
  let length = 0, node;
  while (length < 3000 && (node = walker.nextNode())) {
    if (visited > 10000 || performance.now() - started > 50) break;
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const value = node.textContent.replace(/\s+/g, ' ').trim().slice(0, 3000 - length);
    if (value) { parts.push(value); length += value.length + 1; }
  }
  page.text = parts.join(' ').slice(0, 3000);
  return page;
}
