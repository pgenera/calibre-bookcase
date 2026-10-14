/* An endless helical bookcase for the calibre library on this host.

   Everything comes from calibre-server's read-only JSON API on the same origin:
     /ajax/search   ordered book ids (and search hits)
     /ajax/books    title/author/series for a chunk of ids
     /ajax/book     one book's full details (description) when it is opened
     /get/thumb     cover thumbnails, always at one size so calibre caches one copy
   With no calibre server (say, on GitHub Pages), or with ?demo in the URL, it shows
   the public-domain demo library in demo/ instead.
   Needs three.js as the global THREE: r111 (Debian's libjs-three) and current
   releases both work. */
'use strict';

(() => {
  // --- tunables ----------------------------------------------------------------
  const R = 6.3;                 // helix radius (book faces sit on this cylinder)
  const PITCH = 1.9;             // vertical drop per full turn
  const COVER = { slot: 1.1, w: 1.0, h: 1.5, depth: 0.08 };
  const SPINE = { slot: 0.27, depth: 1.0 };
  const CAM_DIST = 9;            // camera distance in front of the helix face, at zoom 1
  const ZOOM = { min: 0.45, max: 1.9 };   // max grows on narrow screens so the whole helix fits
  let zoomMax = ZOOM.max;
  const VISIBLE_ARC = 1.75;      // radians either side of the front that get meshes
  const TURNS_VISIBLE = { covers: 3, spines: 2 };
  const THUMB = '150x225';
  const CHUNK = 100;             // ids per /ajax/books request
  const CHECK_EVERY = 60e3;      // look for new or removed books this often while visible
  const RECENT_EVERY = 864e5;    // once a day, check whether recent additions were edited...
  const RECENT_DAYS = 30;        // ...added this many days ago or less
  const GROW_MS = 900;           // a new book grows onto the shelf over this long
  // Vertical flicks, in turns/s. A flick's speed is multiplied by `boost`, and a flick
  // in the direction the helix is already sliding adds to it.
  const LIFT = { friction: 1.2, maxVel: 40, settle: 0.35, boost: 2.5 };
  // Work allowed per frame, so books streaming past don't stall the frame.
  const PER_FRAME = { uploads: 6, spines: 3 };
  const PULL_REFRESH = 120;      // px past the top of the shelf that triggers a refresh
  const PREFETCH = { covers: 2, idleMs: 1500 };   // background filling of the offline cache
  const MAX_META_FETCHES = 2;
  const MAX_THUMB_LOADS = 6;
  const TEXTURE_CACHE = 450;
  const SORTS = {
    author: 'sort=author_sort,series,series_index&sort_order=asc',
    title: 'sort=title&sort_order=asc',
    added: 'sort=timestamp&sort_order=desc',
  };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $ = (sel) => document.querySelector(sel);
  const stage = $('#stage');
  const statusEl = $('#status');

  function fail(html) {
    statusEl.innerHTML = html;
    statusEl.hidden = false;
  }

  if (!window.THREE) {
    fail('The bookcase needs three.js, which didn’t load. <a href="/">Open the regular library view</a>.');
    return;
  }
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl') || probe.getContext('experimental-webgl'))) {
    fail('This browser can’t draw 3D (no WebGL). <a href="/">Open the regular library view</a>.');
    return;
  }

  // --- small helpers -------------------------------------------------------------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  function hash(n) {           // stable 0..1 per book id
    let x = (n | 0) * 2654435761;
    x ^= x >>> 15; x = Math.imul(x, 2246822519); x ^= x >>> 13;
    return ((x >>> 0) % 10007) / 10007;
  }
  async function getJSON(url, fresh = false) {
    // fresh: from calibre itself, not the service worker's saved copy.
    const r = await fetch(url, { credentials: 'same-origin', cache: fresh ? 'no-cache' : 'default' });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }
  function authorsText(m) {
    const a = (m && m.authors) || [];
    return a.length ? 'by ' + (a.length > 2 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a.join(' and ')) : '';
  }
  function seriesText(m) {
    if (!m || !m.series) return '';
    const i = m.series_index;
    if (!i) return `Part of ${m.series}`;
    return `Book ${Number.isInteger(i) ? i : i.toFixed(1)} of ${m.series}`;
  }
  // three.js renamed the *BufferGeometry classes and added colour management after r111.
  const BoxGeometry = THREE.BoxBufferGeometry || THREE.BoxGeometry;
  const CylinderGeometry = THREE.CylinderBufferGeometry || THREE.CylinderGeometry;
  function srgb(tex) {
    if (THREE.SRGBColorSpace && 'colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const SERIF = '"EB Garamond", Georgia, serif';

  // --- where the books come from ---------------------------------------------------------
  // calibre's content server, or the static demo library. Both answer the same questions.
  function calibreSource(library) {
    const q = (path, fresh) => getJSON(path, fresh);
    const order = (sortKey, seriesOrder) => (seriesOrder ? 'sort=series_index&sort_order=asc' : SORTS[sortKey]);
    return {
      name: library, home: '/', live: true, demo: false,
      order: async (sortKey) => (await q(`/ajax/search/${library}?num=100000&${order(sortKey)}`)).book_ids,
      search: async (text, sortKey, seriesOrder) =>
        (await q(`/ajax/search/${library}?num=100000&${order(sortKey, seriesOrder)}&query=${encodeURIComponent(text)}`)).book_ids,
      recent: async (days) =>
        (await q(`/ajax/search/${library}?num=100000&${SORTS.added}&query=${encodeURIComponent(`date:>${days}daysago`)}`)).book_ids,
      books: (list, fresh) => q(`/ajax/books/${library}?ids=${list.join(',')}&category_urls=false`, fresh),
      book: (id) => q(`/ajax/book/${id}/${library}?category_urls=false`),
      thumb: (id) => `/get/thumb/${id}/${library}?sz=${THUMB}`,
      cover: (id) => `/get/cover/${id}/${library}`,
      credit: () => null,
      links: (id, b) => [
        { text: 'Open in the library', href: `/#book_id=${id}&library_id=${encodeURIComponent(library)}&panel=book_details` },
        ...Object.entries(b.main_format || {}).map(([fmt, href]) => ({ text: `Download ${fmt.toUpperCase()}`, href, download: true })),
      ],
    };
  }

  function demoSource(data) {
    const byId = new Map(data.books.map((b) => [b.id, b]));
    const fold = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const titleKey = (b) => fold(b.title).replace(/^(the|a|an) /, '');
    const sorters = {
      added: (a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0),
      title: (a, b) => titleKey(a).localeCompare(titleKey(b)),
      author: (a, b) => fold(a.author_sort).localeCompare(fold(b.author_sort)) ||
        fold(a.series || '').localeCompare(fold(b.series || '')) ||
        (a.series_index || 0) - (b.series_index || 0) || titleKey(a).localeCompare(titleKey(b)),
    };
    const sorted = (list, sortKey) => list.slice().sort(sorters[sortKey] || sorters.added).map((b) => b.id);
    // Enough of calibre's search syntax for the page's own links (authors:"=X",
    // series:"=X") plus plain words, each of which must appear somewhere.
    function matches(text) {
      const exact = /^(authors|series|title):"=((?:[^"\\]|\\.)*)"$/.exec(text.trim());
      if (exact) {
        const want = fold(exact[2].replace(/\\(.)/g, '$1'));
        const field = exact[1];
        return (b) => (field === 'authors' ? b.authors.some((a) => fold(a) === want) : fold(b[field]) === want);
      }
      const words = fold(text).split(/\s+/).filter(Boolean).map((w) => w.replace(/^\w+:/, '').replace(/"/g, ''));
      return (b) => {
        const hay = fold([b.title, b.authors.join(' '), b.series || ''].join(' '));
        return words.every((w) => hay.includes(w));
      };
    }
    const brief = (b) => ({ title: b.title, authors: b.authors, series: b.series, series_index: b.series_index,
                            main_format: {}, last_modified: b.added });
    return {
      name: 'demo', home: data.home || '.', live: false, demo: true,
      order: async (sortKey) => sorted(data.books, sortKey),
      search: async (text, sortKey, seriesOrder) => {
        const hits = data.books.filter(matches(text));
        return seriesOrder ? hits.slice().sort((a, b) => (a.series_index || 0) - (b.series_index || 0)).map((b) => b.id)
                           : sorted(hits, sortKey);
      },
      books: async (list) => Object.fromEntries(list.filter((id) => byId.has(id)).map((id) => [id, brief(byId.get(id))])),
      book: async (id) => {
        const b = byId.get(id);
        return Object.assign(brief(b), { comments: b.comments, pubdate: b.pubdate, links: b.links });
      },
      thumb: (id) => (byId.get(id) || {}).cover || `demo/covers/${id}.svg`,
      cover: (id) => (byId.get(id) || {}).cover || `demo/covers/${id}.svg`,
      links: (id, b) => b.links || (byId.get(id) || {}).links || [],
      credit: (id) => (byId.get(id) || {}).credit || null,
    };
  }

  async function chooseSource() {
    const wantDemo = new URLSearchParams(location.search).has('demo');
    if (!wantDemo) {
      try {
        const info = await getJSON('/ajax/library-info');
        return calibreSource(info.default_library || 'books');
      } catch (e) { /* no calibre here: try the demo */ }
    }
    return demoSource(await getJSON('demo/library.json'));
  }
  let source = null;

  // --- state ---------------------------------------------------------------------
  let ids = [];                  // book ids in display order
  let indexOf = new Map();       // id -> position
  const meta = new Map();        // id -> {title, authors, series, series_index, main, lm (last modified)}
  const chunkState = new Map();  // chunk number -> 'loading' | 'done'
  const fresh = new Set();       // ids whose metadata came from calibre during this visit
  let lastInput = 0;             // time of the last touch, click, wheel or key
  let metaInFlight = 0;

  const params = new URLSearchParams(location.hash.slice(1));
  let mode = params.get('mode') || store.get('bookcase.mode') || 'covers';
  if (mode !== 'covers' && mode !== 'spines') mode = 'covers';
  const sortChosen = params.get('sort') || store.get('bookcase.sort');
  let sortKey = sortChosen || 'added';
  if (!SORTS[sortKey]) sortKey = 'added';
  // A real library opens newest first; the demo (whose "date added" is made up) by
  // author, which keeps each series together.
  const defaultSort = () => (source && source.demo ? 'author' : 'added');
  let m = mode === 'spines' ? 1 : 0;   // animated 0 (covers) .. 1 (spines)

  let pos = 0;                   // continuous position along the helix, in books
  let vel = 0;                   // books per second
  let target = null;             // animate pos toward this, when set
  // Vertical movement slides the helix without turning it: `lift` is an offset in
  // turns, and it only settles on whole turns, which look exactly like no offset.
  let lift = 0, liftVel = 0, liftTarget = null;
  let liftDir = 0;               // direction of the last slide, so small nudges carry on to the next turn
  // At the top of the shelf the camera rests this many turns down, so the newest
  // books start just under the header instead of mid-screen below empty space.
  let headTurns = 0;
  let footTurns = 0;             // likewise at the bottom, so the oldest books end just above the caption
  let tween = null;              // a glide started by goTo: from/to pos and lift, start, duration
  let zoom = 1;
  let introT = 1;                // 0..1 while the opening plays
  const born = new Map();        // id -> time it appeared, for the grow-in animation
  let pull = 0;                  // px dragged down past the top of the shelf
  let refreshing = false;
  let selected = null;           // index of the opened book
  let selT = 0;                  // pull-out animation 0..1
  let prevSel = null, prevT = 0; // the previously open book, sliding back in
  let hits = null, hitAt = 0;    // search results (indices) and the current one
  let dirty = true;

  // --- three.js scene --------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const bg = new THREE.Color(css('--wall', '#14211b'));
  scene.background = bg;
  scene.fog = new THREE.Fog(bg, CAM_DIST + 2, CAM_DIST + R * 1.6);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 1.4, R + CAM_DIST);
  camera.lookAt(0, 0.5, 0);

  const helix = new THREE.Group();
  scene.add(helix);

  // The case's dark core hides the far side of the helix.
  const core = new THREE.Mesh(
    new CylinderGeometry(R - 1.08, R - 1.08, 60, 64, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x24170e }));
  scene.add(core);

  const box = new BoxGeometry(1, 1, 1);
  const paper = new THREE.MeshBasicMaterial({ color: 0xddd2bb });
  const board = new THREE.MeshBasicMaterial({ color: 0x2a1f17 });
  const blank = srgb(new THREE.DataTexture(new Uint8Array([58, 72, 62, 255]), 1, 1, THREE.RGBAFormat));
  blank.needsUpdate = true;

  // Shelf plank under every visible book: one instanced draw call.
  const MAX_BOOKS = 1600;
  const shelfMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(css('--walnut', '#5b3b22')) });
  const shelves = new THREE.InstancedMesh(box, shelfMat, MAX_BOOKS);
  shelves.count = 0;
  helix.add(shelves);

  // Pool of book meshes. Face order on a box: +x, -x, +y, -y, +z (outward face), -z.
  const pool = [];
  const active = new Map();      // index -> mesh
  function makeBook() {
    const face = new THREE.MeshBasicMaterial({ map: blank, color: 0xffffff });
    const mesh = new THREE.Mesh(box, [board, board, paper, paper, face, board]);
    mesh.userData.face = face;
    mesh.visible = false;
    helix.add(mesh);
    return mesh;
  }

  // --- textures ---------------------------------------------------------------------
  // One LRU for both cover thumbnails and generated spines.
  const textures = new Map();    // key -> {tex, img?}
  function touch(key) {
    const v = textures.get(key);
    textures.delete(key);
    textures.set(key, v);
    return v;
  }
  function remember(key, v) {
    textures.set(key, v);
    while (textures.size > TEXTURE_CACHE) {
      const [k, old] = textures.entries().next().value;
      textures.delete(k);
      if (old.tex) old.tex.dispose();
    }
  }

  const thumbQueue = [];
  const thumbPending = new Set();
  let thumbLoads = 0;
  const avgColor = new Map();    // id -> css color from the cover
  const coverAspect = new Map(); // id -> width / height of the cover image

  const thumbUrl = (id) => source.thumb(id);
  function wantThumb(id, request = true) {
    const key = 't' + id;
    if (textures.has(key)) return touch(key).tex;
    if (request && !thumbPending.has(id)) { thumbPending.add(id); thumbQueue.push(id); thumbQueueDirty = true; }
    return null;
  }
  let thumbQueueDirty = false;
  function pumpThumbs() {
    if (thumbQueueDirty) {
      // Forget books that have scrolled out of range, then nearest to the front first.
      const here = front(), range = booksPerTurn() * (turnsShown() + 1);
      const dist = (id) => (indexOf.has(id) ? Math.abs(indexOf.get(id) - here) : Infinity);
      for (let k = thumbQueue.length - 1; k >= 0; k--) {
        if (dist(thumbQueue[k]) > range) { thumbPending.delete(thumbQueue[k]); thumbQueue.splice(k, 1); }
      }
      thumbQueue.sort((a, b) => dist(b) - dist(a));
      thumbQueueDirty = false;
    }
    while (thumbLoads < MAX_THUMB_LOADS && thumbQueue.length) {
      const id = thumbQueue.pop();
      const i = indexOf.get(id);
      if (i === undefined || Math.abs(i - front()) > booksPerTurn() * (turnsShown() + 1)) {
        thumbPending.delete(id);      // scrolled away; ask again if it comes back
        continue;
      }
      thumbLoads++;
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        thumbLoads--; thumbPending.delete(id);
        const tex = srgb(new THREE.Texture(img));
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        remember('t' + id, { tex, img });
        avgColor.set(id, averageColor(img));
        if (img.naturalWidth && img.naturalHeight) coverAspect.set(id, img.naturalWidth / img.naturalHeight);
        textures.delete('s' + id);    // redraw the spine in the cover's colour
        dirty = true; pumpThumbs();
      };
      img.onerror = () => { thumbLoads--; thumbPending.delete(id); pumpThumbs(); };
      img.src = thumbUrl(id);
    }
  }

  const sampler = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  sampler.canvas.width = sampler.canvas.height = 8;
  function averageColor(img) {
    sampler.drawImage(img, 0, 0, 8, 8);
    const d = sampler.getImageData(0, 0, 8, 8).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return [r / n, g / n, b / n];
  }

  function spineTexture(id) {
    const key = 's' + id;
    if (textures.has(key)) return touch(key).tex;
    const mt = meta.get(id);
    if (!mt || frameBudget.spines <= 0) return null;
    frameBudget.spines--;
    const c = document.createElement('canvas');
    c.width = 64; c.height = 384;
    const g = c.getContext('2d');
    let rgb = avgColor.get(id);
    if (!rgb) {
      const h = hash(id) * 360;
      rgb = hslToRgb(h, 0.3, 0.3);
    }
    g.fillStyle = `rgb(${rgb.map(Math.round).join(',')})`;
    g.fillRect(0, 0, c.width, c.height);
    const light = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) > 150;
    const ink = light ? '#1d1712' : '#f6efe4';
    // Bands near the head and foot, like a cloth binding.
    g.fillStyle = light ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.28)';
    g.fillRect(0, 18, 64, 3); g.fillRect(0, 363, 64, 3);
    g.save();
    g.translate(32, 30);
    g.rotate(Math.PI / 2);          // read top to bottom, as English spines do
    g.fillStyle = ink;
    g.textBaseline = 'middle';
    fitText(g, mt.title, 250, 28, 'italic 400', SERIF, 0, -1);
    g.globalAlpha = 0.85;
    fitText(g, surnameOf(mt), 70, 19, '400', SERIF, 262, 0);
    g.restore();
    const tex = srgb(new THREE.CanvasTexture(c));
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    remember(key, { tex });
    return tex;
  }
  function surnameOf(mt) {
    const a = (mt.authors || [])[0] || '';
    return a.split(/\s+/).pop();
  }
  function fitText(g, text, maxW, size, weight, family, x, y) {
    let s = size;
    do { g.font = `${weight} ${s}px ${family}`; } while (g.measureText(text).width > maxW && --s > 13);
    let t = text;
    if (g.measureText(t).width > maxW) {
      while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
      t += '…';
    }
    g.fillText(t, x, y);
  }
  function hslToRgb(h, s, l) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }

  // --- metadata ---------------------------------------------------------------------
  function wantMeta(i) {
    const c = Math.floor(i / CHUNK);
    if (!chunkState.has(c)) chunkState.set(c, 'queued');
  }
  function pumpMeta() {
    while (metaInFlight < MAX_META_FETCHES) {
      // Only chunks with books on screen, nearest first. Search runs on the server,
      // so the rest of the library never needs downloading.
      let best = null;
      for (const [c, st] of chunkState) {
        if (st === 'queued' && (best === null || Math.abs(c * CHUNK - front()) < Math.abs(best * CHUNK - front()))) best = c;
      }
      if (best === null) return;
      fetchChunk(best);
    }
  }
  async function fetchChunk(c) {
    chunkState.set(c, 'loading');
    metaInFlight++;
    const order = ids;
    // Books on screen get fresh details once per visit; the saved copy shows meanwhile.
    const slice = order.slice(c * CHUNK, (c + 1) * CHUNK).filter((id) => !fresh.has(id));
    try {
      if (!slice.length) { chunkState.set(c, 'done'); return; }
      const data = await source.books(slice);
      storeBooks(data);
      if (order === ids) chunkState.set(c, 'done');
      dirty = true;
      updateFacing();
    } catch (e) {
      if (order === ids) chunkState.set(c, 'queued');
      await new Promise((r) => setTimeout(r, 5000));
    } finally {
      metaInFlight--;
      pumpMeta();
    }
  }

  function storeBooks(data) {
    const changed = [];
    for (const [key, b] of Object.entries(data)) {
      if (!b) continue;
      const id = +key;
      const before = meta.get(id);
      // Covers are kept indefinitely; a book edited in calibre gets its cover fetched again.
      if (before && before.lm && b.last_modified && before.lm !== b.last_modified) {
        changed.push(thumbUrl(id));
        dropCover(id);
      }
      meta.set(id, { title: b.title, authors: b.authors, series: b.series, series_index: b.series_index,
                     main: b.main_format || {}, lm: b.last_modified });
      fresh.add(id);
    }
    if (changed.length && navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'forget', urls: changed.map((u) => new URL(u, location.href).href) });
    }
    if (changed.length) dirty = true;
    saveMeta();
  }

  // Forget the drawn cover and spine, so they're made again from a fresh thumbnail.
  function dropCover(id) {
    for (const k of ['t' + id, 's' + id]) {
      if (textures.has(k)) { textures.get(k).tex.dispose(); textures.delete(k); }
    }
    avgColor.delete(id);
  }

  // Titles, authors and series are kept on the device, so the whole shelf is
  // labelled at once on the next launch, online or not.
  const metaKey = () => `bookcase.meta.${source.name}`;
  function loadMeta() {
    try {
      const saved = JSON.parse(localStorage.getItem(metaKey()) || 'null');
      if (!saved || saved.v !== 1) return;
      for (const [id, [title, authors, series, series_index, main, lm]] of Object.entries(saved.books)) {
        if (!meta.has(+id)) meta.set(+id, { title, authors, series, series_index, main, lm });
      }
    } catch (e) { /* no storage, or a damaged copy: start empty */ }
  }
  let saveTimer = null;
  function saveMeta() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const books = {};
      for (const [id, mt] of meta) books[id] = [mt.title, mt.authors, mt.series, mt.series_index, mt.main, mt.lm];
      try { localStorage.setItem(metaKey(), JSON.stringify({ v: 1, books })); } catch (e) { /* full or private */ }
    }, 2000);
  }

  // --- background cache filling ---------------------------------------------------
  // While nobody is touching the screen, fetch covers and titles so they're on the
  // device before they're needed. First the books level with you but round the back
  // of the helix (out of sight, and next to appear when you turn it), then everything
  // else outward from where you are. The order follows you as you move.
  let prefetchQueue = null, prefetchAt = 0, prefetchFrom = 0, prefetching = 0, metaPrefetching = false;
  const prefetched = new Set();  // covers already requested during this visit
  function prefetchAllowed() {
    const net = navigator.connection;
    if (net && (net.saveData || /2g/.test(net.effectiveType || ''))) return false;
    return !document.hidden && !dragging && !pinch && target === null && liftTarget === null &&
           Math.abs(vel) < 0.02 && Math.abs(liftVel) < 0.01 && (Math.abs(lift - Math.round(lift)) < 1e-3 || atEnd()) &&
           performance.now() - lastInput > PREFETCH.idleMs && thumbLoads === 0 && metaInFlight === 0;
  }
  function prefetchOrder() {
    const here = front(), perBook = slot() / R, near = booksPerTurn() * turnsShown();
    const hidden = (i) => {
      let phi = ((i - pos) * perBook) % (2 * Math.PI);
      if (phi > Math.PI) phi -= 2 * Math.PI;
      if (phi < -Math.PI) phi += 2 * Math.PI;
      return Math.abs(phi) > VISIBLE_ARC;
    };
    const order = ids.map((id, i) => [id, Math.abs(i - here), Math.abs(i - here) <= near && hidden(i) ? 0 : 1]);
    order.sort((a, b) => a[2] - b[2] || a[1] - b[1]);
    return order.map((o) => o[0]);
  }
  function pumpPrefetch() {
    if (!ids.length || !navigator.serviceWorker || !navigator.serviceWorker.controller) return;
    if (!prefetchAllowed()) return;
    if (!prefetchQueue || Math.abs(front() - prefetchFrom) > booksPerTurn() / 2) {
      prefetchQueue = prefetchOrder();
      prefetchAt = 0;
      prefetchFrom = front();
    }
    // Titles for the next books in line, a chunk at a time, ahead of their covers.
    if (!metaPrefetching) {
      const missing = [];
      for (let k = prefetchAt; k < prefetchQueue.length && missing.length < CHUNK; k++) {
        if (!meta.has(prefetchQueue[k])) missing.push(prefetchQueue[k]);
        if (k - prefetchAt > 4 * CHUNK) break;      // only look a little way ahead
      }
      if (missing.length) {
        metaPrefetching = true;
        source.books(missing)
          .then(storeBooks).catch(() => {}).finally(() => { metaPrefetching = false; });
      }
    }
    while (prefetching < PREFETCH.covers && prefetchAt < prefetchQueue.length && prefetchAllowed()) {
      const id = prefetchQueue[prefetchAt++];
      if (prefetched.has(id) || textures.has('t' + id)) continue;
      prefetched.add(id);
      prefetching++;
      fetch(thumbUrl(id)).then((r) => r.blob()).catch(() => prefetched.delete(id)).finally(() => { prefetching--; });
    }
  }
  setInterval(pumpPrefetch, 250);
  for (const type of ['pointerdown', 'wheel', 'keydown']) {
    addEventListener(type, () => { lastInput = performance.now(); }, { capture: true, passive: true });
  }

  // --- layout -----------------------------------------------------------------------
  const slot = () => lerp(COVER.slot, SPINE.slot, m);
  const booksPerTurn = () => (2 * Math.PI * R) / slot();
  const front = () => pos + lift * booksPerTurn();       // the book level with the camera
  // Turns above and below the middle that get meshes: what the camera can see, plus one.
  function turnsShown() {
    const seen = (Math.tan((camera.fov * Math.PI) / 360) * camera.position.z) / PITCH + 1;
    return Math.max(TURNS_VISIBLE[mode], seen);
  }
  // The least and greatest lift with book i in front: the top and bottom of the shelf.
  // On a library too short to fill the screen, the top wins.
  function topLift(i = pos) {
    return headTurns - i / booksPerTurn();
  }
  function bottomLift(i = pos) {
    const end = (Math.max(0, ids.length - 1) - i) / booksPerTurn() - footTurns;
    return Math.max(topLift(i), end);
  }
  const clampLift = (l) => clamp(l, topLift(), bottomLift());
  const atTop = () => selected === null && Math.abs(lift - topLift()) < 1e-3;
  const atEnd = () => atTop() || (selected === null && Math.abs(lift - bottomLift()) < 1e-3);
  function foldLift() {           // turn a whole-turn lift into a position, invisibly
    const n = booksPerTurn(), turns = Math.round(lift), p = pos + turns * n;
    // Not near either end, where the lift is what keeps the end book front and centre.
    if (turns && p >= (headTurns + 1) * n && p <= ids.length - 1 - (footTurns + 1) * n) {
      pos = clamp(p, 0, Math.max(0, ids.length - 1));
      lift -= turns;
      if (Math.abs(lift) < 1e-3) lift = 0;
    }
    liftVel = 0; liftTarget = null; liftDir = 0;
  }
  function slide(newLift) {
    newLift = clampLift(newLift);
    if (newLift !== lift) liftDir = Math.sign(newLift - lift);
    lift = newLift;
  }

  function bookDims(id) {
    const h = hash(id);
    // Covers keep their own proportions (within what fits a slot), once the image is in.
    const aspect = coverAspect.get(id);
    const coverW = aspect ? clamp(COVER.h * aspect, 0.75, COVER.slot - 0.06) : COVER.w;
    return {
      w: lerp(coverW, 0.18 + 0.1 * h, m),
      h: lerp(COVER.h, 1.32 + 0.22 * hash(id + 7), m),
      d: lerp(COVER.depth, SPINE.depth, m),
    };
  }

  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();
  const tmpP = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);

  const onGpu = new WeakSet();    // textures already drawn once (so uploaded)
  const frameBudget = { uploads: 0, spines: 0 };
  let lastPump = 0, pumpLater = null;
  function layout() {
    frameBudget.uploads = PER_FRAME.uploads;
    frameBudget.spines = PER_FRAME.spines;
    const fast = Math.abs(liftVel) > 2.5 || Math.abs(vel) > booksPerTurn() * 2;
    const s = slot();
    const perTurn = booksPerTurn();
    const theta = (i) => (i * s) / R;
    const shelfY = (i) => -(theta(i) / (2 * Math.PI)) * PITCH;
    // Rotate and lift the helix so book `pos` is front and centre.
    // The opening: the helix rises and turns into place.
    const rise = 1 - Math.pow(1 - introT, 3);
    helix.rotation.y = -theta(pos) + (1 - rise) * 1.1;
    helix.position.y = -shelfY(pos) + lift * PITCH - 0.75 - pull * 0.45 * worldPerPixel() - (1 - rise) * 3.5;

    const span = Math.ceil(perTurn * turnsShown());
    const mid = Math.round(front());
    // The lamp hangs at the camera, except at the top, where it moves up to light the newest rows.
    const lampAt = front() - (headTurns * perTurn / 2) * clamp(2 - front() / (Math.max(1, headTurns) * perTurn), 0, 1)
      + (footTurns * perTurn / 2) * clamp(2 - (ids.length - 1 - front()) / (Math.max(1, footTurns) * perTurn), 0, 1);
    const want = new Set();
    // Nearest the camera first, so the pool runs out at the edges, not mid-screen.
    for (let d = 0; d <= span && want.size < MAX_BOOKS; d++) {
      for (const i of d ? [mid - d, mid + d] : [mid]) {
        if (i < 0 || i >= ids.length) continue;
        let phi = (theta(i) - theta(pos)) % (2 * Math.PI);
        if (phi > Math.PI) phi -= 2 * Math.PI;
        if (phi < -Math.PI) phi += 2 * Math.PI;
        if (Math.abs(phi) <= VISIBLE_ARC && want.size < MAX_BOOKS) want.add(i);
      }
    }
    for (const [i, mesh] of active) {
      if (!want.has(i)) { mesh.visible = false; active.delete(i); pool.push(mesh); }
    }

    let n = 0;
    for (const i of want) {
      const id = ids[i];
      let mesh = active.get(i);
      if (!mesh) {
        mesh = pool.pop() || makeBook();
        active.set(i, mesh);
        mesh.userData.index = i;
        mesh.visible = true;
      }
      wantMeta(i);
      const dim = bookDims(id);
      const th = theta(i);
      let out = 0;
      if (i === selected) out = selT * (0.6 + 0.6 * m);
      else if (i === prevSel) out = prevT * (0.6 + 0.6 * m);
      const r = R - dim.d / 2 + out;
      // A book that just arrived grows up from the shelf.
      let g = 1;
      if (born.has(id)) {
        const t = (performance.now() - born.get(id)) / GROW_MS;
        if (t >= 1 || reduceMotion) born.delete(id); else g = 1 - Math.pow(1 - t, 3);
      }
      const raise = i === selected ? selT * 0.15 : i === prevSel ? prevT * 0.15 : 0;
      mesh.position.set(Math.sin(th) * r, shelfY(i) + (dim.h * g) / 2 + raise, Math.cos(th) * r);
      mesh.rotation.set(0, th, 0);
      mesh.scale.set(dim.w * Math.max(0.001, g), dim.h * Math.max(0.001, g), dim.d);

      // Face texture: the cover, or the spine drawn in the cover's colour.
      const face = mesh.userData.face;
      // While flying past at speed, use only covers already loaded; fill in as it slows.
      const cover = wantThumb(id, !fast);
      let tex = m < 0.5 ? (cover || blank) : (spineTexture(id) || blank);
      if (tex !== blank && !onGpu.has(tex)) {
        // A texture is uploaded to the GPU the first time it's drawn: only a few a frame.
        if (frameBudget.uploads > 0) { frameBudget.uploads--; onGpu.add(tex); } else tex = blank;
      }
      if (face.map !== tex) face.map = tex;
      // Lit as if by a lamp in front: darker round the curve and further up or down.
      let phiI = (th - theta(pos)) % (2 * Math.PI);
      if (phiI > Math.PI) phiI -= 2 * Math.PI;
      if (phiI < -Math.PI) phiI += 2 * Math.PI;
      const side = Math.min(1, Math.abs(phiI) / VISIBLE_ARC);
      const turnsAway = Math.min(1, Math.abs(i - lampAt) / perTurn / 2.5);
      let light = i === selected ? 1 : (1 - 0.5 * side * side) * (1 - 0.35 * turnsAway);
      light *= 0.25 + 0.75 * rise;
      if (hits && !hits.set.has(i)) light *= 0.28;                 // dim non-matches
      face.color.setScalar(light);

      // Shelf plank under the book.
      tmpP.set(Math.sin(th) * (R - 0.55), shelfY(i) - 0.03, Math.cos(th) * (R - 0.55));
      tmpQ.setFromAxisAngle(yAxis, th);
      tmpS.set(s * 1.02, 0.06, 1.12);
      tmpM.compose(tmpP, tmpQ, tmpS);
      shelves.setMatrixAt(n++, tmpM);
    }
    shelves.count = n;
    shelves.instanceMatrix.needsUpdate = true;
    // Placeholders still waiting for their turn to upload: keep drawing until they're in.
    if (frameBudget.uploads <= 0 || frameBudget.spines <= 0) dirty = true;
    const now = performance.now();
    if (now - lastPump > 100) {
      lastPump = now;
      pumpMeta();
      pumpThumbs();
    } else if (!pumpLater) {
      // Make sure what this frame asked for is requested even if nothing moves again.
      pumpLater = setTimeout(() => { pumpLater = null; lastPump = performance.now(); pumpMeta(); pumpThumbs(); }, 110);
    }
  }

  function placeCamera() {
    // On narrow screens back off a little so a few covers fit across.
    const extra = camera.aspect < 0.8 ? 3 : 0;
    // Fully zoomed out, the helix's whole width fits across the screen with a little margin.
    const halfWidth = Math.tan((camera.fov * Math.PI) / 360) * camera.aspect;
    const fit = (R + 1.2) / halfWidth - R;
    zoomMax = Math.max(ZOOM.max, (fit - extra) / CAM_DIST);
    zoom = clamp(zoom, ZOOM.min, zoomMax);
    // While the book card is open the camera may back off so the open book fits beside it.
    restDist = CAM_DIST * zoom + extra;
    const dist = Math.max(restDist, view.need);
    camera.position.z = R + dist;
    scene.fog.near = dist + 2;
    scene.fog.far = dist + R * 1.6;
    dirty = true;
  }
  // --- keeping the open book in view beside its card -----------------------------------
  // The card covers the bottom of a phone screen, or the right of a wide one. Each frame
  // it's open (or moving), shift the picture so the open book is centred in the space
  // left over, and back the camera off if the book wouldn't fit there. Both follow the
  // card's real position, so they move with its slide and with a swipe.
  const view = { x: 0, y: 0, need: 0 };
  const headerEl = document.querySelector('header');
  // Where a world point lands on screen, in CSS px, ignoring the current view shift.
  function screenPoint(v, W, H, cam = camera) {
    v.project(cam);
    return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H];
  }
  // Targets come from where the open book will rest (front and centre, fully pulled
  // out), not from where it is mid-animation, and the view eases toward them.
  function followCard(force, dt = 1) {
    if (!force && selected === null && !view.x && !view.y && !view.need) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    const r = detail.getBoundingClientRect();
    const bottomSheet = sheetLayout.matches;
    const coverY = bottomSheet ? clamp(H - r.top, 0, H) : 0;
    const coverX = bottomSheet ? 0 : clamp(W - r.left, 0, W);
    let tx = 0, ty = 0, tneed = 0;
    if ((coverY || coverX) && selected !== null) {
      // The free area: below the header and above the card (phone), or left of it (desktop).
      const top = coverY ? Math.max(0, headerEl.getBoundingClientRect().bottom - 24) : 0;
      const bottom = H - coverY, right = W - coverX;
      const dim = bookDims(ids[selected]);
      const out = 0.6 + 0.6 * m;
      // An open book near either end rests above or below the camera's shelf.
      const rest = (tween ? tween.l : lift) * PITCH;
      const c = new THREE.Vector3(0, rest - 0.75 + dim.h / 2 + 0.15, R - dim.d / 2 + out);
      camera.clearViewOffset();
      camera.updateMatrixWorld();
      const [, yTop] = screenPoint(c.clone().setY(c.y + dim.h / 2), W, H);
      const [, yBot] = screenPoint(c.clone().setY(c.y - dim.h / 2), W, H);
      const [xL] = screenPoint(c.clone().setX(-dim.w / 2), W, H);
      const [xR] = screenPoint(c.clone().setX(dim.w / 2), W, H);
      // Back off until it fills at most 85% of the free height and 70% of the free width.
      const ratio = Math.max((yBot - yTop) / (0.85 * (bottom - top)), (xR - xL) / (0.7 * right));
      tneed = c.z + (camera.position.z - c.z) * ratio - R;
      // Then move the picture only as far as it takes to bring the whole book into the
      // free area, measured from where the camera will end up, so the book goes straight
      // there. A book already in the clear doesn't move.
      const cam = camera.clone();
      cam.position.z = R + Math.max(restDist, tneed);
      cam.updateMatrixWorld();
      const [, t1] = screenPoint(c.clone().setY(c.y + dim.h / 2), W, H, cam);
      const [, b1] = screenPoint(c.clone().setY(c.y - dim.h / 2), W, H, cam);
      const [l1] = screenPoint(c.clone().setX(-dim.w / 2), W, H, cam);
      const [r1] = screenPoint(c.clone().setX(dim.w / 2), W, H, cam);
      const my = 0.06 * (bottom - top), mx = 0.06 * right;
      ty = t1 < top + my ? t1 - (top + my) : b1 > bottom - my ? b1 - (bottom - my) : 0;
      tx = l1 < mx ? l1 - mx : r1 > right - mx ? r1 - (right - mx) : 0;
    }
    const k = force || reduceMotion ? 1 : 1 - Math.exp(-dt * 9);
    const nx = view.x + (tx - view.x) * k, ny = view.y + (ty - view.y) * k;
    const nneed = view.need + (tneed - view.need) * k;
    const before = [view.x, view.y, view.need];
    view.x = Math.abs(tx - nx) < 0.5 ? tx : nx;
    view.y = Math.abs(ty - ny) < 0.5 ? ty : ny;
    view.need = Math.abs(tneed - nneed) < 0.005 ? tneed : nneed;
    const moved = force || view.x !== before[0] || view.y !== before[1] || view.need !== before[2];
    if (moved) placeCamera();      // (marks the frame for redrawing)
    if (view.x || view.y) camera.setViewOffset(W, H, view.x, view.y, W, H); else camera.clearViewOffset();
  }

  // How many turns fit above and below the camera's shelf with the camera at rest: the
  // top row's books just clear the header, the bottom row's the caption.
  let restDist = CAM_DIST;
  const headPoint = new THREE.Vector3();
  function measureHead() {
    const H = stage.clientHeight;
    if (!H) return;
    const wasTop = atTop(), wasBottom = !wasTop && atEnd();
    const cam = camera.clone();
    cam.position.z = R + restDist;
    cam.clearViewOffset();
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const limit = Math.max(0, headerEl.getBoundingClientRect().bottom - stage.getBoundingClientRect().top) + 4;
    // Where the line of sight just under the header meets the front of the shelf.
    const shelfAt = (px) => {        // world height where the line of sight through px meets the shelf
      headPoint.set(0, 1 - (2 * px) / H, 0.5).unproject(cam).sub(cam.position);
      return cam.position.y + (headPoint.y * (R - cam.position.z)) / headPoint.z;
    };
    headTurns = Math.max(0, (shelfAt(limit) - (-0.75 + COVER.h)) / PITCH);
    // The caption is up to three lines (about 76px) above its bottom edge.
    const foot = $('#facing').getBoundingClientRect().bottom - stage.getBoundingClientRect().top - 76 - 8;
    footTurns = Math.max(0, (-0.75 - shelfAt(foot)) / PITCH);
    if (wasTop) lift = topLift();
    else if (wasBottom) lift = bottomLift();
    dirty = true;
  }

  function setZoom(z) {
    zoom = clamp(z, ZOOM.min, zoomMax);
    placeCamera();
    measureHead();
  }
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    placeCamera();
    measureHead();
    if (selected !== null || view.x || view.y) followCard(true);
  }
  addEventListener('resize', resize);

  // --- motion ---------------------------------------------------------------------
  function goTo(i, instant) {
    i = clamp(i, 0, Math.max(0, ids.length - 1));
    foldLift();
    vel = 0;
    const l = clamp(0, topLift(i), bottomLift(i));   // near an end, stay at the end
    dirty = true;
    if (instant || reduceMotion) { pos = i; lift = l; target = null; tween = null; return; }
    // Glide rather than spin: whole turns of the way become a straight slide up or down,
    // leaving at most half a turn of rotation, on an ease that starts and ends gently.
    const n = booksPerTurn();
    const turns = Math.round((i - pos) / n);
    const p1 = i - turns * n;
    const dur = Math.min(1.1, 0.45 + 0.12 * Math.sqrt(Math.abs(turns)) + 0.25 * Math.abs(p1 - pos) / n);
    tween = { p0: pos, l0: lift, p1, l1: l + turns, l, t0: performance.now(), dur };
    target = i; liftTarget = null;
  }

  let last = performance.now();
  let dragging = false;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    followCard(false, dt);
    if (ids.length) {
      if (target !== null && tween) {
        const t = clamp((now - tween.t0) / (tween.dur * 1000), 0, 1);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(2 - 2 * t, 3) / 2;
        pos = lerp(tween.p0, tween.p1, e);
        lift = lerp(tween.l0, tween.l1, e);
        // Arrived: drop the whole turns slid through (invisibly), so the book is exactly in front.
        if (t === 1) { pos = target; lift = tween.l; target = null; tween = null; }
        dirty = true;
      } else if (!dragging && Math.abs(vel) > 0.02) {
        pos += vel * dt;
        vel *= Math.exp(-dt * 3.2);
        if (pos < 0 || pos > ids.length - 1) { pos = clamp(pos, 0, ids.length - 1); vel = 0; }
        dirty = true;
      } else if (!dragging && Math.abs(pos - Math.round(pos)) > 0.001) {
        vel = 0;
        pos += (Math.round(pos) - pos) * Math.min(1, dt * 8);   // settle on a book
        dirty = true;
      }
      if (liftTarget !== null) {
        const d = liftTarget - lift;
        if (Math.abs(d) < 0.001) { lift = liftTarget; liftTarget = null; } else { lift += d * Math.min(1, dt * 7); }
        dirty = true;
      } else if (!dragging && Math.abs(liftVel) > LIFT.settle) {
        const l = clampLift(lift + liftVel * dt);
        liftDir = Math.sign(liftVel);
        if (l !== lift + liftVel * dt) liftVel = 0;
        lift = l;
        liftVel *= Math.exp(-dt * LIFT.friction);
        dirty = true;
      } else if (!dragging && lift !== 0 && target === null) {
        liftVel = 0;
        // Settle on a whole turn, carrying on in the direction of travel past 15% of one,
        // or at either end of the shelf.
        let k = liftDir > 0 ? Math.ceil(lift - 0.15) : liftDir < 0 ? Math.floor(lift + 0.15) : Math.round(lift);
        // So are the top and bottom of the shelf, though they're usually not whole turns.
        if (!liftDir && Math.abs(lift - topLift()) < Math.abs(lift - k)) k = topLift();
        if (!liftDir && Math.abs(lift - bottomLift()) < Math.abs(lift - k)) k = bottomLift();
        k = clampLift(k);
        const kk = Math.abs(k - Math.round(k)) < 1e-9 || Math.abs(k - topLift()) < 1e-6 ||
          Math.abs(k - bottomLift()) < 1e-6 ? k : Math.round(lift);
        if (Math.abs(lift - kk) > 0.001) lift += (kk - lift) * Math.min(1, dt * 8);
        else foldLift();
        dirty = true;
      }
      const mt = mode === 'spines' ? 1 : 0;
      if (m !== mt) {
        m = reduceMotion ? mt : clamp(m + Math.sign(mt - m) * dt * 2.2, 0, 1);
        dirty = true;
      }
      if (prevT > 0) {
        prevT = reduceMotion ? 0 : Math.max(0, prevT - dt * 4);
        if (!prevT) prevSel = null;
        dirty = true;
      }
      const st = selected !== null ? 1 : 0;
      if (selT !== st) {
        selT = reduceMotion ? st : clamp(selT + Math.sign(st - selT) * dt * 4, 0, 1);
        dirty = true;
      }
    }
    if (pull > 0 && !dragging && !refreshing) {
      pull = pull < 1 ? 0 : pull * Math.exp(-dt * 12);
      showPull();
      dirty = true;
    }
    if (introT < 1) {
      introT = Math.min(1, introT + dt / 1.4);
      dirty = true;
      if (introT === 1) maybeWelcome();
    }
    if (born.size) dirty = true;
    if (dirty) {
      dirty = false;
      if (ids.length) { layout(); updateFacing(); }
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  }

  // Wheel: vertical scrolling slides the helix up and down, horizontal turns it.
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    target = null; liftTarget = null;
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
    pos = clamp(pos + dx * booksPerTurn() / 1400, 0, ids.length - 1);
    if (e.ctrlKey) {               // trackpad pinch arrives as ctrl+wheel
      setZoom(zoom * Math.exp(px * 0.01));
      return;
    }
    slide(lift + px / 500);
    vel = 0; liftVel = 0;
    dirty = true;
  }, { passive: false });

  // Drag: horizontal turns the helix along the shelf, vertical slides it up and down.
  let down = null, moved = 0, samples = [];
  const pointers = new Map();    // pointerId -> [x, y], for pinch
  let pinch = null;
  const spread = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {     // second finger: pinch to zoom instead of dragging
      pinch = { d: spread(), zoom };
      down = null; dragging = false; moved = Infinity;
      stage.classList.remove('dragging');
      return;
    }
    if (pointers.size > 2 || pinch) return;
    down = { x: e.clientX, y: e.clientY, pos, lift, liftVel };
    moved = 0; samples = [[performance.now(), pos, lift]];
    dragging = true; target = null; liftTarget = null; vel = 0; liftVel = 0;
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pointers.size === 2) { setZoom((pinch.zoom * pinch.d) / Math.max(1, spread())); return; }
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    moved = Math.max(moved, Math.hypot(dx, dy));
    const wpp = worldPerPixel();
    pos = clamp(down.pos - (dx * wpp) / slot(), 0, ids.length - 1);
    // Dragging down past the top of the shelf is pull-to-refresh.
    const wanted = down.lift - (dy * wpp) / PITCH;
    const top = topLift();
    pull = !refreshing && wanted < top ? ((top - wanted) * PITCH) / wpp : refreshing ? pull : 0;
    showPull();
    slide(wanted);
    samples.push([performance.now(), pos, lift]);
    if (samples.length > 6) samples.shift();
    dirty = true;
  });
  function endDrag(e) {
    pointers.delete(e.pointerId);
    if (pinch) { if (!pointers.size) pinch = null; return; }
    if (!down) return;
    dragging = false;
    stage.classList.remove('dragging');
    if (pull >= PULL_REFRESH && !refreshing) {
      down = null;
      refresh();
      return;
    }
    if (moved < 6) {
      pick(e);
    } else if (!reduceMotion && samples.length > 1) {
      const [t0, p0, l0] = samples[0], [t1, p1, l1] = samples[samples.length - 1];
      if (t1 - t0 > 0) {
        vel = clamp(((p1 - p0) / (t1 - t0)) * 1000, -booksPerTurn() * 3, booksPerTurn() * 3);
        let v = ((l1 - l0) / (t1 - t0)) * 1000 * LIFT.boost;
        // Flicking again in the same direction adds to the slide already under way.
        if (Math.abs(v) > 0.5 && Math.sign(v) === Math.sign(down.liftVel)) v += down.liftVel;
        liftVel = clamp(v, -LIFT.maxVel, LIFT.maxVel);
      }
    }
    down = null;
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    if (!pointers.size) pinch = null;
    down = null; dragging = false; stage.classList.remove('dragging');
  });

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pick(e) {
    const rect = stage.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([...active.values()], false)[0];
    if (hit) open(hit.object.userData.index);
    else if (selected !== null) close();
  }

  addEventListener('keydown', (e) => {
    if (e.target.matches && e.target.matches('input, select')) return;
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (step && selected !== null) { e.preventDefault(); stepSelection(step); return; }
    if (step) { e.preventDefault(); goTo(Math.round(target ?? pos) + step); return; }
    const turns = { ArrowDown: 1, ArrowUp: -1, PageDown: 3, PageUp: -3 }[e.key];
    if (turns) {
      e.preventDefault();
      liftTarget = clampLift(Math.round(liftTarget ?? lift) + turns);
      liftDir = Math.sign(turns);
      if (reduceMotion) { lift = liftTarget; liftTarget = null; }
      dirty = true;
      return;
    }
    if (e.key === '+' || e.key === '=') { setZoom(zoom / 1.15); return; }
    if (e.key === '-' || e.key === '_') { setZoom(zoom * 1.15); return; }
    if (e.key === 'Home') goTo(0);
    else if (e.key === 'End') goTo(ids.length - 1);
    else if (e.key === 'Enter' && document.activeElement === stage) open(Math.round(front()));
    else if (e.key === 'Escape') { if (selected !== null) close(); else if (hits) clearSearch(true); }
    else if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
  });

  // --- caption, details panel ---------------------------------------------------------
  let facingId = null;
  function updateFacing() {
    const i = Math.round(target ?? front());
    const id = ids[i];
    const mt = meta.get(id);
    const key = mt ? id : null;
    if (key === facingId) return;
    facingId = key;
    $('#facing .t').textContent = mt ? mt.title : '';
    $('#facing .a').textContent = mt ? authorsText(mt) : '';
    $('#facing .s').textContent = mt ? seriesText(mt) : '';
  }

  const detail = $('#detail');
  let detailToken = 0;
  async function open(i) {
    const id = ids[i];
    if (id === undefined) return;
    if (selected !== null && selected !== i) { prevSel = selected; prevT = selT; selT = 0; }
    // A book outside the highlighted matches ends that selection; its history entry
    // becomes the card's.
    if (hits && !hits.set.has(i)) {
      const wasHits = history.state && history.state.layer === 'hits';
      clearSearch(false);
      if (wasHits) replaceLayer('card');
    }
    if (selected === null) pushLayer('card');
    selected = i;
    goTo(i);
    setHash();
    const token = ++detailToken;
    fillDetail(id, details.get(id) || stub(id));
    updateCardNav();
    detail.classList.add('open');
    detail.setAttribute('aria-hidden', 'false');
    try {
      const b = await bookDetails(id);
      if (token === detailToken) fillDetail(id, b);
    } catch (e) { /* keep what we have */ }
  }
  // Full details of the last few books shown, so a card swiped in is already complete.
  const details = new Map();
  async function bookDetails(id) {
    const b = await source.book(id);
    details.delete(id);
    details.set(id, b);
    if (details.size > 8) details.delete(details.keys().next().value);
    return b;
  }
  function stub(id) {
    const mt = meta.get(id) || {};
    return { title: mt.title || '', authors: mt.authors || [], series: mt.series, series_index: mt.series_index };
  }
  // Back (Android's gesture, the browser button) closes the card, then clears the
  // highlighted matches, then leaves. Each is a history entry tagged with its layer.
  let skipPop = 0;
  function pushLayer(layer) {
    if (!history.state || history.state.layer !== layer) history.pushState({ layer }, '', location.href);
  }
  function replaceLayer(layer) { history.replaceState({ layer }, '', location.href); }
  function dropLayer(layer) {        // closed from the page: remove its history entry too
    if (history.state && history.state.layer === layer) { skipPop++; history.back(); }
  }
  addEventListener('popstate', () => {
    if (skipPop) { skipPop--; return; }
    if (selected !== null) close(false);
    else if (hits) clearSearch(false);
  });

  function close(fromPage = true) {
    if (selected === null) return;
    if (fromPage) dropLayer('card');
    selected = null;
    if (lift < topLift() && target === null) { liftTarget = topLift(); liftDir = 0; }   // back to the top
    detailToken++;
    detail.classList.remove('open');
    detail.setAttribute('aria-hidden', 'true');
    setHash();
    dirty = true;
    stage.focus({ preventScroll: true });
  }
  $('#close').addEventListener('click', () => close());

  // Step to the next or previous book without closing the card: through the current
  // matches (a series in reading order) when the open book is one of them, otherwise
  // along the shelf.
  function inList() { return hits && selected !== null && hits.set.has(selected); }
  // The book stepSelection(dir) would open, or null at the end of the list.
  function stepTo(dir) {
    if (selected === null) return null;
    if (inList()) {
      const next = hits.list.indexOf(selected) + dir;
      return next >= 0 && next < hits.list.length ? hits.list[next] : null;
    }
    const next = selected + dir;
    return next >= 0 && next < ids.length ? next : null;
  }
  function stepSelection(dir) {
    if (selected === null) return;
    if (inList()) {
      const k = hits.list.indexOf(selected);
      const next = k + dir;
      if (next < 0 || next >= hits.list.length) return;
      hitAt = next;
      showHits(`${hitAt + 1} of ${hits.list.length}`);
      open(hits.list[next]);
    } else {
      const next = selected + dir;
      if (next >= 0 && next < ids.length) open(next);
    }
  }
  const cardNav = $('#cardnav');
  function updateCardNav(nav = cardNav, at = selected) {
    const list = inList();
    nav.hidden = !list;
    if (!list) return;
    const k = hits.list.indexOf(at);
    nav.querySelector('.where').textContent = `${k + 1} of ${hits.list.length}`;
    nav.querySelector('.prev').disabled = k <= 0;
    nav.querySelector('.next').disabled = k >= hits.list.length - 1;
  }
  cardNav.querySelector('.prev').addEventListener('click', () => stepSelection(-1));
  cardNav.querySelector('.next').addEventListener('click', () => stepSelection(1));

  // Touching the card: swipe sideways for the next or previous book; on phones (where
  // it's a bottom sheet) pull it down from the top of its content to close it.
  const sheetLayout = matchMedia('(max-width: 640px)');
  let sheet = null;
  detail.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { sheet = null; return; }
    const t = e.touches[0];
    sheet = { x: t.clientX, y: t.clientY, dx: 0, dy: 0, mode: null, samples: [[performance.now(), 0, 0]] };
  }, { passive: true });
  detail.addEventListener('touchmove', (e) => {
    if (!sheet) return;
    const t = e.touches[0];
    let dx = t.clientX - sheet.x, dy = t.clientY - sheet.y;
    if (!sheet.mode) {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) sheet.mode = 'swipe';
      else if (sheetLayout.matches && dy > 8 && detail.scrollTop <= 0) { sheet.mode = 'pull'; sheet.y += dy; dy = 0; }
      else { if (Math.abs(dy) > 8) sheet = null; return; }   // scrolling the description instead
      detail.classList.add('dragging');
    }
    e.preventDefault();
    if (sheet.mode === 'pull') {
      sheet.dy = Math.max(0, t.clientY - sheet.y);
      detail.style.transform = `translateY(${sheet.dy}px)`;
    } else {
      sheet.dx = dx;
      // The card follows the finger with the next book's card alongside; at the end of
      // the list it only gives a little.
      const dir = dx < 0 ? 1 : -1, next = stepTo(dir);
      if (next !== null) {
        showPeek(next, dir);
        placeCards(dx, dir);
      } else {
        hidePeek();
        detail.style.transform = `translateX(${dx * 0.35}px)`;
      }
    }
    sheet.samples.push([performance.now(), sheet.dx, sheet.dy]);
    if (sheet.samples.length > 5) sheet.samples.shift();
  }, { passive: false });
  function endSheet() {
    if (!sheet || !sheet.mode) { sheet = null; return; }
    const [t0, x0, y0] = sheet.samples[0], [t1, x1, y1] = sheet.samples[sheet.samples.length - 1];
    const vx = t1 > t0 ? (x1 - x0) / (t1 - t0) : 0, vy = t1 > t0 ? (y1 - y0) / (t1 - t0) : 0;   // px/ms
    const { mode, dx, dy } = sheet;
    sheet = null;
    const dir = dx < 0 ? 1 : -1;
    if (mode === 'swipe' && peekDir === dir) {
      slideCards(dir, Math.abs(dx) > 60 || Math.abs(vx) > 0.5);
      return;
    }
    hidePeek();
    detail.classList.remove('dragging');
    detail.style.transform = '';   // the CSS transition carries it home, or off screen
    if (mode === 'pull' && (dy > detail.offsetHeight * 0.25 || vy > 0.6)) close();
  }
  // The neighbouring book's card, side by side with the open one while it's swiped.
  const peek = detail.cloneNode(true);
  peek.removeAttribute('id');
  peek.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
  peek.classList.add('peek', 'open');
  peek.setAttribute('aria-hidden', 'true');
  peek.inert = true;
  peek.hidden = true;
  detail.after(peek);
  let peekIndex = null, peekDir = 0, peekToken = 0;
  function showPeek(i, dir) {
    peekDir = dir;
    if (peekIndex === i && !peek.hidden) return;
    peekIndex = i;
    const id = ids[i], token = ++peekToken;
    fillDetail(id, details.get(id) || stub(id), peek);
    updateCardNav(peek.querySelector('.cardnav'), i);
    peek.scrollTop = 0;
    peek.hidden = false;
    bookDetails(id).then((b) => { if (token === peekToken) fillDetail(id, b, peek); }).catch(() => {});
  }
  function hidePeek() {
    peek.hidden = true;
    peek.style.transition = peek.style.transform = '';
    peekIndex = null; peekDir = 0; peekToken++;
  }
  function placeCards(dx, dir) {
    detail.style.transform = `translateX(${dx}px)`;
    peek.style.transform = `translateX(${dx + dir * detail.offsetWidth}px)`;
  }
  // Let go: both cards carry on together, the new one into place (or both back).
  let swapTimer = null;
  function slideCards(dir, commit) {
    clearTimeout(swapTimer);
    const w = detail.offsetWidth;
    const done = () => {
      if (commit) {
        // The open card becomes the one just swiped in, put in its place without moving.
        detail.style.transition = 'none';
        stepSelection(dir);
        detail.scrollTop = 0;
        detail.style.transform = '';
        void detail.offsetWidth;
      }
      detail.classList.remove('dragging');
      detail.style.transition = '';
      hidePeek();
    };
    if (reduceMotion) { done(); return; }
    const ease = 'transform 0.22s ease-out';
    detail.classList.remove('dragging');
    detail.style.transition = ease;
    peek.style.transition = ease;
    detail.style.transform = commit ? `translateX(${-dir * w}px)` : '';
    peek.style.transform = `translateX(${commit ? 0 : dir * w}px)`;
    swapTimer = setTimeout(done, 230);
  }
  detail.addEventListener('touchend', endSheet);
  detail.addEventListener('touchcancel', endSheet);

  function fillDetail(id, b, card = detail) {
    const img = card.querySelector('.cover');
    const src = source.cover(id);
    if (img.getAttribute('src') !== src) img.src = src;
    img.alt = b.title ? `Cover of ${b.title}` : '';
    card.querySelector('h2').textContent = b.title || '';
    const sub = (b.user_metadata && b.user_metadata['#subtitle'] && b.user_metadata['#subtitle']['#value#']) || '';
    card.querySelector('.sub').textContent = sub;
    // Authors and series link to the rest of their books on the shelf.
    const authors = b.authors || [];
    const by = card.querySelector('.by');
    by.replaceChildren();
    if (authors.length) {
      by.append('by ');
      authors.forEach((a, k) => {
        if (k) by.append(k === authors.length - 1 ? ' and ' : ', ');
        by.append(shelfLink(a, `Show every book by ${a}`, `authors:"=${quoteQuery(a)}"`, id, false));
      });
    }
    const year = b.pubdate && !String(b.pubdate).startsWith('0101') ? String(b.pubdate).slice(0, 4) : '';
    const series = card.querySelector('.series');
    series.replaceChildren();
    if (b.series) {
      const text = seriesText(b);
      series.append(text.slice(0, text.length - b.series.length),
                    shelfLink(b.series, `Show the whole ${b.series} series`, `series:"=${quoteQuery(b.series)}"`, id, true));
    }
    card.querySelector('.pub').textContent =
      b.publisher ? `Published by ${b.publisher}${year ? ', ' + year : ''}` : (year ? `Published ${year}` : '');
    const links = card.querySelector('.links');
    links.replaceChildren();
    const add = (text, href, download) => {
      const a = document.createElement('a');
      a.textContent = text; a.href = href;
      if (download) a.setAttribute('download', '');
      links.append(a);
    };
    const main = b.main_format || (meta.get(id) || {}).main || {};
    for (const link of source.links(id, Object.assign({}, b, { main_format: main }))) add(link.text, link.href, link.download);
    links.append(shareButton(id, b));
    card.querySelector('.desc').replaceChildren(...sanitize(b.comments || ''));
    // Where the cover image came from, when the source says (the demo's scans).
    const credit = card.querySelector('.credit');
    const c = source.credit(id);
    credit.replaceChildren();
    if (c) {
      const a = document.createElement('a');
      a.href = c.href; a.textContent = c.text; a.rel = 'noopener';
      credit.append(a);
    }
  }

  function quoteQuery(s) { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
  function shelfLink(text, title, query, fromId, seriesOrder) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shelflink';
    btn.textContent = text;
    btn.title = title;
    btn.addEventListener('click', () => {
      q.value = query;
      // The card's history entry becomes the selection's.
      close(false);
      replaceLayer('hits');
      search(query, { fromId, seriesOrder });
    });
    return btn;
  }

  // Share a direct link to the book: the system share sheet on phones, the
  // clipboard elsewhere (desktop share dialogs are less useful than a copied link).
  function bookLink(id) { return `${location.origin}${location.pathname}#book=${id}`; }
  function shareButton(id, b) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sharebtn';
    btn.textContent = 'Share';
    btn.addEventListener('click', async () => {
      const url = bookLink(id);
      const phone = (navigator.userAgentData && navigator.userAgentData.mobile) || matchMedia('(pointer: coarse)').matches;
      if (phone && navigator.share) {
        try {
          await navigator.share({ title: b.title, text: [b.title, authorsText(b)].filter(Boolean).join(' '), url });
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;      // closed the share sheet
        }
      }
      let copied = false;
      try { await navigator.clipboard.writeText(url); copied = true; } catch (e) {
        const t = document.createElement('textarea');    // older or non-secure contexts
        t.value = url; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
        document.body.append(t); t.select();
        try { copied = document.execCommand('copy'); } catch (e2) { /* nothing else to try */ }
        t.remove();
      }
      btn.textContent = copied ? 'Link copied' : 'Couldn’t copy the link';
      setTimeout(() => { btn.textContent = 'Share'; }, 2000);
    });
    return btn;
  }

  // calibre descriptions are HTML from many stores: keep only simple text formatting.
  const KEEP = new Set(['P', 'BR', 'I', 'EM', 'B', 'STRONG', 'UL', 'OL', 'LI', 'BLOCKQUOTE']);
  function sanitize(html) {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const clean = (node) => {
      const out = [];
      for (const ch of node.childNodes) {
        if (ch.nodeType === Node.TEXT_NODE) out.push(document.createTextNode(ch.textContent));
        else if (ch.nodeType === Node.ELEMENT_NODE) {
          if (ch.tagName === 'SCRIPT' || ch.tagName === 'STYLE') continue;
          if (KEEP.has(ch.tagName)) {
            const el = document.createElement(ch.tagName.toLowerCase());
            el.append(...clean(ch));
            out.push(el);
          } else out.push(...clean(ch));
        }
      }
      return out;
    };
    return clean(doc.body.firstChild);
  }

  // --- search, mode, sort -------------------------------------------------------------
  const q = $('#q');
  // Matches are stepped through in shelf order, or for a series in reading order.
  // fromId starts the walk at that book (the one whose card was open).
  async function search(text, { fromId = null, seriesOrder = false } = {}) {
    text = text.trim();
    if (!text) { clearSearch(true); return; }
    let found;
    try {
      found = await source.search(text, sortKey, seriesOrder);
    } catch (e) { showHits('Search didn’t answer; try again'); return; }
    const list = found.map((id) => indexOf.get(id)).filter((i) => i !== undefined);
    if (!seriesOrder) list.sort((a, b) => a - b);
    hits = { list, set: new Set(list), ids: list.map((i) => ids[i]), seriesOrder };
    pushLayer('hits');
    if (!list.length) { showHits('Nothing found'); dirty = true; return; }
    const from = fromId !== null && indexOf.has(fromId) ? list.indexOf(indexOf.get(fromId)) : -1;
    // Otherwise start at the first match at or after where we are.
    hitAt = from >= 0 ? from : Math.max(0, list.findIndex((i) => i >= (atTop() ? 0 : Math.round(front()))));
    jumpHit(0);
  }
  function jumpHit(step) {
    if (!hits || !hits.list.length) return;
    hitAt = (hitAt + step + hits.list.length) % hits.list.length;
    goTo(hits.list[hitAt]);
    showHits(`${hitAt + 1} of ${hits.list.length}`);
  }
  function showHits(text) {
    const el = $('#hits');
    el.textContent = text; el.hidden = false;
    const many = hits && hits.list.length > 1;
    $('#prev').hidden = !many; $('#next').hidden = !many;
    $('#clear').hidden = false;
  }
  // Back to the whole shelf: no highlights, empty search box.
  function clearSearch(fromPage = false) {
    if (fromPage && hits) dropLayer('hits');
    hits = null;
    q.value = '';
    $('#hits').hidden = $('#prev').hidden = $('#next').hidden = $('#clear').hidden = true;
    updateCardNav();
    dirty = true;
  }
  $('#clear').addEventListener('click', () => { clearSearch(true); stage.focus({ preventScroll: true }); });
  $('#search').addEventListener('submit', (e) => { e.preventDefault(); search(q.value); q.blur(); });
  q.addEventListener('input', () => { if (!q.value) clearSearch(true); });
  $('#prev').addEventListener('click', () => jumpHit(-1));
  $('#next').addEventListener('click', () => jumpHit(1));

  function setMode(next) {
    mode = next;
    prefetchQueue = null;          // which books are round the back depends on the layout
    store.set('bookcase.mode', mode);
    $('#mode-covers').setAttribute('aria-pressed', String(mode === 'covers'));
    $('#mode-spines').setAttribute('aria-pressed', String(mode === 'spines'));
    setHash();
    dirty = true;
  }
  $('#mode-covers').addEventListener('click', () => setMode('covers'));
  $('#mode-spines').addEventListener('click', () => setMode('spines'));

  const sortSel = $('#sort');
  sortSel.value = sortKey;
  sortSel.addEventListener('change', () => {
    sortKey = sortSel.value;
    store.set('bookcase.sort', sortKey);
    const keep = ids[Math.round(front())];
    load(keep);
  });

  function setHash() {
    const p = new URLSearchParams();
    if (selected !== null) p.set('book', ids[selected]);
    if (mode !== 'covers') p.set('mode', mode);
    if (sortKey !== defaultSort()) p.set('sort', sortKey);
    const h = p.toString();
    history.replaceState(history.state, '', h ? '#' + h : location.pathname);
  }

  // --- start ---------------------------------------------------------------------------
  // The demo's first visit: what this is and how to get around. Shown once.
  const welcome = $('#welcome');
  function maybeWelcome() {
    if (!source || !source.demo || store.get('bookcase.welcomed') || selected !== null) return;
    $('#welcome-count').textContent = ids.length.toLocaleString();
    welcome.hidden = false;
    $('#welcome-go').focus({ preventScroll: true });
  }
  function dismissWelcome() {
    if (welcome.hidden) return;
    welcome.hidden = true;
    store.set('bookcase.welcomed', '1');
    stage.focus({ preventScroll: true });
  }
  $('#welcome-go').addEventListener('click', dismissWelcome);
  stage.addEventListener('pointerdown', dismissWelcome);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') dismissWelcome(); });

  function countText() {
    const n = `${ids.length.toLocaleString()} ${source && source.demo ? 'public-domain ' : ''}${ids.length === 1 ? 'book' : 'books'}`;
    return n;
  }

  async function load(focusId) {
    try {
      if (!source) {
        source = await chooseSource();
        if (source.demo) useWebFont();
        $('.mark a').href = source.home;
        if (source.demo) $('.mark a').title = 'About this demo';
        loadMeta();
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
        if (!sortChosen || !SORTS[sortChosen]) { sortKey = defaultSort(); sortSel.value = sortKey; }
      }
      ids = await source.order(sortKey);
    } catch (e) {
      fail('The library isn’t answering right now. <a href="/">Open the regular library view</a> or reload in a minute.');
      return;
    }
    indexOf = new Map(ids.map((id, i) => [id, i]));
    chunkState.clear();
    prefetchQueue = null;
    clearSearch(true);
    $('#count').textContent = countText();
    if (!statusEl.hidden) {        // first load: play the opening
      statusEl.hidden = true;
      if (reduceMotion) maybeWelcome(); else introT = 0;
    }
    const i = indexOf.has(focusId) ? indexOf.get(focusId) : 0;
    goTo(i, true);
    if (selected !== null) selected = indexOf.has(focusId) ? i : null;
    setHash();
  }

  function worldPerPixel() {     // world units per screen pixel at the helix face
    return (2 * Math.tan((camera.fov * Math.PI) / 360) * (camera.position.z - R)) / Math.max(1, stage.clientHeight);
  }

  const pullEl = $('#pull');
  const pullArc = pullEl.querySelector('circle');
  const pullSvg = pullEl.querySelector('svg');
  const pullLabel = pullEl.querySelector('.sr-only');
  const ARC = 2 * Math.PI * 9;
  function showPull() {
    const shown = pull > 4 || refreshing;
    pullEl.hidden = !shown;
    if (!shown) return;
    const p = refreshing ? 1 : Math.min(1, pull / PULL_REFRESH);
    // Drops in from under the header as you pull; the arc fills and turns with it.
    pullEl.style.transform = `translateY(${(Math.min(pull, PULL_REFRESH * 1.4) - PULL_REFRESH) * 0.45}px)`;
    pullEl.style.opacity = Math.min(1, p * 1.6);
    pullEl.classList.toggle('spinning', refreshing);
    if (!refreshing) {
      pullArc.style.strokeDasharray = `${(0.08 + 0.72 * p) * ARC} ${ARC}`;
      pullSvg.style.transform = `rotate(${-90 + p * 270}deg)`;
      pullArc.style.opacity = p >= 1 ? 1 : 0.65;
    } else {
      pullArc.style.strokeDasharray = '';
      pullSvg.style.transform = '';
      pullArc.style.opacity = 1;
    }
    const label = refreshing ? 'Refreshing' : p >= 1 ? 'Release to refresh' : 'Pull to refresh';
    if (pullLabel.textContent !== label) pullLabel.textContent = label;
  }


  // A full refresh: newest copy of the app itself, fresh titles and details (covers
  // stay cached), then reload.
  async function refresh() {
    refreshing = true;
    clearTimeout(saveTimer);
    try { localStorage.removeItem(metaKey()); } catch (e) { /* nothing saved */ }
    pull = PULL_REFRESH;
    showPull();
    try {
      const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
      if (reg) {
        await Promise.race([reg.update().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
        const worker = reg.active;
        if (worker) {
          await new Promise((resolve) => {
            const ch = new MessageChannel();
            ch.port1.onmessage = resolve;
            worker.postMessage({ type: 'refresh' }, [ch.port2]);
            setTimeout(resolve, 5000);   // an older worker never answers
          });
        }
      }
    } catch (e) { /* reload anyway */ }
    location.reload();
  }

  // --- keeping up with the library ------------------------------------------------------
  // New imports appear while the bookcase is open. Every book keeps its place on
  // screen; new ones grow onto the shelf, and when you're at the top of the shelf
  // the helix glides over to the newest.
  let checking = false;
  async function checkForChanges() {
    if (checking || !ids.length || document.hidden || !source.live) return;
    if (dragging || pinch || target !== null || liftTarget !== null) { setTimeout(checkForChanges, 2000); return; }
    checking = true;
    try {
      merge(await source.order(sortKey));
      await refreshRecentCovers();
    } catch (e) { /* calibre restarts briefly during imports; try again next time */ }
    checking = false;
  }

  // Titles and last-modified times are saved on the device and served from the
  // worker's cache first, so an edit made in calibre after import (a fixed cover,
  // a corrected title) can go unnoticed. Once a day, ask calibre itself about the
  // last month's additions; storeBooks refetches the covers of any that changed.
  async function refreshRecentCovers() {
    if (!source.recent || !navigator.onLine) return;
    const key = `bookcase.recentCheck.${source.name}`;
    let last = 0;
    try { last = +localStorage.getItem(key) || 0; } catch (e) { /* no storage: check every launch */ }
    if (Date.now() - last < RECENT_EVERY) return;
    const recent = await source.recent(RECENT_DAYS);
    for (let k = 0; k < recent.length; k += CHUNK) storeBooks(await source.books(recent.slice(k, k + CHUNK), true));
    try { localStorage.setItem(key, String(Date.now())); } catch (e) { /* as above */ }
  }

  function merge(next) {
    const old = ids;
    if (next.length === old.length && next.every((id, k) => id === old[k])) return;
    const frontIndex = clamp(Math.round(front()), 0, old.length - 1);
    const frontId = old[frontIndex];
    const wasTop = atTop() && Math.round(pos) === 0 && !hits;
    target = null; tween = null;   // a glide in progress was aimed at the old order
    const selId = selected !== null ? old[selected] : null;
    const added = next.filter((id) => !indexOf.has(id));

    ids = next;
    indexOf = new Map(ids.map((id, i) => [id, i]));
    // Shift the position by however far the front book moved, so nothing on screen jumps.
    if (indexOf.has(frontId)) pos += indexOf.get(frontId) - frontIndex;
    pos = clamp(pos, 0, Math.max(0, ids.length - 1));
    vel = 0;
    // Meshes follow their books to the new indices.
    const moved = new Map();
    for (const [i, mesh] of active) {
      const ni = indexOf.get(old[i]);
      if (ni === undefined || moved.has(ni)) { mesh.visible = false; pool.push(mesh); }
      else { mesh.userData.index = ni; moved.set(ni, mesh); }
    }
    active.clear();
    for (const [i, mesh] of moved) active.set(i, mesh);
    if (selId !== null) { if (indexOf.has(selId)) selected = indexOf.get(selId); else close(); }
    if (hits) {
      hits.list = hits.ids.filter((id) => indexOf.has(id)).map((id) => indexOf.get(id));
      if (!hits.seriesOrder) hits.list.sort((a, b) => a - b);
      hits.set = new Set(hits.list);
      hitAt = Math.min(hitAt, Math.max(0, hits.list.length - 1));
    }
    chunkState.clear();
    prefetchQueue = null;
    const now = performance.now();
    for (const id of added) born.set(id, now);
    $('#count').textContent = countText();
    if (wasTop && added.length && indexOf.get(added[0]) === 0) goTo(0);
    dirty = true;
  }

  setInterval(checkForChanges, CHECK_EVERY);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForChanges(); });
  addEventListener('online', checkForChanges);

  // Spines are drawn on canvases; redraw them once the book face has loaded.
  function redrawSpinesWhenFontLoads() {
    if (!document.fonts) return;
    document.fonts.load(`italic 28px ${SERIF}`).then(() => {
      for (const k of [...textures.keys()]) if (k[0] === 's') { textures.get(k).tex.dispose(); textures.delete(k); }
      dirty = true;
    }).catch(() => {});
  }
  redrawSpinesWhenFontLoads();
  // The demo has no font files of its own; it borrows EB Garamond from Google Fonts.
  function useWebFont() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=EB+Garamond:ital@0;1&display=swap';
    link.onload = redrawSpinesWhenFontLoads;
    document.head.append(link);
  }

  // Installable, quick to reopen, and browsable offline (see sw.js).
  if ('serviceWorker' in navigator) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  setMode(mode);
  resize();
  requestAnimationFrame(frame);
  const startId = Number(params.get('book'));
  load(startId).then(() => { if (startId && indexOf.has(startId)) open(indexOf.get(startId)); });
  stage.focus({ preventScroll: true });
})();
