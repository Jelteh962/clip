const express = require("express");
const { execFile, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const app = express();
app.use(express.json());
// Serve everything in /public EXCEPT index.html — that goes through the
// renderer below so we can swap titles/copy per-page for SEO landing pages.
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// =============================================================================
// YouTube cookies bypass
// =============================================================================
// YouTube blocks datacenter IPs ("Sign in to confirm you're not a bot").
// We work around that by passing yt-dlp a cookies file from a logged-in browser
// session. Set YT_COOKIES_BASE64 in your Railway service variables to a base64
// blob of a Netscape cookies.txt file. We decode it once at startup.
// =============================================================================
const COOKIES_PATH = path.join(os.tmpdir(), "yt-cookies.txt");
let COOKIES_AVAILABLE = false;

if (process.env.YT_COOKIES_BASE64) {
  try {
    fs.writeFileSync(
      COOKIES_PATH,
      Buffer.from(process.env.YT_COOKIES_BASE64, "base64").toString("utf8")
    );
    COOKIES_AVAILABLE = true;
    console.log("[clip] YT cookies loaded from env (" + COOKIES_PATH + ")");
  } catch (e) {
    console.error("[clip] Failed to decode YT_COOKIES_BASE64:", e.message);
  }
}

// =============================================================================
// Webshare residential proxy pool
// =============================================================================
// YT_PROXY_LIST env var format — one proxy per line:
//   host:port:user:pass
//   host:port:user:pass
//   ...
// We pick a random proxy per yt-dlp call so requests are spread across all IPs
// and a single flagged IP doesn't take the service down.
// =============================================================================
const PROXIES = [];
if (process.env.YT_PROXY_LIST) {
  const lines = process.env.YT_PROXY_LIST.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(":");
    if (parts.length !== 4) {
      console.warn("[clip] skipping malformed proxy line:", line);
      continue;
    }
    const [host, port, user, pass] = parts;
    PROXIES.push(`http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`);
  }
  console.log(`[clip] Loaded ${PROXIES.length} proxies from YT_PROXY_LIST`);
}

function pickProxy() {
  if (!PROXIES.length) return null;
  return PROXIES[Math.floor(Math.random() * PROXIES.length)];
}

// Common args we want on every yt-dlp invocation (formats + download).
function ytCommonArgs() {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--retries", "5",
    "--fragment-retries", "5",
    "--force-ipv4", // YT's bot scoring is harsher on IPv6 datacenter ranges
    "--geo-bypass",
    // With cookies loaded the default client mix works best. Without cookies,
    // we rely on yt-dlp picking sensible fallbacks.
    "--extractor-args", "youtube:player_client=default",
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  ];
  if (COOKIES_AVAILABLE) {
    args.push("--cookies", COOKIES_PATH);
  }
  const proxy = pickProxy();
  if (proxy) {
    args.push("--proxy", proxy);
    // Log redacted host so we can correlate failures with specific proxy IPs
    const m = proxy.match(/@([^:]+):(\d+)/);
    if (m) console.log(`[yt-dlp] using proxy ${m[1]}:${m[2]}, cookies=${COOKIES_AVAILABLE}`);
  } else {
    console.log(`[yt-dlp] NO PROXY available, cookies=${COOKIES_AVAILABLE}`);
  }
  return args;
}

// Health endpoint — useful to verify cookies are wired up after a deploy.
// Hit https://yourdomain.com/api/health to see status.
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    cookiesLoaded: COOKIES_AVAILABLE,
    proxyCount: PROXIES.length,
    nodeVersion: process.version,
  });
});

// =============================================================================
// /api/test-proxy — diagnostic. Verifies the proxy stack actually reaches
// YouTube and reports yt-dlp's own view of what's happening.
// Hit https://yourdomain.com/api/test-proxy?url=https://youtu.be/dQw4w9WgXcQ
// =============================================================================
app.get("/api/test-proxy", (req, res) => {
  const url = req.query.url || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const useCookies = req.query.cookies !== "0";
  const useProxy = req.query.proxy !== "0";

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--verbose",
    "--simulate",
    "--print", "title",
    "--extractor-args", "youtube:player_client=default",
  ];
  if (useCookies && COOKIES_AVAILABLE) args.push("--cookies", COOKIES_PATH);
  let chosenProxy = null;
  if (useProxy) {
    chosenProxy = pickProxy();
    if (chosenProxy) args.push("--proxy", chosenProxy);
  }
  args.push(url);

  // Redact creds from the proxy URL for the response
  const safeProxy = chosenProxy ? chosenProxy.replace(/\/\/[^@]+@/, "//***@") : null;
  console.log("[test-proxy] running yt-dlp with proxy:", safeProxy, "cookies:", useCookies && COOKIES_AVAILABLE);

  execFile("yt-dlp", args, { timeout: 25000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
    res.json({
      ok: !err,
      url,
      proxyUsed: safeProxy,
      cookiesUsed: useCookies && COOKIES_AVAILABLE,
      title: (stdout || "").trim(),
      // Last ~40 lines of yt-dlp's stderr — shows the real story
      stderrTail: (stderr || "").split("\n").slice(-40).join("\n"),
    });
  });
});

// Get available formats for a video
app.post("/api/formats", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  execFile(
    "yt-dlp",
    [...ytCommonArgs(), "--dump-json", url],
    { timeout: 30000, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) {
        // Surface the real yt-dlp message so we can see what's actually wrong
        // (e.g. YouTube bot challenge, Instagram login wall, network timeout).
        const detail = (stderr || err.message || "").toString().trim().split("\n").slice(-3).join(" | ").slice(0, 500);
        console.error("[yt-dlp] formats failed:", detail);
        return res.status(400).json({
          error: detail || "Could not fetch video info.",
        });
      }
      try {
        const info = JSON.parse(stdout);
        const formats = info.formats || [];

        // Build clean format list
        const seen = new Set();
        const videoFormats = [];

        // Add combined formats (video+audio)
        formats
          .filter((f) => f.vcodec !== "none" && f.acodec !== "none" && f.height)
          .sort((a, b) => (b.height || 0) - (a.height || 0))
          .forEach((f) => {
            const key = `${f.height}p`;
            if (!seen.has(key)) {
              seen.add(key);
              videoFormats.push({
                format_id: f.format_id,
                label: `${f.height}p`,
                height: f.height,
                ext: f.ext,
                filesize: f.filesize || f.filesize_approx || null,
                type: "video",
              });
            }
          });

        // Add best video formats (video-only, merged with audio)
        formats
          .filter((f) => f.vcodec !== "none" && f.acodec === "none" && f.height)
          .sort((a, b) => (b.height || 0) - (a.height || 0))
          .forEach((f) => {
            const key = `${f.height}p-hq`;
            if (!seen.has(key) && !seen.has(`${f.height}p`)) {
              seen.add(key);
              videoFormats.push({
                format_id: `${f.format_id}+bestaudio`,
                label: `${f.height}p (HQ)`,
                height: f.height,
                ext: "mp4",
                filesize: null,
                type: "video",
              });
            }
          });

        // Audio only
        videoFormats.push({
          format_id: "bestaudio",
          label: "Audio only (MP3)",
          height: 0,
          ext: "mp3",
          filesize: null,
          type: "audio",
        });

        videoFormats.sort((a, b) => b.height - a.height);

        res.json({
          title: info.title,
          thumbnail: info.thumbnail,
          duration: info.duration,
          uploader: info.uploader,
          formats: videoFormats,
        });
      } catch (e) {
        res.status(500).json({ error: "Failed to parse video info." });
      }
    }
  );
});

// Download endpoint
app.get("/api/download", (req, res) => {
  const { url, format_id, label, ext } = req.query;
  if (!url || !format_id) return res.status(400).json({ error: "Missing params" });

  const tmpDir = os.tmpdir();
  const filename = `yt-${Date.now()}`;
  const outputTemplate = path.join(tmpDir, `${filename}.%(ext)s`);

  const isAudio = ext === "mp3";
  const args = [
    ...ytCommonArgs(),
    // For audio, fall back to "best" if the platform has no separate audio
    // stream (TikTok / Instagram only expose merged streams).
    "-f", isAudio ? "bestaudio/best" : format_id,
    "-o", outputTemplate,
  ];

  if (isAudio) {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    args.push("--merge-output-format", "mp4");
  }

  args.push(url);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const child = execFile("yt-dlp", args, { timeout: 300000, maxBuffer: 32 * 1024 * 1024 }, (err, _stdout, stderr) => {
    if (err) {
      const detail = (stderr || err.message || "").toString().trim().split("\n").slice(-3).join(" | ").slice(0, 500);
      console.error("[yt-dlp] download failed:", detail);
      res.write(`data: ${JSON.stringify({ type: "error", message: detail || "Download failed." })}\n\n`);
      return res.end();
    }

    // Find the output file
    const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(filename));
    if (!files.length) {
      res.write(`data: ${JSON.stringify({ type: "error", message: "File not found after download." })}\n\n`);
      return res.end();
    }

    const outFile = path.join(tmpDir, files[0]);
    const safeLabel = (label || "video").replace(/[^a-zA-Z0-9-_ ]/g, "");
    const downloadName = `${safeLabel}.${files[0].split(".").pop()}`;

    res.write(`data: ${JSON.stringify({ type: "done", file: outFile, name: downloadName })}\n\n`);
    res.end();
  });

  child.stderr.on("data", (data) => {
    const line = data.toString();
    const match = line.match(/(\d+\.?\d*)%/);
    if (match) {
      res.write(`data: ${JSON.stringify({ type: "progress", percent: parseFloat(match[1]) })}\n\n`);
    }
  });
});

// Serve the downloaded file
app.get("/api/file", (req, res) => {
  const { path: filePath, name } = req.query;
  if (!filePath || !filePath.startsWith(os.tmpdir())) {
    return res.status(403).send("Forbidden");
  }
  if (!fs.existsSync(filePath)) return res.status(404).send("File not found");

  res.download(filePath, name, () => {
    fs.unlink(filePath, () => {});
  });
});

// =============================================================================
// SEO landing pages
// =============================================================================
// Each landing page is a tweaked version of the home page with custom title,
// meta description, h1, lede, default platform/format, and educational copy
// targeting a specific search query. Same backend, same UI.
// Add new pages here — they show up at /<key> and in the sitemap automatically.
// =============================================================================

const SITE_BASE = process.env.SITE_BASE_URL || ""; // e.g. "https://clip.app"
const SITE_NAME = "Clip";

// Shared default chunks reused across pages
const SEO_FOOTER = `
  <h2>Why use <span class="it">Clip</span>?</h2>
  <p>Clip is the fastest free video downloader for YouTube, Instagram and TikTok.
  No signup, no installation, no watermark. Paste a link, pick a quality, save the file.
  Upgrade to Pro for 1080p+, batch playlists, and zero ads — all for €4 a month.</p>
`;

const HOWTO_JSON = (name, platform) => ({
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": name,
  "step": [
    { "@type": "HowToStep", "position": 1, "name": "Copy the video link", "text": `Open the ${platform} video and copy its URL from the address bar or share menu.` },
    { "@type": "HowToStep", "position": 2, "name": "Paste it on Clip", "text": "Paste the URL into the input box and click Get video." },
    { "@type": "HowToStep", "position": 3, "name": "Pick a quality", "text": "Choose your preferred resolution or MP3 audio from the format grid." },
    { "@type": "HowToStep", "position": 4, "name": "Download", "text": "Click Download. The file lands straight in your Downloads folder." },
  ]
});

const LANDING_PAGES = {
  "/": {
    title: "Clip — Download videos from YouTube, Instagram & TikTok",
    description: "Free downloader for YouTube, Instagram and TikTok. No signup, no watermark, MP4 video and MP3 audio. Up to 4K with Pro.",
    platform: "youtube",
    format: "",
    seoContent: "",
  },
  "/youtube": {
    title: "YouTube Video Downloader — Free, fast, no signup | Clip",
    description: "Download any YouTube video as MP4 or MP3 in seconds. Free up to 720p, no watermark, no signup. Go Pro for 4K.",
    platform: "youtube",
    format: "",
    seoContent: "",
  },
  "/instagram": {
    title: "Instagram Video Downloader — Reels, posts, stories | Clip",
    description: "Download Instagram videos, Reels, posts and stories in original quality. No watermark, no login required.",
    platform: "instagram",
    format: "",
    seoContent: "",
  },
  "/tiktok": {
    title: "TikTok Video Downloader — No watermark | Clip",
    description: "Save TikTok videos without the watermark. Free, no login, original resolution. Works on iOS and Android too.",
    platform: "tiktok",
    format: "",
    seoContent: "",
  },

  // ---- SEO landing pages ----
  "/youtube-to-mp3": {
    title: "YouTube to MP3 Converter — Free, fast, no signup | Clip",
    description: "Convert any YouTube video to MP3 audio in seconds. Free, no signup, original audio quality. Works for music, podcasts and lectures.",
    platform: "youtube",
    format: "mp3",
    jsonLd: HOWTO_JSON("How to convert a YouTube video to MP3", "YouTube"),
    seoContent: `
      <section class="seo-content">
        <h2>How to convert a <span class="it">YouTube video to MP3</span></h2>
        <ol>
          <li>Copy the link of the YouTube video you want to convert.</li>
          <li>Paste it into the input above and click <strong>Get video</strong>.</li>
          <li>Pick the <strong>Audio only (MP3)</strong> tile from the format grid.</li>
          <li>Click <strong>Download</strong>. Your MP3 will save to your Downloads folder.</li>
        </ol>
        <p>Clip's YouTube to MP3 converter pulls audio directly from the original source — no re-encoding, no quality loss. Files are saved as standard <code>.mp3</code> at the highest available bitrate (typically 128 kbps for music videos, up to 320 kbps for high-quality uploads).</p>

        <h3>Why use Clip instead of another converter?</h3>
        <p>Most YouTube to MP3 sites bury the download link under fake buttons, redirect you through ad pages, or cap your file size. Clip shows you exactly what you're getting, runs two short ads (which keep the service free), and saves the file straight to your device.</p>

        <h3>Can I convert YouTube playlists or whole channels?</h3>
        <p>Batch playlist and channel conversion is part of <a href="/#features">Clip Pro</a>. For €4/month you can paste a playlist URL and queue every video as MP3 in one click.</p>

        <h3>Is converting YouTube to MP3 legal?</h3>
        <p>It depends on the content and your country. Downloading copyrighted music for personal listening is permitted in many jurisdictions but redistributing it is almost never permitted. Always check the platform's terms and your local copyright law.</p>
      </section>
    `,
  },

  "/youtube-to-mp4": {
    title: "YouTube to MP4 Downloader — Free HD video | Clip",
    description: "Download any YouTube video as MP4 in HD. Free up to 720p, no signup, no watermark. Go Pro for 1080p, 4K and 60fps.",
    platform: "youtube",
    format: "mp4",
    jsonLd: HOWTO_JSON("How to download a YouTube video as MP4", "YouTube"),
    seoContent: `
      <section class="seo-content">
        <h2>How to download a <span class="it">YouTube video as MP4</span></h2>
        <ol>
          <li>Copy the link of the YouTube video you want to download.</li>
          <li>Paste it above and click <strong>Get video</strong>.</li>
          <li>Pick a resolution — 360p, 480p or 720p are free; 1080p and 4K are Pro.</li>
          <li>Click <strong>Download</strong>. The MP4 saves to your Downloads folder.</li>
        </ol>
        <p>Clip downloads YouTube videos as standard <code>.mp4</code> files that play on every device — phones, laptops, smart TVs, video editors. We pull the source video and audio streams directly and merge them losslessly.</p>

        <h3>What resolutions are available?</h3>
        <p>Free downloads go up to 720p, which is more than enough for most viewing. <a href="/#features">Clip Pro</a> unlocks 1080p, 1440p, 4K and HDR — same source, just sharper. Older or low-quality YouTube uploads may not have higher resolutions available.</p>

        <h3>How big are the files?</h3>
        <p>Roughly 25 MB per minute at 720p, 60 MB at 1080p, 200 MB at 4K. Clip shows the estimated size next to each format so you know before you click.</p>
      </section>
    `,
  },

  "/youtube-shorts-downloader": {
    title: "YouTube Shorts Downloader — Free, no watermark | Clip",
    description: "Download YouTube Shorts in original quality. No watermark, no signup, MP4 or MP3.",
    platform: "youtube",
    format: "",
    jsonLd: HOWTO_JSON("How to download a YouTube Short", "YouTube"),
    seoContent: `
      <section class="seo-content">
        <h2>How to download a <span class="it">YouTube Short</span></h2>
        <ol>
          <li>Open the Short on YouTube and tap <strong>Share → Copy link</strong>.</li>
          <li>Paste the link above and click <strong>Get video</strong>.</li>
          <li>Pick a resolution and download.</li>
        </ol>
        <p>Shorts download as MP4 in their original vertical (9:16) aspect ratio — perfect for re-uploading to TikTok or Instagram Reels, or saving to your camera roll.</p>

        <h3>Can I download multiple Shorts at once?</h3>
        <p>Yes — <a href="/#features">Clip Pro</a> includes batch downloads. Paste a channel URL and grab every Short in one click.</p>
      </section>
    `,
  },

  "/tiktok-downloader": {
    title: "TikTok Video Downloader — No watermark, free | Clip",
    description: "Download TikTok videos without the watermark. Free, no signup, original resolution. Works on phone and desktop.",
    platform: "tiktok",
    format: "",
    jsonLd: HOWTO_JSON("How to download a TikTok video", "TikTok"),
    seoContent: `
      <section class="seo-content">
        <h2>How to download a <span class="it">TikTok video</span></h2>
        <ol>
          <li>Open the TikTok video and tap <strong>Share → Copy link</strong>.</li>
          <li>Paste the link above and click <strong>Get video</strong>.</li>
          <li>Choose a resolution. TikToks are short, so the file is usually under 20 MB.</li>
          <li>Click <strong>Download</strong>. No watermark, original quality.</li>
        </ol>
        <p>Unlike TikTok's built-in save button, Clip downloads the video without the TikTok logo or username overlay baked in. The file is a clean <code>.mp4</code> ready to re-upload, edit or share.</p>

        <h3>Will the creator be notified?</h3>
        <p>No. TikTok doesn't notify creators when their videos are downloaded through external tools. That said, please credit creators if you re-share their work.</p>

        <h3>Can I download just the audio (TikTok sounds)?</h3>
        <p>Yes — pick the MP3 option from the format grid. Great for saving sounds you want to use in your own videos.</p>
      </section>
    `,
  },

  "/tiktok-no-watermark": {
    title: "TikTok Downloader (No Watermark) — Free | Clip",
    description: "Save TikTok videos without the TikTok watermark. Free, no signup, original quality. Works for any public TikTok video.",
    platform: "tiktok",
    format: "",
    jsonLd: HOWTO_JSON("How to download TikTok videos without watermark", "TikTok"),
    seoContent: `
      <section class="seo-content">
        <h2>Download <span class="it">TikTok</span> videos without the watermark</h2>
        <p>TikTok's official download button burns the TikTok logo and the creator's username into the video, which makes it useless for re-editing or re-uploading elsewhere. Clip pulls the underlying clean copy — same content, no overlay.</p>

        <ol>
          <li>Tap <strong>Share → Copy link</strong> on the TikTok video.</li>
          <li>Paste it above and click <strong>Get video</strong>.</li>
          <li>Pick MP4 to save the video, or MP3 to save just the sound.</li>
          <li>Click <strong>Download</strong>.</li>
        </ol>

        <h3>Does this work for private or restricted videos?</h3>
        <p>No. Clip can only download videos that are publicly viewable without a TikTok account.</p>

        <h3>Why might a download fail?</h3>
        <p>Three common reasons: the URL is broken (re-copy it), the video has been deleted by the creator, or the video is region-locked. Most failures resolve by trying again with a fresh link.</p>
      </section>
    `,
  },

  "/instagram-reels-downloader": {
    title: "Instagram Reels Downloader — Free, no watermark | Clip",
    description: "Download Instagram Reels in HD without the watermark. No signup, no login, MP4 or MP3.",
    platform: "instagram",
    format: "",
    jsonLd: HOWTO_JSON("How to download an Instagram Reel", "Instagram"),
    seoContent: `
      <section class="seo-content">
        <h2>How to download an <span class="it">Instagram Reel</span></h2>
        <ol>
          <li>Open the Reel and tap the <strong>···</strong> menu → <strong>Copy link</strong>.</li>
          <li>Paste the link above and click <strong>Get video</strong>.</li>
          <li>Pick MP4 or MP3 and click <strong>Download</strong>.</li>
        </ol>
        <p>Reels download as standard MP4 in their original 9:16 portrait aspect ratio. Perfect for keeping a personal archive, re-editing in CapCut, or cross-posting to TikTok and YouTube Shorts.</p>

        <h3>Can I download Reels from private accounts?</h3>
        <p>No. Clip only supports content that's publicly viewable without an Instagram login.</p>

        <h3>What about Stories or carousel posts?</h3>
        <p>Public Stories and standard video posts work too — just paste the link from the share menu.</p>
      </section>
    `,
  },

  "/instagram-video-downloader": {
    title: "Instagram Video Downloader — Reels, posts, IGTV | Clip",
    description: "Download Instagram videos, Reels, IGTV and stories in HD. Free, no signup, no watermark.",
    platform: "instagram",
    format: "",
    jsonLd: HOWTO_JSON("How to download an Instagram video", "Instagram"),
    seoContent: `
      <section class="seo-content">
        <h2>Download any <span class="it">Instagram video</span></h2>
        <p>Clip works with Instagram Reels, regular video posts, IGTV and public stories. Just copy the post link from Instagram's share menu and paste it here.</p>

        <ol>
          <li>On Instagram, tap the share icon → <strong>Copy link</strong>.</li>
          <li>Paste the link in the box above and click <strong>Get video</strong>.</li>
          <li>Pick the format you want and click <strong>Download</strong>.</li>
        </ol>

        <h3>Why do some Instagram links not work?</h3>
        <p>Two reasons: the post is from a private account (we can't access those), or Instagram has rate-limited the IP. Wait a minute and try again, or try a different video.</p>
      </section>
    `,
  },
};

// Render the index template with the page-specific values substituted in.
const INDEX_PATH = path.join(__dirname, "public", "index.html");
let _indexCache = null;
function readIndex() {
  if (_indexCache) return _indexCache;
  _indexCache = fs.readFileSync(INDEX_PATH, "utf8");
  return _indexCache;
}

function renderPage(req, res, pageKey) {
  const cfg = LANDING_PAGES[pageKey] || LANDING_PAGES["/"];
  const canonical = SITE_BASE
    ? SITE_BASE.replace(/\/+$/, "") + pageKey
    : `${req.protocol}://${req.get("host")}${pageKey}`;
  const jsonLd = cfg.jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(cfg.jsonLd)}</script>`
    : "";

  const html = readIndex()
    .replaceAll("{{TITLE}}", escapeAttr(cfg.title))
    .replaceAll("{{DESCRIPTION}}", escapeAttr(cfg.description))
    .replaceAll("{{CANONICAL}}", escapeAttr(canonical))
    .replaceAll("{{JSON_LD}}", jsonLd)
    .replaceAll("{{DEFAULT_PLATFORM}}", cfg.platform || "")
    .replaceAll("{{DEFAULT_FORMAT}}", cfg.format || "")
    .replaceAll("{{SEO_CONTENT}}", cfg.seoContent || "");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}

function escapeAttr(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// All known landing pages (and the home page) → renderer
Object.keys(LANDING_PAGES).forEach((p) => {
  app.get(p, (req, res) => renderPage(req, res, p));
});

// FAQ page (static)
app.get("/faq", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "faq.html"));
});

// Legal pages (static)
app.get("/privacy", (_req, res) => res.sendFile(path.join(__dirname, "public", "privacy.html")));
app.get("/terms",   (_req, res) => res.sendFile(path.join(__dirname, "public", "terms.html")));
app.get("/dmca",    (_req, res) => res.sendFile(path.join(__dirname, "public", "dmca.html")));

// Sitemap.xml
app.get("/sitemap.xml", (req, res) => {
  const base = SITE_BASE
    ? SITE_BASE.replace(/\/+$/, "")
    : `${req.protocol}://${req.get("host")}`;
  const urls = [...Object.keys(LANDING_PAGES), "/faq", "/privacy", "/terms", "/dmca"];
  const today = new Date().toISOString().split("T")[0];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${base}${u}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${u === "/" ? "1.0" : "0.8"}</priority>
  </url>`
  )
  .join("\n")}
</urlset>`;
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.send(xml);
});

// robots.txt
app.get("/robots.txt", (req, res) => {
  const base = SITE_BASE
    ? SITE_BASE.replace(/\/+$/, "")
    : `${req.protocol}://${req.get("host")}`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(`User-agent: *
Allow: /
Disallow: /api/

Sitemap: ${base}/sitemap.xml
`);
});

// =============================================================================
// Lemon Squeezy license verification
// =============================================================================
// Validates a license key against LS's public Validate endpoint. No API key
// required for this call (LS exposes it without auth).
// Docs: https://docs.lemonsqueezy.com/api/license-api
// =============================================================================
app.post("/api/verify-license", async (req, res) => {
  const key = (req.body && req.body.key ? String(req.body.key) : "").trim();
  if (!key) return res.json({ valid: false, error: "Missing key" });

  try {
    const r = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({ license_key: key }),
    });
    const data = await r.json();

    const ok =
      r.ok &&
      data &&
      data.valid === true &&
      data.license_key &&
      ["active", "inactive"].includes(data.license_key.status);

    if (!ok) {
      console.warn("[license] rejected:", key.slice(0, 8) + "…", data && data.error);
      return res.json({ valid: false, error: (data && data.error) || "Invalid license" });
    }

    return res.json({
      valid: true,
      status: data.license_key.status,
      expires_at: data.license_key.expires_at,
    });
  } catch (e) {
    console.error("[license] verify failed:", e.message);
    res.status(500).json({ valid: false, error: "Verification service unreachable" });
  }
});

const PORT = process.env.PORT || 3000;
// Bind to 0.0.0.0 explicitly so cloud platforms (Railway, Fly, Render) can reach it.
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
