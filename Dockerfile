# Clip — production image
# Builds an image with Node 20, yt-dlp, and ffmpeg. Works on Railway, Fly.io,
# Render, DigitalOcean App Platform — anything that takes a Dockerfile.

FROM node:20-bookworm-slim

# Bookworm ships Python 3.11, which yt-dlp now requires.
# ffmpeg is needed for merging video+audio streams and for the MP3 extract path.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        ca-certificates \
        ffmpeg \
        curl \
 && pip3 install --no-cache-dir --break-system-packages --upgrade yt-dlp \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install npm deps first so Docker can cache the layer when only source changes.
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app.
COPY . .

# Railway / Fly inject PORT at runtime; default to 3000 for local docker run.
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
