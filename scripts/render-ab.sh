#!/bin/bash
# render-ab.sh — render one real letter in BOTH neural voices (full hybrid each),
# for an A/B comparison. Each word goes through the complete pipeline
# (espeak emphatics + selected neural voice + WSOLA vowel-length), then the words
# are concatenated with natural gaps and resampled to a common 24 kHz.
#
# Usage: scripts/render-ab.sh <piper|omnivoice> <out-basename-no-ext>
#
# Source: oracc tsae / P225173
#   ṭuppi Nabû-šumu-lēšir ana Ham-puḫi. eqla ina pān Didīya ramme.
#   "Tablet of Nabû-šumu-lēšir to Ham-puḫi: release the field at Didīya's disposal."
set -euo pipefail
cd "$(dirname "$0")/.."

ENGINE="${1:?engine: piper|omnivoice}"
OUT="${2:?output basename without extension}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SR=24000

# word | eBL IPA | gap-after (seconds)   — gap 0.06 = inside the personal name.
WORDS=(
  "01_tuppi|[ˈtˤup.pi]|0.14"
  "02_nabu|[na.ˈbuːː]|0.06"
  "03_sumu|[ˈʃu.mu]|0.06"
  "04_lesir|[ˈleː.ʃir]|0.14"
  "05_ana|[ˈa.na]|0.14"
  "06_hampuhi|[ˈxam.pu.xi]|0.40"
  "07_eqla|[ˈeq.la]|0.14"
  "08_ina|[ˈi.na]|0.14"
  "09_pan|[ˈpaːn]|0.14"
  "10_didiya|[di.ˈdiː.ja]|0.14"
  "11_ramme|[ˈram.me]|0.0"
)

silence() { # dur out
  ffmpeg -y -loglevel error -f lavfi -i "anullsrc=r=$SR:cl=mono" -t "$1" -sample_fmt s16 "$2"
}

LIST="$TMP/list.txt"
: > "$LIST"
echo "# A/B render — engine=$ENGINE  ($(date '+%F %T %Z'))"
for entry in "${WORDS[@]}"; do
  IFS='|' read -r name ipa gap <<< "$entry"
  raw="$TMP/${name}.wav"
  # Full hybrid render of this word on the selected engine.
  line=$(node dist/cli.js --ipa "$ipa" --engine "$ENGINE" -o "$raw" --detail 2>&1)
  echo "  $name $ipa"
  echo "$line" | sed 's/^/      /'
  # Normalize to common SR/mono/s16 so words in mixed engine rates concat cleanly.
  norm="$TMP/${name}_r.wav"
  ffmpeg -y -loglevel error -i "$raw" -ar $SR -ac 1 -sample_fmt s16 "$norm"
  echo "file '$norm'" >> "$LIST"
  # inter-word gap
  if [ "$gap" != "0.0" ]; then
    sil="$TMP/sil_${name}.wav"; silence "$gap" "$sil"
    echo "file '$sil'" >> "$LIST"
  fi
done

mkdir -p "$(dirname "$OUT")"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$LIST" -ar $SR -ac 1 -sample_fmt s16 "${OUT}.wav"
ffmpeg -y -loglevel error -i "${OUT}.wav" -codec:a libmp3lame -qscale:a 2 "${OUT}.mp3"
dur=$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${OUT}.wav")
echo "  -> ${OUT}.wav / .mp3  (${dur}s, ${SR} Hz)"
