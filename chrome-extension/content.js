// =============================================================================
// Clip — content script
// =============================================================================
// Injects a floating "Download with Clip" button on supported video pages.
// Click → opens https://YOUR-DOMAIN/?url=<current_page_url> in a new tab,
// where the site auto-prefills the input and starts the download flow.
// =============================================================================

// Change this to your real Clip domain when you deploy.
// http://localhost:3000 works during local development.
const CLIP_URL = 'https://clipexports.com';

// Patterns that mean "this is a watchable video page" per platform.
// We don't want to show the button on the YouTube homepage, the Instagram
// inbox, etc. — only on actual video pages.
const VIDEO_URL_PATTERNS = [
  /youtube\.com\/watch\?v=/,
  /youtube\.com\/shorts\//,
  /youtu\.be\//,
  /tiktok\.com\/@[^/]+\/video\//,
  /tiktok\.com\/v\//,
  /instagram\.com\/(reel|p|tv|stories)\//,
  /(twitter|x)\.com\/[^/]+\/status\//,
  /facebook\.com\/(watch|reel|.+\/videos\/)/,
];

function isVideoPage() {
  const href = location.href;
  return VIDEO_URL_PATTERNS.some((re) => re.test(href));
}

function buildButton() {
  const btn = document.createElement('button');
  btn.id = 'clip-download-fab';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Download with Clip');
  btn.innerHTML = `
    <span class="clip-fab-dot"></span>
    <span class="clip-fab-icon" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3v12M6 11l6 6 6-6M3 21h18"/>
      </svg>
    </span>
    <span class="clip-fab-label">Download</span>
  `;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const target = `${CLIP_URL}/?url=${encodeURIComponent(location.href)}&from=ext`;
    window.open(target, '_blank', 'noopener');
  });
  return btn;
}

function injectButton() {
  // Don't double-inject
  if (document.getElementById('clip-download-fab')) return;
  if (!isVideoPage()) return;
  document.body.appendChild(buildButton());
}

function removeButton() {
  const existing = document.getElementById('clip-download-fab');
  if (existing) existing.remove();
}

function syncButton() {
  if (isVideoPage()) {
    injectButton();
  } else {
    removeButton();
  }
}

// All supported platforms are SPAs — URL changes without a page reload.
// Listen for both popstate and pushState/replaceState to keep the button in sync.
syncButton();

(function patchHistory() {
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function () {
    const r = origPush.apply(this, arguments);
    setTimeout(syncButton, 100);
    return r;
  };
  history.replaceState = function () {
    const r = origReplace.apply(this, arguments);
    setTimeout(syncButton, 100);
    return r;
  };
  window.addEventListener('popstate', () => setTimeout(syncButton, 100));
})();

// Some platforms (Instagram in particular) re-render the body without changing
// the URL. Watch for body mutations and re-inject if our button got nuked.
const observer = new MutationObserver(() => {
  if (isVideoPage() && !document.getElementById('clip-download-fab')) {
    injectButton();
  }
});
observer.observe(document.body, { childList: true, subtree: true });
