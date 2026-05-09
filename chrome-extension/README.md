# Clip — Chrome Extension

Two ways to use the extension:

1. **One-click button on every video page.** A floating "Download" button appears in the bottom-right corner of YouTube, Instagram, TikTok, Twitter/X and Facebook video pages. Click → opens Clip in a new tab with the URL pre-filled and the fetch already started.
2. **Toolbar popup.** Click the Clip icon in your Chrome toolbar to paste any URL manually (same flow as the website).

Both routes funnel users back to the Clip site so ads and Pro upsells still fire — the extension is a traffic driver, not a way to bypass monetization.

## Files

| File             | What it does                                                                |
|------------------|-----------------------------------------------------------------------------|
| `manifest.json`  | MV3 manifest. Lists supported sites and permissions.                        |
| `content.js`     | Injects the floating Download button on supported pages.                    |
| `content.css`    | Scoped styles for the button — uses `!important` to defeat host-page CSS.   |
| `popup.html`     | Toolbar popup UI (paste-a-URL flow).                                        |
| `popup.js`       | Popup logic.                                                                |
| `background.js`  | Service worker — minimal, kept for future hooks.                            |
| `icons/`         | 16/32/48/128 px PNG icons (you need to add these).                          |

## Configure before publishing

Edit two constants:

| File          | Constant         | Set to                                              |
|---------------|------------------|------------------------------------------------------|
| `content.js`  | `CLIP_URL`       | Your hosted Clip site, e.g. `https://clip.app`     |
| `popup.js`    | `BACKEND_URL`    | Same as above                                        |
| `popup.js`    | `CHECKOUT_URL`   | Your Lemon Squeezy checkout URL                      |
| `manifest.json` | `host_permissions` | Replace `https://YOUR-DOMAIN.com/*` with your real one |

## Icons

Add four PNGs to `icons/` (omitted from this scaffold):

- `icons/icon16.png` — 16×16
- `icons/icon32.png` — 32×32
- `icons/icon48.png` — 48×48
- `icons/icon128.png` — 128×128

Quick way: take your favicon, run it through [realfavicongenerator.net](https://realfavicongenerator.net), use the Chrome Extension preset.

## Test locally

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and pick this `chrome-extension/` folder.
4. Visit a YouTube video — the red Download button should appear in the bottom-right corner. Click it.
5. A new tab opens at `http://localhost:3000/?url=…` (assuming Clip is running locally) with the URL pre-filled and the format grid already loading.

## Publishing to the Chrome Web Store

1. Bundle the folder into a zip.
2. Pay the one-time $5 developer fee at [Chrome Web Store dashboard](https://chrome.google.com/webstore/devconsole/).
3. Upload the zip; fill in screenshots, copy and the privacy policy URL (use `https://yourdomain.com/privacy`).
4. Submit for review (typically 1–3 days for content scripts, since Google reviews them more carefully).

### What to put in the listing

- **Name:** Clip — One-Click Video Downloader
- **Short description (132 chars):** "Add a Download button to YouTube, Instagram, TikTok, Twitter & Facebook. One click → MP4 or MP3 in seconds."
- **Category:** Productivity
- **Language:** English (you can add more later)
- **Privacy policy URL:** `https://yourdomain.com/privacy`
- **Permissions justification:**
  - `activeTab` / `tabs` — to read the URL of the page the user is currently on so the Download button knows what to download.
  - `host_permissions` for the supported sites — to inject the button on those sites only.
  - `storage` — to remember the user's Pro license key so they don't have to re-enter it.
  - `downloads` — used by the popup flow to save files to the user's Downloads folder.
