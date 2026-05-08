const express = require("express");
const { execFile, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Get available formats for a video
app.post("/api/formats", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  execFile(
    "yt-dlp",
    ["--dump-json", "--no-playlist", url],
    { timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) {
        return res.status(400).json({ error: "Could not fetch video info. Check the URL." });
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

  const args = [
    "--no-playlist",
    "-f", format_id,
    "--merge-output-format", ext === "mp3" ? "mp3" : "mp4",
    "-o", outputTemplate,
  ];

  if (ext === "mp3") {
    args.push("-x", "--audio-format", "mp3");
  }

  args.push(url);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const child = execFile("yt-dlp", args, { timeout: 300000 }, (err) => {
    if (err) {
      res.write(`data: ${JSON.stringify({ type: "error", message: "Download failed." })}\n\n`);
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

const PORT = process.env.PORT || 3000;
// Bind to 0.0.0.0 explicitly so cloud platforms (Railway, Fly, Render) can reach it.
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
