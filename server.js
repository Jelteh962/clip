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
// Per-platform cookies bypass
// =============================================================================
// YouTube, TikTok and Instagram all increasingly require auth on datacenter IPs.
// We work around this by passing yt-dlp a cookies file built from logged-in
// sessions. Each platform gets its own env var so you can refresh them
// independently when one expires:
//   YT_COOKIES_BASE64  — youtube.com cookies (Netscape format, base64)
//   TT_COOKIES_BASE64  — tiktok.com cookies
//   IG_COOKIES_BASE64  — instagram.com cookies
// We combine whatever's present into one /tmp/cookies.txt at startup.
// yt-dlp matches cookies to the request domain automatically, so combined is fine.
// =============================================================================
const COOKIES_PATH = path.join(os.tmpdir(), "cookies.txt");
const COOKIES_LOADED = { youtube: false, tiktok: false, instagram: false };
let COOKIES_AVAILABLE = false;

(function loadCookies() {
  const sources = [
    { env: "YT_COOKIES_BASE64", platform: "youtube" },
    { env: "TT_COOKIES_BASE64", platform: "tiktok" },
    { env: "IG_COOKIES_BASE64", platform: "instagram" },
  ];
  const parts = ["# Netscape HTTP Cookie File", "# Combined by Clip server", ""];
  for (const src of sources) {
    if (!process.env[src.env]) continue;
    try {
      const raw = Buffer.from(process.env[src.env], "base64").toString("utf8");
      // Strip duplicate netscape header lines, keep cookie data
      const stripped = raw.replace(/^# Netscape HTTP Cookie File[\s\S]*?(?=^[^#]|^$)/m, "").trim();
      if (stripped) {
        parts.push(`# --- ${src.platform} ---`);
        parts.push(stripped);
        parts.push("");
        COOKIES_LOADED[src.platform] = true;
        console.log(`[clip] ${src.platform} cookies loaded from ${src.env}`);
      }
    } catch (e) {
      console.error(`[clip] Failed to decode ${src.env}:`, e.message);
    }
  }
  COOKIES_AVAILABLE = Object.values(COOKIES_LOADED).some(Boolean);
  if (COOKIES_AVAILABLE) {
    fs.writeFileSync(COOKIES_PATH, parts.join("\n"));
    console.log(`[clip] Combined cookies file written to ${COOKIES_PATH}`);
  }
})();

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

// =============================================================================
// URL sanitisation
// =============================================================================
// YouTube URLs that include &list= or &start_radio= push yt-dlp toward the
// "radio playlist" extractor, which is more heavily bot-walled than the plain
// video extractor. We normalise YouTube links to the canonical
// https://www.youtube.com/watch?v=<ID> form before passing them to yt-dlp.
// Other platforms (TikTok, Instagram) are passed through unchanged.
// =============================================================================
function sanitizeUrl(raw) {
  if (!raw || typeof raw !== "string") return raw;
  const url = raw.trim();
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");

    // youtu.be/<id>
    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }

    // youtube.com / m.youtube.com / music.youtube.com
    if (host.endsWith("youtube.com")) {
      // /shorts/<id>
      const shortsMatch = u.pathname.match(/^\/shorts\/([^/?]+)/);
      if (shortsMatch) return `https://www.youtube.com/watch?v=${shortsMatch[1]}`;
      // /embed/<id>
      const embedMatch = u.pathname.match(/^\/embed\/([^/?]+)/);
      if (embedMatch) return `https://www.youtube.com/watch?v=${embedMatch[1]}`;
      // /watch?v=<id>
      const v = u.searchParams.get("v");
      if (v) return `https://www.youtube.com/watch?v=${v}`;
    }
  } catch (e) {
    // Not a parseable URL — let yt-dlp handle it
  }
  return url;
}

// Common args we want on every yt-dlp invocation (formats + download).
function ytCommonArgs() {
  // Kept minimal: --user-agent and --force-ipv4 were causing YouTube's bot
  // detection to flag requests even with valid cookies + proxy attached.
  // The /api/test-proxy endpoint succeeds with this minimal set, so we use
  // the same minimal set everywhere now.
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--retries", "3",
    "--extractor-args", "youtube:player_client=default",
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
app.post("/api/formats", async (req, res) => {
  const url = sanitizeUrl(req.body && req.body.url);
  if (!url) return res.status(400).json({ error: "URL required" });

  // Retry up to 3 times — each attempt gets a fresh random proxy.
  // Handles "Video unavailable" (region-blocked proxy IP) and intermittent
  // bot challenges by giving us another shot from a different IP.
  const MAX_TRIES = 3;
  let lastDetail = "";
  let stdout = "";

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const result = await new Promise((resolve) => {
      execFile(
        "yt-dlp",
        [...ytCommonArgs(), "--dump-json", url],
        { timeout: 30000, maxBuffer: 32 * 1024 * 1024 },
        (err, _stdout, stderr) => resolve({ err, stdout: _stdout, stderr })
      );
    });
    if (!result.err) { stdout = result.stdout; lastDetail = ""; break; }
    lastDetail = (result.stderr || result.err.message || "").toString().trim().split("\n").slice(-3).join(" | ").slice(0, 500);
    console.warn(`[yt-dlp] formats attempt ${attempt}/${MAX_TRIES} failed:`, lastDetail);
  }

  if (lastDetail) {
    return res.status(400).json({ error: lastDetail || "Could not fetch video info." });
  }

  // Parse the JSON yt-dlp gave us into our normalised format list.
  try {
    const info = JSON.parse(stdout);
    const formats = info.formats || [];
    const seen = new Set();
    const videoFormats = [];

    // Combined formats (video+audio)
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

    // Video-only formats merged with best audio
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

    // Audio-only entry
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
});

// Validate a "M:SS", "MM:SS" or "HH:MM:SS" time string. Returns the original
// string if valid, null otherwise. Prevents shell-injection through the time arg.
function validTime(s) {
  if (!s || typeof s !== "string") return null;
  if (!/^(?:\d{1,2}:)?\d{1,2}:\d{2}$/.test(s.trim())) return null;
  return s.trim();
}

// Download endpoint
app.get("/api/download", (req, res) => {
  const { format_id, label, ext } = req.query;
  const url = sanitizeUrl(req.query.url);
  if (!url || !format_id) return res.status(400).json({ error: "Missing params" });

  // Optional Pro feature: trim a section of the video.
  // Both start and end must be valid; otherwise we ignore them and download
  // the full video. Server doesn't enforce Pro gating here — the client does
  // (Pro is verified via /api/verify-license on activation). A bad actor
  // bypassing the client check just gets a trimmed video, which is fine.
  const trimStart = validTime(req.query.start);
  const trimEnd = validTime(req.query.end);
  const trimSection = (trimStart && trimEnd) ? `*${trimStart}-${trimEnd}` : null;

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

  // Pro trim — extracts only the section from start to end.
  // --force-keyframes-at-cuts ensures clean cuts at the requested timestamps.
  if (trimSection) {
    args.push("--download-sections", trimSection, "--force-keyframes-at-cuts");
    console.log(`[yt-dlp] trim section: ${trimSection}`);
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
// Once your extension is published in the Chrome Web Store, set this env var
// to its install URL (e.g. https://chrome.google.com/webstore/detail/clip/abc...).
// Until then we point users at /chrome-extension explainer page.
const EXTENSION_URL = process.env.EXTENSION_URL || "/chrome-extension";

// Shared "Related tools" block automatically appended to every landing page's
// SEO content. Internal linking distributes page authority across the whole
// landing page set — every page reinforces every other page.
const RELATED_TOOLS_BLOCK = (currentPath) => {
  const ALL_TOOLS = [
    { path: "/youtube-to-mp3",                label: "YouTube to MP3" },
    { path: "/youtube-to-mp4",                label: "YouTube to MP4" },
    { path: "/youtube-shorts-downloader",     label: "YouTube Shorts" },
    { path: "/tiktok-downloader",             label: "TikTok downloader" },
    { path: "/tiktok-no-watermark",           label: "TikTok (no watermark)" },
    { path: "/tiktok-to-mp3",                 label: "TikTok to MP3" },
    { path: "/instagram-reels-downloader",    label: "Instagram Reels" },
    { path: "/instagram-video-downloader",    label: "Instagram videos" },
    { path: "/instagram-story-downloader",    label: "Instagram Stories" },
    { path: "/twitter-video-downloader",      label: "Twitter / X videos" },
    { path: "/facebook-video-downloader",     label: "Facebook videos" },
    { path: "/reddit-video-downloader",       label: "Reddit videos" },
    { path: "/vimeo-downloader",              label: "Vimeo videos" },
    { path: "/soundcloud-to-mp3",             label: "SoundCloud to MP3" },
    { path: "/twitch-clip-downloader",        label: "Twitch clips" },
    { path: "/chrome-extension",              label: "Chrome extension" },
  ];
  const others = ALL_TOOLS.filter((t) => t.path !== currentPath);
  return `
    <section class="seo-related">
      <h3 class="seo-related-title">More <span class="it">Clip</span> tools</h3>
      <div class="seo-related-grid">
        ${others.map((t) => `<a class="seo-related-link" href="${t.path}">${t.label} <span aria-hidden="true">→</span></a>`).join("")}
      </div>
    </section>
  `;
};

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
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      "name": "Clip",
      "applicationCategory": "MultimediaApplication",
      "operatingSystem": "Web",
      "offers": [
        { "@type": "Offer", "name": "Free", "price": "0", "priceCurrency": "EUR" },
        { "@type": "Offer", "name": "Pro", "price": "4", "priceCurrency": "EUR" }
      ],
      "description": "Free downloader for YouTube, Instagram and TikTok videos. No signup, no watermark."
    },
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
        <p>Not yet — Clip handles one video at a time right now. Playlist support is on our roadmap. For now, paste each video URL one by one.</p>

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
        <p>Not yet — batch downloads are on our roadmap. For now, paste each Short's URL one at a time.</p>
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

  "/tiktok-to-mp3": {
    title: "TikTok to MP3 — Save TikTok sounds as audio | Clip",
    description: "Convert any TikTok video to MP3. Save sounds, music and audio clips for use in your own videos. Free, no signup, no watermark.",
    platform: "tiktok",
    format: "mp3",
    jsonLd: HOWTO_JSON("How to convert a TikTok video to MP3", "TikTok"),
    seoContent: `
      <section class="seo-content">
        <h2>Convert any <span class="it">TikTok to MP3</span></h2>
        <p>Clip extracts the audio from any public TikTok video and saves it as a clean MP3 file. Useful for grabbing sounds you want to use in your own TikToks, saving original songs, or archiving viral audio before it disappears.</p>
        <ol>
          <li>Open the TikTok video and tap <strong>Share → Copy link</strong>.</li>
          <li>Paste the link above and click <strong>Get video</strong>.</li>
          <li>Pick <strong>Audio only (MP3)</strong> from the format grid.</li>
          <li>Click <strong>Download</strong>. The MP3 saves to your Downloads folder.</li>
        </ol>

        <h3>What audio quality do I get?</h3>
        <p>Clip pulls the highest-quality audio TikTok exposes for that video, then converts it to standard MP3 (typically 128–192 kbps). The audio is the original — not re-recorded or compressed extra times.</p>

        <h3>Can I use TikTok sounds in my own videos?</h3>
        <p>It depends on the source. TikTok's built-in sound library is licensed for use within TikTok. Re-uploading copyrighted audio elsewhere may infringe rights. Always check what you're using.</p>

        <h3>Related tools</h3>
        <ul>
          <li><a href="/tiktok-downloader">TikTok video downloader</a> — full video, no watermark.</li>
          <li><a href="/tiktok-no-watermark">TikTok without watermark</a> — clean MP4 export.</li>
          <li><a href="/youtube-to-mp3">YouTube to MP3</a> — same MP3 extraction for YouTube.</li>
        </ul>
      </section>
    `,
  },

  "/instagram-story-downloader": {
    title: "Instagram Story Downloader — Save public stories | Clip",
    description: "Download Instagram Stories from public accounts. No login, no watermark, original quality.",
    platform: "instagram",
    format: "",
    jsonLd: HOWTO_JSON("How to download an Instagram story", "Instagram"),
    seoContent: `
      <section class="seo-content">
        <h2>Download <span class="it">Instagram Stories</span> from public accounts</h2>
        <p>Public Instagram Stories disappear after 24 hours. Clip lets you save them while they're still up — useful for archiving your own content, keeping a copy of an interview, or saving something a brand posted about you.</p>
        <ol>
          <li>Open the story on Instagram (web or mobile).</li>
          <li>Tap the <strong>···</strong> menu on the story → <strong>Copy link</strong>.</li>
          <li>Paste the link above and click <strong>Get video</strong>.</li>
          <li>Pick MP4 (video stories) or MP3 (audio only) and download.</li>
        </ol>

        <h3>What about private accounts?</h3>
        <p>Clip only works with publicly accessible content. Stories from private accounts can't be downloaded — that's how Instagram designs the privacy boundary, and we respect it.</p>

        <h3>Will the account owner know?</h3>
        <p>No. Unlike viewing a story directly through Instagram (which shows you in the viewer list), downloading a story link through Clip doesn't notify the creator.</p>

        <h3>Related tools</h3>
        <ul>
          <li><a href="/instagram-reels-downloader">Instagram Reels downloader</a></li>
          <li><a href="/instagram-video-downloader">All Instagram videos</a></li>
          <li><a href="/instagram">Instagram homepage</a></li>
        </ul>
      </section>
    `,
  },

  "/twitter-video-downloader": {
    title: "Twitter / X Video Downloader — Free, fast, no signup | Clip",
    description: "Download videos from Twitter (X) in their original quality. Free, no signup, no watermark.",
    platform: "youtube",
    format: "",
    jsonLd: HOWTO_JSON("How to download a Twitter / X video", "Twitter"),
    seoContent: `
      <section class="seo-content">
        <h2>Download videos from <span class="it">Twitter / X</span></h2>
        <p>Twitter (now X) doesn't expose a download button on its videos. Clip pulls the underlying MP4 directly from the platform's CDN, so you can save the original file in its native quality.</p>
        <ol>
          <li>On Twitter / X, tap <strong>Share → Copy link</strong> on the post containing the video.</li>
          <li>Paste the link into the input above and click <strong>Get video</strong>.</li>
          <li>Pick a quality and click <strong>Download</strong>.</li>
        </ol>

        <h3>Does it work for old Twitter URLs (twitter.com vs x.com)?</h3>
        <p>Yes. Clip handles both <code>twitter.com</code> and <code>x.com</code> URLs identically — the underlying media is the same.</p>

        <h3>What about videos in replies and quote tweets?</h3>
        <p>Works the same way — copy the URL of the specific tweet that has the video attached, even if it's a reply or quoted post.</p>

        <h3>Related tools</h3>
        <ul>
          <li><a href="/youtube-to-mp4">YouTube downloader</a></li>
          <li><a href="/tiktok-downloader">TikTok downloader</a></li>
          <li><a href="/instagram-reels-downloader">Instagram Reels downloader</a></li>
        </ul>
      </section>
    `,
  },

  "/chrome-extension": {
    title: "Clip Chrome Extension — One-click video downloads | Clip",
    description: "Free Chrome extension that adds a Download button to YouTube, Instagram, TikTok, Twitter and Facebook. Skip the paste step — download in one click.",
    platform: "youtube",
    format: "",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      "name": "Clip Chrome Extension",
      "applicationCategory": "BrowserApplication",
      "operatingSystem": "Chrome",
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "EUR" },
      "description": "Adds a one-click Download button to YouTube, Instagram, TikTok, Twitter and Facebook video pages."
    },
    seoContent: `
      <section class="seo-content">
        <div class="ext-hero">
          <span class="ext-hero-tag">Free · Chrome Extension</span>
          <h2 style="margin-top:14px">One click. <span class="it">Any video.</span></h2>
          <p style="font-size:17px">A red Download button appears on every YouTube, Instagram, TikTok, Twitter and Facebook video page. Click it. The video opens in Clip with the link already filled in. Skip the copy-paste dance.</p>
          <p style="margin-top:18px">
            <a class="seo-cta" href="https://chrome.google.com/webstore/category/extensions" target="_blank" rel="noopener">
              Install for Chrome — it's free
            </a>
          </p>
          <p style="font-size:12px;color:var(--muted);margin-top:8px">Works on Chrome, Edge, Brave, Opera and any other Chromium browser.</p>
        </div>

        <h2 style="margin-top:64px">How it <span class="it">works</span></h2>
        <ol>
          <li><strong>Install the extension</strong> from the Chrome Web Store (one click).</li>
          <li><strong>Browse YouTube, TikTok, Instagram, Twitter or Facebook</strong> as you normally would.</li>
          <li>On any video page, you'll see a small red <strong>Download</strong> button in the bottom-right corner.</li>
          <li><strong>Click it.</strong> A new tab opens at Clip with the video loaded and ready to download.</li>
          <li><strong>Pick a quality, hit Download.</strong> Done.</li>
        </ol>

        <h2 style="margin-top:48px">What makes it <span class="it">good</span></h2>
        <h3>It only shows up when you actually want it</h3>
        <p>The button doesn't appear on the YouTube homepage, your Instagram inbox, or anywhere else that isn't a real video page. It only loads on watch pages, reels, posts and Twitter status URLs with video.</p>

        <h3>It doesn't slow your browser down</h3>
        <p>The extension is ~12 KB total. It runs only on the supported sites, doesn't track you across the web, doesn't read your data, and doesn't run any background processes when you're not on a video page.</p>

        <h3>It respects your privacy</h3>
        <p>The extension reads the URL of the page you click Download on — that's it. It doesn't collect history, login state, or any personal data. The list of permissions in the install prompt looks scary but is actually minimal — Chrome requires you grant access to each domain the extension reads URLs from. We grant ourselves access to YouTube, Instagram, TikTok, Twitter and Facebook only.</p>

        <h3>It's free, including for Pro users</h3>
        <p>Clip Pro and Free users both get the extension for free. Pro users get the same 1-click experience, but skip the ads and unlock 4K. <a href="/#features">See Pro features</a>.</p>

        <h2 style="margin-top:48px">Frequently <span class="it">asked</span></h2>
        <div class="seo-faq-item">
          <h3>Does the extension download videos itself, or does it use the website?</h3>
          <p>It opens the video in the Clip website. We do this on purpose — it means the same Pro features (4K, no ads) work in the extension, and you don't end up with two separate accounts to manage.</p>
        </div>
        <div class="seo-faq-item">
          <h3>Will it work on Edge / Brave / Opera?</h3>
          <p>Yes. All Chromium-based browsers run Chrome Web Store extensions. We've tested on Chrome, Edge and Brave. Firefox isn't supported yet — let us know if you want it.</p>
        </div>
        <div class="seo-faq-item">
          <h3>How do I uninstall?</h3>
          <p>Right-click the Clip icon in your Chrome toolbar → "Remove from Chrome." That's it.</p>
        </div>
        <div class="seo-faq-item">
          <h3>Does YouTube ban accounts that use this?</h3>
          <p>No. The extension doesn't sign you into YouTube or interact with your YouTube account in any way. It just reads the URL of the video page you're already viewing.</p>
        </div>
      </section>
    `,
  },

  "/reddit-video-downloader": {
    title: "Reddit Video Downloader — With sound, no fuss | Clip",
    description: "Download Reddit videos with audio in their original quality. Reddit's native download is silent — Clip merges the video and audio streams properly.",
    platform: "youtube",
    format: "",
    jsonLd: HOWTO_JSON("How to download a Reddit video", "Reddit"),
    seoContent: `
      <section class="seo-content">
        <h2>Download <span class="it">Reddit videos</span> with audio</h2>
        <p>Reddit hosts videos on a domain called <code>v.redd.it</code> and stores the video and audio as <strong>separate streams</strong>. That's why Reddit's own "Save" button gives you a silent video — the audio never gets attached. Clip merges both streams properly so the file you save actually has sound.</p>
        <ol>
          <li>Open the Reddit post containing the video.</li>
          <li>Tap <strong>Share → Copy link</strong> on the post (works for new Reddit, old Reddit, mobile, and Reddit apps).</li>
          <li>Paste the link into the input above and click <strong>Get video</strong>.</li>
          <li>Pick a quality and click <strong>Download</strong>. You'll get a single MP4 with video + audio merged.</li>
        </ol>

        <h3>Does it work for crossposts and old Reddit URLs?</h3>
        <p>Yes — Clip handles <code>reddit.com</code>, <code>old.reddit.com</code>, <code>v.redd.it</code> direct links, and crosspost URLs. The underlying video file is the same regardless of which URL form you paste.</p>

        <h3>Why does Reddit's own "Save" button drop the audio?</h3>
        <p>Reddit serves video and audio as separate HLS streams to save bandwidth. Their built-in download grabs only the video stream because muxing the two server-side would cost them money. Clip does the merge client-side via FFmpeg.</p>

        <h3>What about NSFW or quarantined subreddits?</h3>
        <p>Public videos in those subreddits work as long as the URL is publicly accessible. Subreddits requiring a login won't.</p>
      </section>
    `,
  },

  "/vimeo-downloader": {
    title: "Vimeo Downloader — Save Vimeo videos in HD | Clip",
    description: "Download public Vimeo videos in their original HD quality. Free, no signup, no watermark. Works for short films, tutorials, and creator portfolios.",
    platform: "youtube",
    format: "",
    jsonLd: HOWTO_JSON("How to download a Vimeo video", "Vimeo"),
    seoContent: `
      <section class="seo-content">
        <h2>Download videos from <span class="it">Vimeo</span></h2>
        <p>Vimeo doesn't expose a download button on most videos — creators have to explicitly enable it, and most don't. Clip pulls the underlying MP4 directly from Vimeo's CDN so you can save the original file.</p>
        <ol>
          <li>Open the Vimeo video page.</li>
          <li>Copy the URL from your browser's address bar (it'll look like <code>vimeo.com/123456789</code>).</li>
          <li>Paste into the input above and click <strong>Get video</strong>.</li>
          <li>Vimeo videos often have higher resolution than YouTube — pick the quality that fits your use.</li>
        </ol>

        <h3>Vimeo quality is usually high — why?</h3>
        <p>Vimeo skews toward filmmakers, designers and professional creators who upload from high-end cameras. A typical Vimeo upload is 1080p at minimum, often 4K. That's also why Vimeo files are larger than equivalent-length YouTube videos.</p>

        <h3>Can I download password-protected or private Vimeo videos?</h3>
        <p>No. Clip only works with publicly accessible content. Password-protected and members-only videos require Vimeo authentication, which Clip respects.</p>

        <h3>What about Vimeo Showcase / Vimeo OTT?</h3>
        <p>If the showcase is public, the underlying videos can be downloaded one at a time using each video's individual URL. Paid OTT content (Vimeo's Netflix-style platform) cannot be downloaded.</p>
      </section>
    `,
  },

  "/soundcloud-to-mp3": {
    title: "SoundCloud to MP3 — Save tracks as MP3 | Clip",
    description: "Convert any public SoundCloud track to MP3 in seconds. Free, no signup, original audio quality.",
    platform: "youtube",
    format: "mp3",
    jsonLd: HOWTO_JSON("How to convert a SoundCloud track to MP3", "SoundCloud"),
    seoContent: `
      <section class="seo-content">
        <h2>Convert <span class="it">SoundCloud</span> tracks to MP3</h2>
        <p>SoundCloud only lets artists offer downloads if they've enabled it for their track — and most don't. Clip pulls the audio stream directly from SoundCloud's CDN and saves it as a clean MP3 you can play anywhere.</p>
        <ol>
          <li>Open the SoundCloud track in a browser.</li>
          <li>Click <strong>Share → Copy link</strong> (or just copy the URL from the address bar).</li>
          <li>Paste it into the input above and click <strong>Get video</strong>.</li>
          <li>The MP3 option is pre-selected for SoundCloud links — click <strong>Download</strong>.</li>
        </ol>

        <h3>What audio quality do I get?</h3>
        <p>Clip extracts the highest-quality stream SoundCloud exposes for that track — typically 128 kbps MP3 for free uploads, up to 256 kbps for SoundCloud Pro accounts.</p>

        <h3>Can I download private or paid tracks?</h3>
        <p>No. Clip only works with publicly playable tracks. Private tracks, secret links, and paid downloads can't be accessed without SoundCloud authentication.</p>

        <h3>What about full SoundCloud playlists or sets?</h3>
        <p>Currently we handle one track at a time. Paste the URL of the specific track you want.</p>

        <h3>Is this fair to the artist?</h3>
        <p>If a track is publicly playable on SoundCloud, the artist has chosen to share it freely. Downloading it for personal listening is generally fine; redistributing or monetising it isn't. Support artists you like by following them, sharing, and buying their releases on platforms like Bandcamp.</p>
      </section>
    `,
  },

  "/twitch-clip-downloader": {
    title: "Twitch Clip Downloader — Save streamer clips | Clip",
    description: "Download Twitch clips in their original quality. Save your favorite streamer moments, your own clips, or anything you want to re-edit.",
    platform: "youtube",
    format: "",
    jsonLd: HOWTO_JSON("How to download a Twitch clip", "Twitch"),
    seoContent: `
      <section class="seo-content">
        <h2>Download <span class="it">Twitch clips</span></h2>
        <p>Twitch clips are short highlights pulled from a longer livestream — usually 30 seconds, sometimes up to 60. Clip saves them as standard MP4 files, perfect for re-uploading to TikTok or YouTube Shorts, archiving your favourite moments, or editing into compilations.</p>
        <ol>
          <li>Open the Twitch clip in a browser (URLs look like <code>clips.twitch.tv/SomeClipName</code> or <code>twitch.tv/{streamer}/clip/{name}</code>).</li>
          <li>Copy the URL from the address bar.</li>
          <li>Paste it into the input above and click <strong>Get video</strong>.</li>
          <li>Pick a quality and download.</li>
        </ol>

        <h3>Can I download full Twitch VODs (past streams)?</h3>
        <p>Technically yes for VODs that are publicly available, but they're often hours long and may exceed the free tier's 15-minute length cap. Pro users can download VODs of any length.</p>

        <h3>What about subscriber-only clips?</h3>
        <p>Subscriber-only content requires a Twitch login and can't be downloaded by Clip. Public clips work fine.</p>

        <h3>Does the streamer get notified?</h3>
        <p>No. Twitch doesn't notify creators when their clips are downloaded externally. That said, please credit creators when re-sharing their content.</p>

        <h3>Will it work for old clips from inactive streamers?</h3>
        <p>Yes, as long as the clip URL still loads on Twitch. Twitch keeps clips indefinitely unless the streamer or Twitch removes them.</p>
      </section>
    `,
  },

  "/facebook-video-downloader": {
    title: "Facebook Video Downloader — Save FB videos in HD | Clip",
    description: "Download videos from Facebook in HD. Public posts, Reels and watch videos — no signup, no watermark.",
    platform: "youtube",
    format: "",
    jsonLd: HOWTO_JSON("How to download a Facebook video", "Facebook"),
    seoContent: `
      <section class="seo-content">
        <h2>Download videos from <span class="it">Facebook</span></h2>
        <p>Clip saves Facebook videos as standard MP4 files — public posts, Facebook Reels, Watch videos, and most embedded video content. The download is the source quality, not a re-encoded preview.</p>
        <ol>
          <li>Open the Facebook video and click the <strong>Share</strong> button → <strong>Copy link</strong>.</li>
          <li>Paste the link into the input above and click <strong>Get video</strong>.</li>
          <li>Pick a resolution and click <strong>Download</strong>.</li>
        </ol>

        <h3>Can I download videos from private groups?</h3>
        <p>No. Clip only works with publicly accessible Facebook videos. Anything behind a login or in a private group can't be downloaded.</p>

        <h3>What about live videos?</h3>
        <p>You can download a Facebook Live broadcast after it ends and is saved to the page. Live streams in progress aren't supported.</p>

        <h3>Related tools</h3>
        <ul>
          <li><a href="/youtube-to-mp4">YouTube downloader</a></li>
          <li><a href="/twitter-video-downloader">Twitter / X downloader</a></li>
          <li><a href="/instagram-video-downloader">Instagram downloader</a></li>
        </ul>
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
  const baseHost = SITE_BASE
    ? SITE_BASE.replace(/\/+$/, "")
    : `${req.protocol}://${req.get("host")}`;
  const canonical = baseHost + pageKey;

  const jsonLdBlocks = [];
  if (cfg.jsonLd) jsonLdBlocks.push(cfg.jsonLd);

  // Auto-add a BreadcrumbList for non-home pages so Google can show the
  // breadcrumb in search results.
  if (pageKey !== "/") {
    const niceName = pageKey
      .replace(/^\//, "")
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    jsonLdBlocks.push({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Clip", "item": baseHost + "/" },
        { "@type": "ListItem", "position": 2, "name": niceName, "item": canonical },
      ],
    });
  }

  const jsonLd = jsonLdBlocks
    .map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`)
    .join("\n");

  // Auto-append the Related Tools block to any page that has SEO content.
  const seoContent = cfg.seoContent
    ? cfg.seoContent + RELATED_TOOLS_BLOCK(pageKey)
    : "";

  const html = readIndex()
    .replaceAll("{{TITLE}}", escapeAttr(cfg.title))
    .replaceAll("{{DESCRIPTION}}", escapeAttr(cfg.description))
    .replaceAll("{{CANONICAL}}", escapeAttr(canonical))
    .replaceAll("{{JSON_LD}}", jsonLd)
    .replaceAll("{{DEFAULT_PLATFORM}}", cfg.platform || "")
    .replaceAll("{{DEFAULT_FORMAT}}", cfg.format || "")
    .replaceAll("{{SEO_CONTENT}}", seoContent);

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

// Catch-all 404 — must be the LAST route registered so it only fires for
// URLs no other route matched. Serves the styled 404 page with the proper
// HTTP status so Google doesn't treat unknown URLs as soft-200s.
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
});

const PORT = process.env.PORT || 3000;
// Bind to 0.0.0.0 explicitly so cloud platforms (Railway, Fly, Render) can reach it.
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
