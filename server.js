const express = require("express");
const { execFile, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

// Common args we want on every yt-dlp invocation (formats + download).
function ytCommonArgs() {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--retries", "3",
    // Prefer Android client first — it sidesteps a lot of YouTube's web bot checks.
    "--extractor-args", "youtube:player_client=android,web",
    // Realistic UA helps with Instagram and TikTok specifically.
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  ];
  if (COOKIES_AVAILABLE) {
    args.push("--cookies", COOKIES_PATH);
  }
  return args;
}

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

// Serve the same index for platform routes (SPA-style routing)
app.get(["/youtube", "/instagram", "/tiktok"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// FAQ page
app.get("/faq", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "faq.html"));
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
