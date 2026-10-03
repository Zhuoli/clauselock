#!/usr/bin/env bash
# Generate one voiceover clip + SRT per scene with edge-tts; writes durations.json.
set -euo pipefail
cd "$(dirname "$0")"; NAR=${NAR:-narration.json}; OUT=${OUT:-out}; mkdir -p $OUT/tts
VOICE=${VOICE:-en-US-AndrewNeural}
n=$(jq length $NAR); echo '{' > $OUT/durations.json
for i in $(seq 0 $((n-1))); do
  id=$(jq -r ".[$i].id" $NAR); text=$(jq -r ".[$i].text" $NAR)
  [ -s $OUT/tts/$id.mp3 ] || ~/.venvs/tts/bin/edge-tts --voice "$VOICE" --rate=${RATE:-+4%} --text "$text" --write-media $OUT/tts/$id.mp3 --write-subtitles $OUT/tts/$id.srt
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $OUT/tts/$id.mp3)
  sep=$([ $i -lt $((n-1)) ] && echo , || true); echo "\"$id\": $d$sep" >> $OUT/durations.json
done
echo '}' >> $OUT/durations.json; cat $OUT/durations.json
