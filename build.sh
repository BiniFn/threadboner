#!/bin/bash
# ─────────────────────────────────────────────────────────────────
#  THREADBORN — Full Build Script
#  Run: chmod +x build.sh && ./build.sh
# ─────────────────────────────────────────────────────────────────
set -e

VIDEO="media/videos/threadborn_trailer/1080p60/Trailer.mp4"
if [ -n "${TRAILER_AUDIO:-}" ]; then
  AUDIO="$TRAILER_AUDIO"
else
  AUDIO=""
fi
OUTPUT="threadborn_final.mp4"
YT_URL="https://www.youtube.com/watch?v=uc2aaziVV0w"

echo "🔍 Checking dependencies..."
command -v .venv/bin/python >/dev/null 2>&1 || { echo "❌ Python venv not found. Activate or create .venv"; exit 1; }
command -v yt-dlp >/dev/null 2>&1 || { echo "❌ yt-dlp not found. brew install yt-dlp"; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "❌ ffmpeg not found. brew install ffmpeg"; exit 1; }
echo "✅ All good."

echo ""
echo "🎬 Rendering trailer..."
.venv/bin/python -m manim -qh threadborn_trailer.py Trailer
echo "✅ Render done → $VIDEO"

echo ""
if [ -z "$AUDIO" ] || [ ! -f "$AUDIO" ]; then
  echo "❌ Set TRAILER_AUDIO to an audio file you have permission to use."
  exit 1
fi

DURATION=$(ffprobe -v error -show_entries format=duration \
           -of default=noprint_wrappers=1:nokey=1 "$VIDEO" | cut -d. -f1)
FADE_START=$((DURATION - 3))
echo ""
echo "📏 Duration: ${DURATION}s  |  Fade out at: ${FADE_START}s"

echo ""
echo "🔧 Merging..."
ffmpeg -y \
  -i "$VIDEO" \
  -i "$AUDIO" \
  -c:v copy -c:a aac -b:a 192k \
  -af "afade=t=in:st=0:d=1.5,afade=t=out:st=${FADE_START}:d=3" \
  -shortest \
  "$OUTPUT"

echo ""
echo "✅ Done! → $OUTPUT"
open "$OUTPUT"
