#!/usr/bin/env python3
"""Find public-domain cover scans for the demo books on Wikimedia Commons.

For each book in build.py: search English Wikipedia for its article, take the
article's lead image, and keep it only if the file lives on Commons and is
marked public domain. Writes demo/covers.json ({book id: {file, url, page,
licence, artist}}) and downloads a 300 px wide copy to demo/covers/<id>.jpg.
Books without a usable image keep their generated cover.

Uses the public MediaWiki APIs politely: one request at a time, a second apart,
with a descriptive User-Agent.

usage: python3 demo/find_covers.py [--refresh]
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import BOOKS  # noqa: E402

HERE = Path(__file__).resolve().parent
# Lead images that turned out not to be covers or title pages, on review: author
# portraits, illustrations and paintings, a comic strip, a stamp, a film still, a
# play poster, and Russian first-edition title pages that don't match the English
# titles in the demo.
NOT_COVERS = {11, 34, 35, 39, 40, 42, 43, 44, 65, 67, 81, 92, 110, 111, 113, 115, 143, 149, 150}
OUT = HERE / 'covers.json'
UA = 'calibre-bookcase demo cover finder (https://github.com/pgenera/calibre-bookcase)'
WIKI = 'https://en.wikipedia.org/w/api.php'
COMMONS = 'https://commons.wikimedia.org/w/api.php'
_last = 0.0


def api(base, **params):
    global _last
    time.sleep(max(0, _last + 1.0 - time.time()))
    _last = time.time()
    params.update(format='json', formatversion='2')
    req = urllib.request.Request(base + '?' + urllib.parse.urlencode(params), headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def get(url):
    global _last
    time.sleep(max(0, _last + 1.0 - time.time()))
    _last = time.time()
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def article(title, author, year):
    """The Wikipedia article for the book: the best search hit that mentions the author."""
    surname = author.split()[-1]
    hits = api(WIKI, action='query', list='search', srsearch=f'"{title}" {surname} {year}', srlimit=5)
    for h in hits['query']['search']:
        snippet = re.sub(r'<[^>]+>', '', h.get('snippet', ''))
        if surname.lower() in (h['title'] + ' ' + snippet).lower() or title.lower() in h['title'].lower():
            return h['title']
    return None


def lead_image(page):
    r = api(WIKI, action='query', prop='pageimages', piprop='name', titles=page, redirects=1)
    pages = r['query']['pages']
    return pages[0].get('pageimage') if pages else None


def commons_info(name):
    """Commons metadata for File:name, or None if it isn't on Commons."""
    r = api(COMMONS, action='query', prop='imageinfo', titles=f'File:{name}',
            iiprop='url|extmetadata|mime', iiurlwidth=300)
    page = r['query']['pages'][0]
    if page.get('missing') or 'imageinfo' not in page:
        return None
    info = page['imageinfo'][0]
    meta = info.get('extmetadata', {})
    text = lambda k: re.sub(r'<[^>]+>', '', meta.get(k, {}).get('value', '')).strip()
    return {'file': name, 'url': info.get('thumburl') or info['url'], 'page': info['descriptionurl'],
            'licence': text('LicenseShortName'), 'artist': text('Artist')[:120], 'mime': info.get('mime', '')}


def main():
    found = {} if '--refresh' in sys.argv or not OUT.exists() else json.loads(OUT.read_text())
    for k, (title, authors, year, *_rest) in enumerate(BOOKS):
        bid = str(k + 1)
        if bid in found:
            continue
        entry = None
        try:
            page = article(title, authors[0], year)
            name = lead_image(page) if page else None
            info = commons_info(name) if name else None
            if info and 'public domain' in info['licence'].lower() and info['mime'] in ('image/jpeg', 'image/png'):
                info['article'] = page
                entry = info
            print(f'{bid:>3} {title[:40]:40} {page or "-":40} {name or "-"} {info and info["licence"]}', flush=True)
        except Exception as e:     # one bad lookup shouldn't stop the run
            print(f'{bid:>3} {title[:40]:40} error: {e}', flush=True)
            continue
        found[bid] = entry
        OUT.write_text(json.dumps(found, indent=1, ensure_ascii=False) + '\n')
    for bid in list(found):
        if int(bid) in NOT_COVERS:
            found[bid] = None
    OUT.write_text(json.dumps(found, indent=1, ensure_ascii=False) + '\n')
    covers = HERE / 'covers'
    for bid, info in found.items():
        jpg = covers / f'{bid}.jpg'
        if not info:
            jpg.unlink(missing_ok=True)
        elif not jpg.exists():
            jpg.write_bytes(get(info['url']))   # converted to a small JPEG by shrink_covers.sh
    print(f'{sum(1 for v in found.values() if v)} of {len(BOOKS)} books have a public-domain cover')


if __name__ == '__main__':
    main()
