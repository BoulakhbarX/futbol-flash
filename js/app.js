'use strict';
/* =====================================================================
   FÚTBOL FLASH STUDIO · editor logic
   Form → live preview → exact-size PNG.
   On the PC (Start Futbol Flash.bat): saved by server.py into output/ + copied to clipboard.
   Anywhere else, e.g. the phone app: shared (Facebook…) or saved to the device.
   ===================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STORE_KEY = 'ff.studio.v1';
const OLD_TEAMS_KEY = 'ff.studio.teams.v1';   // team memory of v1 (moved to data/teams.json)
const NEUTRAL_COLOR = '#8b95a5';
const MAX_PHOTO_BYTES = 640 * 1024;           // keeps exports fast and 4 draft photos within browser storage
const MAX_PHOTO_PIXELS = 4_000_000;
const PHOTO_HEADROOM = 1.5;                   // extra resolution so zooming in stays sharp up to ~150%
// Zoom in % of the size that exactly fills the photo area. Below 100 the whole photo
// shrinks (to fit a head or a full body) and a blurred copy fills the edges.
const ZOOM_MIN = 40, ZOOM_MAX = 300;

// Photo slots per template and the area each photo must cover
const PHOTO_SLOTS = {
  'ultima-hora': { photo: [1080, 900] },
  declaraciones: { photo: [1080, 1350] },
  'en-juego': { photo: [1080, 1350], photo2: [1080, 1350] },
};

// Example content shown on first launch (and after "Reset")
const DEFAULTS = {
  // *Size: '' = auto-fit, a number = exact px from the slider. *Zoom: 100 = photo exactly fills its area
  'ultima-hora': {
    photo: '', photoX: '50', photoY: '30', photoZoom: '100',
    headline: 'El club confirma la lesión de su capitán', headlineSize: '',
    label: 'ÚLTIMA HORA',
    highlight: 'lesión', status: 'EN DESARROLLO', source: '[Nombre]',
  },
  declaraciones: {
    photo: '', photoX: '50', photoY: '25', photoZoom: '100', photoMono: false,
    quote: 'Hemos trabajado mucho para este momento y vamos a darlo todo en la final.', quoteSize: '',
    name: '[Jugador]', context: 'Rueda de prensa · Previa de la final',
  },
  'en-juego': {
    layout: 'single',
    photo: '', photoX: '50', photoY: '35', photoZoom: '100',
    photo2: '', photo2X: '50', photo2Y: '35', photo2Zoom: '100',
    label: 'EN JUEGO', headline: '¡Dura entrada en el Clásico!', headlineSize: '', highlight: 'dura',
    context: 'El Clásico · Minuto 67', credit: '',
  },
  resultado: {
    competition: 'LaLiga · Jornada 10', state: 'FINAL', winner: 'auto',
    homeName: 'Real Madrid', homeCode: 'RMA', homeColor: '#ffffff', homeScore: '2', homeScorers: "Vinícius Jr. 23', Bellingham 67'",
    homeLogo: '', homeLogoCircle: false, homeLogoFresh: false,
    awayName: 'FC Barcelona', awayCode: 'BAR', awayColor: '#a50044', awayScore: '1', awayScorers: "Lewandowski 81'",
    awayLogo: '', awayLogoCircle: false, awayLogoFresh: false,
    stat1Label: 'Posesión', stat1Home: '46%', stat1Away: '54%',
    stat2Label: 'Tiros', stat2Home: '14', stat2Away: '11',
    stat3Label: 'Tiros a puerta', stat3Home: '6', stat3Away: '4',
    source: '[fuente]',
  },
};

/* ---------- Small helpers ---------- */
const upper = s => s.toLocaleUpperCase('es');
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordCount = s => (s.trim().match(/\S+/g) || []).length;
const isWordChar = ch => /[\p{L}\p{N}]/u.test(ch);
const canvasOf = tpl => document.getElementById(`tpl-${tpl}`);
const formOf = tpl => $(`form[data-form="${tpl}"]`);
const teamKey = name => upper(name.normalize('NFC').trim());
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toNum = (v, fallback) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; };
const lineCount = text => text.split('\n').length;

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; }
}

function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('.toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 6000);
}

/* ---------- Where the Studio runs ----------
   "studio": opened with Start Futbol Flash.bat; server.py saves PNGs into output/ and keeps
   data/teams.json. "standalone": any other web server, e.g. the phone app: PNGs are shared
   or saved on the device, and the team library lives on the device. */
let MODE = 'unknown';
const backend = (async () => {
  if (location.protocol !== 'file:') {
    try {
      const res = await fetch('api/ping', { cache: 'no-store' });
      if (res.ok && (await res.json()).app === 'futbol-flash-studio') return 'studio';
    } catch (_) { /* not the Studio server, or offline */ }
  }
  return 'standalone';
})().then(mode => (MODE = mode));

// Small key-value store on the device (IndexedDB holds far more than localStorage)
const deviceStore = {
  db: null,
  open() {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('futbol-flash-studio', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  },
  async run(mode, op) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const req = op(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  },
  get(key) { return this.run('readonly', s => s.get(key)); },
  set(key, value) { return this.run('readwrite', s => s.put(value, key)); },
};

// One team record, checked like server.py does (imported files can contain anything)
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
function cleanTeam(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '').trim().slice(0, 80);
  if (!name) return null;
  const color = String(raw.color ?? '');
  const logo = typeof raw.logo === 'string' && raw.logo.length <= 2_000_000 && PNG_DATA_URL.test(raw.logo) ? raw.logo : '';
  return {
    name,
    code: String(raw.code ?? '').trim().slice(0, 4),
    color: /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : NEUTRAL_COLOR,
    logo,
    logoCircle: Boolean(raw.logoCircle),
  };
}

// Team library: data/teams.json through server.py on the PC, IndexedDB everywhere else
const teamStore = {
  async load() {
    if ((await backend) === 'studio') {
      const res = await fetch('api/teams');
      if (!res.ok) throw new Error(`server error ${res.status}`);
      return (await res.json()).teams;
    }
    return (await deviceStore.get('teams')) || {};
  },
  // Adds or updates teams; returns the whole library
  async save(records) {
    if ((await backend) === 'studio') {
      const res = await fetch('api/teams', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teams: records }),
      });
      const info = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(info.error || `server error ${res.status}`);
      return info.teams;
    }
    const teams = (await deviceStore.get('teams')) || {};
    for (const raw of records) {
      const team = cleanTeam(raw);
      if (team) teams[teamKey(team.name)] = team;
    }
    await deviceStore.set('teams', teams);
    return teams;
  },
};

/* ---------- State (drafts auto-saved in this browser) ---------- */
function loadState() {
  const saved = loadJson(STORE_KEY, {});
  const data = {};
  for (const tpl of Object.keys(DEFAULTS)) data[tpl] = { ...DEFAULTS[tpl], ...(saved.data?.[tpl] || {}) };
  return { active: DEFAULTS[saved.active] ? saved.active : 'ultima-hora', data };
}
const state = loadState();

let saveTimer = 0;
let storageWarned = false;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (_) {
      // Storage full (big photos): keep saving the text, drop the photos from the draft
      const light = JSON.parse(JSON.stringify(state));
      for (const [tpl, slots] of Object.entries(PHOTO_SLOTS)) for (const key of Object.keys(slots)) light.data[tpl][key] = '';
      try { localStorage.setItem(STORE_KEY, JSON.stringify(light)); } catch (_) { /* nothing more we can do */ }
      if (!storageWarned) {
        storageWarned = true;
        toast('Browser storage is full: your text is still saved, but photos won\'t be kept after closing the Studio.', 'error');
      }
    }
  }, 250);
}

/* ---------- Team library (codes, colors, logos) ---------- */
let teamIndex = new Map();

function setTeams(teams) {
  teamIndex = new Map(Object.values(teams || {}).filter(t => t && t.name).map(t => [teamKey(t.name), t]));
  const options = [...teamIndex.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'es'))
    .map(t => Object.assign(document.createElement('option'), { value: t.name }));
  $('#team-list').replaceChildren(...options);
}

async function pushTeams(records) {
  setTeams(await teamStore.save(records));
}

async function loadTeamLibrary() {
  const old = loadJson(OLD_TEAMS_KEY, null);
  try {
    setTeams(await teamStore.load());
  } catch (_) {
    setTeams(old);   // library not reachable: read-only fallback
    return;
  }
  // One-time move of the teams remembered by v1 of the Studio
  if (old && typeof old === 'object') {
    const missing = Object.values(old).filter(t => t && t.name && !teamIndex.has(teamKey(t.name)));
    try {
      if (missing.length) await pushTeams(missing);
      localStorage.removeItem(OLD_TEAMS_KEY);
    } catch (_) { /* try again next launch */ }
  }
}

async function rememberTeams() {
  const d = state.data.resultado;
  const records = ['home', 'away'].filter(side => d[`${side}Name`].trim()).map(side => ({
    name: d[`${side}Name`].trim(),
    code: d[`${side}Code`].trim(),
    color: d[`${side}Color`],
    logo: d[`${side}Logo`],
    logoCircle: Boolean(d[`${side}LogoCircle`]),
  }));
  d.homeLogoFresh = d.awayLogoFresh = false;
  persist();
  if (records.length) await pushTeams(records);
}

// Move the library between the PC and the phone: Export there, Import here
async function exportTeams() {
  try {
    const teams = await teamStore.load();
    const json = JSON.stringify({ app: 'futbol-flash-studio', teams }, null, 1);
    downloadBlob(new Blob([json], { type: 'application/json' }), 'futbol-flash-teams.json');
    const n = Object.keys(teams).length;
    toast(`Exported ${n} ${n === 1 ? 'team' : 'teams'} to futbol-flash-teams.json.`);
  } catch (err) {
    toast(`Could not export the team library: ${err.message}`, 'error');
  }
}

async function importTeams(file) {
  let records;
  try {
    const data = JSON.parse(await file.text());
    const teams = data && typeof data === 'object' && 'teams' in data ? data.teams : data;
    records = Array.isArray(teams) ? teams : Object.values(teams || {});
  } catch (_) {
    return toast('That file is not a Fútbol Flash team library.', 'error');
  }
  const valid = records.map(cleanTeam).filter(Boolean);
  if (!valid.length) return toast('No teams found in that file.', 'error');
  try {
    // Small batches: the PC server accepts up to 8 MB per request
    let batch = [], size = 0;
    for (const team of valid) {
      const n = JSON.stringify(team).length;
      if (batch.length && (size + n > 4_000_000 || batch.length >= 200)) {
        await pushTeams(batch);
        batch = [];
        size = 0;
      }
      batch.push(team);
      size += n;
    }
    if (batch.length) await pushTeams(batch);
    toast(`Imported ${valid.length} ${valid.length === 1 ? 'team' : 'teams'}.`);
  } catch (err) {
    toast(`Import failed: ${err.message}`, 'error');
  }
}

/* ---------- Design rules ---------- */
// Wraps the first match of `word` (whole word preferred) in the yellow highlight
function withHighlight(text, word) {
  const w = word.trim();
  if (!w) return escapeHtml(text);
  const esc = escapeRegExp(w);
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu').exec(text) || new RegExp(esc, 'iu').exec(text);
  if (!m) return escapeHtml(text);
  return escapeHtml(text.slice(0, m.index)) + '<span class="hl">' + escapeHtml(m[0]) + '</span>' + escapeHtml(text.slice(m.index + m[0].length));
}

// Long text shrinks instead of breaking the layout
function shrinkToFit(el, minPx, overflows) {
  el.style.fontSize = '';
  let size = parseFloat(getComputedStyle(el).fontSize);
  while (overflows(el) && size > minPx) {
    size -= 2;
    el.style.fontSize = `${size}px`;
  }
}
// Height of one line in px (the computed line-height can be "115.2px" or a plain number)
function linePx(el) {
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight), fs = parseFloat(cs.fontSize);
  if (!Number.isFinite(lh)) return fs * 1.2;
  return cs.lineHeight.endsWith('px') ? lh : lh * fs;
}
// clientHeight counts only the line boxes. scrollHeight also counts Anton's tall accents
// spilling past the first/last line, which made any exactly-3-line headline look too tall.
const fitLines = (el, lines, minPx) => shrinkToFit(el, minPx, e => e.clientHeight > lines * linePx(e) + 1);
const fitWidth = (el, minPx) => shrinkToFit(el, minPx, e => e.scrollWidth > e.clientWidth + 1);

// Slider size (px) is used exactly. Auto-fit shrinks the text to `maxLines`, or to as many
// lines as you typed yourself if that's more, so your own line breaks never force a shrink.
function sizeText(el, size, text, maxLines, minPx) {
  const px = toNum(size, 0);
  if (px > 0) {
    el.style.fontSize = `${px}px`;
    return;
  }
  fitLines(el, Math.max(maxLines, lineCount(text)), minPx);
}

// Line breaks typed with Enter are kept; spaces/empty lines at the start and end are not
const multiline = text => text.replace(/\r\n?/g, '\n').trim();

// Dark or white text, whichever contrasts more with the club color
function textOn(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!m) return 'var(--blanco)';
  const lin = v => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = m.slice(1).map(h => lin(parseInt(h, 16)));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (L + 0.05) / 0.0539 > 0.978 / (L + 0.05) ? 'var(--negro)' : 'var(--blanco)';
}

// "Real Madrid" → RMA, "FC Barcelona" → BAR (you can always overwrite it)
const CODE_SKIP = new Set(['FC', 'CF', 'CD', 'AC', 'AS', 'SC', 'SS', 'UD', 'SD', 'RC', 'RCD', 'CA', 'AFC', 'CLUB', 'DE', 'DEL', 'LA', 'EL', 'THE']);
function deriveCode(name) {
  const words = upper(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^A-Z0-9]+/).filter(w => w && !CODE_SKIP.has(w));
  if (!words.length) return '';
  return words.length === 1 ? words[0].slice(0, 3) : words[0][0] + words[1].slice(0, 2);
}

/* ---------- Rendering the designs ---------- */
// Photo framing. Zoom 100% = the photo exactly fills its area (like CSS "cover"). Above 100%
// it's enlarged; below, it shrinks and a blurred, darkened copy fills the rest of the area.
// X/Y choose which part shows (or where the smaller photo sits). Needs the photo's pixel
// size, read once per photo (box._ready resolves when it's known).

// Blurred, darkened mini copy of the photo for the edges (tiny, so exports stay light)
function makeBackdrop(img) {
  const k = 160 / Math.max(img.naturalWidth, img.naturalHeight);
  const w = Math.max(8, Math.round(img.naturalWidth * k));
  const h = Math.max(8, Math.round(img.naturalHeight * k));
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0A0D12';
  ctx.fillRect(0, 0, w, h);
  ctx.filter = 'blur(5px) brightness(0.6) saturate(1.1)';
  const o = 0.15;   // overscan: the blur reaches into real photo at the edges, not into black
  ctx.drawImage(img, -w * o, -h * o, w * (1 + 2 * o), h * (1 + 2 * o));
  return canvas.toDataURL('image/jpeg', 0.85);
}

function loadPhoto(src) {
  const img = new Image();
  img.src = src;
  return img.decode().then(() => ({ w: img.naturalWidth, h: img.naturalHeight, backdrop: makeBackdrop(img) }));
}

function applyPhoto(box, d, key) {
  const src = d[key] || '';
  if (box._src !== src) {
    box._src = src;
    box._size = null;
    box._layers = src ? 1 : 0;
    box.style.backgroundImage = src ? `url("${src}")` : 'none';
    box.classList.toggle('has-photo', Boolean(src));
    box._ready = !src ? Promise.resolve() : loadPhoto(src).then(info => {
      if (box._src !== src) return;   // replaced meanwhile
      box._size = { w: info.w, h: info.h };
      box._layers = 2;               // the photo on top, its blurred copy underneath
      box.style.backgroundImage = `url("${src}"), url("${info.backdrop}")`;
      placePhoto(box);
    }, () => {});
  }
  box._view = {
    x: clamp(toNum(d[`${key}X`], 50), 0, 100),
    y: clamp(toNum(d[`${key}Y`], 50), 0, 100),
    zoom: clamp(toNum(d[`${key}Zoom`], 100), ZOOM_MIN, ZOOM_MAX) / 100,
  };
  placePhoto(box);
}

// Box and displayed photo size in design pixels (the preview zoom doesn't matter here)
function photoGeometry(box) {
  if (!box._size) return null;
  const bw = box.offsetWidth || parseFloat(getComputedStyle(box).width);
  const bh = box.offsetHeight || parseFloat(getComputedStyle(box).height);
  const k = Math.max(bw / box._size.w, bh / box._size.h) * box._view.zoom;
  return { bw, bh, iw: box._size.w * k, ih: box._size.h * k };
}

// Only size/position change while you drag or zoom (cheap); the image layers are set
// once per photo in applyPhoto
function placePhoto(box) {
  const g = photoGeometry(box);
  const size = g ? `${g.iw.toFixed(2)}px ${g.ih.toFixed(2)}px` : 'cover';
  const position = `${box._view.x}% ${box._view.y}%`;
  const backdrop = box._layers === 2;
  box.style.backgroundSize = backdrop ? `${size}, cover` : size;
  box.style.backgroundPosition = backdrop ? `${position}, 50% 50%` : position;
}

function applyCrest(crest, d, side) {
  const logo = d[`${side}Logo`] || '';
  if (crest._logo !== logo) {
    crest._logo = logo;
    crest.style.backgroundImage = logo ? `url("${logo}")` : 'none';
  }
  crest.classList.toggle('has-logo', Boolean(logo));
  crest.classList.toggle('on-circle', Boolean(logo) && Boolean(d[`${side}LogoCircle`]));
  crest.style.backgroundColor = logo ? '' : d[`${side}Color`];
  crest.style.color = textOn(d[`${side}Color`]);
  crest.textContent = logo ? '' : d[`${side}Code`];
}

const RENDER = {
  'ultima-hora'(d, root) {
    applyPhoto($('[data-photo]', root), d, 'photo');
    const label = $('.label-flash', root);
    label.textContent = d.label.trim();
    label.hidden = !d.label.trim();
    fitWidth(label, 28);
    const headline = $('.headline', root);
    const text = multiline(d.headline);
    headline.innerHTML = withHighlight(text, d.highlight);
    sizeText(headline, d.headlineSize, text, 3, 72);
    const source = d.source.trim();
    $('.meta', root).textContent = source ? `${d.status} · FUENTE: ${source}` : d.status;
  },

  declaraciones(d, root) {
    const photo = $('[data-photo]', root);
    applyPhoto(photo, d, 'photo');
    photo.classList.toggle('mono', Boolean(d.photoMono));   // "Black & white filter" checkbox
    const body = multiline(d.quote).replace(/^[«"“'‘]+|[»"”'’]+$/g, '').trim();
    const quote = $('.quote-text', root);
    quote.textContent = body ? `«${body}»` : '';
    sizeText(quote, d.quoteSize, body, 6, 36);
    $('.q-name', root).textContent = d.name;
    const context = $('.q-context', root);
    context.textContent = d.context;
    context.hidden = !d.context.trim();
  },

  'en-juego'(d, root) {
    $('.ej-photos', root).dataset.layout = d.layout === 'split' ? 'split' : 'single';
    for (const box of $$('[data-photo]', root)) applyPhoto(box, d, box.dataset.photo);
    const label = $('.ej-label', root);
    label.textContent = d.label.trim();
    label.hidden = !d.label.trim();
    const headline = $('.headline', root);
    const text = multiline(d.headline);
    headline.innerHTML = withHighlight(text, d.highlight);
    sizeText(headline, d.headlineSize, text, 3, 72);
    const meta = $('.meta', root);
    meta.textContent = d.context;
    meta.hidden = !d.context.trim();
    const credit = d.credit.trim();
    $('.ej-credit', root).textContent = credit ? `Foto: ${credit}` : '';
  },

  resultado(d, root) {
    $('.competition', root).textContent = d.competition;
    $('.match-state', root).textContent = d.state;

    const goals = {};
    for (const side of ['home', 'away']) {
      const row = $(`.team-row[data-side="${side}"]`, root);
      applyCrest($('.crest', row), d, side);
      const name = $('.team-name', row);
      name.textContent = d[`${side}Name`];
      fitWidth(name, 36);
      $('.score', row).textContent = d[`${side}Score`];
      goals[side] = parseInt(d[`${side}Score`], 10);

      const line = $(`.scorers [data-side="${side}"]`, root);
      $('b', line).textContent = d[`${side}Code`];
      $('span', line).textContent = d[`${side}Scorers`];
      line.hidden = !d[`${side}Scorers`].trim();
    }

    // Winner: yellow bar + white text; loser grey; draw: both white
    let winner = d.winner === 'home' || d.winner === 'away' ? d.winner : null;
    if (!winner && Number.isFinite(goals.home) && Number.isFinite(goals.away) && goals.home !== goals.away) {
      winner = goals.home > goals.away ? 'home' : 'away';
    }
    for (const row of $$('.team-row', root)) {
      row.classList.toggle('is-winner', row.dataset.side === winner);
      row.classList.toggle('is-loser', Boolean(winner) && row.dataset.side !== winner);
    }

    // Stats: bar = home share of the two numbers
    for (const stat of $$('.stat', root)) {
      const i = stat.dataset.stat;
      const home = d[`stat${i}Home`], away = d[`stat${i}Away`];
      const [vHome, vAway] = $$('.v', stat);
      vHome.textContent = home;
      vAway.textContent = away;
      $('.stat-label', stat).textContent = d[`stat${i}Label`];
      stat.hidden = !d[`stat${i}Label`].trim();
      const a = parseFloat(home.replace(',', '.')) || 0;
      const b = parseFloat(away.replace(',', '.')) || 0;
      $('.fill', stat).style.width = `${(a + b > 0 ? a / (a + b) : 0.5) * 100}%`;
    }

    const source = d.source.trim();
    $('.source', root).textContent = source ? `Datos: ${source}` : '';
  },
};

function render(tpl) {
  RENDER[tpl](state.data[tpl], canvasOf(tpl));
  syncControls(tpl);
}

/* ---------- Forms ---------- */
function setThumb(img, src) {
  if (!img || img._src === src) return;
  img._src = src;
  img.hidden = !src;
  if (src) img.src = src;
  else img.removeAttribute('src');
}

function refreshForm(tpl) {
  const form = formOf(tpl);
  const d = state.data[tpl];
  for (const el of $$('[data-count]', form)) {
    const n = wordCount(d[el.dataset.count]);
    const max = Number(el.dataset.max);
    el.textContent = `${n} ${n === 1 ? 'word' : 'words'} · max ~${max}`;
    el.classList.toggle('over', n > max);
  }
  for (const btn of $$('[data-photo-pick]', form)) setThumb($('img', btn), d[btn.dataset.photoPick]);
  for (const btn of $$('[data-logo-pick]', form)) setThumb($('img', btn), d[`${btn.dataset.logoPick}Logo`]);
  for (const el of $$('[data-split-only]', form)) el.hidden = d.layout !== 'split';
}

function fillForm(tpl) {
  const d = state.data[tpl];
  for (const el of formOf(tpl).elements) {
    if (!el.name || !(el.name in d)) continue;
    if (el.type === 'checkbox') el.checked = Boolean(d[el.name]);
    else el.value = d[el.name];
  }
  refreshForm(tpl);
}

// Sliders and their readouts follow the design: after dragging the photo, scroll-zooming,
// or auto-fit (in Auto mode the size slider shows the size auto-fit picked)
function syncControls(tpl) {
  const form = formOf(tpl);
  const d = state.data[tpl];
  for (const el of $$('input[type="range"][name]', form)) {
    let value = toNum(d[el.name], NaN);
    let text = '';
    if (el.dataset.sizeOf) {
      const auto = !(value > 0);
      if (auto) value = Math.round(parseFloat(getComputedStyle($(el.dataset.sizeOf, canvasOf(tpl))).fontSize));
      text = auto ? `Auto · ${value} px` : `${value} px`;
      const autoBox = $(`[data-auto-size="${el.name}"]`, form);
      if (autoBox) autoBox.checked = auto;
    } else if (el.name.endsWith('Zoom')) {
      text = `${Math.round(value)}%`;
    }
    if (Number.isFinite(value) && Number(el.value) !== value) el.value = value;
    const out = $('.val', el.closest('.field'));
    if (out) {
      out.textContent = text;
      el.setAttribute('aria-valuetext', text);
    }
  }
}

// "Auto-fit" ticked: let the text shrink to fit again. Unticked: keep the current size, now fixed.
document.addEventListener('change', e => {
  const key = e.target.dataset?.autoSize;
  if (!key) return;
  const tpl = e.target.closest('form[data-form]').dataset.form;
  const slider = formOf(tpl).elements[key];
  const current = parseFloat(getComputedStyle($(slider.dataset.sizeOf, canvasOf(tpl))).fontSize);
  state.data[tpl][key] = e.target.checked ? '' : String(Math.round(current));
  persist();
  render(tpl);
});

document.addEventListener('input', e => {
  const el = e.target;
  const form = el.closest?.('form[data-form]');
  if (!form || !el.name) return;
  const tpl = form.dataset.form;
  state.data[tpl][el.name] = el.type === 'checkbox' ? el.checked : el.value;
  persist();
  render(tpl);
  refreshForm(tpl);
});

// Team picked or typed: reuse its saved code/color/logo, otherwise suggest a code
function onTeamNameChange(side) {
  const d = state.data.resultado;
  const k = suffix => `${side}${suffix}`;
  const name = d[k('Name')].trim();
  const known = teamIndex.get(teamKey(name));
  const fresh = d[k('LogoFresh')];   // a logo dropped just before typing the name stays
  if (known) {
    Object.assign(d, { [k('Name')]: known.name, [k('Code')]: known.code, [k('Color')]: known.color });
    if (!fresh) Object.assign(d, { [k('Logo')]: known.logo || '', [k('LogoCircle')]: Boolean(known.logoCircle) });
  } else {
    const code = deriveCode(name);
    if (code !== d[k('Code')]) {
      Object.assign(d, { [k('Code')]: code, [k('Color')]: NEUTRAL_COLOR });
      if (!fresh) Object.assign(d, { [k('Logo')]: '', [k('LogoCircle')]: false });
    }
  }
  d[k('LogoFresh')] = false;
  fillForm('resultado');
  persist();
  render('resultado');
}

document.addEventListener('change', e => {
  const m = /^(home|away)Name$/.exec(e.target.name || '');
  if (m && e.target.closest('form[data-form="resultado"]')) onTeamNameChange(m[1]);
});

$$('form[data-form]').forEach(form => form.addEventListener('submit', e => e.preventDefault()));

/* ---------- Images: photos and club logos ---------- */
const fileInput = $('#file-input');
let pickTarget = null;                      // { kind: 'photo', tpl, key } | { kind: 'logo', side }
let lastSide = 'home';                      // team you're editing (for pasted logos)
const lastSlot = { 'en-juego': 'photo' };   // photo you last touched (for pasted photos)

function activeSlots(tpl) {
  const slots = Object.keys(PHOTO_SLOTS[tpl] || {});
  return tpl === 'en-juego' && state.data[tpl].layout !== 'split' ? ['photo'] : slots;
}

function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  return img.decode().then(() => img).finally(() => URL.revokeObjectURL(url));
}

// Photos: enough pixels to cover the area with room to zoom in (when the original has them),
// pixel- and size-capped so drafts and exports stay light
async function preparePhoto(file, minW, minH) {
  const img = await loadImage(file);
  const w = img.naturalWidth || minW, h = img.naturalHeight || minH;
  const cover = Math.max(minW / w, minH / h);
  const k = Math.max(Math.min(1, cover), Math.min(1, cover * PHOTO_HEADROOM, Math.sqrt(MAX_PHOTO_PIXELS / (w * h))));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#161B22';   // transparent PNGs get the brand background, not black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  let url = '';
  for (const quality of [0.88, 0.82, 0.76, 0.7, 0.64]) {
    url = canvas.toDataURL('image/jpeg', quality);
    if (url.length * 0.75 <= MAX_PHOTO_BYTES) break;
  }
  return url;
}

// Logos: keep transparency, trim empty margins, max 256 px
async function prepareLogo(file) {
  const img = await loadImage(file);
  const w = img.naturalWidth || 512, h = img.naturalHeight || 512;
  const k0 = Math.min(1, 512 / Math.max(w, h));
  const work = document.createElement('canvas');
  work.width = Math.max(1, Math.round(w * k0));
  work.height = Math.max(1, Math.round(h * k0));
  const wctx = work.getContext('2d', { willReadFrequently: true });
  wctx.imageSmoothingQuality = 'high';
  wctx.drawImage(img, 0, 0, work.width, work.height);

  const { data } = wctx.getImageData(0, 0, work.width, work.height);
  let x0 = work.width, y0 = work.height, x1 = -1, y1 = -1, transparent = false;
  for (let y = 0; y < work.height; y++) {
    for (let x = 0; x < work.width; x++) {
      const alpha = data[(y * work.width + x) * 4 + 3];
      if (alpha < 250) transparent = true;
      if (alpha > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('empty image');
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const k = Math.min(1, 256 / Math.max(bw, bh));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(bw * k));
  out.height = Math.max(1, Math.round(bh * k));
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(work, x0, y0, bw, bh, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL('image/png'), transparent };
}

// Back to the default position and 100% zoom
function resetFrame(tpl, key) {
  for (const suffix of ['X', 'Y', 'Zoom']) state.data[tpl][key + suffix] = DEFAULTS[tpl][key + suffix];
}

async function usePhoto(file, tpl, key = 'photo') {
  const size = PHOTO_SLOTS[tpl]?.[key];
  if (!size) return;
  if (!file?.type.startsWith('image/')) return toast('That file is not an image.', 'error');
  try {
    state.data[tpl][key] = await preparePhoto(file, ...size);
  } catch (_) {
    return toast('This image could not be opened. Try a JPG or PNG.', 'error');
  }
  resetFrame(tpl, key);   // a new photo starts unzoomed and centered
  if (tpl in lastSlot) lastSlot[tpl] = key;
  persist();
  render(tpl);
  refreshForm(tpl);
}

async function useLogo(file, side) {
  if (!file?.type.startsWith('image/')) return toast('That file is not an image.', 'error');
  const d = state.data.resultado;
  let logo;
  try {
    logo = await prepareLogo(file);
  } catch (_) {
    return toast('This logo could not be opened. Try a PNG.', 'error');
  }
  d[`${side}Logo`] = logo.dataUrl;
  d[`${side}LogoFresh`] = true;
  if (!logo.transparent) d[`${side}LogoCircle`] = true;   // JPG or solid background: show it on white
  lastSide = side;
  fillForm('resultado');
  persist();
  render('resultado');
}

function useImage(file, target) {
  if (!target) return;
  if (target.kind === 'logo') useLogo(file, target.side);
  else usePhoto(file, target.tpl, target.key);
}

function pick(target) {
  pickTarget = target;
  fileInput.click();
}
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (file) useImage(file, pickTarget);
});

// Where a drop or paste on the preview should go
function previewTarget(e) {
  const tpl = state.active;
  if (tpl === 'resultado') {
    const row = e?.target?.closest?.('.team-row');
    return { kind: 'logo', side: row ? row.dataset.side : lastSide };
  }
  const slots = activeSlots(tpl);
  if (!slots.length) return null;
  if (slots.length === 1) return { kind: 'photo', tpl, key: slots[0] };
  const box = e?.target?.closest?.('[data-photo]');
  if (box) return { kind: 'photo', tpl, key: box.dataset.photo };
  const r = canvasOf(tpl).getBoundingClientRect();
  return { kind: 'photo', tpl, key: e.clientX < r.left + r.width / 2 ? 'photo' : 'photo2' };
}

function formTarget(btn) {
  if (btn.dataset.logoPick) return { kind: 'logo', side: btn.dataset.logoPick };
  return { kind: 'photo', tpl: btn.closest('form').dataset.form, key: btn.dataset.photoPick };
}

function makeDropTarget(el, resolve) {
  el.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('Files') || !resolve(e)) return;
    e.preventDefault();
    el.classList.add('drag');
  });
  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drag');
  });
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('drag');
    const file = e.dataTransfer.files[0];
    if (file) useImage(file, resolve(e));
  });
}

for (const btn of $$('[data-photo-pick], [data-logo-pick]')) {
  btn.addEventListener('click', () => pick(formTarget(btn)));
  makeDropTarget(btn, () => formTarget(btn));
}
makeDropTarget($('#preview'), previewTarget);
// A file dropped anywhere else must not replace the app with the image
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

/* ---------- Photo framing in the preview ----------
   Mouse: drag to move, scroll to zoom. Touch: one finger moves, two fingers pinch-zoom.
   The point of the photo you grab stays under your mouse/fingers while you move and zoom. */

// Preview screen pixels per design pixel (the preview is scaled down to fit the window)
function previewScale(tpl) {
  const canvas = canvasOf(tpl);
  return canvas.getBoundingClientRect().width / canvas.offsetWidth || 1;
}

// The photo (with a loaded image) under a screen point in the visible template
function photoAt(x, y) {
  const canvas = canvasOf(state.active);
  return document.elementsFromPoint(x, y).find(el => el.matches?.('[data-photo]') && canvas.contains(el) && el._size) || null;
}

function gestureStart(box, at) {
  return { at, view: { ...box._view }, g: photoGeometry(box), rect: box.getBoundingClientRect(), scale: previewScale(state.active) };
}

// New framing: the photo point that was under `start.at` moves to `to`, zoomed by `factor`
function frameGesture(box, start, to, factor) {
  const tpl = state.active, key = box.dataset.photo, d = state.data[tpl];
  const { g, rect, scale, view } = start;
  const z0 = view.zoom * 100;
  const z1 = clamp(z0 * factor, ZOOM_MIN, ZOOM_MAX);
  const f = z1 / z0;
  const axis = (p, size, img, from, now) => {
    const slack1 = size - img * f;            // room to move: < 0 photo overhangs its area, > 0 it's smaller
    if (Math.abs(slack1) <= 0.5) return p;    // fits exactly on this axis: nothing to position
    const edge0 = (size - img) * p / 100;     // where the photo's edge was
    return clamp(((now - (from - edge0) * f) / slack1) * 100, 0, 100);
  };
  d[`${key}X`] = axis(view.x, g.bw, g.iw, (start.at.x - rect.left) / scale, (to.x - rect.left) / scale).toFixed(2);
  d[`${key}Y`] = axis(view.y, g.bh, g.ih, (start.at.y - rect.top) / scale, (to.y - rect.top) / scale).toFixed(2);
  if (f !== 1) d[`${key}Zoom`] = z1.toFixed(2);
  applyPhoto(box, d, key);
  syncControls(tpl);
}

const gesture = { pointers: new Map(), box: null, start: null };

function gestureCenter() {
  let x = 0, y = 0;
  for (const p of gesture.pointers.values()) { x += p.x; y += p.y; }
  return { x: x / gesture.pointers.size, y: y / gesture.pointers.size };
}
function gestureSpread() {
  const [a, b] = [...gesture.pointers.values()];
  return b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}
// Fingers added or lifted: continue from the current framing
function gestureRestart() {
  gesture.start = gesture.pointers.size ? { ...gestureStart(gesture.box, gestureCenter()), spread: gestureSpread() } : null;
}

const preview = $('#preview');
preview.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (!gesture.box) {
    if (e.target.closest?.('.headline')) return;   // tap/click a word to make it yellow
    const box = photoAt(e.clientX, e.clientY);
    if (!box) return;                              // empty photo area: the click opens the file picker
    gesture.box = box;
    box.classList.add('panning');
  }
  e.preventDefault();
  preview.setPointerCapture(e.pointerId);
  gesture.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gestureRestart();
});
preview.addEventListener('pointermove', e => {
  if (!gesture.start || !gesture.pointers.has(e.pointerId)) return;
  gesture.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const pinch = gesture.pointers.size > 1 && gesture.start.spread > 0;
  frameGesture(gesture.box, gesture.start, gestureCenter(), pinch ? gestureSpread() / gesture.start.spread : 1);
});
const gestureEnd = e => {
  if (!gesture.pointers.delete(e.pointerId)) return;
  if (gesture.pointers.size) return gestureRestart();
  gesture.box.classList.remove('panning');
  gesture.box = gesture.start = null;
  persist();
};
preview.addEventListener('pointerup', gestureEnd);
preview.addEventListener('pointercancel', gestureEnd);

preview.addEventListener('wheel', e => {
  const box = PHOTO_SLOTS[state.active] && photoAt(e.clientX, e.clientY);
  if (!box) return;
  e.preventDefault();
  const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  const at = { x: e.clientX, y: e.clientY };
  frameGesture(box, gestureStart(box, at), at, Math.exp(-delta * 0.0015));
  persist();
}, { passive: false });

// Empty photo area: click/tap to choose a file
for (const box of $$('[data-photo]')) {
  box.addEventListener('click', () => {
    if (!box.classList.contains('has-photo')) pick({ kind: 'photo', tpl: state.active, key: box.dataset.photo });
  });
}

for (const row of $$('#tpl-resultado .team-row')) {
  $('.crest', row).addEventListener('click', () => pick({ kind: 'logo', side: row.dataset.side }));
}

for (const btn of $$('[data-photo-remove]')) {
  btn.addEventListener('click', () => {
    const tpl = btn.closest('form').dataset.form;
    state.data[tpl][btn.dataset.photoRemove] = '';
    persist();
    render(tpl);
    refreshForm(tpl);
  });
}
for (const btn of $$('[data-photo-reset]')) {
  btn.addEventListener('click', () => {
    const tpl = btn.closest('form').dataset.form;
    resetFrame(tpl, btn.dataset.photoReset);
    persist();
    render(tpl);
  });
}
for (const btn of $$('[data-logo-remove]')) {
  btn.addEventListener('click', () => {
    const side = btn.dataset.logoRemove;
    Object.assign(state.data.resultado, { [`${side}Logo`]: '', [`${side}LogoCircle`]: false, [`${side}LogoFresh`]: false });
    fillForm('resultado');
    persist();
    render('resultado');
  });
}

// Remember which team / photo you're working on, for pasted images
const trackContext = e => {
  const side = e.target.closest?.('fieldset[data-side]');
  if (side) lastSide = side.dataset.side;
  const slot = e.target.closest?.('.slot[data-slot]');
  if (slot) lastSlot['en-juego'] = slot.dataset.slot;
};
document.addEventListener('focusin', trackContext);
document.addEventListener('pointerdown', trackContext);

// Ctrl+V with an image on the clipboard (e.g. "Copy image" from a website)
document.addEventListener('paste', e => {
  const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
  if (!file) return;
  const typing = e.target.matches?.('input[type="text"], textarea') && e.clipboardData.types.includes('text/plain');
  if (typing) return;
  const tpl = state.active;
  if (tpl === 'resultado') {
    e.preventDefault();
    useLogo(file, lastSide);
    return;
  }
  const slots = activeSlots(tpl);
  if (!slots.length) return;
  e.preventDefault();
  const empty = slots.find(key => !state.data[tpl][key]);
  usePhoto(file, tpl, empty || (slots.includes(lastSlot[tpl]) ? lastSlot[tpl] : slots[0]));
});

/* ---------- Click a headline word to make it yellow ---------- */
for (const headline of $$('#tpl-ultima-hora .headline, #tpl-en-juego .headline')) {
  headline.addEventListener('click', e => {
    e.stopPropagation();
    const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    const range = pos ? null : document.caretRangeFromPoint?.(e.clientX, e.clientY);
    const node = pos ? pos.offsetNode : range?.startContainer;
    const offset = pos ? pos.offset : range?.startOffset;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent;
    let a = offset, b = offset;
    while (a > 0 && isWordChar(text[a - 1])) a--;
    while (b < text.length && isWordChar(text[b])) b++;
    const word = text.slice(a, b);
    if (!word) return;
    const tpl = headline.closest('.canvas').id.replace('tpl-', '');
    const d = state.data[tpl];
    d.highlight = upper(d.highlight.trim()) === upper(word) ? '' : word;   // click again to remove
    formOf(tpl).elements.highlight.value = d.highlight;
    persist();
    render(tpl);
  });
}

/* ---------- Tabs + preview scaling ---------- */
function layout() {
  const stage = $(`[data-stage="${state.active}"]`);
  const canvas = stage.firstElementChild;
  const cs = getComputedStyle(preview);
  const w = preview.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = preview.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const s = clamp(Math.min(w / canvas.offsetWidth, h / canvas.offsetHeight), 0.1, 1);
  canvas.style.transform = `scale(${s})`;
  stage.style.width = `${canvas.offsetWidth * s}px`;
  stage.style.height = `${canvas.offsetHeight * s}px`;
}

// Phone layout: the preview sticks under the top bar, so it needs the bar's height
const topbar = $('.topbar');
new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`)).observe(topbar);

// While typing on the phone the keyboard takes half the screen: the CSS shrinks the preview
const isTextField = el => Boolean(el?.matches?.('input[type="text"], textarea'));
document.addEventListener('focusin', e => {
  if (isTextField(e.target)) document.body.classList.add('typing');
});
document.addEventListener('focusout', () => setTimeout(() => {
  if (!isTextField(document.activeElement)) document.body.classList.remove('typing');
}, 0));

function activate(tpl) {
  state.active = tpl;
  for (const tab of $$('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.tab === tpl));
  for (const form of $$('form[data-form]')) form.hidden = form.dataset.form !== tpl;
  for (const stage of $$('[data-stage]')) stage.hidden = stage.dataset.stage !== tpl;
  render(tpl);
  layout();
  persist();
}

$$('.tab').forEach(tab => tab.addEventListener('click', () => activate(tab.dataset.tab)));
new ResizeObserver(layout).observe(preview);

/* ---------- PNG export ---------- */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// The local fonts, embedded once so every PNG uses the real Anton/Montserrat
let fontCssPromise = null;
function getFontCss() {
  fontCssPromise ??= (async () => {
    const cssUrl = new URL('vendor/fonts.css', location.href);
    let css = await (await fetch(cssUrl)).text();
    const urls = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map(m => m[1]))];
    for (const u of urls) {
      const res = await fetch(new URL(u.replace(/["']/g, ''), cssUrl));
      if (!res.ok) throw new Error(`font file missing: ${u}`);
      css = css.split(`url(${u})`).join(`url(${await blobToDataUrl(await res.blob())})`);
    }
    return css;
  })().catch(err => { fontCssPromise = null; throw err; });
  return fontCssPromise;
}

async function renderPng(node) {
  if (!window.htmlToImage) throw new Error('vendor/html-to-image.js did not load.');
  await document.fonts.ready;
  await Promise.all($$('[data-photo]', node).map(box => box._ready));   // photo zoom needs their sizes
  try {
    const blob = await window.htmlToImage.toBlob(node, {
      width: node.offsetWidth,
      height: node.offsetHeight,
      pixelRatio: 1,                    // 1 design pixel = 1 image pixel (1080×1350)
      style: { transform: 'none' },     // ignore the preview zoom
      fontEmbedCSS: await getFontCss(),
      // Skip editor-only elements, and HTML comments (they would break the SVG step)
      filter: n => n.nodeType !== Node.COMMENT_NODE && !(n.classList && n.classList.contains('no-export')),
    });
    if (!blob) throw new Error('PNG encoding failed.');
    return blob;
  } catch (err) {
    // The library rejects with a bare browser Event when the image can't be drawn
    if (err instanceof Event) throw new Error('the browser could not draw the design.');
    throw err;
  }
}

/* ---------- Generate ----------
   PC Studio: render → copy to clipboard → server.py saves it into output/<date>/.
   Phone app (or any other server): render → result sheet with Share / Save / Copy. */
const SLUG = {
  'ultima-hora': d => d.headline.split(/\s+/).slice(0, 6).join(' '),
  declaraciones: d => d.name,
  'en-juego': d => d.headline.split(/\s+/).slice(0, 6).join(' '),
  resultado: d => `${d.homeCode} ${d.homeScore} ${d.awayScore} ${d.awayCode}`,
};

const slugify = s => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');

function fileName(tpl) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const slug = slugify(SLUG[tpl](state.data[tpl]));
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `futbol-flash-${tpl}${slug ? `-${slug}` : ''}-${stamp}.png`;
}

function copyImage(pngPromise) {
  if (!navigator.clipboard?.write || !window.ClipboardItem) return Promise.resolve(false);
  try {
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]).then(() => true, () => false);
  } catch (_) {
    return Promise.resolve(false);
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// PC Studio: server.py writes the PNG into output/<date>/
async function saveToStudio(blob, tpl) {
  const slug = SLUG[tpl](state.data[tpl]);
  let res;
  try {
    res = await fetch(`api/save?template=${encodeURIComponent(tpl)}&slug=${encodeURIComponent(slug)}`, {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob,
    });
  } catch (_) {
    downloadBlob(blob, fileName(tpl));   // server stopped meanwhile: fall back to a normal download
    return 'to your Downloads folder (the Studio server is not running)';
  }
  const info = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(info.error || `server error ${res.status}`);
  return `in ${info.saved}`;
}

/* ---------- Result sheet: Share / Save / Copy (phone app) ---------- */
const resultDialog = $('#result');
const result = { blob: null, file: null, url: '' };
const touchUi = matchMedia('(pointer: coarse)');

function openResult(blob, tpl) {
  if (result.url) URL.revokeObjectURL(result.url);
  result.blob = blob;
  result.file = new File([blob], fileName(tpl), { type: 'image/png' });
  result.url = URL.createObjectURL(blob);
  $('#result-img').src = result.url;
  let canShare = false;
  try { canShare = Boolean(navigator.canShare?.({ files: [result.file] })); } catch (_) { /* not supported */ }
  $('[data-result="share"]').hidden = !canShare;
  // Copy is for the desktop (paste with Ctrl+V); on the phone Share does that job
  $('[data-result="copy"]').hidden = touchUi.matches || !(navigator.clipboard?.write && window.ClipboardItem);
  $('#result-hint').textContent = canShare
    ? 'Share opens your share menu: pick Facebook to post it. Save keeps a copy on this device.'
    : 'Save downloads the PNG to this device.';
  if (!resultDialog.open) resultDialog.showModal();
}

resultDialog.addEventListener('close', () => {
  if (result.url) URL.revokeObjectURL(result.url);
  result.url = '';
  $('#result-img').removeAttribute('src');
});

$('[data-result="share"]').addEventListener('click', async () => {
  try {
    await navigator.share({ files: [result.file] });
  } catch (err) {
    if (err.name !== 'AbortError') toast(`Could not share: ${err.message}`, 'error');
  }
});
$('[data-result="save"]').addEventListener('click', () => {
  downloadBlob(result.blob, result.file.name);
  toast(touchUi.matches ? 'Saved to Downloads: Gallery and Google Photos show it there.' : `Downloaded ${result.file.name}`);
});
$('[data-result="copy"]').addEventListener('click', async () => {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': result.blob })]);
    toast('Copied: paste it into the post with Ctrl+V.');
  } catch (_) {
    toast('This browser can\'t copy images. Use Save instead.', 'error');
  }
});

let busy = false;
async function generate() {
  if (busy || resultDialog.open) return;
  busy = true;
  const tpl = state.active;
  const btn = $('#btn-generate');
  const label = $('.btn-label', btn);
  btn.disabled = true;
  label.textContent = 'Rendering…';
  const mode = MODE !== 'unknown' ? MODE : await backend;
  const png = renderPng(canvasOf(tpl));
  try {
    if (mode === 'studio') {
      const copied = copyImage(png);   // must start inside the click/keypress to be allowed
      const where = await saveToStudio(await png, tpl);
      toast(`Saved ${where}${(await copied) ? ' · Copied: press Ctrl+V in the Facebook post box' : ''}`);
    } else {
      openResult(await png, tpl);
    }
    if (tpl === 'resultado') {
      rememberTeams().catch(err => toast(`PNG created, but the team library was not updated: ${err.message}`, 'error'));
    }
  } catch (err) {
    console.error(err);
    toast(`Could not create the PNG: ${err.message}`, 'error');
  } finally {
    busy = false;
    btn.disabled = false;
    label.textContent = 'Generate PNG';
  }
}

$('#btn-generate').addEventListener('click', generate);
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    generate();
  }
});

$('#btn-folder').addEventListener('click', async () => {
  try {
    const res = await fetch('api/open-folder', { method: 'POST' });
    if (!res.ok) throw new Error();
  } catch (_) {
    toast('Could not open the folder. Is the Studio server running?', 'error');
  }
});

$('#btn-reset').addEventListener('click', () => {
  const tpl = state.active;
  if (!confirm('Reset this template to the example content? Its photos and logos will be removed.')) return;
  state.data[tpl] = { ...DEFAULTS[tpl] };
  fillForm(tpl);
  render(tpl);
  persist();
});

// Team library: Export / Import (to move it between the PC and the phone)
const teamsInput = $('#teams-input');
$('#btn-teams-export').addEventListener('click', exportTeams);
$('#btn-teams-import').addEventListener('click', () => teamsInput.click());
teamsInput.addEventListener('change', () => {
  const file = teamsInput.files[0];
  teamsInput.value = '';
  if (file) importTeams(file);
});

/* ---------- Start ---------- */
if (location.protocol === 'file:') {
  toast('Open the Studio with "Start Futbol Flash.bat" so your PNGs can be saved.', 'error');
}
Object.keys(DEFAULTS).forEach(fillForm);
activate(state.active);
loadTeamLibrary();
document.fonts.ready.then(() => render(state.active));   // re-fit once the fonts are ready

backend.then(mode => {
  $('#btn-folder').hidden = mode !== 'studio';
  // Phone app: keep a copy of the app on the device so it opens and works offline.
  // (Not on the PC Studio, where it would keep serving old files after an update.)
  if (mode !== 'studio' && 'serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Offline mode unavailable:', err));
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('Fútbol Flash Studio was updated: close and reopen it to use the new version.');
    });
  }
});
