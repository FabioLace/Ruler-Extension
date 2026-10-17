(() => {
  'use strict';

  // Lo script può essere iniettato più volte: la seconda iniezione fa solo toggle.
  if (window.__alignRuler) {
    window.__alignRuler.toggle();
    return;
  }

  const S = {
    active: false,
    ruler: true,         // riga a croce che segue il cursore (funzione principale)
    snap: true,          // la riga si aggancia ai bordi vicini (Shift = libera)
    ticks: false,        // graduazione in pixel sulla riga; false = linee semplici
    boxes: 'none',       // riquadri evidenziati: vedi BOX_MODES
    details: false,      // pannello info + etichetta coordinate; false = solo le righe
    shift: false,
    inspect: false,      // hover/click selezionano elementi (e bloccano i click sulla pagina)
    cache: null,         // box degli elementi visibili, ricalcolato su scroll/resize/mutazioni
    cacheAt: 0,
    help: true,
    tol: 1,              // tolleranza di allineamento in px
    pins: [],            // elementi fissati come riferimento; pins[0] è il riferimento principale
    raw: null,           // elemento sotto il mouse
    depth: 0,            // quanti livelli risalire da `raw` (tasti P / N)
    mouse: { x: -1, y: -1 },
    guides: [],
    selGuide: null,
    dragging: null,
    corner: 'br',
  };

  const BLOCKED_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick'];
  const SNAP_PX = 5;
  const NEAR_MISS_PX = 8;  // oltre la tolleranza ma entro questa distanza = "quasi allineato" (rosso)
  const BOX_MODES = {
    none: 'nessuno',
    all: 'tutti',
    misaligned: 'solo non allineati',
    aligned: 'solo allineati',
  };
  const C = { hover: '#2f80ff', pin: '#e0249a', match: '#00c853', gap: '#ff9100', guide: '#00b8d4' };

  let toast, toastTimer;
  let host, root, dyn, guideLayer, panel, cursorStyle, raf = 0;

  // ---------- utilità ----------

  const fmt = (n) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));
  const signed = (n) => (n > 0 ? '+' : '') + fmt(n);
  const near = (a, b) => Math.abs(a - b) <= S.tol + 0.01;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const rectOf = (el) => boxOf(el.getBoundingClientRect());

  function boxOf(r) {
    return {
      l: r.left, t: r.top, r: r.right, b: r.bottom,
      cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2,
      w: r.width, h: r.height,
    };
  }

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = [...el.classList].slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    return s.length > 40 ? s.slice(0, 39) + '…' : s;
  }

  // elementFromPoint si ferma agli shadow host della pagina: scendiamo nei web component aperti.
  function pageTarget(x, y) {
    let el = document.elementFromPoint(x, y);
    if (el === host) return S.raw;
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function hovered() {
    if (!S.inspect) return null;
    let el = S.raw;
    for (let i = 0; i < S.depth && el && el.parentElement; i++) el = el.parentElement;
    return el;
  }

  const isOurs = (e) => e.composedPath().includes(host);

  // Box di tutti gli elementi visibili nel viewport. Valido per poco tempo perché hover,
  // animazioni e transizioni spostano gli elementi senza generare mutazioni del DOM.
  const CACHE_MS = 300;
  const MAX_ELEMENTS = 5000;

  function invalidate() { S.cache = null; }

  function layoutCache() {
    if (S.cache && performance.now() - S.cacheAt < CACHE_MS) return S.cache;
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    const vw = innerWidth, vh = innerHeight;
    const map = new Map();
    for (let i = 0; i < all.length && map.size < MAX_ELEMENTS; i++) {
      const r = all[i].getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
      map.set(all[i], boxOf(r));
    }
    // Wrapper con lo stesso identico box del figlio: teniamo solo il più interno.
    const same = (a, b) => a.l === b.l && a.t === b.t && a.r === b.r && a.b === b.b;
    const dup = new Set();
    for (const [el, rc] of map) {
      const pr = el.parentElement && map.get(el.parentElement);
      if (pr && same(pr, rc)) dup.add(el.parentElement);
    }
    S.cache = [];
    for (const [el, rc] of map) if (!dup.has(el)) S.cache.push({ el, rc });
    S.cacheAt = performance.now();
    return S.cache;
  }

  // Posizione della riga (con aggancio) ed elementi che la toccano.
  function computeRuler() {
    const cache = layoutCache();
    let { x, y } = S.mouse;
    let snapX = null, snapY = null;
    if (S.snap && !S.shift) {
      let bx = SNAP_PX + 1, by = SNAP_PX + 1;
      for (const it of cache) {
        for (const k of ['l', 'cx', 'r']) {
          const d = Math.abs(it.rc[k] - S.mouse.x);
          if (d < bx) { bx = d; x = it.rc[k]; snapX = { it, k }; }
        }
        for (const k of ['t', 'cy', 'b']) {
          const d = Math.abs(it.rc[k] - S.mouse.y);
          if (d < by) { by = d; y = it.rc[k]; snapY = { it, k }; }
        }
      }
    }
    const touching = (keys, pos) => cache
      .map((it) => ({ it, k: keys.find((k) => near(it.rc[k], pos)) }))
      .filter((m) => m.k)
      .slice(0, 60);
    // Elementi con un bordo vicino alla riga ma fuori tolleranza: il bordo più vicino e lo scarto.
    const nearMiss = (keys, pos, aligned) => {
      const skip = new Set(aligned.map((m) => m.it));
      const out = [];
      for (const it of cache) {
        if (skip.has(it)) continue;
        let best = null;
        for (const k of keys) {
          const d = it.rc[k] - pos;
          if (Math.abs(d) > S.tol + 0.01 && Math.abs(d) <= NEAR_MISS_PX && (!best || Math.abs(d) < Math.abs(best.d))) {
            best = { it, k, d };
          }
        }
        if (best) out.push(best);
      }
      return out.sort((a, b) => Math.abs(a.d) - Math.abs(b.d)).slice(0, 40);
    };
    const ax = touching(['l', 'r', 'cx'], x);
    const ay = touching(['t', 'b', 'cy'], y);
    return {
      x, y, snapX, snapY, ax, ay,
      mx: nearMiss(['l', 'r', 'cx'], x, ax),
      my: nearMiss(['t', 'b', 'cy'], y, ay),
    };
  }

  // ---------- costruzione overlay ----------

  function build() {
    host = document.createElement('align-ruler-overlay');
    host.setAttribute('popover', 'manual');
    host.style.cssText = [
      'all: initial', 'position: fixed', 'inset: 0', 'width: 100vw', 'height: 100vh',
      'margin: 0', 'padding: 0', 'border: 0', 'background: transparent', 'overflow: visible',
      'pointer-events: none', 'z-index: 2147483647', 'display: block',
    ].map((d) => d + ' !important').join(';');

    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="layer" id="dyn"></div>
      <div class="layer" id="guides"></div>
      <div class="panel br" id="panel"></div>
      <div class="toast" id="toast"></div>`;
    dyn = root.getElementById('dyn');
    guideLayer = root.getElementById('guides');
    panel = root.getElementById('panel');
    toast = root.getElementById('toast');

    cursorStyle = document.createElement('style');
    cursorStyle.textContent = '*, *::before, *::after { cursor: crosshair !important; }';
  }

  // ---------- attivazione ----------

  function activate() {
    if (!host) build();
    document.documentElement.appendChild(host);
    // Top layer: sta sopra qualunque z-index della pagina (anche dialog già aperti).
    try { host.showPopover?.(); } catch { /* popover non supportato: resta lo z-index */ }
    S.active = true;
    loadPrefs();
    showToast('Align Ruler attivo · <kbd>D</kbd> dettagli e scorciatoie · <kbd>Esc</kbd> esci');
    setInspect(S.inspect);
    window.addEventListener('mousemove', onMove, true);
    BLOCKED_EVENTS.forEach((t) => window.addEventListener(t, onBlocked, true));
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mouseout', onLeave, true);
    window.addEventListener('scroll', onLayout, true);
    window.addEventListener('resize', onLayout);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    notify();
    schedule();
  }

  // propagate = false quando lo spegnimento arriva da un'altra scheda: non va rimbalzato.
  function deactivate(propagate = true) {
    S.active = false;
    window.removeEventListener('mousemove', onMove, true);
    BLOCKED_EVENTS.forEach((t) => window.removeEventListener(t, onBlocked, true));
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('mouseout', onLeave, true);
    window.removeEventListener('scroll', onLayout, true);
    window.removeEventListener('resize', onLayout);
    observer.disconnect();
    invalidate();
    cursorStyle.remove();
    try { host.hidePopover?.(); } catch { /* ignore */ }
    host.remove();
    notify(propagate);
  }

  // Preferenze condivise tra tutte le pagine (chrome.storage è disponibile solo dentro l'estensione).
  function loadPrefs() {
    try {
      chrome.storage.local.get({ ticks: false, boxes: 'none', details: false }, (p) => {
        S.ticks = p.ticks;
        S.details = p.details;
        S.boxes = p.boxes in BOX_MODES ? p.boxes : 'none';
        schedule();
      });
    } catch { /* fuori dall'estensione: restano i default */ }
  }

  function savePrefs() {
    try { chrome.storage.local.set({ ticks: S.ticks, boxes: S.boxes, details: S.details }); } catch { /* ignore */ }
  }

  function notify(propagate = true) {
    try {
      chrome.runtime.sendMessage({ alignRulerOn: S.active, propagate }).catch(() => {});
    } catch { /* fuori dall'estensione */ }
  }

  function setInspect(on) {
    S.inspect = on;
    updateCursor();
  }

  // Il cursore a croce serve solo quando stiamo misurando o ispezionando.
  function updateCursor() {
    if (S.active && (S.inspect || S.ruler)) (document.head || document.documentElement).appendChild(cursorStyle);
    else cursorStyle.remove();
  }

  const observer = new MutationObserver(invalidate);
  function onLayout() { invalidate(); schedule(); }

  // Mouse uscito dalla finestra: nascondiamo la riga.
  function onLeave(e) {
    if (e.relatedTarget) return;
    S.mouse = { x: -1, y: -1 };
    schedule();
  }

  function onKeyUp(e) {
    if (e.key === 'Shift') { S.shift = false; schedule(); }
  }

  // ---------- input ----------

  function onMove(e) {
    S.mouse = { x: e.clientX, y: e.clientY };
    S.shift = e.shiftKey;
    if (S.inspect && !S.dragging) {
      const t = pageTarget(e.clientX, e.clientY);
      if (t !== S.raw) { S.raw = t; S.depth = 0; }
    }
    avoidPanel();
    schedule();
  }

  // In modalità ispezione i click servono a noi: la pagina non deve riceverli.
  function onBlocked(e) {
    if (!S.inspect || isOurs(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' && e.button === 0) {
      pin(hovered(), e.shiftKey);
      schedule();
    }
  }

  function pin(el, additive) {
    if (!el) return;
    const i = S.pins.indexOf(el);
    if (additive) {
      if (i >= 0) S.pins.splice(i, 1); else S.pins.push(el);
    } else {
      S.pins = i === 0 && S.pins.length === 1 ? [] : [el];
    }
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.composedPath()[0];
    const editable = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (editable && e.key !== 'Escape') return;

    const g = S.selGuide;
    const step = e.shiftKey ? 10 : 1;
    let handled = true;

    switch (e.key) {
      case 'h': case 'H': addGuide('h', S.mouse.y); break;
      case 'v': case 'V': addGuide('v', S.mouse.x); break;
      case 'c': case 'C': S.ruler = !S.ruler; updateCursor(); break;
      case 's': case 'S': S.snap = !S.snap; break;
      case 't': case 'T': S.ticks = !S.ticks; savePrefs(); break;
      case 'b': case 'B': {
        const modes = Object.keys(BOX_MODES);
        S.boxes = modes[(modes.indexOf(S.boxes) + 1) % modes.length];
        savePrefs();
        break;
      }
      case ' ': {
        if (S.mouse.x < 0) break;
        const R = computeRuler();
        addGuide('h', R.y); addGuide('v', R.x);
        break;
      }
      case 'Shift': S.shift = true; handled = false; break;
      case 'i': case 'I': setInspect(!S.inspect); break;
      case 'g': case 'G': [...S.guides].forEach(removeGuide); break;
      case 'd': case 'D': S.details = !S.details; savePrefs(); break;
      case '?':
        if (S.details) S.help = !S.help; else { S.details = true; S.help = true; savePrefs(); }
        break;
      case '+': case '=': S.tol = Math.min(20, S.tol + 1); break;
      case '-': case '_': S.tol = Math.max(0, S.tol - 1); break;
      case 'p': case 'P': {
        const h = hovered();
        if (h && h.parentElement && h.parentElement !== document.documentElement) S.depth++;
        break;
      }
      case 'n': case 'N': S.depth = Math.max(0, S.depth - 1); break;
      case 'Delete': case 'Backspace': case 'x': case 'X':
        if (g) removeGuide(g); else handled = false;
        break;
      case 'ArrowUp': case 'ArrowDown':
        if (g?.axis === 'h') g.pos += e.key === 'ArrowUp' ? -step : step; else handled = false;
        break;
      case 'ArrowLeft': case 'ArrowRight':
        if (g?.axis === 'v') g.pos += e.key === 'ArrowLeft' ? -step : step; else handled = false;
        break;
      case 'Escape':
        if (S.pins.length || S.selGuide) { S.pins = []; S.selGuide = null; } else deactivate();
        break;
      default: handled = false;
    }

    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (S.active) schedule();
    }
  }

  // Se il mouse finisce sopra il pannello, lo spostiamo nell'angolo opposto.
  // Avviso temporaneo: l'unica cosa visibile oltre alle righe quando i dettagli sono spenti.
  function showToast(html) {
    toast.innerHTML = html;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
  }

  function avoidPanel() {
    const r = panel.getBoundingClientRect();
    const m = 16;
    const { x, y } = S.mouse;
    if (x > r.left - m && x < r.right + m && y > r.top - m && y < r.bottom + m) {
      S.corner = S.corner === 'br' ? 'bl' : 'br';
      panel.className = 'panel ' + S.corner;
    }
  }

  // ---------- guide ----------

  function addGuide(axis, pos) {
    if (pos < 0) pos = axis === 'h' ? innerHeight / 2 : innerWidth / 2;
    const g = { axis, pos, el: document.createElement('div') };
    g.el.className = 'guide ' + axis;
    g.el.innerHTML = '<div class="gl"></div><span class="gt"></span>';
    g.el.addEventListener('pointerdown', (ev) => startDrag(ev, g));
    g.el.addEventListener('dblclick', (ev) => { ev.stopPropagation(); removeGuide(g); schedule(); });
    guideLayer.appendChild(g.el);
    S.guides.push(g);
    S.selGuide = g;
  }

  function removeGuide(g) {
    g.el.remove();
    S.guides = S.guides.filter((x) => x !== g);
    if (S.selGuide === g) S.selGuide = null;
  }

  // Bordi (e centri) degli elementi visibili, usati per lo snap e per colorare le guide.
  function edgesFor(axis, items) {
    return items.flatMap(({ rc }) => (axis === 'h' ? [rc.t, rc.cy, rc.b] : [rc.l, rc.cx, rc.r]));
  }

  function startDrag(ev, g) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    S.selGuide = g;
    S.dragging = g;
    g.el.setPointerCapture(ev.pointerId);

    const move = (m) => {
      S.mouse = { x: m.clientX, y: m.clientY };
      let p = g.axis === 'h' ? m.clientY : m.clientX;
      const edges = m.shiftKey ? [] : edgesFor(g.axis, currentItems());
      const best = edges.reduce((a, e) => (Math.abs(e - p) < Math.abs(a - p) ? e : a), Infinity);
      g.pos = Math.abs(best - p) <= SNAP_PX ? best : Math.round(p);
      schedule();
    };
    const up = () => {
      g.el.removeEventListener('pointermove', move);
      g.el.removeEventListener('pointerup', up);
      g.el.removeEventListener('pointercancel', up);
      S.dragging = null;
      const max = g.axis === 'h' ? innerHeight : innerWidth;
      if (g.pos < 2 || g.pos > max - 2) removeGuide(g); // trascinata fuori schermo = eliminata
      schedule();
    };
    g.el.addEventListener('pointermove', move);
    g.el.addEventListener('pointerup', up);
    g.el.addEventListener('pointercancel', up);
    schedule();
  }

  // ---------- calcolo allineamenti ----------

  function currentItems() {
    S.pins = S.pins.filter((el) => el.isConnected);
    const items = S.pins.map((el, i) => ({ el, rc: rectOf(el), pinned: true, n: i + 1 }));
    const h = hovered();
    if (h && !S.pins.includes(h)) items.push({ el: h, rc: rectOf(h), pinned: false });
    return items;
  }

  const AXES = {
    v: { keys: ['l', 'cx', 'r'], from: 't', to: 'b' }, // linee verticali (allineamento orizzontale)
    h: { keys: ['t', 'cy', 'b'], from: 'l', to: 'r' }, // linee orizzontali (allineamento verticale)
  };
  const NAMES = { l: 'sx', cx: 'centro', r: 'dx', t: 'alto', cy: 'centro', b: 'basso' };

  // Coppie di bordi allineati tra elementi diversi: stesso tipo (sx=sx, centro=centro…)
  // oppure bordo contro bordo opposto (dx di A = sx di B, elementi affiancati).
  function findMatches(items) {
    const out = [];
    for (const [axis, { keys, from, to }] of Object.entries(AXES)) {
      const lines = items.flatMap((it) => keys.map((k) => ({ it, k, pos: it.rc[k] })));
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          const a = lines[i], b = lines[j];
          if (a.it === b.it || !near(a.pos, b.pos)) continue;
          const isCenter = (k) => k === 'cx' || k === 'cy';
          if (a.k !== b.k && (isCenter(a.k) || isCenter(b.k))) continue;
          out.push({
            axis,
            pos: (a.pos + b.pos) / 2,
            start: Math.min(a.it.rc[from], b.it.rc[from]),
            end: Math.max(a.it.rc[to], b.it.rc[to]),
            exact: Math.abs(a.pos - b.pos) < 0.05,
            label: a.k === b.k ? NAMES[a.k] : `${NAMES[a.k]}↔${NAMES[b.k]}`,
          });
        }
      }
    }
    return out;
  }

  // ---------- rendering ----------

  function schedule() {
    if (!raf && S.active) raf = requestAnimationFrame(render);
  }

  function render() {
    raf = 0;
    if (!S.active) return;
    const items = currentItems();
    const hov = items.find((it) => !it.pinned) || null;
    const ref = items.find((it) => it.pinned) || null;
    const cmp = hov || items.find((it) => it.pinned && it !== ref) || null;
    let html = '';

    // Bordi dell'elemento in hover estesi su tutto lo schermo.
    const ext = hov || (S.inspect ? items.find((it) => it.el === hovered()) : null);
    if (ext) {
      const r = ext.rc;
      html += vline('ext', r.l) + vline('ext', r.r) + hline('ext', r.t) + hline('ext', r.b);
    }

    for (const it of items) {
      const r = it.rc;
      const cls = it.pinned ? 'pin' : 'hover';
      const tagPos = r.t < 18 ? 'inside' : '';
      const num = it.pinned ? `<b>${it.n}</b> ` : '';
      html += `<div class="box ${cls}" style="left:${r.l}px;top:${r.t}px;width:${r.w}px;height:${r.h}px">
        <span class="tag ${tagPos}">${num}${esc(describe(it.el))} <i>${fmt(r.w)}×${fmt(r.h)}</i></span></div>`;
    }

    for (const m of findMatches(items)) {
      const pad = 10;
      const style = m.axis === 'v'
        ? `left:${m.pos}px;top:${m.start - pad}px;height:${m.end - m.start + pad * 2}px`
        : `top:${m.pos}px;left:${m.start - pad}px;width:${m.end - m.start + pad * 2}px`;
      html += `<div class="match ${m.axis} ${m.exact ? '' : 'approx'}" style="${style}">
        <span>${m.label}</span></div>`;
    }

    if (ref && cmp) html += gaps(ref.rc, cmp.rc);

    const R = S.ruler && S.mouse.x >= 0 && !S.dragging ? computeRuler() : null;
    if (R) html += rulerHtml(R);

    dyn.innerHTML = html;

    const all = S.guides.length ? items.concat(layoutCache()) : items;
    const edges = { h: edgesFor('h', all), v: edgesFor('v', all) };
    for (const g of S.guides) {
      g.el.style[g.axis === 'h' ? 'top' : 'left'] = g.pos + 'px';
      g.el.classList.toggle('hit', edges[g.axis].some((p) => near(p, g.pos)));
      g.el.classList.toggle('sel', g === S.selGuide);
      g.el.querySelector('.gt').textContent = fmt(g.pos) + 'px';
    }

    panel.hidden = !S.details;
    if (S.details) renderPanel(ref, cmp, items, R);
  }

  // ---------- righello ----------

  const TICK_RADIUS = 200;   // lunghezza della graduazione attorno al cursore (per lato)
  const LABEL_STEP = 50;

  // Graduazione: le tacche restano su coordinate assolute del viewport
  // (background-position compensa l'inizio della striscia), così si leggono come un righello vero.
  function ticksHtml(x, y) {
    const x0 = x - TICK_RADIUS, y0 = y - TICK_RADIUS;
    let h = `<div class="ticks tx" style="left:${x0}px;top:${y}px;width:${TICK_RADIUS * 2}px;background-position-x:${-x0}px"></div>`;
    h += `<div class="ticks ty" style="top:${y0}px;left:${x}px;height:${TICK_RADIUS * 2}px;background-position-y:${-y0}px"></div>`;
    for (let v = Math.ceil(x0 / LABEL_STEP) * LABEL_STEP; v <= x + TICK_RADIUS; v += LABEL_STEP) {
      if (v >= 0 && Math.abs(v - x) > 16) h += `<span class="tn tnx" style="left:${v}px;top:${y + 9}px">${v}</span>`;
    }
    for (let v = Math.ceil(y0 / LABEL_STEP) * LABEL_STEP; v <= y + TICK_RADIUS; v += LABEL_STEP) {
      if (v >= 0 && Math.abs(v - y) > 10) h += `<span class="tn tny" style="top:${v}px;left:${x + 10}px">${v}</span>`;
    }
    return h;
  }

  function rulerHtml(R) {
    const { x, y } = R;
    let h = '';

    const box = (cls, r) => `<div class="${cls}" style="left:${r.l}px;top:${r.t}px;width:${r.w}px;height:${r.h}px"></div>`;

    // Bordi degli elementi toccati dalla riga: segmento verde + contorno leggero.
    if (S.boxes === 'all' || S.boxes === 'aligned') {
      for (const { it } of R.ax) {
        const r = it.rc;
        h += box('abox', r) + `<div class="aseg v" style="left:${x}px;top:${r.t}px;height:${r.h}px"></div>`;
      }
      for (const { it } of R.ay) {
        const r = it.rc;
        h += box('abox', r) + `<div class="aseg h" style="top:${y}px;left:${r.l}px;width:${r.w}px"></div>`;
      }
    }

    // Quasi allineati: segmento rosso sul bordo reale dell'elemento + scarto rispetto alla riga.
    if (S.boxes === 'all' || S.boxes === 'misaligned') {
      for (const { it, k, d } of R.mx) {
        const r = it.rc, ex = r[k];
        h += box('mbox', r) + `<div class="mseg v" style="left:${ex}px;top:${r.t}px;height:${r.h}px"></div>
          <span class="mlab" style="left:${ex}px;top:${r.t}px">Δ ${signed(d)}</span>`;
      }
      for (const { it, k, d } of R.my) {
        const r = it.rc, ey = r[k];
        h += box('mbox', r) + `<div class="mseg h" style="top:${ey}px;left:${r.l}px;width:${r.w}px"></div>
          <span class="mlab" style="left:${r.l}px;top:${ey}px">Δ ${signed(d)}</span>`;
      }
    }

    h += `<div class="cross v ${R.ax.length > 1 ? 'on' : ''}" style="left:${x}px"></div>`;
    h += `<div class="cross h ${R.ay.length > 1 ? 'on' : ''}" style="top:${y}px"></div>`;

    if (S.ticks) h += ticksHtml(x, y);

    // Etichetta coordinate vicino al cursore, ribaltata vicino ai bordi dello schermo.
    const flipX = x > innerWidth - 170, flipY = y > innerHeight - 50;
    const pos = `${flipX ? 'right' : 'left'}:${flipX ? innerWidth - x + 12 : x + 12}px;` +
      `${flipY ? 'bottom' : 'top'}:${flipY ? innerHeight - y + 24 : y + 24}px`;
    const snap = (s) => (s ? ` <i>⇥ ${NAMES[s.k]}</i>` : '');
    if (S.details) h += `<span class="coord" style="${pos}">x ${fmt(x)}${snap(R.snapX)} · y ${fmt(y)}${snap(R.snapY)}</span>`;
    return h;
  }

  const vline = (cls, x) => `<div class="${cls} v" style="left:${x}px"></div>`;
  const hline = (cls, y) => `<div class="${cls} h" style="top:${y}px"></div>`;

  // Distanza tra due elementi che non si sovrappongono su un asse.
  function gaps(a, b) {
    let out = '';
    const [left, right] = a.l <= b.l ? [a, b] : [b, a];
    if (right.l > left.r) {
      const y = (Math.max(a.t, b.t) + Math.min(a.b, b.b)) / 2;
      const yy = Math.max(a.t, b.t) < Math.min(a.b, b.b) ? y : (a.cy + b.cy) / 2;
      out += `<div class="gap h" style="left:${left.r}px;top:${yy}px;width:${right.l - left.r}px">
        <span>${fmt(right.l - left.r)}</span></div>`;
    }
    const [top, bot] = a.t <= b.t ? [a, b] : [b, a];
    if (bot.t > top.b) {
      const overlapX = Math.max(a.l, b.l) < Math.min(a.r, b.r);
      const x = overlapX ? (Math.max(a.l, b.l) + Math.min(a.r, b.r)) / 2 : (a.cx + b.cx) / 2;
      out += `<div class="gap v" style="top:${top.b}px;left:${x}px;height:${bot.t - top.b}px">
        <span>${fmt(bot.t - top.b)}</span></div>`;
    }
    return out;
  }

  function renderPanel(ref, cmp, items, R) {
    let h = `<div class="hd"><span>📐 Align Ruler</span><span class="tol">tolleranza ±${S.tol}px</span></div>`;

    if (R) {
      const list = (ms) => ms.slice(0, 3).map((m) => `${esc(describe(m.it.el))} <i>${NAMES[m.k]}</i>`).join('<br>') +
        (ms.length > 3 ? `<br>+${ms.length - 3} altri` : '');
      const misses = (mm) => mm.slice(0, 3).map((m) =>
        `<span class="ko">✗ ${esc(describe(m.it.el))} <i>${NAMES[m.k]}</i> Δ ${signed(m.d)}</span>`).join('<br>') +
        (mm.length > 3 ? `<br><span class="ko">+${mm.length - 3} quasi allineati</span>` : '');
      const block = (label, pos, ms, mm) => `<div class="rl ${ms.length > 1 ? 'ok' : ''}">
        <div class="rlh"><span>${label} ${fmt(pos)}</span>
        <b>${ms.length > 1 ? '✓ ' + ms.length + ' allineati' : ms.length ? '1 bordo' : '—'}</b></div>
        ${ms.length ? `<div class="rll">${list(ms)}</div>` : ''}
        ${mm.length ? `<div class="rll">${misses(mm)}</div>` : ''}</div>`;
      h += block('│ x', R.x, R.ax, R.mx) + block('─ y', R.y, R.ay, R.my);
      h += `<div class="dim">riquadri: ${BOX_MODES[S.boxes]} (B)</div>`;
      if (!S.snap) h += '<div class="dim">aggancio ai bordi disattivato (S)</div>';
    }

    const line = (it, label) =>
      `<div class="el"><span class="${it.pinned ? 'pn' : 'hv'}">${label}</span> ${esc(describe(it.el))}
       <span class="dim">x ${fmt(it.rc.l)} · y ${fmt(it.rc.t)} · ${fmt(it.rc.w)}×${fmt(it.rc.h)}</span></div>`;

    if (ref) h += line(ref, '#' + ref.n);
    if (cmp) h += line(cmp, cmp.pinned ? '#' + cmp.n : 'hover');
    if (S.pins.length > 2) h += `<div class="dim">+${S.pins.length - 2} altri fissati (linee verdi)</div>`;

    if (ref && cmp) {
      const rows = [['Sinistra', 'l'], ['Centro X', 'cx'], ['Destra', 'r'],
        ['Alto', 't'], ['Centro Y', 'cy'], ['Basso', 'b'], ['Larghezza', 'w'], ['Altezza', 'h']];
      h += '<table>' + rows.map(([name, k]) => {
        const d = cmp.rc[k] - ref.rc[k];
        const ok = near(d, 0);
        return `<tr class="${ok ? 'ok' : 'ko'}"><td>${name}</td>
          <td>${ok ? '✓ ' + (Math.abs(d) < 0.05 ? 'allineato' : 'Δ ' + signed(d)) : 'Δ ' + signed(d) + 'px'}</td></tr>`;
      }).join('') + '</table>';
    } else if (!ref) {
      if (S.inspect) h += '<div class="hint">Clicca un elemento per fissarlo come riferimento, poi passa sopra agli altri.</div>';
      else if (!R) h += '<div class="hint">Muovi il mouse sulla pagina per usare il righello.</div>';
    } else {
      h += '<div class="hint">Passa sopra a un altro elemento per confrontarlo con #1.</div>';
    }

    if (S.depth) h += `<div class="dim">risalito di ${S.depth} livell${S.depth === 1 ? 'o' : 'i'} (N per scendere)</div>`;

    if (S.help) {
      h += `<div class="help">
        <div>La riga segue il mouse e diventa <b class="g">verde</b> sui bordi allineati</div>
        <div><kbd>Shift</kbd> tenuto = riga libera · <kbd>S</kbd> aggancio on/off · <kbd>C</kbd> righello on/off</div>
        <div><kbd>B</kbd> riquadri: nessuno → tutti → non allineati → allineati</div>
        <div><kbd>D</kbd> nascondi dettagli (solo righe)</div>
        <div><kbd>T</kbd> ${S.ticks ? 'nascondi i pixel (solo linee)' : 'mostra i pixel sul righello'}</div>
        <div><kbd>Spazio</kbd> fissa la riga come guide · <kbd>H</kbd>/<kbd>V</kbd> solo orizz./vert.</div>
        <div>Guide: trascina · <kbd>←↑↓→</kbd> sposta · <kbd>X</kbd>/doppio click elimina · <kbd>G</kbd> elimina tutte</div>
        <div><kbd>I</kbd> ispezione: <kbd>Click</kbd> fissa elemento e confronta · <kbd>P</kbd>/<kbd>N</kbd> padre/figlio</div>
        <div><kbd>+</kbd>/<kbd>-</kbd> tolleranza</div>
        <div><kbd>Esc</kbd> deseleziona / esci · <kbd>?</kbd> nascondi aiuto</div>
      </div>`;
    }
    panel.innerHTML = h;
  }

  const CSS = `
    * { box-sizing: border-box; }
    .layer { position: fixed; inset: 0; pointer-events: none;
      font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

    .box { position: fixed; }
    .box.hover { outline: 1px solid ${C.hover}; background: rgba(47,128,255,.08); }
    .box.pin { outline: 2px solid ${C.pin}; background: rgba(224,36,154,.07); }
    .tag { position: absolute; left: -1px; bottom: 100%; padding: 1px 5px; white-space: nowrap;
      color: #fff; background: ${C.hover}; border-radius: 3px 3px 0 0; }
    .tag.inside { bottom: auto; top: 0; border-radius: 0 0 3px 0; }
    .tag i { font-style: normal; opacity: .8; }
    .box.pin .tag { background: ${C.pin}; }

    .ext, .cross { position: fixed; }
    .ext.v, .cross.v { top: 0; bottom: 0; width: 0; }
    .ext.h, .cross.h { left: 0; right: 0; height: 0; }
    .ext.v { border-left: 1px dashed rgba(47,128,255,.75); }
    .ext.h { border-top: 1px dashed rgba(47,128,255,.75); }
    .cross.v { border-left: 1px solid rgba(255,59,48,.85); }
    .cross.h { border-top: 1px solid rgba(255,59,48,.85); }
    .cross.on { border-color: ${C.match}; }
    .coord { position: fixed; padding: 2px 6px; color: #fff; background: rgba(22,24,30,.9);
      border-radius: 4px; white-space: nowrap; }
    .coord i { font-style: normal; color: #4ade80; }

    .ticks { position: fixed; }
    .tx { height: 15px; margin-top: -7px;
      background:
        repeating-linear-gradient(90deg, rgba(255,59,48,.95) 0 1px, transparent 1px 50px) 0 0 / 100% 100% repeat-x,
        repeating-linear-gradient(90deg, rgba(255,59,48,.85) 0 1px, transparent 1px 10px) 0 50% / 100% 60% repeat-x,
        repeating-linear-gradient(90deg, rgba(255,59,48,.5) 0 1px, transparent 1px 2px) 0 50% / 100% 30% repeat-x;
      -webkit-mask-image: linear-gradient(90deg, transparent, #000 30%, #000 70%, transparent);
      mask-image: linear-gradient(90deg, transparent, #000 30%, #000 70%, transparent); }
    .ty { width: 15px; margin-left: -7px;
      background:
        repeating-linear-gradient(180deg, rgba(255,59,48,.95) 0 1px, transparent 1px 50px) 0 0 / 100% 100% repeat-y,
        repeating-linear-gradient(180deg, rgba(255,59,48,.85) 0 1px, transparent 1px 10px) 50% 0 / 60% 100% repeat-y,
        repeating-linear-gradient(180deg, rgba(255,59,48,.5) 0 1px, transparent 1px 2px) 50% 0 / 30% 100% repeat-y;
      -webkit-mask-image: linear-gradient(180deg, transparent, #000 30%, #000 70%, transparent);
      mask-image: linear-gradient(180deg, transparent, #000 30%, #000 70%, transparent); }
    .tn { position: fixed; font-size: 9px; color: #d92d20;
      text-shadow: 0 0 2px #fff, 0 0 2px #fff, 0 0 3px #fff; }
    .tnx { transform: translateX(-50%); }
    .tny { transform: translateY(-50%); }

    .abox { position: fixed; outline: 1px solid rgba(0,200,83,.45); background: rgba(0,200,83,.05); }
    .aseg { position: fixed; background: ${C.match}; }
    .mbox { position: fixed; outline: 1px dashed rgba(255,59,48,.75); background: rgba(255,59,48,.05); }
    .mseg { position: fixed; background: #ff3b30; }
    .mseg.v { width: 2px; margin-left: -1px; }
    .mseg.h { height: 2px; margin-top: -1px; }
    .mlab { position: fixed; transform: translate(4px, 2px); padding: 0 4px; font-size: 10px; color: #fff;
      background: #ff3b30; border-radius: 3px; white-space: nowrap; }
    .aseg.v { width: 3px; margin-left: -1px; }
    .aseg.h { height: 3px; margin-top: -1px; }

    .match { position: fixed; }
    .match.v { width: 0; border-left: 1px solid ${C.match}; }
    .match.h { height: 0; border-top: 1px solid ${C.match}; }
    .match.approx { border-style: dashed; }
    .match span { position: absolute; padding: 0 4px; font-size: 10px; color: #fff;
      background: ${C.match}; border-radius: 3px; white-space: nowrap; }
    .match.v span { bottom: -14px; left: 2px; }
    .match.h span { right: -2px; top: 2px; transform: translateX(100%); }

    .gap { position: fixed; }
    .gap.h { height: 0; border-top: 1px solid ${C.gap}; }
    .gap.v { width: 0; border-left: 1px solid ${C.gap}; }
    .gap span { position: absolute; padding: 0 4px; font-size: 10px; color: #fff;
      background: ${C.gap}; border-radius: 3px; white-space: nowrap; }
    .gap.h span { left: 50%; top: 2px; transform: translateX(-50%); }
    .gap.v span { top: 50%; left: 3px; transform: translateY(-50%); }

    .guide { position: fixed; pointer-events: auto; }
    .guide.h { left: 0; right: 0; height: 9px; margin-top: -4px; cursor: row-resize; }
    .guide.v { top: 0; bottom: 0; width: 9px; margin-left: -4px; cursor: col-resize; }
    .gl { position: absolute; background: ${C.guide}; }
    .guide.h .gl { left: 0; right: 0; top: 4px; height: 1px; }
    .guide.v .gl { top: 0; bottom: 0; left: 4px; width: 1px; }
    .guide.hit .gl { background: ${C.match}; box-shadow: 0 0 0 1px rgba(0,200,83,.35); }
    .guide.sel .gl { box-shadow: 0 0 0 1px rgba(0,184,212,.45); }
    .gt { position: absolute; padding: 0 4px; font-size: 10px; color: #fff; background: ${C.guide};
      border-radius: 3px; white-space: nowrap; }
    .guide.hit .gt { background: ${C.match}; }
    .guide.h .gt { left: 6px; top: -10px; }
    .guide.v .gt { top: 6px; left: 8px; }

    .panel { position: fixed; bottom: 12px; right: 12px; width: 300px; padding: 10px 12px;
      pointer-events: auto; color: #e8e8ea; background: rgba(22,24,30,.95);
      border: 1px solid rgba(255,255,255,.1); border-radius: 10px;
      box-shadow: 0 8px 30px rgba(0,0,0,.35);
      font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    .panel.bl { right: auto; left: 12px; }
    .panel[hidden] { display: none; }
    .toast { position: fixed; left: 50%; bottom: 20px; transform: translate(-50%, 8px); padding: 6px 12px;
      color: #e8e8ea; background: rgba(22,24,30,.92); border-radius: 8px; white-space: nowrap;
      font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      opacity: 0; transition: opacity .25s, transform .25s; pointer-events: none; }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
    .hd { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; font-weight: 600; }
    .tol { font-weight: 400; font-size: 11px; color: #9aa0aa; }
    .el { margin: 3px 0; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; word-break: break-all; }
    .el .pn, .el .hv { display: inline-block; padding: 0 5px; border-radius: 3px; color: #fff; font-size: 10px; }
    .el .pn { background: ${C.pin}; }
    .el .hv { background: ${C.hover}; }
    .dim { display: block; color: #9aa0aa; font-size: 11px; }
    table { width: 100%; margin-top: 6px; border-collapse: collapse; font-size: 12px; }
    td { padding: 2px 0; border-top: 1px solid rgba(255,255,255,.06); }
    td:last-child { text-align: right; font-family: ui-monospace, Menlo, Consolas, monospace; }
    tr.ok td:last-child { color: #4ade80; }
    tr.ko td:last-child { color: #f87171; }
    .hint { margin-top: 6px; color: #c4c8d0; }
    .rl { margin: 4px 0; padding: 5px 7px; border-radius: 6px; background: rgba(255,255,255,.05); }
    .rl.ok { background: rgba(0,200,83,.14); }
    .rlh { display: flex; justify-content: space-between; font-family: ui-monospace, Menlo, Consolas, monospace; }
    .rl.ok b { color: #4ade80; }
    .rl b { font-weight: 600; color: #9aa0aa; }
    .rll { margin-top: 2px; font: 10px/1.4 ui-monospace, Menlo, Consolas, monospace; color: #c4c8d0; word-break: break-all; }
    .rll i { font-style: normal; color: #9aa0aa; }
    .rll .ko { color: #f87171; }
    .g { color: #4ade80; }
    .help { margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,.1);
      color: #9aa0aa; font-size: 11px; }
    .help div { margin: 2px 0; }
    kbd { display: inline-block; padding: 0 4px; font: 10px ui-monospace, Menlo, monospace; color: #e8e8ea;
      background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.15); border-radius: 3px; }
  `;

  window.__alignRuler = {
    toggle: () => (S.active ? deactivate() : activate()),
  };
  // Interruttore unico: l'OFF dato in un'altra scheda spegne anche questa.
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.alignRulerOff && S.active) deactivate(false);
    });
  } catch { /* fuori dall'estensione */ }

  activate();
})();
