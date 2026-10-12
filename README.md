# Bookcase

An endless helical bookcase for a [calibre](https://calibre-ebook.com) library, drawn with WebGL.
It's a static page: it reads everything from the calibre content server it is served alongside,
so it needs no build step, no database and no server code of its own.

Inspired by Google's [WebGL Bookcase](https://developers.googleblog.com/designing-an-infinite-digital-bookcase/).

**[Try the demo](https://pgenera.github.io/calibre-bookcase/)**: 151 public-domain books, no calibre needed.

## What it does

- Shows every book as a cover on a helical shelf, or as a spine drawn in the colour of its cover.
- Drag sideways to turn the helix and up or down to slide it. A flick keeps it moving.
  Pinch, ctrl+scroll or <kbd>+</kbd>/<kbd>−</kbd> zoom.
- Orders books newest first (the default), by author (then series and position), or by title.
- Search uses calibre's own search syntax, so `author:wolfe` or `series:"Book of the New Sun"` work.
- Click a book to pull it off the shelf and see its cover, description and download links.
  Its authors and series link to the rest of their books, which light up on the shelf.
  A series is stepped through in reading order.
- `#book=<id>` links straight to a book.
- Notices new books while it's open (it checks once a minute, and whenever you return to it) and grows
  them onto the shelf without moving what you're looking at.
- Pull down past the top of the shelf to refresh: it fetches the newest copy of the page and fresh book
  details, then reloads.
- Installs as an app on phones and desktops. A service worker keeps the page and covers on the device,
  and titles and authors are saved too, so it opens instantly and works offline. While you're not
  touching it, it fills in the rest of the covers in the background, nearest first (skipped in data-saver
  mode).

It only ever reads from calibre, using these endpoints:

| Endpoint | Used for |
| --- | --- |
| `/ajax/library-info` | the default library |
| `/ajax/search` | book order and search |
| `/ajax/books` | titles and authors, for books on screen only |
| `/ajax/book` | one book's details, when it's opened |
| `/get/thumb` | covers, always at one size, so calibre caches a single copy |

## Demo

With no calibre server answering (as on GitHub Pages), or with `?demo` in the URL, the page shows
the library in `demo/` instead: 151 books published in 1930 or earlier, so public domain in the
United States, including several series (Sherlock Holmes, Oz, Anne of Green Gables, Poirot, Barsoom,
Father Brown and more). The covers are drawn by `demo/build.py` in an old cloth-binding style; there
are no scans or modern cover art. The descriptions are short summaries written for the demo, and each
book links to a Project Gutenberg search rather than a download. Edit the list in `demo/build.py`
and run it to rebuild `demo/library.json` and `demo/covers/`.

## Setup

Serve these files from the same origin as the calibre content server (`calibre-server`,
calibre 5 or later), for example under `/bookcase/`:

```
bookcase/
  index.html
  bookcase.js
  sw.js               service worker (offline cache)
  manifest.webmanifest
  icons/
  three.min.js        three.js, r111 or later
  fonts/              EBGaramond12-Regular.otf and EBGaramond12-Italic.otf
  demo/               optional: only used when there's no calibre server
```

- **three.js:** a copy of r111 is included. Debian and Ubuntu also ship it as `libjs-three`
  (`/usr/share/javascript/three/three.min.js`), and any build that defines the global `THREE` works.
- **Fonts:** EB Garamond is included, and also in Debian as `fonts-ebgaramond`. Without it the page
  falls back to Georgia.
- **Service worker:** it keeps covers until calibre reports the book changed (at most 6,000, about
  35 MB). It needs HTTPS, as all service workers do. Bump `VERSION` in `sw.js` to discard every
  cached copy.
- **Proxy:** put a reverse proxy (nginx, Caddy, Envoy…) in front of `calibre-server`. Have it serve the
  `bookcase/` directory and pass everything else through to calibre.

The page's "Library" link and "Open in the library" links go to calibre's own interface at `/`.

## Licence

MIT, for the page, its scripts and the demo library.

Included third-party files keep their own licences:
- `three.min.js`: three.js r111, MIT; see `three.min.js.COPYRIGHT`.
- `fonts/`: EB Garamond by Georg Duffner, SIL Open Font License 1.1; see `fonts/COPYRIGHT`.

The books in the demo are in the public domain in the United States.
