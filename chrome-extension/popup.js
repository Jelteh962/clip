// =============================================================================
// Clip — popup logic
// =============================================================================
// CONFIG: change BACKEND_URL to your hosted server (e.g. https://clip.yourdomain.com)
// During local development, this works against http://localhost:3000.
// =============================================================================
const BACKEND_URL = 'http://localhost:3000';

// CHECKOUT_URL = your Lemon Squeezy / Gumroad / Paddle checkout link.
// Same value as in public/index.html — keep them in sync.
const CHECKOUT_URL = 'https://toolstackr.lemonsqueezy.com/checkout/buy/ed65dcf2-7ba4-4c65-997e-9d54c4d10192';

// Dev licenses, same as the website. Replace with a server check when ready.
const VALID_LICENSES = new Set([
  'CLIP-PRO-DEV-2024',
  'CLIP-FOUNDER-001'
]);

// ---- State ----
let videoData = null;
let selectedFormat = null;
let isPro = false;

// ---- Helpers ----
const $ = (id) => document.getElementById(id);

function detectPlatform(url) {
  if (!url) return null;
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/tiktok\.com/i.test(url)) return 'TikTok';
  return null;
}

function setStatus(msg, type = '') {
  const el = $('status');
  el.textContent = msg || '';
  el.className = 'status ' + type;
}

function isProFormat(f) {
  const label = (f.label || '').toLowerCase();
  if (label.includes('hq')) return true;
  const m = label.match(/(\d+)p/);
  return !!(m && parseInt(m[1], 10) >= 2160);
}

function setProUI(on) {
  isPro = on;
  $('proPill').classList.toggle('on', on);
  $('upgradeLink').textContent = on ? 'Manage Pro' : 'Upgrade to Pro';
}

// ---- Init: pre-fill URL from active tab if it's a supported platform ----
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  if (!tab || !tab.url) return;
  const platform = detectPlatform(tab.url);
  if (platform) {
    $('urlInput').value = tab.url;
    $('platform').textContent = `${platform} detected`;
  } else {
    $('platform').textContent = 'Paste any video link';
  }
});

// ---- Init: Pro state ----
chrome.storage.local.get(['clip_pro'], (res) => setProUI(!!res.clip_pro));

// ---- Fetch formats ----
$('fetchBtn').addEventListener('click', fetchFormats);
$('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchFormats(); });

async function fetchFormats() {
  const url = $('urlInput').value.trim();
  if (!url) return setStatus('Paste a link first.', 'error');
  setStatus('Fetching…');
  $('fetchBtn').disabled = true;
  $('result').style.display = 'none';

  try {
    const res = await fetch(`${BACKEND_URL}/api/formats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Failed');
    videoData = data;
    renderResult(data);
    setStatus('');
  } catch (e) {
    setStatus(e.message || 'Could not load video info.', 'error');
  } finally {
    $('fetchBtn').disabled = false;
  }
}

function renderResult(data) {
  $('meta').innerHTML = `
    ${data.thumbnail ? `<img class="thumb" src="${data.thumbnail}" onerror="this.style.display='none'">` : ''}
    <div>
      <div class="title">${data.title || 'Untitled'}</div>
      <div class="sub">${data.uploader || ''}${data.duration ? ' · ' + Math.floor(data.duration/60) + ':' + String(data.duration%60).padStart(2,'0') : ''}</div>
    </div>
  `;
  const grid = $('formats');
  grid.innerHTML = '';
  data.formats.forEach((f) => {
    const proOnly = isProFormat(f);
    const locked = proOnly && !isPro;
    const div = document.createElement('div');
    div.className = 'fmt' + (locked ? ' locked' : '');
    div.innerHTML = `
      <div class="fmt-res">${f.label.split(' ')[0]}</div>
      <div class="fmt-type">${f.type === 'audio' ? 'MP3' : (f.ext || '').toUpperCase()}</div>
    `;
    div.addEventListener('click', () => {
      if (locked) { openLicense(); return; }
      document.querySelectorAll('.fmt').forEach(c => c.classList.remove('selected'));
      div.classList.add('selected');
      selectedFormat = f;
      $('downloadBtn').disabled = false;
    });
    grid.appendChild(div);
  });
  $('result').style.display = 'block';
}

// ---- Download ----
$('downloadBtn').addEventListener('click', () => {
  if (!selectedFormat || !videoData) return;
  const url = $('urlInput').value.trim();
  const params = new URLSearchParams({
    url,
    format_id: selectedFormat.format_id,
    label: videoData.title,
    ext: selectedFormat.ext
  });
  $('progress').classList.add('on');
  $('progressFill').style.width = '0%';
  $('downloadBtn').disabled = true;
  setStatus('Downloading…');

  const evt = new EventSource(`${BACKEND_URL}/api/download?${params}`);
  evt.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'progress') $('progressFill').style.width = Math.min(m.percent, 99) + '%';
    if (m.type === 'done') {
      evt.close();
      $('progressFill').style.width = '100%';
      const fileUrl = `${BACKEND_URL}/api/file?path=${encodeURIComponent(m.file)}&name=${encodeURIComponent(m.name)}`;
      // Use chrome.downloads so it goes to the user's Downloads folder cleanly
      chrome.downloads.download({ url: fileUrl, filename: m.name, saveAs: false });
      setStatus('Saved to Downloads.', 'success');
      $('downloadBtn').disabled = false;
    }
    if (m.type === 'error') {
      evt.close();
      setStatus(m.message || 'Download failed.', 'error');
      $('downloadBtn').disabled = false;
      $('progress').classList.remove('on');
    }
  };
  evt.onerror = () => {
    evt.close();
    setStatus('Connection lost.', 'error');
    $('downloadBtn').disabled = false;
    $('progress').classList.remove('on');
  };
});

// ---- License modal ----
$('upgradeLink').addEventListener('click', () => {
  if (isPro) {
    openLicense();
  } else {
    if (CHECKOUT_URL.includes('YOUR-')) {
      openLicense();
    } else {
      chrome.tabs.create({ url: CHECKOUT_URL });
    }
  }
});

function openLicense() {
  $('licenseModal').classList.add('on');
  $('licenseInput').value = '';
  $('licenseMsg').textContent = '';
}

$('licenseCancel').addEventListener('click', () => $('licenseModal').classList.remove('on'));
$('licenseSave').addEventListener('click', () => {
  const key = ($('licenseInput').value || '').trim().toUpperCase();
  if (!key) {
    $('licenseMsg').textContent = 'Enter a key.';
    $('licenseMsg').className = 'status error';
    return;
  }
  if (VALID_LICENSES.has(key)) {
    chrome.storage.local.set({ clip_pro: true }, () => {
      setProUI(true);
      $('licenseMsg').textContent = '✓ Activated.';
      $('licenseMsg').className = 'status success';
      setTimeout(() => {
        $('licenseModal').classList.remove('on');
        if (videoData) renderResult(videoData);
      }, 700);
    });
  } else {
    $('licenseMsg').textContent = '✗ Invalid key.';
    $('licenseMsg').className = 'status error';
  }
});
