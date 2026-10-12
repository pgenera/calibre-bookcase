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
# Images that turned out, on review, not to be covers or title pages of the book:
# author portraits, illustrations and paintings, a comic strip, a stamp, a film
# still, posters, a building plan, and Russian first-edition title pages that
# don't match the English titles in the demo. Names are compared ignoring _ vs space.
REJECTED = {
    'How Uncle Eli Laughed Too Soon.jpg', 'Alice-entering-looking-glass-house-vertical-alignment.png',
    'Tom Sawyer 1876 frontispiece.jpg', '1989 CPA 6130.jpg', 'Cooper-Offterdinger.jpg',
    'Dartagnan-musketeers.jpg', 'Myladys son 1925 David Ljungdahl 021.jpg', 'Vicomte de Bragelonne Gravure1.jpg',
    'G. K. Chesterton at the age of 31.jpg', 'CassandraAusten-JaneAusten(c.1810) hires.jpg',
    'Olivertwist front.jpg', 'Tolstoy - War and Peace - first edition, 1869.jpg', 'AnnaKareninaTitle.jpg',
    'Dostoevsky-Brothers Karamazov.jpg', 'Monsieur Madeleine par Gustave Brion.jpg',
    'Peter-pan-play-announcement.jpg', 'Portrait of Rafael Sabatini.jpg', 'André Castaigne Fantôme Opéra1.jpg',
    'The Marvelous Land of Oz (1904) - The End.jpg', 'The Adventures of Tom Sawyer. Mark Twain. 1876.jpg',
    'The Secret of Father Brown (1927) - frontispiece.png', 'Oliver Twist Pavilion Theatre 1838.jpg',
    'Tolstoy - War and Peace - third edition, 1873.png', 'Cover of the first edition of Crime and Punishment.jpg',
    'The Brothers Karamazov first edition cover page.JPG', 'Peter pan 1911 pipes.jpg',
    'Cover Sheet and Site Plan - Cape Arago Lighthouse, Gregory Point, Charleston, Coos County, OR HABS OR-189 (sheet 1 of 7).png',
}
OUT = HERE / 'covers.json'
TRIED = HERE / '.covers-searched.json'   # books already searched on Commons (not published)


def rejected(name):
    return name.replace('_', ' ') in REJECTED


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


COVERISH = ('cover', 'jacket', 'title', 'first', 'edition', '1st')


def commons_search(title, authors, year):
    """Second chance for books whose article had no usable image: search Commons
    files by title, keeping names that look like a cover of this book."""
    words = [w for w in re.findall(r"[A-Za-z']+", title) if len(w) >= 4 and w.lower() not in ('with', 'from', 'that')]
    key = max(words, key=len).lower() if words else title.lower()
    surname = authors[0].split()[-1].lower()
    for query in (f'"{title}" {year}', f'"{title}" cover', f'{title} {surname}'):
        hits = api(COMMONS, action='query', list='search', srsearch=query, srnamespace=6, srlimit=10)
        for h in hits['query']['search']:
            name = h['title'].split(':', 1)[1]
            low = name.lower()
            if rejected(name) or key not in low.replace('_', ' ') or not any(c in low for c in COVERISH + (str(year),)):
                continue
            info = commons_info(name)
            if info and 'public domain' in info['licence'].lower() and info['mime'] in ('image/jpeg', 'image/png'):
                return info
    return None


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
            if (info and not rejected(name) and 'public domain' in info['licence'].lower()
                    and info['mime'] in ('image/jpeg', 'image/png')):
                info['article'] = page
                entry = info
            print(f'{bid:>3} {title[:40]:40} {page or "-":40} {name or "-"} {info and info["licence"]}', flush=True)
        except Exception as e:     # one bad lookup shouldn't stop the run
            print(f'{bid:>3} {title[:40]:40} error: {e}', flush=True)
            continue
        found[bid] = entry
        OUT.write_text(json.dumps(found, indent=1, ensure_ascii=False) + '\n')
    # A second pass over books still without a cover (including ones whose
    # Wikipedia image wasn't a cover), searching Commons itself.
    tried = json.loads(TRIED.read_text()) if TRIED.exists() else []
    for k, (title, authors, year, *_rest) in enumerate(BOOKS):
        bid = str(k + 1)
        if found.get(bid) or bid in tried:
            continue
        try:
            info = commons_search(title, authors, year)
        except Exception as e:
            print(f'{bid:>3} {title[:40]:40} search error: {e}', flush=True)
            continue
        tried.append(bid)
        TRIED.write_text(json.dumps(tried) + '\n')
        print(f'{bid:>3} {title[:40]:40} search: {info["file"] if info else "-"}', flush=True)
        if info:
            info['article'] = None
            found[bid] = info
        OUT.write_text(json.dumps(found, indent=1, ensure_ascii=False) + '\n')
    for bid, info in list(found.items()):
        if info and rejected(info['file']):
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
