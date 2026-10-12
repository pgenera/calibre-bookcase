#!/usr/bin/env python3
"""Draw demo/preview.png, the 1200x630 picture shown when a link to the demo is
shared: the demo's covers on three turns of a helix, lit from the front.

usage: python3 demo/preview.py      (needs rsvg-convert)
"""
import base64
import json
import math
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
W, H = 1200, 630
BOOK_W, BOOK_H = 96, 144
R = 430                       # helix radius, px
PER_TURN = 24                 # books per turn
ROWS = [(118, 0.0), (290, 0.5), (462, 1.0)]   # (shelf top y, phase in books)


def data_uri(path):
    data = path.read_bytes()
    mime = 'image/jpeg' if path.suffix == '.jpg' else 'image/svg+xml'
    return f'data:{mime};base64,{base64.b64encode(data).decode()}'


def main():
    library = json.loads((HERE / 'library.json').read_text())
    # Scanned covers first, grouped by author and series as the demo shelves them.
    books = sorted((b for b in library['books'] if b['credit']),
                   key=lambda b: (b['author_sort'], b['series'] or '', b['series_index'] or 0))
    parts = [f'<rect width="{W}" height="{H}" fill="#14211b"/>']
    k = 0
    for row, (top, phase) in enumerate(ROWS):
        slots = []
        for j in range(-PER_TURN // 4 - 1, PER_TURN // 4 + 2):
            a = (j + phase) * 2 * math.pi / PER_TURN
            if abs(a) >= math.pi / 2 * 0.98:
                continue
            slots.append((math.cos(a), j, a))
        # Shelf plank under the row.
        parts.append(f'<rect x="{W / 2 - R - 20}" y="{top + BOOK_H}" width="{2 * R + 40}" height="9" fill="#5b3b22"/>')
        for depth, j, a in sorted(slots):          # far books first, so near ones overlap them
            b = books[(k + j + 50) % len(books)]
            x = W / 2 + R * math.sin(a)
            w = BOOK_W * math.cos(a)
            light = (1 - 0.55 * (abs(a) / (math.pi / 2)) ** 2) * (1 - 0.18 * abs(row - 1))
            shade = 1 - light
            parts.append(f'<image x="{x - w / 2:.1f}" y="{top}" width="{w:.1f}" height="{BOOK_H}" '
                         f'preserveAspectRatio="none" href="{data_uri(HERE.parent / b["cover"])}"/>')
            parts.append(f'<rect x="{x - w / 2:.1f}" y="{top}" width="{w:.1f}" height="{BOOK_H}" '
                         f'fill="#000" opacity="{shade:.2f}"/>')
        k += PER_TURN // 2 + 1
    # Lamp light and shadowed edges, as on the page.
    parts.append('<defs>'
                 '<radialGradient id="v" cx="50%" cy="50%" r="75%"><stop offset="55%" stop-color="#000" stop-opacity="0"/>'
                 '<stop offset="100%" stop-color="#000" stop-opacity="0.6"/></radialGradient>'
                 '<linearGradient id="band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14211b" stop-opacity="0"/>'
                 '<stop offset="0.6" stop-color="#14211b" stop-opacity="0.92"/></linearGradient></defs>')
    parts.append(f'<rect width="{W}" height="{H}" fill="url(#v)"/>')
    parts.append(f'<rect y="{H - 190}" width="{W}" height="190" fill="url(#band)"/>')
    serif = "'EB Garamond', 'Liberation Serif', Georgia, serif"
    parts.append(f'<text x="60" y="{H - 78}" font-family="{serif}" font-style="italic" font-size="64" fill="#ece3cf">Bookcase</text>')
    parts.append(f'<text x="62" y="{H - 38}" font-family="{serif}" font-size="27" fill="#a7ae9c">'
                 'A calibre library as an endless helix of books</text>')
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}">' + ''.join(parts) + '</svg>'
    tmp = HERE / '.preview.svg'
    tmp.write_text(svg)
    subprocess.run(['rsvg-convert', str(tmp), '-o', str(HERE / 'preview.png')], check=True)
    tmp.unlink()
    print(HERE / 'preview.png')


if __name__ == '__main__':
    main()
