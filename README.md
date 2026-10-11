# Bookcase

An endless helical bookcase for a [calibre](https://calibre-ebook.com) library, drawn with WebGL.
It's a static page: it reads everything from the calibre content server it is served alongside,
so it needs no build step, no database and no server code of its own.

Inspired by Google's [WebGL Bookcase](https://developers.googleblog.com/designing-an-infinite-digital-bookcase/).

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
- Installs as an app on phones and desktops. A service worker keeps the page, covers you've seen and
  book details on the device, so it opens instantly and still works offline for shelves already visited.

It only ever reads from calibre, using these endpoints:

| Endpoint | Used for |
| --- | --- |
| `/ajax/library-info` | the default library |
| `/ajax/search` | book order and search |
| `/ajax/books` | titles and authors, for books on screen only |
| `/ajax/book` | one book's details, when it's opened |
| `/get/thumb` | covers, always at one size, so calibre caches a single copy |

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
  fonts/              optional: EBGaramond12-Regular.otf and EBGaramond12-Italic.otf
```

- **three.js:** Debian and Ubuntu ship it as `libjs-three` (`/usr/share/javascript/three/three.min.js`).
  Any build that defines the global `THREE` works.
- **Fonts:** EB Garamond is in Debian as `fonts-ebgaramond`. Without it the page falls back to Georgia.
- **Service worker:** it caches covers for 30 days (at most 4,000, about 25 MB). It needs HTTPS,
  as all service workers do. Bump `VERSION` in `sw.js` to discard every cached copy.
- **Proxy:** put a reverse proxy (nginx, Caddy, Envoy…) in front of `calibre-server`. Have it serve the
  `bookcase/` directory and pass everything else through to calibre.

The page's "Library" link and "Open in the library" links go to calibre's own interface at `/`.

## Licence

MIT
