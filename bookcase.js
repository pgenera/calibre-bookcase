/* An endless helical bookcase for the calibre library on this host.

   Everything comes from calibre-server's read-only JSON API on the same origin:
     /ajax/search   ordered book ids (and search hits)
     /ajax/books    title/author/series for a chunk of ids
     /ajax/book     one book's full details (description) when it is opened
     /get/thumb     cover thumbnails, always at one size so calibre caches one copy
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
  const ZOOM = { min: 0.45, max: 1.9 };
  const VISIBLE_ARC = 1.75;      // radians either side of the front that get meshes
  const TURNS_VISIBLE = { covers: 3, spines: 2 };
  const THUMB = '150x225';
  const CHUNK = 100;             // ids per /ajax/books request
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
  async function getJSON(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
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

  // --- state ---------------------------------------------------------------------
  let library = 'books';         // calibre library id, from /ajax/library-info
  let ids = [];                  // book ids in display order
  let indexOf = new Map();       // id -> position
  const meta = new Map();        // id -> {title, authors, series, series_index, formats}
  const chunkState = new Map();  // chunk number -> 'loading' | 'done'
  let metaInFlight = 0;

  const params = new URLSearchParams(location.hash.slice(1));
  let mode = params.get('mode') || store.get('bookcase.mode') || 'covers';
  if (mode !== 'covers' && mode !== 'spines') mode = 'covers';
  let sortKey = params.get('sort') || store.get('bookcase.sort') || 'author';
  if (!SORTS[sortKey]) sortKey = 'author';
  let m = mode === 'spines' ? 1 : 0;   // animated 0 (covers) .. 1 (spines)

  let pos = 0;                   // continuous position along the helix, in books
  let vel = 0;                   // books per second
  let target = null;             // animate pos toward this, when set
  // Vertical movement slides the helix without turning it: `lift` is an offset in
  // turns, and it only settles on whole turns, which look exactly like no offset.
  let lift = 0, liftVel = 0, liftTarget = null;
  let liftDir = 0;               // direction of the last slide, so small nudges carry on to the next turn
  let zoom = 1;
  let selected = null;           // index of the opened book
  let selT = 0;                  // pull-out animation 0..1
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
  const MAX_BOOKS = 900;
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

  function wantThumb(id) {
    const key = 't' + id;
    if (textures.has(key)) return touch(key).tex;
    if (!thumbPending.has(id)) { thumbPending.add(id); thumbQueue.push(id); }
    return null;
  }
  function pumpThumbs() {
    // Nearest to the front first.
    const dist = (id) => (indexOf.has(id) ? Math.abs(indexOf.get(id) - front()) : Infinity);
    thumbQueue.sort((a, b) => dist(b) - dist(a));
    while (thumbLoads < MAX_THUMB_LOADS && thumbQueue.length) {
      const id = thumbQueue.pop();
      const i = indexOf.get(id);
      if (i === undefined || Math.abs(i - front()) > booksPerTurn() * (TURNS_VISIBLE[mode] + 1)) {
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
        textures.delete('s' + id);    // redraw the spine in the cover's colour
        dirty = true; pumpThumbs();
      };
      img.onerror = () => { thumbLoads--; thumbPending.delete(id); pumpThumbs(); };
      img.src = `/get/thumb/${id}/${library}?sz=${THUMB}`;
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
    if (!mt) return null;
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
    const slice = order.slice(c * CHUNK, (c + 1) * CHUNK);
    try {
      const data = await getJSON(`/ajax/books/${library}?ids=${slice.join(',')}&category_urls=false`);
      for (const [id, b] of Object.entries(data)) {
        if (!b) continue;
        meta.set(+id, { title: b.title, authors: b.authors, series: b.series, series_index: b.series_index,
                        formats: b.formats || [], main: b.main_format || {} });
      }
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

  // --- layout -----------------------------------------------------------------------
  const slot = () => lerp(COVER.slot, SPINE.slot, m);
  const booksPerTurn = () => (2 * Math.PI * R) / slot();
  const front = () => pos + lift * booksPerTurn();       // the book level with the camera
  function clampLift(l) {
    const n = booksPerTurn();
    return clamp(l, -pos / n, (Math.max(0, ids.length - 1) - pos) / n);
  }
  function foldLift() {           // turn a whole-turn lift into a position, invisibly
    pos = clamp(pos + Math.round(lift) * booksPerTurn(), 0, Math.max(0, ids.length - 1));
    lift = 0; liftVel = 0; liftTarget = null; liftDir = 0;
  }
  function slide(newLift) {
    newLift = clampLift(newLift);
    if (newLift !== lift) liftDir = Math.sign(newLift - lift);
    lift = newLift;
  }

  function bookDims(id) {
    const h = hash(id);
    return {
      w: lerp(COVER.w, 0.18 + 0.1 * h, m),
      h: lerp(COVER.h, 1.32 + 0.22 * hash(id + 7), m),
      d: lerp(COVER.depth, SPINE.depth, m),
    };
  }

  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();
  const tmpP = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);

  function layout() {
    const s = slot();
    const perTurn = booksPerTurn();
    const theta = (i) => (i * s) / R;
    const shelfY = (i) => -(theta(i) / (2 * Math.PI)) * PITCH;
    // Rotate and lift the helix so book `pos` is front and centre.
    helix.rotation.y = -theta(pos);
    helix.position.y = -shelfY(pos) + lift * PITCH - 0.75;

    const span = Math.ceil(perTurn * TURNS_VISIBLE[mode] * Math.max(1, zoom));
    const mid = Math.round(front());
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
      const r = R - dim.d / 2 + out;
      mesh.position.set(Math.sin(th) * r, shelfY(i) + dim.h / 2 + selT * 0.15 * (i === selected), Math.cos(th) * r);
      mesh.rotation.set(0, th, 0);
      mesh.scale.set(dim.w, dim.h, dim.d);

      // Face texture: the cover, or the spine drawn in the cover's colour.
      const face = mesh.userData.face;
      const cover = wantThumb(id);
      const tex = m < 0.5 ? (cover || blank) : (spineTexture(id) || blank);
      if (face.map !== tex) face.map = tex;
      face.color.setScalar(hits && !hits.set.has(i) ? 0.28 : 1);   // dim non-matches

      // Shelf plank under the book.
      tmpP.set(Math.sin(th) * (R - 0.55), shelfY(i) - 0.03, Math.cos(th) * (R - 0.55));
      tmpQ.setFromAxisAngle(yAxis, th);
      tmpS.set(s * 1.02, 0.06, 1.12);
      tmpM.compose(tmpP, tmpQ, tmpS);
      shelves.setMatrixAt(n++, tmpM);
    }
    shelves.count = n;
    shelves.instanceMatrix.needsUpdate = true;
    core.position.y = 0;
    pumpMeta();
    pumpThumbs();
  }

  function placeCamera() {
    // On narrow screens back off a little so a few covers fit across.
    const dist = CAM_DIST * zoom + (camera.aspect < 0.8 ? 3 : 0);
    camera.position.z = R + dist;
    scene.fog.near = dist + 2;
    scene.fog.far = dist + R * 1.6;
    dirty = true;
  }
  function setZoom(z) {
    zoom = clamp(z, ZOOM.min, ZOOM.max);
    placeCamera();
  }
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    placeCamera();
  }
  addEventListener('resize', resize);

  // --- motion ---------------------------------------------------------------------
  function goTo(i, instant) {
    i = clamp(i, 0, Math.max(0, ids.length - 1));
    foldLift();
    vel = 0;
    if (instant || reduceMotion) { pos = i; target = null; } else { target = i; }
    dirty = true;
  }

  let last = performance.now();
  let dragging = false;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (ids.length) {
      if (target !== null) {
        const d = target - pos;
        if (Math.abs(d) < 0.002) { pos = target; target = null; } else { pos += d * Math.min(1, dt * 7); }
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
      } else if (!dragging && Math.abs(liftVel) > 0.01) {
        const l = clampLift(lift + liftVel * dt);
        if (l !== lift + liftVel * dt) liftVel = 0;
        lift = l;
        liftVel *= Math.exp(-dt * 3.2);
        dirty = true;
      } else if (!dragging && lift !== 0) {
        liftVel = 0;
        // Settle on a whole turn, carrying on in the direction of travel past 15% of one.
        const k = clampLift(liftDir > 0 ? Math.ceil(lift - 0.15) : liftDir < 0 ? Math.floor(lift + 0.15) : Math.round(lift));
        const kk = Math.abs(k - Math.round(k)) < 1e-9 ? k : Math.round(lift);
        if (Math.abs(lift - kk) > 0.001) lift += (kk - lift) * Math.min(1, dt * 8);
        else foldLift();
        dirty = true;
      }
      const mt = mode === 'spines' ? 1 : 0;
      if (m !== mt) {
        m = reduceMotion ? mt : clamp(m + Math.sign(mt - m) * dt * 2.2, 0, 1);
        dirty = true;
      }
      const st = selected !== null ? 1 : 0;
      if (selT !== st) {
        selT = reduceMotion ? st : clamp(selT + Math.sign(st - selT) * dt * 4, 0, 1);
        dirty = true;
      }
    }
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
    down = { x: e.clientX, y: e.clientY, pos, lift };
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
    // World units per pixel at the helix face.
    const wpp = (2 * Math.tan((camera.fov * Math.PI) / 360) * (camera.position.z - R)) / stage.clientHeight;
    pos = clamp(down.pos - (dx * wpp) / slot(), 0, ids.length - 1);
    slide(down.lift - (dy * wpp) / PITCH);
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
    if (moved < 6) {
      pick(e);
    } else if (!reduceMotion && samples.length > 1) {
      const [t0, p0, l0] = samples[0], [t1, p1, l1] = samples[samples.length - 1];
      if (t1 - t0 > 0) {
        vel = clamp(((p1 - p0) / (t1 - t0)) * 1000, -booksPerTurn() * 3, booksPerTurn() * 3);
        liftVel = clamp(((l1 - l0) / (t1 - t0)) * 1000, -6, 6);
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
    else if (e.key === 'Escape') close();
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
    selected = i;
    goTo(i);
    setHash();
    const token = ++detailToken;
    const mt = meta.get(id) || {};
    fillDetail(id, { title: mt.title || '', authors: mt.authors || [], series: mt.series, series_index: mt.series_index });
    detail.classList.add('open');
    detail.setAttribute('aria-hidden', 'false');
    try {
      const b = await getJSON(`/ajax/book/${id}/${library}?category_urls=false`);
      if (token === detailToken) fillDetail(id, b);
    } catch (e) { /* keep what we have */ }
  }
  function close() {
    if (selected === null) return;
    selected = null;
    detailToken++;
    detail.classList.remove('open');
    detail.setAttribute('aria-hidden', 'true');
    setHash();
    dirty = true;
    stage.focus({ preventScroll: true });
  }
  $('#close').addEventListener('click', close);

  function fillDetail(id, b) {
    const img = detail.querySelector('.cover');
    const src = `/get/cover/${id}/${library}`;
    if (img.getAttribute('src') !== src) img.src = src;
    img.alt = b.title ? `Cover of ${b.title}` : '';
    detail.querySelector('h2').textContent = b.title || '';
    const sub = (b.user_metadata && b.user_metadata['#subtitle'] && b.user_metadata['#subtitle']['#value#']) || '';
    detail.querySelector('.sub').textContent = sub;
    detail.querySelector('.by').textContent = authorsText(b);
    const year = b.pubdate && !String(b.pubdate).startsWith('0101') ? String(b.pubdate).slice(0, 4) : '';
    detail.querySelector('.series').textContent = seriesText(b);
    detail.querySelector('.pub').textContent =
      b.publisher ? `Published by ${b.publisher}${year ? ', ' + year : ''}` : (year ? `Published ${year}` : '');
    const links = detail.querySelector('.links');
    links.replaceChildren();
    const add = (text, href, download) => {
      const a = document.createElement('a');
      a.textContent = text; a.href = href;
      if (download) a.setAttribute('download', '');
      links.append(a);
    };
    add('Open in the library', `/#book_id=${id}&library_id=${encodeURIComponent(library)}&panel=book_details`);
    const main = b.main_format || (meta.get(id) || {}).main || {};
    for (const [fmt, href] of Object.entries(main)) add(`Download ${fmt.toUpperCase()}`, href, true);
    detail.querySelector('.desc').replaceChildren(...sanitize(b.comments || ''));
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
  async function search(text) {
    text = text.trim();
    if (!text) { clearSearch(); return; }
    let res;
    try {
      res = await getJSON(`/ajax/search/${library}?num=100000&${SORTS[sortKey]}&query=${encodeURIComponent(text)}`);
    } catch (e) { showHits('Search didn’t answer; try again'); return; }
    const list = res.book_ids.map((id) => indexOf.get(id)).filter((i) => i !== undefined).sort((a, b) => a - b);
    hits = { list, set: new Set(list) };
    if (!list.length) { showHits('Nothing found'); dirty = true; return; }
    // Start at the first match at or after where we are.
    hitAt = Math.max(0, list.findIndex((i) => i >= Math.round(front())));
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
  }
  function clearSearch() {
    hits = null;
    $('#hits').hidden = $('#prev').hidden = $('#next').hidden = true;
    dirty = true;
  }
  $('#search').addEventListener('submit', (e) => { e.preventDefault(); search(q.value); q.blur(); });
  q.addEventListener('input', () => { if (!q.value) clearSearch(); });
  $('#prev').addEventListener('click', () => jumpHit(-1));
  $('#next').addEventListener('click', () => jumpHit(1));

  function setMode(next) {
    mode = next;
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
    if (sortKey !== 'author') p.set('sort', sortKey);
    const h = p.toString();
    history.replaceState(null, '', h ? '#' + h : location.pathname);
  }

  // --- start ---------------------------------------------------------------------------
  async function load(focusId) {
    let res;
    try {
      if (!load.started) {
        load.started = true;
        library = (await getJSON('/ajax/library-info')).default_library || library;
      }
      res = await getJSON(`/ajax/search/${library}?num=100000&${SORTS[sortKey]}`);
    } catch (e) {
      fail('The library isn’t answering right now. <a href="/">Open the regular library view</a> or reload in a minute.');
      return;
    }
    ids = res.book_ids;
    indexOf = new Map(ids.map((id, i) => [id, i]));
    chunkState.clear();
    hits = null; clearSearch();
    $('#count').textContent = `${ids.length.toLocaleString()} ${ids.length === 1 ? 'book' : 'books'}`;
    statusEl.hidden = true;
    const i = indexOf.has(focusId) ? indexOf.get(focusId) : 0;
    goTo(i, true);
    if (selected !== null) selected = indexOf.has(focusId) ? i : null;
    setHash();
  }

  // Spines are drawn on canvases; redraw them once the book face has loaded.
  if (document.fonts) {
    document.fonts.load(`italic 28px ${SERIF}`).then(() => {
      for (const k of [...textures.keys()]) if (k[0] === 's') { textures.get(k).tex.dispose(); textures.delete(k); }
      dirty = true;
    }).catch(() => {});
  }

  setMode(mode);
  resize();
  requestAnimationFrame(frame);
  const startId = Number(params.get('book'));
  load(startId).then(() => { if (startId && indexOf.has(startId)) open(indexOf.get(startId)); });
  stage.focus({ preventScroll: true });
})();
