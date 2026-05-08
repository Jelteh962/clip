# Clip — Chrome Extension

Paid Chrome extension companion to the Clip web downloader.

## Architecture

The extension is a thin client over the Express backend in `../server.js`.
When the user clicks the toolbar icon, the popup:

1. Reads the active tab's URL (if it's YouTube/Instagram/TikTok, pre-fills it).
2. Calls `BACKEND_URL/api/formats` to list available qualities.
3. Streams `BACKEND_URL/api/download` and uses `chrome.downloads.download(...)`
   to save the file straight to the user's Downloads folder — no extra browser tab.

Pro state (4K + HQ unlock) is persisted in `chrome.storage.local`.

## Configure before publishing

Open `popup.js` and `manifest.json` and replace:

| Placeholder                              | What to set it to                                        |
|------------------------------------------|----------------------------------------------------------|
| `BACKEND_URL` (popup.js)                 | Your hosted server, e.g. `https://clip.yourdomain.com`   |
| `CHECKOUT_URL` (popup.js)                | Your Lemon Squeezy checkout link                         |
| `https://YOUR-DOMAIN.com/*` (manifest)   | Your hosted server origin                                |
| `VALID_LICENSES` (popup.js)              | Replace with a real `/api/verify-license` server check   |

## Icons

Add four PNGs to `icons/` (omitted from this scaffold):

- `icons/icon16.png` — 16×16
- `icons/icon32.png` — 32×32
- `icons/icon48.png` — 48×48
- `icons/icon128.png` — 128×128

## Load locally for testing

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and pick this `chrome-extension/` folder.
4. Run `node server.js` from the project root so `BACKEND_URL=http://localhost:3000` works.
5. Pin the extension and click the icon while on a YouTube video.

## Publishing to the Chrome Web Store

> Heads up: the Chrome Web Store removed paid extensions in 2020. You can't charge
> for the extension itself anymore — distribute it free and gate Pro features
> behind your own license check (Lemon Squeezy → license key → activated in popup).

1. Bundle the folder into a zip.
2. Pay the one-time $5 developer fee at the [Chrome Web Store dashboard](https://chrome.google.com/webstore/devconsole/).
3. Upload the zip, fill in screenshots and copy.
4. Submit for review (typically 1–3 days).
5. After approval, link the extension's listing from your website's Pro modal.

## Server-side license verification (next step)

When you're ready to lock things down properly, replace the in-popup `VALID_LICENSES`
set with a server endpoint:

```js
// server.js
app.post('/api/verify-license', async (req, res) => {
  const key = req.body.key;
  // Hit Lemon Squeezy's License API: https://docs.lemonsqueezy.com/api/license-api
  const r = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
    method: 'POST',
    headers: { 'Accept': 'application/json' },
    body: new URLSearchParams({ license_key: key })
  });
  const data = await r.json();
  res.json({ valid: !!data.valid });
});
```

Then have `popup.js` call `${BACKEND_URL}/api/verify-license` instead of checking
the local set.
