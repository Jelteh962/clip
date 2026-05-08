# Clip — YouTube Downloader

A clean, minimalist YouTube downloader with a web UI.

## Requirements

- **Node.js** (v16+)
- **yt-dlp** installed and in your PATH
- **ffmpeg** (recommended, for merging high-quality video+audio)

## Setup

### 1. Install yt-dlp

**macOS (Homebrew):**
```bash
brew install yt-dlp
```

**Windows (winget):**
```bash
winget install yt-dlp
```

**Linux / pip:**
```bash
pip install yt-dlp
```

### 2. Install ffmpeg (recommended)

**macOS:** `brew install ffmpeg`  
**Windows:** Download from https://ffmpeg.org/download.html  
**Linux:** `sudo apt install ffmpeg`

### 3. Run the app

```bash
npm install
node server.js
```

Then open **http://localhost:3000** in your browser.

## Usage

1. Paste a YouTube URL
2. Click **Fetch** to load available formats
3. Select your preferred resolution/format
4. Click **Download** — the file saves to your downloads folder

## Notes

- For personal use only. Respect copyright and YouTube's Terms of Service.
- High-quality formats (1080p+) require ffmpeg for audio/video merging.
