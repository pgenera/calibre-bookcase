# Bookcase

An endless helical bookcase for a [calibre](https://calibre-ebook.com) library, drawn with WebGL.
It's a static page: it reads everything from the calibre content server it is served alongside,
so it needs no build step, no database and no server code of its own.

Inspired by Google's [WebGL Bookcase](https://developers.googleblog.com/designing-an-infinite-digital-bookcase/).

## What it does

- Shows every book as a cover on a helical shelf, or as a spine drawn in the colour of its cover.
- Drag sideways to turn the helix and up or down to slide it. A flick keeps it moving.
  Pinch, ctrl+scroll or <kbd>+</kbd>/<kbd>−</kbd> zoom.
- Orders books by author (then series and position), by title, or newest first.
- Search uses calibre's own search syntax, so `author:wolfe` or `series:"Book of the New Sun"` work.
- Click a book to pull it off the shelf and see its cover, description and download links.
- `#book=<id>` links straight to a book.

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
  three.min.js        three.js, r111 or later
  fonts/              optional: EBGaramond12-Regular.otf and EBGaramond12-Italic.otf
```

- **three.js:** Debian and Ubuntu ship it as `libjs-three` (`/usr/share/javascript/three/three.min.js`).
  Any build that defines the global `THREE` works.
- **Fonts:** EB Garamond is in Debian as `fonts-ebgaramond`. Without it the page falls back to Georgia.
- **Proxy:** put a reverse proxy (nginx, Caddy, Envoy…) in front of `calibre-server`. Have it serve the
  `bookcase/` directory and pass everything else through to calibre.

The page's "Library" link and "Open in the library" links go to calibre's own interface at `/`.

## Licence

MIT
