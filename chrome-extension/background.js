// Service worker — kept minimal. Used so the extension stays MV3-compliant
// and we can route messages or context-menu actions in the future.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    // Optional: open a welcome tab on first install.
    // chrome.tabs.create({ url: 'https://YOUR-DOMAIN.com/welcome' });
  }
});

// Future hook: forward "download this video" requests from content scripts.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'PING') sendResponse({ ok: true });
  return true;
});
