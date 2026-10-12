#!/bin/sh
# Turn the downloaded cover scans into small JPEGs (300 px wide), flattening any
# transparency onto white. Needs ImageMagick.
set -eu
for f in "$(dirname "$0")"/covers/*.jpg; do
  convert "$f" -background white -flatten -resize '300x>' -strip -interlace Plane -quality 80 "$f.tmp.jpg"
  mv "$f.tmp.jpg" "$f"
done
