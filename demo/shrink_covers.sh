#!/bin/sh
# Turn newly downloaded cover scans into small JPEGs (300 px wide), flattening any
# transparency onto white. Ones already that small are left alone, so they aren't
# recompressed. Needs ImageMagick.
set -eu
for f in "$(dirname "$0")"/covers/*.jpg; do
  [ "$(identify -format '%w' "$f[0]")" -le 300 ] && [ "$(identify -format '%m' "$f[0]")" = JPEG ] && continue
  convert "$f[0]" -background white -flatten -resize '300x>' -strip -interlace Plane -quality 80 "$f.tmp.jpg"
  mv "$f.tmp.jpg" "$f"
done
# Scans with a white scanner margin around the cover (trimmed by hand: trimming
# every file would also cut into covers that are themselves white).
for n in 6 10; do
  f="$(dirname "$0")/covers/$n.jpg"
  convert "$f" -bordercolor white -border 1 -fuzz 6% -trim +repage -strip -interlace Plane -quality 80 "$f.tmp.jpg"
  mv "$f.tmp.jpg" "$f"
done
