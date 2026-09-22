'use strict';
// ---------- utils
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = n => String(n).padStart(2, '0');
const lc = s => (/^(Panera|DoorDash)/.test(s) ? s : s[0].toLowerCase() + s.slice(1));
const round5 = m => Math.max(5, Math.round(m / 5) * 5);

function fmtClock(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440, h = Math.floor(m / 60), mm = m % 60;
  return (h % 12 || 12) + (mm ? ':' + pad(mm) : '') + (h < 12 ? 'a' : 'p');
}
const fmtTime = ts => { const d = new Date(ts); return fmtClock(d.getHours() * 60 + d.getMinutes()); };
function fmtDur(min) {
  min = Math.round(min);
  if (min < 60) return min + 'm';
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function fmtAgo(ts) {
  if (!ts) return 'never';
  const m = (Date.now() - ts) / MIN;
  if (m < 60) return Math.max(1, Math.round(m)) + 'm ago';
  if (m < 48 * 60) return Math.round(m / 60) + 'h ago';
  return Math.round(m / 1440) + 'd ago';
}
// "day" rolls over at 4am so late nights belong to the day before
const dayKey = (ts = Date.now()) => { const d = new Date(ts - 4 * HOUR); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// ---------- storage
const store = {
  get(k, d) { try { const v = localStorage.getItem('hj.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hj.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('hj.' + k); } catch {} },
};
const DEFAULT_STATE = {
  settings: { theme: 'auto', maps: 'gapp', club: true, tent: true, hotel: false, name: '', autotrack: true, alist: true },
  fav: {}, avoid: {}, obs: [], last: {}, nights: [], days: {}, log: [], wishes: [], mine: [],
  workout: 0, supplies: {}, zone: null, zoneT: 0, loc: null,
};
let S = Object.assign(structuredClone(DEFAULT_STATE), store.get('state', {}));
S.settings = Object.assign({}, DEFAULT_STATE.settings, S.settings);
let saveT;
// save() = a real change (stamped + synced); saveQuiet() = local-only bookkeeping like GPS fixes (no sync, no stamp)
function save() { S.updatedAt = Date.now(); clearTimeout(saveT); saveT = setTimeout(() => { store.set('state', S); syncSoon(); }, 120); }
function saveQuiet() { clearTimeout(saveT); saveT = setTimeout(() => store.set('state', S), 400); }
function saveNow() { clearTimeout(saveT); store.set('state', S); }

// ---------- sync: user state <-> private GitHub repo (contents API). Local-first; the repo is the backup + source for rebuilds.
const sync = { sha: null, busy: false, t: null, last: store.get('syncLast', 0), err: null, dirty: false };
const SYNC_SKIP = ['loc'];   // don't commit GPS pings
const u8b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const toB64 = str => u8b64(new TextEncoder().encode(str));
const fromB64 = b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, '')), c => c.charCodeAt(0)));
function ghApi(method, body, path) {
  const s = D?.sync;
  return fetch(`https://api.github.com/repos/${s.repo}/contents/${path || s.path}`, {
    method, cache: 'no-store', body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
}
function syncSoon(ms = 15000) { if (!D?.sync) return; sync.dirty = true; clearTimeout(sync.t); sync.t = setTimeout(syncPush, ms); }
// append-only lists merge by id / time so two devices (or a stale phone) never lose notes, logs or nights.
// Removals are tombstones ({del: time}) so a merge can't resurrect them; for the same key the removed / most recently edited copy wins.
function mergeState(remote) {
  const ver = x => Math.max(x.del || 0, x.u || 0, x.t || 0);
  const byKey = (a, b, k) => {
    const m = new Map();
    for (const x of [...(a || []), ...(b || [])]) { if (!x) continue; const key = k(x), prev = m.get(key); if (!prev || (x.del && !prev.del) || (!prev.del && ver(x) > ver(prev))) m.set(key, x); }
    return [...m.values()].sort((x, y) => (x.t || 0) - (y.t || 0));
  };
  const newer = (remote.updatedAt || 0) > (S.updatedAt || 0) ? remote : S;
  const out = { ...structuredClone(DEFAULT_STATE), ...newer, loc: S.loc };
  out.obs = byKey(S.obs, remote.obs, x => x.id);
  out.log = byKey(S.log, remote.log, x => x.id);
  out.nights = byKey(S.nights, remote.nights, x => x.poi + '|' + (x.day || x.t));
  out.wishes = byKey(S.wishes, remote.wishes, x => x.area + x.t);
  out.mine = byKey(S.mine, remote.mine, x => x.id);
  // days: the newer state wins per date; a cleared day is a tombstone so the older copy can't come back
  out.days = { ...(newer === S ? remote.days : S.days), ...newer.days };
  return out;
}
const alive = arr => (arr || []).filter(x => !x.del);
// remove tonight's (or any day's) logged night without letting a sync merge bring it back
function dropNights(pred) { for (const n of S.nights) if (!n.del && pred(n)) n.del = Date.now(); }
async function syncPull() {
  if (!D?.sync) return false;
  try {
    const r = await ghApi('GET');
    if (!r.ok) throw new Error('pull ' + r.status);
    const j = await r.json();
    sync.sha = j.sha;
    const remote = JSON.parse(fromB64(j.content || '') || '{}');
    if (remote.updatedAt && remote.updatedAt !== S.updatedAt) { S = mergeState(remote); S.settings = Object.assign({}, DEFAULT_STATE.settings, S.settings); sanitize(); mountMine(); store.set('state', S); return true; }
    sync.err = null;
  } catch (e) { sync.err = e.message; }
  return false;
}
async function syncPush() {
  if (!D?.sync || sync.busy) return;
  sync.busy = true; clearTimeout(sync.t);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = JSON.stringify(S, (k, v) => (SYNC_SKIP.includes(k) ? undefined : v), 1);
      if (!sync.sha) { const g = await ghApi('GET'); if (g.ok) sync.sha = (await g.json()).sha; }
      const r = await ghApi('PUT', { message: `sync ${new Date().toISOString()}`, content: toB64(body + '\n'), sha: sync.sha || undefined });
      if (r.ok) { sync.sha = (await r.json()).content.sha; sync.last = Date.now(); store.set('syncLast', sync.last); sync.err = null; sync.dirty = false; break; }
      if (r.status === 409 || r.status === 422) { sync.sha = null; await syncPull(); continue; }   // changed elsewhere: merge, retry
      throw new Error('push ' + r.status);
    }
  } catch (e) { sync.err = navigator.onLine === false ? 'offline, will retry' : e.message; syncSoon(60000); }
  finally { sync.busy = false; }
}

// ---------- crypto (data.enc = "HJ1" | ver | iter u32 | salt16 | iv12 | AES-GCM(gzip(json)))
const b64 = { enc: u8 => btoa(String.fromCharCode(...u8)), dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)) };
async function fetchEnc() {
  const r = await fetch('data.enc', { cache: 'no-cache' });
  if (!r.ok) throw new Error('data ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
function encParts(buf) {
  if (String.fromCharCode(buf[0], buf[1], buf[2]) !== 'HJ1') throw new Error('bad data file');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return { iter: dv.getUint32(4), salt: buf.slice(8, 24), iv: buf.slice(24, 36), ct: buf.slice(36) };
}
async function keyFromPassword(pw, buf) {
  const { iter, salt } = encParts(buf);
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
}
const importKey = raw => crypto.subtle.importKey('raw', b64.dec(raw), 'AES-GCM', true, ['decrypt']);
async function exportKey(key) { return b64.enc(new Uint8Array(await crypto.subtle.exportKey('raw', key))); }
async function decryptData(buf, key) {
  const { iv, ct } = encParts(buf);
  const gz = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

// ---------- data
let D = null;
const P = {}, Z = {};
function indexPoi(p) {
  P[p.id] = p;
  p.caps ||= {}; p.am ||= []; p.tags ||= []; p.x ||= {};
  p._z = Z[p.z];
  p._ov = D.ovn[p.id]?.[0] || p._ov; p._camp = D.camp[p.id]?.[0]; p._mail = D.mail[p.id]?.[0];
  p._rec = D.rec[p.id]?.[0]; p._food = D.food[p.id]?.[0];
  p._txt = [p.n, p.city, p.a, p.sc, p.c, p.tags.join(' '), p.x.brand, p._z?.n].join(' ').toLowerCase();
}
function indexData(data) {
  D = data;
  for (const z of D.zones) Z[z.id] = z;
  for (const p of D.pois) indexPoi(p);
  // places merged away by a data rebuild still resolve (saved plans, notes, favorites)
  for (const [a, b] of Object.entries(D.alias || {})) if (P[b] && !P[a]) P[a] = P[b];
  // DoorDash market hotspots point at restaurant POIs
  for (const [zid, ms] of Object.entries(D.dd || {})) for (const m of ms) { m.z = zid; for (const s of m.subs || []) if (s.poi && P[s.poi]) P[s.poi]._dd = m; }
  mountMine();
}

// ---------- his own places (added in the app; synced in S.mine, folded into packs on rebuilds)
// kind → how the planner treats it
const MINE_KINDS = {
  hotel: ['🏨', 'Hotel lot (night spot)', 'overnight_candidate', 'hotel', { sleep_candidate: 'r' }, 'hotel_cluster'],
  walmart: ['🛒', 'Walmart lot (night spot)', 'overnight_candidate', 'walmart', { sleep_candidate: 'r', groceries: 'r' }, 'walmart'],
  cracker: ['🪑', 'Cracker Barrel (night spot)', 'overnight_candidate', 'cracker_barrel', { sleep_candidate: 'r', meal: 'r' }, 'cracker_barrel'],
  truck: ['🚛', 'Truck stop (night spot)', 'overnight_candidate', 'truck_stop', { sleep_candidate: 'r', fuel: 'r', restroom: 'r' }, 'truck_stop'],
  lot: ['🅿️', 'Other lot (night spot)', 'overnight_candidate', 'public_lot', { sleep_candidate: 'r' }, 'public_lot'],
  camp: ['⛺', 'Campground', 'camping', 'campground', { tent_camp: 'r', restroom: 'i' }],
  cafe: ['☕', 'Café (work)', 'work', 'independent_cafe', { work_indoor: 'r', wifi: 'i' }],
  kava: ['🍵', 'Kava / tea bar (work)', 'work', 'kava_bar', { work_indoor: 'r' }],
  library: ['📚', 'Library', 'work', 'library', { work_indoor: 'r', wifi: 'r' }],
  water: ['🌊', 'Water spot', 'waterfront', 'park', { work_outdoors: 'r', recreation: 'r' }],
  food: ['🍜', 'Food', 'food', 'local_cheap', { meal: 'r' }],
  pizza: ['🍕', 'Pizza', 'food', 'pizza', { meal: 'r' }],
  bar: ['🍺', 'Bar', 'social', 'dive_bar', {}],
  gym: ['🏋️', 'Gym / shower', 'gym', 'planet_fitness', { gym: 'r', shower: 'r' }],
  run: ['🏃', 'Trail run', 'fun', 'trailhead', { trail_run: 'r', recreation: 'r' }],
  fun: ['🌿', 'Fun / explore', 'fun', 'attraction', { recreation: 'r' }],
  movie: ['🎬', 'Movie theater', 'fun', 'movie_theater', { recreation: 'r' }],
  arcade: ['👾', 'Arcade / barcade', 'fun', 'arcade', { recreation: 'r' }],
  groc: ['🥦', 'Groceries', 'food', 'grocery', { groceries: 'r' }],
  gas: ['⛽', 'Gas', 'life_support', 'gas_station', { fuel: 'r' }],
  laundry: ['🧺', 'Laundromat', 'life_support', 'laundromat', { laundry: 'r' }],
  other: ['📍', 'Other', 'fun', 'other', { recreation: 'i' }],
};
function minePoi(m) {
  const k = MINE_KINDS[m.kind] || MINE_KINDS.other, z = D.zones.length ? nearestZone(m) : null;
  const p = { id: 'u_' + m.id, z: z?.id, n: m.n, c: k[2], sc: k[3], a: m.a || '', city: m.city || '', lat: m.lat, lng: m.lng, gq: 'exact',
    caps: { ...k[4] }, am: [], tags: ['mine', ...({ pizza: ['pizza'], run: ['trail_run'], movie: ['movies'], arcade: ['arcade'] }[m.kind] || [])], tn: m.note || '', q: m.q || [m.n, m.a].filter(Boolean).join(', '),
    x: {}, mine: 1 };
  if (m.h) p.h = m.h;
  if (k[5]) p._ov = { ty: k[5], st: 'uncertain', pr: 'inspect_first', notes: 'Added by you' + (m.note ? ': ' + m.note : '') };
  if (m.kind === 'bar') p.tags.push('social');
  return p;
}
function mountMine() {
  if (!D) return;
  for (const p of D.pois) if (p.mine) delete P[p.id];
  D.pois = D.pois.filter(p => !p.mine);
  for (const m of alive(S.mine)) { if (m.lat == null) continue; const p = minePoi(m); D.pois.push(p); indexPoi(p); }
}
function addMine(place, kind) {
  const m = { id: uid(), t: Date.now(), kind, n: place.n.trim(), a: place.a || '', city: place.city || '', lat: +(+place.lat).toFixed(5), lng: +(+place.lng).toFixed(5), q: place.q, osm: place.osm, note: place.note || '' };
  S.mine.push(m); mountMine(); save();
  return P['u_' + m.id];
}

// ---------- geo
function hav(a, b) {
  const R = 3958.8, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function bearing(a, b) {
  const r = Math.PI / 180, y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((Math.atan2(y, x) / r + 360) % 360) / 45) % 8];
}
const ptOf = p => (p.lat != null ? { lat: p.lat, lng: p.lng } : p._z?.lat != null ? { lat: p._z.lat, lng: p._z.lng, approx: 1 } : null);
const driveMin = mi => (mi < 0.2 ? 0 : round5(4 + (mi * 1.3) / (mi > 25 ? 58 : mi > 8 ? 42 : 27) * 60));
const fmtMi = mi => (mi < 0.1 ? 'here' : mi < 10 ? mi.toFixed(1) + ' mi' : Math.round(mi) + ' mi');
// TV-only zones (South Florida: Guy's / Tony's picks) never count as an everyday planning area
function nearestZone(pt, withTv) {
  let best = null, bd = 1e9;
  for (const z of D.zones) { if (z.tv && !withTv) continue; const d = hav(pt, z); if (d < bd) { bd = d; best = z; } }
  return best;
}
// "Plan as if I'm in zone X" is a temporary override: it expires after 12h so the app never stays stuck in an old area
const ZONE_TTL = 12 * HOUR;
function zoneOverride() {
  if (!S.zone) return null;
  if (!Z[S.zone] || (S.zoneT && Date.now() - S.zoneT > ZONE_TTL)) { S.zone = null; S.zoneT = 0; return null; }
  if (!S.zoneT) S.zoneT = Date.now();
  return Z[S.zone];
}
function here() {
  const z = zoneOverride();
  if (z) return { lat: z.lat, lng: z.lng, zone: z.id };
  if (S.loc) return S.loc;
  return { lat: 28.793, lng: -81.307, zone: 'sanford-lake-mary' };
}
// where he actually is right now: a GPS fix from the last 45 minutes (null if unknown / overridden by a zone)
function liveLoc(maxAge = 45 * MIN) {
  if (zoneOverride()) return null;
  const l = S.loc;
  return l && l.t && Date.now() - l.t < maxAge && (l.acc || 0) < 5000 ? l : null;
}
const locListeners = [];
function setLoc(pos) {
  const prev = S.loc;
  S.loc = { lat: +pos.coords.latitude.toFixed(5), lng: +pos.coords.longitude.toFixed(5), t: Date.now(), acc: Math.round(pos.coords.accuracy || 0) };
  saveQuiet();
  trackPoint(S.loc);
  for (const f of locListeners) try { f(S.loc, prev); } catch (e) { logError(e, 'loc listener'); }
  return S.loc;
}
function locate(fresh) {
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(pos => res(setLoc(pos)), () => res(null), { enableHighAccuracy: !!fresh, timeout: 12000, maximumAge: fresh ? 0 : 2 * MIN });
  });
}
// while the app is on screen, keep the fix fresh (cheap: no high accuracy)
let watchId = null;
function watchLoc(on) {
  if (!navigator.geolocation) return;
  if (on && watchId == null) watchId = navigator.geolocation.watchPosition(setLoc, () => {}, { enableHighAccuracy: false, maximumAge: MIN, timeout: 30000 });
  if (!on && watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
}
// the known place he's standing at (within ~200 m), if any
function nearbyPoi(pt = liveLoc(), maxMi = 0.13, pred) {
  if (!pt || (pt.acc || 0) > 400) return null;
  let best = null, bd = maxMi;
  for (const p of D.pois) {
    if (p.lat == null || p.gq === 'city' || S.avoid[p.id] || (pred && !pred(p))) continue;
    const d = hav(pt, p); if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// ---------- sun (SunCalc-derived)
function sunTimes(date, lat, lng) {
  const rad = Math.PI / 180, J1970 = 2440588, J2000 = 2451545;
  const d = date.valueOf() / DAY - 0.5 + J1970 - J2000;
  const lw = rad * -lng, phi = rad * lat, n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
  const ds = 0.0009 + lw / (2 * Math.PI) + n;
  const M = rad * (357.5291 + 0.98560028 * ds);
  const L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(rad * 23.4397) * Math.sin(L));
  const J = x => J2000 + x + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const w = Math.acos((Math.sin(rad * -0.833) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
  const Jnoon = J(ds), Jset = J(0.0009 + (w + lw) / (2 * Math.PI) + n), Jrise = Jnoon - (Jset - Jnoon);
  const toDate = j => new Date((j + 0.5 - J1970) * DAY);
  return { rise: toDate(Jrise), set: toDate(Jset) };
}
function sunToday(pt = here()) { const noon = new Date(); noon.setHours(12, 0, 0, 0); return sunTimes(noon, pt.lat, pt.lng); }

// ---------- hours
const TZN = ['America/New_York', 'America/Chicago'];
const tzFmt = TZN.map(tz => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }));
function tzParts(date, ct) {
  let dow = 0, h = 0, m = 0;
  for (const x of tzFmt[ct ? 1 : 0].formatToParts(date)) {
    if (x.type === 'weekday') dow = WD.indexOf(x.value); else if (x.type === 'hour') h = +x.value; else if (x.type === 'minute') m = +x.value;
  }
  return { dow, min: (h % 24) * 60 + m };
}
const sunCache = {};
function sunFor(p, date) {
  const pt = ptOf(p) || here(), k = (p.z || '') + '|' + new Date(date).toDateString();
  if (!sunCache[k]) {
    const noon = new Date(date); noon.setHours(12, 0, 0, 0);
    const t = sunTimes(noon, pt.lat, pt.lng);
    sunCache[k] = { rise: tzParts(t.rise, p.ct).min, set: tzParts(t.set, p.ct).min };
  }
  return sunCache[k];
}
const TOK = '(\\d{1,2}:\\d{2}(?:\\+1)?|sunrise|sunset|dawn|dusk)';
const RANGE = new RegExp(TOK + '\\s*-\\s*' + TOK);
function tokMin(t, sun) {
  const m = t.match(/^(\d{1,2}):(\d{2})(\+1)?$/);
  if (m) return +m[1] * 60 + +m[2] + (m[3] ? 1440 : 0);
  return { sunrise: sun.rise, sunset: sun.set, dawn: sun.rise - 30, dusk: sun.set + 30 }[t];
}
// null = unknown, [] = closed, [[start,end,uncertain]] minutes from local midnight (end may exceed 1440)
function parseDay(str, sun) {
  if (str == null) return null;
  const s = String(str).trim().toLowerCase();
  if (!s) return null;
  if (s === 'closed') return [];
  if (s === 'daylight') return [[sun.rise, sun.set, 0]];
  const out = [];
  for (const part of s.split(';')) {
    const m = part.match(RANGE);
    if (!m) continue;
    const a = tokMin(m[1], sun); let b = tokMin(m[2], sun);
    if (a == null || b == null) continue;
    if (b <= a) b += 1440;
    out.push([a, b, /only|first|second|third|fourth|season/.test(part) ? 1 : 0]);
  }
  return out.length ? out : (/closed/.test(s) ? [] : null);
}
const is247 = p => p.x.t247 || (p.h && p.h.every(d => d === '00:00-24:00'));
// state of a place at a moment: {k:'24h'|'open'|'closed'|'unknown', txt, left (min until close), soon}
function hoursState(p, date = new Date()) {
  if (!p.h) return { k: 'unknown', txt: 'Hours unconfirmed' };
  if (is247(p)) return { k: '24h', txt: 'Open 24h', left: 1e4 };
  const { dow, min } = tzParts(date, p.ct);
  const sun = sunFor(p, date);
  const day = i => parseDay(p.h[(dow + i + 7) % 7], sun);
  const openUntil = end => {
    // follow ranges that continue past midnight into following days
    for (let i = 1; i < 7 && end % 1440 === 0 && end === i * 1440; i++) {
      const r = day(i)?.find(x => x[0] === 0);
      if (!r) break;
      end = i * 1440 + r[1];
    }
    const left = end - min;
    if (left >= 1440) return { k: 'open', txt: 'Open all night', left };
    return { k: 'open', txt: (left <= 60 ? 'Closes soon · ' : 'Open · till ') + fmtClock(end), left, soon: left <= 60 };
  };
  const y = day(-1);
  if (y) for (const [a, b] of y) if (b > 1440 && min < b - 1440) return openUntil(b - 1440);
  const t = day(0);
  if (t === null) return { k: 'unknown', txt: 'Hours unconfirmed today' };
  for (const [a, b, q] of t) if (min >= a && min < b) { const r = openUntil(b); if (q) r.txt += ' (some days)'; return r; }
  for (const [a] of t) if (a > min) return { k: 'closed', txt: 'Closed · opens ' + fmtClock(a), opensIn: a - min };
  for (let i = 1; i < 7; i++) {
    const d = day(i);
    if (d === null) break;
    if (d.length) return { k: 'closed', txt: 'Closed · opens ' + (i === 1 ? 'tmrw ' : WD[(dow + i) % 7] + ' ') + fmtClock(d[0][0]), opensIn: i * 1440 + d[0][0] - min };
  }
  return { k: 'closed', txt: 'Closed today' };
}
// does a block of `dur` minutes starting at `ts` fit the place's hours?
function fit(p, ts, dur) {
  const st = hoursState(p, new Date(ts));
  if (st.k === '24h') return { k: 'ok', txt: 'Open 24h' };
  if (st.k === 'unknown') return { k: 'unk', txt: st.txt };
  if (st.k === 'closed') return { k: 'closed', txt: st.txt };
  if (dur && st.left < Math.min(dur, 600) - 15) return { k: 'short', txt: `Closes after ${fmtDur(st.left)}`, cover: st.left / dur };
  return { k: 'ok', txt: st.txt };
}

// ---------- labels
const OBS_TAGS = {
  good: ['👍 Good', 1], nope: ['👎 Skip it', -1], view: ['⭐ Great view', 1], peace: ['😌 Peaceful', 1],
  cheap: ['💲 Good prices', 1], signal: ['📶 Good signal', 1],
   nosignal: ['📵 Bad signal', -1], outlets: ['🔌 Outlets', 1], shade: ['🌳 Shade', 1],
  freepark: ['🅿️ Free parking', 1], paidpark: ['💲 Paid parking', -1], crowded: ['👥 Crowded', -1], closed: ['🚫 Closed', -2],
  slept: ['😴 Slept well', 1], knock: ['🚨 Knock / moved on', -2], noisy: ['🔊 Noisy', -1], bright: ['💡 Too bright', -1],
  security: ['👮 Security patrolling', -2], again: ['🔁 Would return', 1],
  noparking: ['🅿️ No good parking', -2], small: ['📏 Too small / tight', -1], vibe: ['😬 Bad vibe', -2], signs: ['🚫 No-overnight signs', -3], people: ['👀 Sketchy people', -2],
};
function obsFor(id) { return S.obs.filter(o => o.poi === id); }
function obsScore(id) {
  let s = 0;
  for (const o of obsFor(id)) {
    const age = (Date.now() - o.t) / DAY, w = age < 30 ? 1 : age < 120 ? 0.5 : 0.25;
    for (const t of o.tags) s += (OBS_TAGS[t]?.[1] || 0) * w;
  }
  return s;
}
function evOf(p, caps) { let best = null; for (const c of caps || Object.keys(p.caps)) { const e = p.caps[c]; if (e === 'd') return 'd'; if (e === 'r') best = 'r'; else if (e && !best) best = 'i'; } return best; }
function trustChip(p, caps) {
  if (p.use === 'known_unavailable' || /temporarily_closed|announced_not_open/.test(p.st || '')) return ['Closed / unavailable', 'bad'];
  const e = evOf(p, caps);
  return e === 'd' ? ['Confirmed', 'ok'] : e === 'r' ? ['Reported', 'blue'] : ['Unconfirmed', ''];
}
function sketchChip(p) {
  const o = p._ov;
  if (!o) return null;
  if (o.st === 'prohibited') return ['Prohibited overnight', 'bad'];
  if (o.st === 'mixed_reports') return ['Mixed reports', 'warn'];
  if (o.pr === 'extra_friction') return ['Extra friction', 'warn'];
  return null;
}
const LOT_TYPE = { walmart: 'Walmart lot', planet_fitness: 'PF lot', hotel_cluster: 'Hotel lot', cracker_barrel: 'Cracker Barrel', truck_stop: 'Truck stop', public_lot: 'Public lot', rest_area: 'Rest area (3h limit)', outdoor_retailer: 'Bass Pro / Cabela’s', casino: 'Casino' };
const lotChip = p => (p._ov ? [LOT_TYPE[p._ov.ty] || 'Lot', ''] : p.caps.tent_camp ? ['Camping', 'ok'] : p.caps.paid_lodging ? ['Paid room', ''] : null);
function lastNight(id) { let t = 0; for (const n of S.nights) if (!n.del && n.poi === id && n.t > t) t = n.t; return t; }
function wfChips(p) {
  const w = p.wf; if (!w) return [];
  const obs = obsFor(p.id).flatMap(o => o.tags);
  const out = [];
  if (w.cw) out.push(['Causeway / ramp', 'blue']);
  if (w.bch) out.push(['Beach', 'blue']);
  if (obs.includes('freepark') || (w.fp > 0 && !obs.includes('paidpark'))) out.push(['Free parking', 'ok']);
  else if (w.fp < 0 || obs.includes('paidpark')) out.push(['Paid parking', 'warn']);
  if (w.gr) out.push(['Grill', 'acc']);
  if (w.sh) out.push(['Shade', '']);
  return out;
}

// ---------- block types
const isWork = p => p.c === 'work';
const isCafe = p => isWork(p) && /cafe/.test(p.sc || '') && !/panera/i.test(p.n);
const isPanera = p => isWork(p) && /panera/i.test(p.n);
const isLibrary = p => isWork(p) && p.sc === 'library';
const isRestaurant = p => p.c === 'food' && !/walmart|grocery/i.test((p.sc || '') + p.n);
const isSocial = p => p.c === 'social' || p.tags.includes('social');
// where a dev session can happen, in the order options are shown: [key, icon, label, matcher, default minutes, score bonus]
const DEV_KINDS = [
  ['water', '🌊', 'Car office by the water', p => isWater(p), 120, 3],
  ['cafe', '☕', 'Local cafés', p => isCafe(p) && !isBookCafe(p), 150, 3],
  ['bookcafe', '📚', 'Big bookstores with cafés', p => isBookCafe(p), 150, 2],
  ['kava', '🍵', 'Kava bars / tea houses', p => isKava(p), 150, 2],
  ['panera', '🥖', 'Panera: outlets + Sip Club', p => isPanera(p), 180, 2],
  ['library', '📚', 'Libraries', p => isLibrary(p), 150, -6],
  ['pf', '🏋️', 'Car office at a PF lot, then lift + shower', p => !!p.caps.gym, 120, 0],
  ['mall', '🛍️', 'Malls / food courts', p => isMall(p), 120, 0],
  ['food', '🍜', 'Eat + laptop', p => isRestaurant(p) && !isMall(p), 105, -2],
  ['bar', '🍺', 'Bars / social spots', p => isSocial(p), 120, -2],
];
const devKind = p => DEV_KINDS.find(k => k[3](p));
// cheap + loved beats fancy: rating, price level, "known for cheap", Asian preference
function valueScore(p) {
  const f = p.fv; if (!f) return (p._food ? 1 : 0);
  let s = 0;
  if (f.r != null) s += f.r >= 4.7 ? 4 : f.r >= 4.5 ? 3 : f.r >= 4.2 ? 1 : f.r < 4 ? -2 : 0;
  if (f.rc != null && f.rc < 40) s -= 1;
  if (f.pl != null) s += { 1: 4, 2: 1, 3: -5, 4: -8 }[f.pl] || 0;
  if (f.cheap) s += 3;
  if (f.asian) s += 2;
  if (p.sc === 'fast_food' && !p.tags.includes('crave')) s -= 1;
  if (isGuy(p) || isTony(p)) s += 2;
  if (p.tags.includes('local_gem')) s += 1;
  return s;
}
const isGuy = p => p.tags.includes('ddd');
const isTony = p => p.tags.includes('bourdain');
const isGoth = p => p.tags.includes('goth') || p.sc === 'goth_club';
const isMovie = p => p.tags.includes('movies') || /movie_theater|drive_in|cinema/.test(p.sc || '');
const isArcade = p => (p.tags.includes('arcade') || /arcade/.test(p.sc || '')) && !/dave (&|and) buster|main event|round ?1/i.test(p.n);
const isPizza = p => p.c === 'food' && (p.sc === 'pizza' || p.tags.includes('pizza') || /pizza/i.test(p.fv?.cu || ''));
const isRun = p => !!p.caps.trail_run || p.tags.includes('trail_run');
const isWonder = p => p.tags.includes('wonder');
function runBonus(p) {
  const t = p.x.trail || {};
  let s = 0;
  if (t.r != null) s += t.r >= 4.7 ? 3 : t.r >= 4.4 ? 2 : t.r < 4 ? -2 : 0;
  if (/rugged/i.test(t.terrain || '')) s += 3; else if (/rolling/i.test(t.terrain || '')) s += 1;
  if (/single|dirt|root/i.test(t.surface || '')) s += 1;
  if (/paved|asphalt|sidewalk/i.test(t.surface || '')) s -= 2;
  return s;
}
// bar specials on a given moment (in the bar's timezone): {today: [...], now: special|null}
function specialsAt(p, ts = Date.now()) {
  if (!p.sp?.length) return { today: [], now: null };
  const { dow, min } = tzParts(new Date(ts), p.ct);
  // weekly specials by weekday; one-off events (dt) only on their date
  const dd = new Date(ts), ymd = `${dd.getFullYear()}-${pad(dd.getMonth() + 1)}-${pad(dd.getDate())}`;
  const today = p.sp.filter(x => !x.unk && (x.dt ? x.dt === ymd : !x.d?.length || x.d.includes(dow)));
  const hm = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const now = today.find(x => x.s && x.e && min >= hm(x.s) && min < (hm(x.e) <= hm(x.s) ? hm(x.e) + 1440 : hm(x.e))) || null;
  return { today, now };
}
// the special's label, or a sensible one from its window (lunch / happy hour / late night)
const hmm = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
// drinks → happy hour (late if it starts 9p+); food at midday → lunch special; otherwise "Special"
const DRINK_RX = /happy hour|drink|beer|draft|draught|pint|cocktail|wine|well|shot|margarita|mimosa|bloody|tito|vodka|whisk|tequila|rum|seltzer|pbr|domestic|bucket/i;
function specialLabel(x, p) {
  if (x.l) return x.l;
  const s = x.s ? hmm(x.s) : null, txt = (x.items || []).join(' ');
  if (DRINK_RX.test(txt) || (p && p.c === 'social')) return s != null && s >= 21 * 60 ? 'Late-night happy hour' : 'Happy hour';
  if (s != null && s >= 10 * 60 + 30 && s <= 13 * 60 + 30) return 'Lunch special';
  return 'Special';
}
const specialWhat = x => x.items?.[0] || x.l || 'Special';
// a place's specials at a moment: running now (+ until when, minutes left), the next one today, all of today's
function specialState(p, ts = Date.now()) {
  const st = specialsAt(p, ts);
  if (!st.today.length) return { now: null, next: null, today: [] };
  const { min } = tzParts(new Date(ts), p.ct);
  let now = null, next = null;
  if (st.now) { const s = hmm(st.now.s); let e = hmm(st.now.e); if (e <= s) e += 1440; now = { x: st.now, until: e, left: e - min }; }
  for (const x of st.today) {
    if (!x.s || x === st.now) continue;
    const s = hmm(x.s);
    if (s > min && (!next || s < next.start)) next = { x, start: s, end: x.e ? hmm(x.e) : null, in: s - min };
  }
  return { now, next, today: st.today };
}
// specials around a point: on now (nearest first), then starting within the next few hours
function specialsNear(from = here(), ts = Date.now(), maxMi = 10, soonMin = 180) {
  const on = [], soon = [];
  for (const p of D.pois) {
    if (!p.sp?.length || S.avoid[p.id] || p.use === 'known_unavailable') continue;
    const pt = ptOf(p); if (!pt || pt.approx) continue;
    const mi = hav(from, pt); if (mi > maxMi) continue;
    const ss = specialState(p, ts);
    if (ss.now) on.push({ p, mi, ss });
    else if (ss.next && ss.next.in <= soonMin) soon.push({ p, mi, ss });
  }
  on.sort((a, b) => a.mi - b.mi); soon.sort((a, b) => a.ss.next.start - b.ss.next.start || a.mi - b.mi);
  return { on, soon };
}
const dayNames = ds => { const n = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; return ds?.length ? ds.map(d => n[d]).join('/') : 'Daily'; };
const isClub = p => p.sc === 'strip_club' || p.tags.includes('strip_club') || p.bd?.k === 'strip_club';
function barBonus(p, at) {
  const dow = new Date(at).getDay(), sp = specialsAt(p, at);
  let s = sp.now ? 8 : sp.today.length ? 4 : 0;
  // a "Bar night" block auto-picks dive bars; clubs are there to browse (Clubs list), not the default pick
  if (isClub(p)) s -= 8;
  const k = p.bd?.k || p.sc || '';
  if (/dive|barcade|hipster/.test(k)) s += dow === 5 || dow === 6 ? 4 : 2;
  if (p.bd?.r >= 4.5) s += 2;
  if (dow === 0) s -= 10; // not on a Sunday night
  return s;
}
const isKava = p => p.c === 'work' && /kava|tea/.test(p.sc || '') && p.x.kratom !== true;
const isMeatSpecial = x => /steak|prime rib|\bribs?\b|sirloin|ribeye|brisket|bbq|barbecue|wings|meat/i.test((x.l || '') + ' ' + (x.items || []).join(' '));
const isMeatDeal = p => (p.sp || []).some(isMeatSpecial) || /steak/.test(p.sc || '');
const GROCER = { trader_joes: 6, sprouts: 3, publix: 3, whole_foods: 2 };
const isBookCafe = p => p.sc === 'bookstore_cafe' || /barnes & noble|barnes and noble|books-a-million/i.test(p.n);
const isMall = p => p.sc === 'mall' || p.sc === 'food_court';
const isGas = p => !!p.caps.fuel || /murphy_usa|quiktrip|bucees|circle_k|gas_station/.test(p.sc || '');
const GAS_PREF = { murphy_usa: 6, quiktrip: 3, bucees: 2, circle_k: 1 };
// restrooms: documented ones plus places where a restroom is a safe bet (indoor businesses he'll be a customer of)
const hasRestroom = p => !!(p.caps.restroom || p.caps.restroom_candidate || p.am.includes('restroom') || p.wf?.rr) || isMall(p) || isBookCafe(p) || isRestaurant(p) || /panera/i.test(p.n) || p.sc === 'library' || !!p.caps.gym;
// small amenity icons for cards: restroom, free parking, wifi, outlets
function amenIcons(p) {
  const out = [];
  if (hasRestroom(p)) out.push(['🚻', 'Restroom']);
  if (p.wf?.fp > 0 || obsFor(p.id).some(o => o.tags.includes('freepark'))) out.push(['🅿️', 'Free parking']);
  if (p.caps.wifi || p.am.includes('wifi') || /panera/i.test(p.n) || p.sc === 'library' || isBookCafe(p)) out.push(['📶', 'Wi-Fi']);
  if (/panera/i.test(p.n) || p.sc === 'library' || p.x.outlets || obsFor(p.id).some(o => o.tags.includes('outlets'))) out.push(['🔌', 'Outlets']);
  return out;
}
const isOffice = p => isWork(p) && (/panera/i.test(p.n) || p.sc === 'library' || p.sc === 'chain_cafe');
const isWater = p => p.c === 'waterfront' || !!p.wf;
const hasCap = (...cs) => p => cs.some(c => p.caps[c]);
const wfBonus = (p, long) => {
  const w = p.wf || {}; let s = (w.s || 0) / 15;
  s += w.cw ? 6 : 0; s += w.fp > 0 ? 4 : w.fp < 0 ? -6 : 0; s += w.rr ? 2 : 0; s += w.sh ? (long ? 3 : 1) : 0; s += w.bch ? 1 : 0;
  if (p.tags.includes('car_office')) s += 3;
  if (p.tags.includes('beach_work')) s += 1;
  return s;
};
const BT = {
  water_s: { n: 'Water break', ic: '🌊', dur: 75, log: 'water', m: isWater, b: p => wfBonus(p), caps: ['work_outdoors', 'recreation'], hint: 'Sun, notes, sketching game ideas. Car parked close.' },
  water_work: { n: 'Water work session', ic: '💻', dur: 120, log: ['dev', 'water'], m: isWater, b: p => wfBonus(p, 1) + (p.tags.includes('car_office') ? 3 : 0), caps: ['work_outdoors'], hint: 'Laptop on battery (~2h) + inverter + hotspot, car by the water. Design, code, playtest. Save big uploads/builds for Wi-Fi.' },
  water_l: { n: 'Long water day', ic: '🏖️', dur: 240, log: ['dev', 'water'], m: isWater, b: p => wfBonus(p, 1) + (p.tags.includes('car_office') ? 3 : 0), caps: ['work_outdoors', 'recreation'], hint: 'Half a day on the water: work sessions on battery + inverter, breaks, food. Leave before the gate closes.' },
  cafe: { n: 'Local café', ic: '☕', dur: 150, log: 'dev', m: isCafe, b: p => (p.sc === 'independent_cafe' ? 5 : p.sc === 'regional_cafe' ? 3 : 0), caps: ['work_indoor'], alts: ['panera', 'library', 'water_work'], hint: 'Nice environment, focused work.' },
  panera: { n: 'Panera', ic: '🥖', dur: 180, log: 'dev', m: isPanera, b: () => 0, caps: ['work_indoor'], alts: ['library', 'cafe', 'water_work'], hint: 'The cheap powered office: outlets, Wi-Fi, Sip Club refills. Do builds, downloads and uploads here.' },
  library: { n: 'Library', ic: '📚', dur: 180, log: 'dev', m: isLibrary, b: () => 0, caps: ['work_indoor'], alts: ['cafe', 'panera', 'water_work'], hint: 'Free, quiet, Wi-Fi + outlets. Libraries close early (often 5–8p): check the time.' },
  office: { n: 'Panera or library', ic: '🔌', dur: 180, log: 'dev', m: isOffice, b: p => (/panera/i.test(p.n) ? 4 : p.sc === 'library' ? 2 : 0), caps: ['work_indoor'], hint: 'Panera / library: power + Wi-Fi. Do builds, downloads, uploads here.' },
  deep: { n: 'Dev session', ic: '🎮', dur: 150, log: 'dev', m: p => !!devKind(p), b: p => { const k = devKind(p); return k[5] + (k[0] === 'water' ? wfBonus(p) / 2 : 0); }, caps: [], hint: 'Pick any spot that works today: the water, a café, Panera, a library, a restaurant, a bar, or your car at the PF lot.' },
  light: { n: 'Admin / quick tasks', ic: '📋', dur: 60, log: 'dev', m: p => !!devKind(p) && !isLibrary(p), b: p => (isWater(p) ? wfBonus(p) / 2 : 0), caps: ['work_indoor', 'work_outdoors'], hint: 'Notes, email, small tasks.' },
  dash: { n: 'DoorDash', ic: '🚗', dur: 210, log: 'dash', m: p => !!p._dd || p.tags.includes('door_dash') || p.c === 'doordash_cluster', b: p => (p._dd ? 5 + (p._dd.score || 0) / 20 : 0), caps: [], hint: 'One peak block. Don\'t chase red zones 20 miles away.' },
  gym: { n: 'Gym + shower', ic: '🏋️', dur: 80, log: 'gym', m: hasCap('gym'), b: p => (is247(p) ? 3 : 0), caps: ['gym', 'shower'], hint: '' },
  shower: { n: 'Shower', ic: '🚿', dur: 30, log: 'shower', m: p => p.caps.shower || p.am.includes('shower'), b: p => (p.caps.shower ? 2 : 0), caps: ['shower'], hint: 'Outdoor beach showers count too.' },
  meal: { n: 'Meal', ic: '🍜', dur: 50, m: p => p.c === 'food' && !/walmart|grocery|trader|publix|sprouts|whole_foods/i.test((p.sc || '') + p.n) && !!(p.caps.meal || p.caps.protein_food || p.caps.ramen || p.caps.buffet || p.caps.all_you_can_eat), b: (p, at) => { const sa = specialsAt(p, at); return valueScore(p) + (p.caps.ramen ? 1 : 0) + (sa.now ? 7 : sa.today.length ? 3 : 0); }, caps: ['meal', 'protein_food', 'ramen', 'buffet'], hint: 'Protein first. A good Dash can fund this.' },
  grill: { n: 'Grill dinner', ic: '🔥', dur: 90, log: 'water', m: p => p.caps.public_grill || p.am.includes('grill'), b: p => wfBonus(p), caps: ['public_grill'], hint: 'Charcoal, foil, lighter. Check fire rules.' },
  car: { n: 'Car work', ic: '🔧', dur: 120, log: 'car', m: hasCap('auto_parts', 'repair_support', 'auto_service', 'loan_tools'), b: p => (p.caps.loan_tools || p.x.tools ? 3 : 0) + (p.x.lotRepair ? 3 : 0), caps: ['auto_parts', 'loan_tools', 'repair_support'], hint: 'Parts run + lot work. Test drive after.' },
  water: { n: 'Water refill', ic: '💧', dur: 15, log: 'water_refill', m: hasCap('buy_drinking_water', 'water_source_candidate'), b: () => 0, caps: ['buy_drinking_water', 'water_source_candidate'], hint: '3-gal jug at the refill machine (~$1.50).' },
  groc: { n: 'Supply run', ic: '🛒', dur: 35, log: 'groceries', m: hasCap('groceries'), b: p => GROCER[p.sc] ?? (/walmart/i.test(p.n) ? 2 : 0), caps: ['groceries'], hint: '' },
  laundry: { n: 'Laundry', ic: '🧺', dur: 100, log: 'laundry', m: hasCap('laundry'), b: () => 0, caps: ['laundry'], hint: 'Bring the laptop: 90 min of light work.' },
  mail: { n: 'Mail pickup', ic: '📬', dur: 20, log: 'mail', m: hasCap('mail'), b: p => (p._mail?.gd ? 3 : 0), caps: ['mail'], hint: 'Bring ID. General Delivery holds ~30 days.' },
  fun: { n: 'Explore', ic: '🌿', dur: 120, m: p => p.c === 'fun' || p.c === 'camping' && p.tags.includes('joy'), b: p => (p.tags.includes('creative_retreat') ? 2 : 0), caps: ['recreation'], hint: 'Springs, trails, oddities.' },
  social: { n: 'Bar night', ic: '🍺', dur: 120, m: p => p.c === 'social' || p.tags.includes('social'), b: (p, at) => barBonus(p, at), caps: [], hint: 'Done driving for the night first.' },
  restroom: { n: 'Restroom', ic: '🚻', dur: 10, m: p => hasRestroom(p) || (isGas(p) && p.am.includes('restroom')), b: p => (is247(p) ? 2 : 0) + (isMall(p) || isBookCafe(p) || p.sc === 'quiktrip' || p.sc === 'bucees' ? 2 : 0), caps: ['restroom', 'restroom_candidate'], hint: '' },
  travel: { n: 'Travel', ic: '🛣️', dur: 60, hint: 'Move to a new zone. Duration follows the distance.' },
  sleep: { n: 'Night spot', ic: '🌙', dur: 0, m: p => p.caps.sleep_candidate || (S.settings.tent && p.caps.tent_camp) || p.caps.paid_lodging, b: sleepBonus, caps: ['sleep_candidate', 'tent_camp', 'paid_lodging'], hint: 'Rotate spots. Check iOverlander’s newest check-ins as the tiebreaker.' },
  kava: { n: 'Kava / tea session', ic: '🍵', dur: 150, log: 'dev', m: isKava, b: p => valueScore(p) + (p.x.laptop ? 2 : 0), caps: ['work_indoor'], alts: ['cafe', 'panera', 'water_work'], hint: 'Laptop-friendly kava bar or tea house. Kava, not kratom.' },
  meat: { n: 'Meat deal', ic: '🥩', dur: 60, m: isMeatDeal, b: (p, at) => valueScore(p) + ((specialsAt(p, at).today || []).some(isMeatSpecial) ? 8 : 0), caps: ['meal', 'protein_food'], hint: 'Steak / prime rib / ribs deal nights. Check the posted date before you drive.' },
  books: { n: 'Bookstore browse', ic: '📖', dur: 75, m: p => /book/.test(p.sc || ''), b: p => valueScore(p), caps: ['recreation'], hint: 'Big, well-loved used bookstores only.' },
  vape: { n: 'Vape / smoke shop', ic: '💨', dur: 20, m: p => !!p.caps.vape || /vape|smoke/.test(p.sc || ''), b: p => valueScore(p), caps: ['vape'], hint: 'Ranked by reviews that mention good prices.' },
  gas: { n: 'Gas', ic: '⛽', dur: 10, m: isGas, b: p => GAS_PREF[p.sc] || 0, caps: ['fuel'], hint: 'Murphy USA is usually cheapest. Check live prices before a long drive.' },
  mall: { n: 'Mall / food court', ic: '🛍️', dur: 120, m: isMall, b: p => valueScore(p), caps: [], hint: 'Food court, restrooms, a walk, laptop time. Decent DoorDash start point too.' },
  carofc: { n: 'Car office', ic: '🚙', dur: 120, log: 'dev', night: 1, hint: 'Work from the car wherever you\'re parked (usually tonight\'s spot): inverter + hotspot, windows cracked.' },
  gaming: { n: 'Gaming / chill', ic: '🕹️', dur: 90, night: 1, hint: 'Off the clock at your spot: games, shows, whatever recharges you.' },
  agentic: { n: 'Agentic chill session', ic: '🤖', dur: 120, log: 'dev', night: 1, hint: 'Send a prompt, play a little, check in on the agents when they finish. Counts as dev time.' },
  bedtime: { n: 'Bedtime dev', ic: '🌒', dur: 60, log: 'dev', night: 1, hint: 'Light design / code / notes winding down before sleep.' },
  nap: { n: 'Nap', ic: '😴', dur: 40, hint: 'Wherever you\'re parked. Shade + windows cracked.' },
  carmeal: { n: 'Car meal', ic: '🥫', dur: 30, hint: 'Car staples: tuna, PB&J, whey, fruit. Cheap and fast.' },
  storage: { n: 'Storage unit run', ic: '📦', dur: 45, m: p => !!p.caps.storage, b: () => 0, caps: ['storage'], hint: 'Your Public Storage unit in Sanford. Later blocks re-plan around Sanford.' },
  free: { n: 'Free time', ic: '✨', dur: 60, hint: 'Unplanned. Wander, rest, whatever.' },
  run: { n: 'Trail run', ic: '🏃', dur: 75, log: 'run', m: isRun, b: runBonus, caps: ['trail_run'], hint: 'Wild, rugged and scenic first. Water, phone, bug spray; finish before the gate closes. Shower after (PF).' },
  wonder: { n: 'Natural wonder', ic: '🏞️', dur: 120, m: isWonder, b: p => (p.x.wonder?.swim ? 1 : 0), caps: ['recreation'], hint: 'The best springs, sinkholes and waterfalls. Popular springs close when the lot fills: go early, especially weekends.' },
  movie: { n: 'Movie', ic: '🎬', dur: 150, log: 'movie', m: isMovie, b: p => (/^amc/i.test(p.x.brand || p.n) && S.settings.alist ? 4 : /epic/i.test(p.x.brand || '') ? 2 : 0) + (p.sc === 'drive_in' ? 2 : 0), caps: ['recreation'], hint: 'Check showtimes before you drive. A-List: reserve in the AMC app (free with your plan).' },
  arcade: { n: 'Arcade', ic: '👾', dur: 90, m: isArcade, b: p => valueScore(p) + (p.bd?.r >= 4.5 ? 2 : 0), caps: [], hint: 'Pinball + retro cabinets. Barcades are usually 21+ at night.' },
  pizza: { n: 'Pizza', ic: '🍕', dur: 50, m: p => isPizza(p) && !!(p.caps.meal || p.caps.protein_food), b: p => valueScore(p) + (p.tags.includes('dine_in') ? 1 : 0), caps: ['meal'], hint: 'Local gem dine-in pizza first.' },
};
function sleepBonus(p) {
  let s = 0; const o = p._ov;
  if (o) s += o.pr === 'inspect_first' ? 3 : o.pr === 'extra_friction' ? -5 : 0, s -= o.gray ? 1 : 0, s += o.o24 ? 2 : 0;
  if (p.caps.gym) s += S.settings.club ? 3 : -4;
  if (p.caps.paid_lodging && !p.caps.sleep_candidate) s += S.settings.hotel ? 4 : -7;
  if (p.caps.tent_camp) s += p._camp?.vs?.startsWith('documented') ? 4 : 1;
  const ln = lastNight(p.id);
  if (ln) { const d = (Date.now() - ln) / DAY; s -= d < 1.5 ? 14 : d < 3.5 ? 8 : d < 7 ? 3 : 0; }
  return s;
}

// rank candidate places for a block type near `from` at time `at`.
// Distance dominates; closed places sink but stay visible (labeled with when they open); nothing past maxMi.
// `anchor` keeps a day's blocks in its zone so plans don't drift town to town without a Travel block.
const MAX_MI = { fun: 70, social: 60, sleep: 40, storage: 700, wonder: 80, run: 50, movie: 45, arcade: 50 };
function rank(type, { from = here(), at = Date.now(), dur, avoid, anchor, maxMi, adj } = {}) {
  const def = BT[type];
  if (!def?.m) return [];
  if (dur == null) dur = def.dur;
  maxMi ??= MAX_MI[type] || 45;
  // bars are judged on their evening, not whenever you happen to be looking
  if (type === 'social' && new Date(at).getHours() < 16) { const d = new Date(at); d.setHours(18, 0, 0, 0); at = d.getTime(); }
  const out = [];
  for (const p of D.pois) {
    if (!def.m(p) || S.avoid[p.id] || p.use === 'known_unavailable') continue;
    if (type === 'sleep' && p._ov?.st === 'prohibited') continue;
    const pt = ptOf(p);
    if (!pt) continue;
    // unlocated places sit at their zone center: keep them, but never pretend we know the distance
    const mi = hav(from, pt) + (pt.approx ? 4 : 0);
    if (mi > maxMi) continue;
    const f = fit(p, at, type === 'sleep' ? 0 : dur);
    let s = -mi - Math.max(0, mi - 12);
    if (anchor) { const am = hav(anchor, pt); if (am > 8) s -= (am - 8) * 1.3; }
    if (type !== 'sleep') s += f.k === 'ok' ? 5 : f.k === 'unk' ? 0 : f.k === 'short' ? -3 - 12 * (1 - f.cover) : -12;
    const e = evOf(p, def.caps.length ? def.caps : null);
    s += e === 'd' ? 3 : e === 'r' ? 2 : 0;
    s += def.b(p, at) + (S.fav[p.id] ? 8 : 0) + obsScore(p.id) * 3;
    if (/temporarily_closed|announced_not_open/.test(p.st || '')) s -= 40;
    if (pt.approx) s -= 2;
    if (avoid?.has(p.id)) s -= 14;
    if (adj) s += adj(p);
    out.push({ p, s, mi, f, approx: !!pt.approx });
  }
  return out.sort((a, b) => b.s - a.s);
}

// ---------- night spots: several recon targets of different kinds, nearest first
const lotKind = p => p._ov?.ty || (p.caps.tent_camp ? 'camp' : p.caps.paid_lodging ? 'hotel' : 'other');
function nightOptions(from, at, anchor) {
  // tonight's hours matter: a PF open all night means restrooms + light; closed overnight means lot only
  return rank('sleep', { from, at, dur: 0, anchor, maxMi: 25, adj: p => { const n = nightChip(p, at); return n?.[1] === 'ok' ? 3 : p.caps.gym && n?.[0] === 'Closed overnight' ? -4 : 0; } });
}
function pickRecon(b, from, at, anchor) {
  // keep what he already checked nearby (good / bad); spots checked in another town drop off
  const keep = (b.recon || []).filter(x => x.st !== 'todo' && P[x.poi] && (x.st === 'good' || hav(from, ptOf(P[x.poi])) < 25));
  const kinds = new Set(), out = [];
  for (const o of nightOptions(from, at, anchor)) {
    if (keep.some(x => x.poi === o.p.id) || obsScore(o.p.id) < -1) continue;
    const k = lotKind(o.p);
    if (kinds.has(k)) continue;
    kinds.add(k); out.push(o);
    if (out.length >= 3) break;
  }
  return [...keep, ...out.sort((a, z) => a.mi - z.mi).map(o => ({ poi: o.p.id, st: 'todo' }))];
}
// is the place open overnight on that night? (PF 24h Mon–Thu vs closing 9p Fri matters for restrooms)
function nightChip(p, ts = Date.now()) {
  if (!p.h) return null;
  const d = new Date(ts); d.setHours(23, 30, 0, 0);
  const st = hoursState(p, d);
  if (st.k === '24h' || (st.k === 'open' && st.left >= 300)) return ['Open all night', 'ok'];
  if (st.k === 'open') return ['Open till ' + fmtClock(23 * 60 + 30 + st.left), ''];
  return st.k === 'closed' ? ['Closed overnight', ''] : null;
}

// ---------- day model
const WORKOUTS = [
  { n: 'Back + biceps', ex: ['Pulldown', 'Row', 'Rear delt', 'Curl', 'Hammer curl', 'Forearms (optional)'] },
  { n: 'Chest + triceps', ex: ['Machine / Smith press', 'Incline press', 'Fly', 'Triceps pushdown', 'Overhead triceps'] },
  { n: 'Legs + calves + light biceps', ex: ['Leg press / hack', 'Leg curl', 'Leg extension', 'Calves', '2 curl sets'] },
  { n: 'Back + delts + biceps', ex: ['Chest-supported / machine row', 'Pulldown', 'Rear delt', 'Lateral raise', 'Curls'] },
  { n: 'Chest + arms pump', ex: ['Machine / Smith press', 'Incline', 'Triceps', 'Curls', 'Laterals'] },
];
// Day types. Rules: water time every day, no more than ~3h at one indoor venue, dev work mixed across
// water / café / Panera-library / car office. "type:minutes@HH:MM" pins a start time (e.g. DoorDash peak).
const TEMPLATES = [
  { id: 'balanced', n: 'Balanced creative day', d: 'Water work → café → food → Panera → PF → car office', b: ['water_work:120', 'cafe:150', 'meal:45', 'panera:150', 'gym', 'carofc:120', 'sleep'] },
  { id: 'max', n: 'Big game day', d: 'Water break → dev session → food → water work → Panera → PF → car office', b: ['water_s:60', 'deep:150', 'meal:45', 'water_work:120', 'panera:180', 'gym', 'carofc:120', 'sleep'] },
  { id: 'nomad', n: 'Beach nomad', d: 'Half a day working on the water → food → dev session → PF', b: ['water_l:240', 'meal:45', 'deep:150', 'gym', 'carofc:120', 'sleep'] },
  { id: 'cash', n: 'Cash day', d: 'Water work → dev session → DoorDash 5–8 → PF → car office', b: ['water_work:120', 'deep:150', 'meal:45', 'dash:180@17:00', 'gym', 'carofc:120', 'sleep'] },
  { id: 'lunchdash', n: 'Lunch dash day', d: 'DoorDash 11–2 → food → water work → dev session → PF', b: ['dash:180@11:00', 'meal:45', 'water_work:120', 'deep:150', 'gym', 'carofc:120', 'sleep'] },
  { id: 'joy', n: 'Joy day', d: 'Long water → explore → good meal → café → PF', b: ['water_l:180', 'fun:120', 'meal:60', 'cafe:120', 'gym', 'sleep'] },
  { id: 'grill', n: 'Grill night', d: 'Water work → café → dev session → grill dinner by the water → PF', b: ['water_work:120', 'cafe:150', 'deep:120', 'grill:90', 'gym', 'carofc:120', 'sleep'] },
  { id: 'move', n: 'Moving day', d: 'Dev session → travel → water work in the new zone → PF', b: ['water_s:60', 'deep:150', 'travel', 'water_work:120', 'gym', 'carofc:120', 'sleep'] },
  { id: 'car', n: 'Car day', d: '2h car work → water work → food → dev session → PF', b: ['car:120', 'water_work:120', 'meal:45', 'deep:150', 'gym', 'carofc:120', 'sleep'] },
  { id: 'library', n: 'Library day', d: 'Water work → library → food → water break → PF → car office', b: ['water_work:120', 'library:180', 'meal:45', 'water_s:75', 'gym', 'carofc:120', 'sleep'] },
  { id: 'tired', n: 'Easy reset', d: 'PF + shower → good food → water break → early night', b: ['gym', 'meal:60', 'water_s:90', 'sleep'] },
  { id: 'blank', n: 'Blank', d: 'Start empty and add blocks', b: ['sleep'] },
];
function mkBlock(spec) {
  const [main, at] = spec.split('@');
  const [t, d] = main.split(':');
  const b = { id: uid(), t, dur: d ? +d : BT[t].dur, st: 'plan' };
  if (at) { const [h, m] = at.split(':').map(Number); b.at = h * 60 + m; }
  return b;
}
const LOCAL_T = new Set(['gas', 'kava', 'cafe', 'panera', 'library', 'office', 'deep', 'light', 'water_s', 'water_work', 'water_l', 'meal', 'pizza', 'restroom', 'water', 'groc']);
// how far an auto-picked place may sit from the day's area before it's considered stale (he moved) and re-picked
const staleMi = t => (t === 'storage' || t === 'travel' ? Infinity : LOCAL_T.has(t) ? 15 : t === 'wonder' || t === 'fun' ? 45 : 25);
const WORK_T = new Set(['kava', 'cafe', 'panera', 'library', 'office', 'deep', 'light']);
// work sessions are 2–4h; their duration stepper moves in 30m steps
const WORK_BLOCKS = new Set(['agentic', 'kava', 'water_work', 'water_l', 'cafe', 'panera', 'library', 'office', 'deep', 'carofc', 'dash', 'car']);
// ---- multi-day: S.days[date] = { date, startMin, tpl, blocks }
const dateTs = (date, min = 0) => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d, 0, min).getTime(); };
const addDays = (date, n) => dayKey(dateTs(date, 12 * 60) + n * DAY + 4 * HOUR);
const today = () => dayKey();
function dayLabel(date) {
  const t = today();
  if (date === t) return 'Today';
  if (date === addDays(t, 1)) return 'Tomorrow';
  const d = new Date(dateTs(date, 720));
  return WD[d.getDay()] + ' ' + d.getDate();
}
// a cleared day is a tombstone ({del}) so sync can't resurrect it; treat it as no day
function getDay(date) { const d = S.days[date]; return d && !d.del && Array.isArray(d.blocks) ? d : null; }
// minutes since the planning day's midnight (after midnight counts as 24:xx of the day before, until 4am)
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes() + (n.getHours() < 4 ? 1440 : 0); };
function ensureDay(date) {
  let d = getDay(date);
  if (!d) d = S.days[date] = { date, startMin: date === today() ? nowMin() : 480, blocks: [] };
  return d;
}
function newDay(tplId, date = today()) {
  const tpl = TEMPLATES.find(t => t.id === tplId) || TEMPLATES[0];
  const blocks = tpl.b.map(mkBlock);
  const isToday = date === today();
  const startMin = isToday ? nowMin() : 8 * 60;
  // trim to fit what's left of the day (keep gym, travel, sleep)
  const left = 26 * 60 - startMin;
  let trimmed = 0;
  const total = () => blocks.reduce((a, b) => a + (b.t === 'sleep' ? 0 : b.dur + 10), 0);
  while (total() > left && blocks.length > 3) {
    const i = blocks.findIndex(b => !['gym', 'sleep', 'travel', 'dash', 'carofc'].includes(b.t));
    if (i < 0) break;
    blocks.splice(i, 1); trimmed++;
  }
  const day = { date, startMin, tpl: tpl.id, blocks };
  S.days[date] = day;
  if (tplId === 'move') { const tb = blocks.find(b => b.t === 'travel'); if (tb) tb.toZone = nextZone(1, dayOrigin(day).pt)?.id; }
  autofill(day, true);
  return trimmed;
}
function pruneDays() {
  const cut = addDays(today(), -21);
  for (const k of Object.keys(S.days)) if (k < cut) delete S.days[k];
}
// repair saved state so the UI can always render it: unknown block types, duplicate ids, several night spots in one day,
// and blocks left running on a past day (closed at their planned length and logged as auto)
function sanitize() {
  const t = today();
  S.mine ||= []; S.nights ||= []; S.obs ||= []; S.log ||= []; S.days ||= {};
  for (const [k, day] of Object.entries(S.days)) {
    if (!day || typeof day !== 'object') { delete S.days[k]; continue; }
    if (day.del) continue;
    day.date = k;
    if (!Array.isArray(day.blocks)) day.blocks = [];
    const ids = new Set();
    day.blocks = day.blocks.filter(b => b && BT[b.t]);
    for (const b of day.blocks) {
      if (b.poi && D?.alias?.[b.poi]) b.poi = D.alias[b.poi];
      for (const x of b.recon || []) if (D?.alias?.[x.poi]) x.poi = D.alias[x.poi];
      if (!b.id || ids.has(b.id)) b.id = uid();
      ids.add(b.id);
      if (!(b.dur >= 0)) b.dur = BT[b.t].dur;
      if (!['plan', 'active', 'done', 'skip'].includes(b.st)) b.st = 'plan';
      if (b.st === 'active' && !b.s0) b.s0 = Date.now();
    }
    const sl = day.blocks.filter(b => b.t === 'sleep');
    if (sl.length > 1) {
      const keep = sl.find(b => b.confirmed) || sl.find(b => b.st === 'done') || sl[sl.length - 1];
      for (const b of sl) if (b !== keep) for (const x of b.recon || []) if (!(keep.recon ||= []).some(y => y.poi === x.poi)) keep.recon.push(x);
      day.blocks = day.blocks.filter(b => b.t !== 'sleep' || b === keep);
    }
    // the night spot always closes the day
    const si = day.blocks.findIndex(b => b.t === 'sleep');
    if (si >= 0 && si < day.blocks.length - 1) day.blocks.push(...day.blocks.splice(si, 1));
    if (k < t) for (const b of day.blocks) if (b.st === 'active' && b.t !== 'sleep') completeBlock(b, Math.min(b.s0 + b.dur * MIN, dateTs(k, 28 * 60)), 'stale');
  }
}
function zoneOfPoint(pt) { return pt.zone ? Z[pt.zone] : nearestZone(pt); }
function nextZone(dir, from = here()) {
  const cur = zoneOfPoint(from);
  const seq = D.zones.filter(z => !z.inland === !cur.inland).sort((a, b) => a.o - b.o);
  const i = seq.findIndex(z => z.id === cur.id);
  return seq[i + dir] || null;
}
function nextSleep(day, b) {
  const i = day.blocks.indexOf(b);
  return day.blocks.slice(i + 1).find(x => x.t === 'sleep' && x.st !== 'skip' && blockPoint(x)) || null;
}
const blockKind = b => ({ water_s: 'water', water_work: 'water', water_l: 'water', cafe: 'cafe', kava: 'kava', panera: 'panera', library: 'library', carofc: 'car' })[b.t] || (b.t === 'deep' && b.poi && P[b.poi] ? devKind(P[b.poi])?.[0] : null);
function blockPoint(b) {
  if (b.t === 'travel') return b.toZone && Z[b.toZone] ? { lat: Z[b.toZone].lat, lng: Z[b.toZone].lng, zone: b.toZone } : null;
  if (b.t === 'sleep' && !b.poi) { const x = (b.recon || []).find(x => x.st !== 'bad' && P[x.poi]); return x ? ptOf(P[x.poi]) : null; }
  return b.poi && P[b.poi] ? ptOf(P[b.poi]) : null;
}
// where a day begins: today = GPS / chosen zone; future days = the previous day's last stop (usually the sleep spot)
function dayOrigin(day) {
  if (day.date <= today()) {
    const z = zoneOverride();
    if (z) return { pt: here(), label: z.n + ' (chosen zone)' };
    return { pt: here(), label: liveLoc() ? 'where you are' : S.loc ? `your last fix (${fmtAgo(S.loc.t)})` : 'the default area' };
  }
  for (let i = 1; i <= 14; i++) {
    const prev = getDay(addDays(day.date, -i));
    if (!prev) continue;
    for (let j = prev.blocks.length - 1; j >= 0; j--) {
      const b = prev.blocks[j], pt = b.st !== 'skip' && BT[b.t] && blockPoint(b);
      if (pt) return { pt, label: b.poi && P[b.poi] ? P[b.poi].n : b.t === 'sleep' ? 'last night’s spot area' : Z[b.toZone]?.n || 'yesterday’s last stop', fromPrev: true };
    }
  }
  return { pt: here(), label: 'current area' };
}
// Walk a day: compute times, drive legs, warnings, and optionally auto-pick places.
// Today follows him: the first unfinished block starts from his live GPS position, and that position becomes the day's
// area until a Travel / Storage block moves it. Auto-picked places that are now far from the area are stale and get
// re-picked (pinned picks stay, with a warning + "Pick one near me"). Night-spot recon targets left in another town
// are re-picked too. rows.moved = how many blocks were re-picked because he moved.
function flow(day, assign) {
  if (!day) return [];
  const now = Date.now(), isToday = day.date === today(), clamp = day.date <= today();
  const liveAt = isToday ? liveLoc() : null;
  let t = dateTs(day.date, day.startMin ?? 480), from = dayOrigin(day).pt, anchor = from, atLive = false, moved = 0;
  const usedIndoor = new Set(), usedKinds = new Set(), usedPois = new Set();
  let prevKind = null;
  const rows = [];
  for (const b of day.blocks) {
    const def = BT[b.t], r = { b, warn: [], acts: [] };
    if (!def || b.st === 'skip') { r.skip = true; rows.push(r); continue; }
    if (liveAt && !atLive && b.st !== 'done') { atLive = true; from = anchor = liveAt; }
    if (b.t === 'travel') {
      const to = blockPoint(b);
      r.miles = to ? hav(from, to) : 0;
      if (!b.durSet) b.dur = to ? round5(r.miles * 1.3 / 55 * 60 + 10) : 60;
      if (to && r.miles < 3) r.warn.push('Already in this zone');
    }
    // picks start from the previous stop, unless that stop is far outside the day's area (e.g. a pinned place in the old town)
    const pickFrom = hav(from, anchor) > 20 ? anchor : from;
    if (b.t === 'sleep') {
      if (assign && b.st === 'plan' && !b.confirmed) {
        const known = (b.recon || []).filter(x => P[x.poi]), todo = known.filter(x => x.st === 'todo');
        const stale = todo.length && todo.every(x => hav(pickFrom, ptOf(P[x.poi])) > 20) && !known.some(x => x.st === 'good');
        if (assign === 'all' || !known.length || stale) { b.recon = pickRecon(b, pickFrom, Math.max(t, clamp ? now : 0), anchor); if (stale) moved++; }
      }
    } else if (assign && b.st === 'plan' && def.m) {
      const cur = b.poi && P[b.poi], cpt = cur && ptOf(cur);
      const stale = cur && !b.pinned && cpt && hav(anchor, cpt) > staleMi(b.t);
      if (assign === 'all' ? !b.pinned || !cur : !cur || stale) {
        const at = Math.max(t, clamp ? now : 0) + 10 * MIN;
        const avoid = WORK_T.has(b.t) ? usedIndoor : null; // no marathons: each indoor work venue once a day
        // mix spots across the day: a dev session goes somewhere new, ideally a different kind of place than the last block
        const adj = /^water/.test(b.t) ? p => (usedPois.has(p.id) ? -8 : 0) : b.t === 'deep' ? p => (usedPois.has(p.id) ? -14 : 0) + (devKind(p)[0] === prevKind ? -10 : usedKinds.has(devKind(p)[0]) ? -4 : 0) : null;
        const best = rank(b.t, { from: pickFrom, at, dur: b.dur, anchor, avoid, adj })[0];
        // everyday blocks stay local; if the only match is far away, leave it open and say where the nearest is
        const tooFar = best && LOCAL_T.has(b.t) && hav(anchor, ptOf(best.p)) > 15;
        const was = b.poi;
        b.poi = best && !tooFar ? best.p.id : null;
        b.far = tooFar ? best.p.id : null;
        if (!cur) b.pinned = false;
        if (stale && b.poi !== was) moved++;
      }
    }
    const ns = def.night ? nextSleep(day, b) : null;
    const dest = def.night ? (ns ? blockPoint(ns) : null) : blockPoint(b);
    if (b.t !== 'travel') { r.miles = dest ? hav(from, dest) : 0; r.travel = driveMin(r.miles); } else r.travel = 0;
    if (b.st === 'done') { r.s = b.s0 ?? t; r.e = b.s1 ?? r.s + b.dur * MIN; }
    else if (b.st === 'active') { r.s = b.s0 ?? now; r.e = Math.max(r.s + b.dur * MIN, now); r.over = now > r.s + b.dur * MIN; }
    else {
      const ready = Math.max(t + r.travel * MIN, clamp ? now : 0);
      r.s = b.at != null ? Math.max(ready, dateTs(day.date, b.at)) : ready;
      r.gap = (r.s - ready) / MIN;
      r.e = r.s + b.dur * MIN;
    }
    if (b.st !== 'done') blockWarnings(b, r);
    if (b.st === 'plan' && dest && b.t !== 'travel' && b.t !== 'storage' && !def.night) {
      const away = hav(anchor, dest);
      if (b.t === 'sleep' && b.confirmed) { if (away > 30) { r.warn.push(`Tonight’s spot is ${Math.round(away)} mi from ${atLive ? 'you' : 'the day’s area'}`); r.acts.push(['nightNear', 'Find spots near me']); } }
      else if (b.pinned && b.poi && away > staleMi(b.t)) { r.warn.push(`${Math.round(away)} mi from ${atLive ? 'where you are' : 'the day’s area'}`); r.acts.push(['repick', 'Pick one near me']); }
      else if (away > 15) r.warn.push(`Nearest ${lc(def.n)} in the data is ${Math.round(away)} mi out`);
    }
    t = r.e;
    if (dest) from = dest;
    if ((b.t === 'travel' || b.t === 'storage') && dest) anchor = dest;
    if (b.poi && WORK_T.has(b.t)) usedIndoor.add(b.poi);
    const k = blockKind(b); if (k) usedKinds.add(k);
    prevKind = k; if (b.poi) usedPois.add(b.poi);
    rows.push(r);
  }
  rows.moved = moved;
  if (isToday) day._rows = rows;
  return rows;
}
// he moved: re-pick today's stale places around where he is. Future days are NOT touched: they're built logically from
// the plan itself (the previous day's last stop, Travel blocks), and only re-pick when he edits them.
function reanchor() {
  const d = getDay(today());
  const n = d ? flow(d, 'missing').moved || 0 : 0;
  if (n) save();
  return n;
}
function blockWarnings(b, r) {
  const p = b.poi && P[b.poi];
  if (p) {
    r.fit = fit(p, r.s, b.t === 'sleep' ? 0 : b.dur);
    const sunsetGate = p.h && /sunset|dusk|daylight/.test(p.h.join(' '));
    if (r.fit.k === 'closed') r.warn.push(b.t === 'sleep' ? `Business closed overnight (${r.fit.txt.replace('Closed · ', '')}): lot only, no restroom` : 'Closed at that time (' + r.fit.txt.replace('Closed · ', '') + ')');
    else if (r.fit.k === 'short') r.warn.push((sunsetGate ? 'Gate closes around sunset: ' : '') + r.fit.txt + ` of ${fmtDur(b.dur)}`);
    if (/temporarily_closed|announced_not_open/.test(p.st || '')) r.warn.push('Listed as temporarily closed');
    if (b.t === 'sleep') { const ln = lastNight(p.id); if (ln && Date.now() - ln < 3 * DAY) r.warn.push('You slept here ' + fmtAgo(ln) + '. Rotate?'); }
  } else if (b.t === 'sleep') { if (!(b.recon || []).some(x => P[x.poi])) { r.warn.push('No night spot options yet'); r.acts.push(['addPlaceFor', 'Add a spot you know']); } }
  else if (BT[b.t].m && b.t !== 'travel') { r.warn.push(b.far && P[b.far] ? `No ${lc(BT[b.t].n)} within 15 mi (nearest: ${P[b.far].n}, ${P[b.far].city || ''})` : `No ${lc(BT[b.t].n)} in the data near here`); r.acts.push(['addPlaceFor', 'Add a place']); }
  if (b.t === 'social') {
    const dow = new Date(r.s).getDay();
    if (dow === 0) r.warn.push('Sunday night: skip the bars and rest?');
    else if (p && dow >= 1 && dow <= 4 && !specialsAt(p, r.s).today.length) r.warn.push('No known specials here tonight');
  }
  if (b.t === 'dash') {
    const z = zoneOfPoint((p && ptOf(p)) || here()), wins = (D.dd[z?.id] || []).flatMap(m => m.win || []);
    const s = new Date(r.s), sm = s.getHours() * 60 + s.getMinutes(), em = sm + b.dur;
    const inWin = wins.some(w => { const [a, c] = w.split('-').map(x => { const [h, m] = x.split(':'); return +h * 60 + +m; }); return sm < c && em > a; });
    if (wins.length && !inWin) r.warn.push('Outside the peak windows (' + wins.join(', ') + ')');
  }
  if (b.t !== 'sleep' && new Date(r.e).getHours() >= 2 && new Date(r.e).getHours() < 6 && r.e - r.s < 12 * HOUR) r.warn.push('Runs past 2am');
}
function autofill(day, all) { flow(day, all ? 'all' : 'missing'); save(); }
// swap a block's place for the best candidate that actually fits its time slot
function fixBlock(day, b) {
  const rows = flow(day), r = rows.find(x => x.b === b);
  if (!r) return null;
  const alt = rank(b.t, { from: startPoint(day, b, rows), at: r.s, dur: b.dur }).find(c => c.f.k === 'ok' && c.p.id !== b.poi);
  if (alt) { b.poi = alt.p.id; b.pinned = false; save(); }
  return alt;
}
// where he'll be coming from when this block starts (today: live GPS for the first unfinished block)
function startPoint(day, b, rows = flow(day)) {
  const liveAt = day.date === today() ? liveLoc() : null;
  const first = rows.findIndex(y => !y.skip && y.b.st !== 'done');
  let pt = dayOrigin(day).pt;
  for (let i = 0; i < rows.length; i++) {
    const x = rows[i];
    if (liveAt && i === first) pt = liveAt;
    if (x.b === b) break;
    const q = !x.skip && !BT[x.b.t]?.night && blockPoint(x.b); if (q) pt = q;
  }
  return pt;
}

// ---------- coverage + data packs
function coverage(pt = S.loc) {
  if (!pt || !D) return { ok: true };
  const z = nearestZone(pt), mi = hav(pt, z);
  return { ok: mi <= 45, zone: z, mi };
}
function packPrompt(area) {
  const zones = D.zones.map(z => `${z.id} (${z.n})`).join('; ');
  return `You are a research worker extending my "Hey Jim" Florida lifestyle dataset (current data v${D.v}, researched ${D.researched}).

Target area: ${area}

${D.profile?.context || 'I live on the road in Florida as a game developer and delivery driver.'}

Return ONE downloadable JSON data pack. Real, currently open places only; unknown = null (never guess); every fact cites sources[] (url + retrieved_date).
Top-level arrays: zones, pois, capabilities, overnight_candidates, camping, mail_options, doordash_markets, sources, research_gaps (and optional poi_patches).
- zones[]: {id (kebab-case, new area only), name, region, center:{latitude,longitude}, route_order, timezone, recommended_stay_days:{min,max}, best_for[], weaknesses[]}. Existing zones (don't duplicate): ${zones}
- pois[]: {id "<zone_id>_<slug>", zone_id, name, category (waterfront|work|gym|food|social|overnight_candidate|car_maintenance|camping|mail|fun|shop|life_support), subcategory, address "street, city, FL zip", city, state, postal_code, latitude, longitude, website, phone, hours {monday..sunday: "HH:MM-HH:MM" | "11:00-14:00;17:00-21:00" | "16:00-02:00" | "sunrise-sunset" | "closed" | null}, amenities[] (restroom, parking, grill, shade, pavilion, pier, boat_ramp, beach_access, shower, wifi…), parking {free, notes}, tags[], traveler_notes, navigation {search_query "Name, street, city, FL zip"}, source_ids[],
  food_value {cuisine, asian, price_level 1-4, typical_meal_usd, rating, rating_count, rating_source, rating_checked, known_for_cheap, cheap_evidence} (ratings for ANY place),
  specials [{label, days ["tuesday"], start "HH:MM", end "HH:MM", items ["$5 Old Fashioned"], posted_date, checked_date, confidence official|social_post|third_party|review_mention, source_id}] (bar specials, meat-deal nights),
  bar_details {kind dive|hipster_dive|barcade|craft_beer|cocktail|live_music, vibe, games, food} (bars), work_details {wifi_advertised, outlets_confirmed, laptop_friendly, sells_kratom} (cafés/kava/tea)}
- capabilities[]: {id "<poi_id>__<cap>", poi_id, zone_id, capability, evidence_level documented|reported|inferred, assessment_note, conditions[], source_ids[]}. Caps: work_indoor, work_outdoors, wifi, gym, shower, sleep_candidate, tent_camp, paid_lodging, meal, protein_food, groceries, buy_drinking_water, laundry, mail, auto_parts, loan_tools, public_grill, restroom, recreation, fuel, vape. Every POI needs ≥1.
- overnight_candidates[] for car-sleep spots: {id, poi_id, zone_id, type walmart|planet_fitness|cracker_barrel|truck_stop|hotel_cluster|rest_area, status, gray_area, permission_status, notes, field_check[], assessment {priority inspect_first|alternative|extra_friction, rationale}}.

Per zone research: waterfront car-office spots (causeways, boat ramps, Intracoastal parks, beach lots: free parking, restrooms, shade, grills, gate hours); cafés, kava/tea bars (no kratom-first), Barnes & Noble / Books-A-Million cafés, Panera; Planet Fitness hours per day; 5+ overnight candidates (Walmart, Cracker Barrel, truck stops, hotel lots, PF lots, camping); cheap highly rated food (Asian first); dive bars with dated specials; Trader Joe's / Publix / Sprouts; laundromats; USPS General Delivery; auto parts (loan-a-tool); Murphy USA gas; springs, trails, oddities, big used bookstores.
Return only the JSON file plus a short list of research gaps.`;
}

// ---------- logging
function logEntry(k, min, extra = {}) {
  const e = Object.assign({ id: uid(), t: Date.now(), k, min: Math.round(min), z: zoneOfPoint(here())?.id }, extra);
  S.log.push(e); save(); return e;
}
function weekStart(ts = Date.now()) {
  const d = new Date(ts - 4 * HOUR); d.setHours(4, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; return d.getTime() - dow * DAY;
}
// mark a block done and log what it counts for (dev / water / car / run time, gym + shower, needs). Returns a toast message.
const LOG_LBL = { dev: 'game dev', water: 'on the water', car: 'car work', run: 'trail run', movie: 'at the movies' };
function completeBlock(b, end = Date.now(), auto) {
  const def = BT[b.t] || {};
  if (b.st !== 'active' || !b.s0) b.s0 = end - b.dur * MIN;
  b.s1 = Math.max(end, b.s0 + MIN); b.st = 'done';
  if (auto) b.auto = auto; else delete b.auto;
  const min = (b.s1 - b.s0) / MIN, ks = [].concat(def.log || []), extra = { t: b.s1, blk: b.id, ...(auto ? { auto: 1 } : {}), ...(b.poi && P[b.poi] ? { z: P[b.poi].z, poi: b.poi } : {}) };
  let msg = (def.n || 'Block') + ' done';
  const timed = ks.filter(x => LOG_LBL[x]);
  if (timed.length) { timed.forEach(x => logEntry(x, min, extra)); msg = `Logged ${fmtDur(min)} ${timed.map(x => LOG_LBL[x]).join(' + ')}`; }
  if (ks[0] === 'gym') { logEntry('gym', min, extra); S.last.shower = b.s1; msg = `${WORKOUTS[S.workout % 5].n} logged. Shower ✓`; S.workout = (S.workout + 1) % 5; }
  if (['shower', 'laundry', 'water_refill', 'groceries', 'mail'].includes(ks[0])) S.last[ks[0]] = b.s1;
  if (ks[0] === 'groceries') S.supplies = {};
  if (b.t === 'sleep' && b.poi && !b.confirmed) { S.nights.push({ poi: b.poi, t: b.s1 }); msg = 'Night logged. Rotation updated.'; }
  return msg;
}
function weekStats(ws = weekStart()) {
  const we = ws + 7 * DAY, s = { dev: 0, dash: 0, gym: 0, car: 0, run: 0, movies: 0, water: 0, waterDays: new Set(), gross: 0, miles: 0, gas: 0, dashActive: 0 };
  for (const e of S.log) {
    if (e.del || e.t < ws || e.t >= we) continue;
    if (e.k === 'run') s.run++;
    if (e.k === 'movie') s.movies++;
    if (e.k === 'dev') s.dev += e.min;
    if (e.k === 'dash') { s.dash += e.min; s.gross += e.gross || 0; s.miles += e.miles || 0; s.gas += e.gas || 0; s.dashActive += e.active || 0; }
    if (e.k === 'gym') s.gym++;
    if (e.k === 'car') s.car++;
    if (e.k === 'water') { s.water += e.min; if (e.min >= 40) s.waterDays.add(dayKey(e.t)); }
  }
  return s;
}

// ---------- activity: GPS breadcrumbs (while the app is open), iPhone Shortcut pings (car on/off), usage events and errors.
// Kept 14 days on the phone; uploaded one file per day to heyjim-data/activity/<date>.json so his usage can be analyzed.
const ACT = Object.assign({ pts: [], ev: [], pings: [], up: {}, seen: {}, pingT: 0, pushT: 0 }, store.get('act', {}));
let actT;
function actSave() { clearTimeout(actT); actT = setTimeout(() => store.set('act', ACT), 500); }
function actTrim() {
  const cut = Date.now() - 14 * DAY;
  for (const k of ['pts', 'ev', 'pings']) { ACT[k] = ACT[k].filter(x => (x.t2 || x.t) > cut); if (ACT[k].length > 5000) ACT[k] = ACT[k].slice(-5000); }
  for (const k of Object.keys(ACT.seen)) if (ACT.seen[k].t < cut) delete ACT.seen[k];
}
function trackEvent(e, data) {
  ACT.ev.push(Object.assign({ t: Date.now(), e }, data));
  if (ACT.ev.length > 6000) actTrim();
  ACT.dirty = 1; actSave();
}
function logError(err, ctx) {
  const m = String(err?.message || err), s = String(err?.stack || '').split('\n').slice(0, 4).join(' | ');
  try { trackEvent('err', { m: m.slice(0, 300), s: s.slice(0, 600), c: ctx }); } catch {}
}
// stationary points extend the last crumb (t → t2), so a crumb is a stay: [t, t2] at lat/lng
function trackPoint(l) {
  if (!S.settings.autotrack || !l) return;
  const now = Date.now(), last = ACT.pts[ACT.pts.length - 1];
  // same spot again: extend the stay (overnight gaps too: seen at 11pm and 7am in the same lot = slept there)
  const gap = now - (last?.t2 || last?.t || 0);
  if (last && hav(last, l) < 0.07 && (gap < 3 * HOUR || (gap < 11 * HOUR && spansNight(last.t2 || last.t, now)))) { last.t2 = now; if (l.acc < (last.acc || 1e9)) Object.assign(last, { lat: l.lat, lng: l.lng, acc: l.acc }); }
  else if (!last || now - (last.t2 || last.t) > 45000) ACT.pts.push({ t: now, t2: now, lat: l.lat, lng: l.lng, acc: l.acc });   // driving: ~1 crumb a minute
  else return;
  ACT.dirty = 1; actSave();
}
const monthKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
// Shortcut ping file names: pings/<yyyy-MM>/<yyyyMMdd-HHmmss±zzzz>_<on|off>_<lat>_<lng>.txt  (the name is the data)
function parsePing(name) {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})([+-]\d{2}:?\d{2}|Z)?_([a-z]+)_(-?\d+(?:[.,]\d+)?)_(-?\d+(?:[.,]\d+)?)/i);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz, ev, la, ln] = m;
  let t;
  if (tz && tz !== 'Z') { const sg = tz[0] === '-' ? -1 : 1, hh = +tz.slice(1, 3), mm = +tz.slice(-2); t = Date.UTC(+y, mo - 1, +d, +h, +mi, +s) - sg * (hh * 60 + mm) * MIN; }
  else t = tz === 'Z' ? Date.UTC(+y, mo - 1, +d, +h, +mi, +s) : new Date(+y, mo - 1, +d, +h, +mi, +s).getTime();
  const lat = parseFloat(la.replace(',', '.')), lng = parseFloat(ln.replace(',', '.'));
  if (!isFinite(t) || !isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90) return null;
  const out = { t, ev: ev.toLowerCase(), lat, lng, name };
  // Apple Pay pings carry _<amount>_<merchant> after the coordinates
  const rest = name.slice(m[0].length).replace(/\.txt$/i, '');
  if (out.ev === 'pay' && rest.startsWith('_')) {
    const [amt, ...mer] = rest.slice(1).split('_');
    const v = parseFloat(String(amt).replace(/[^\d.]/g, ''));
    if (isFinite(v)) out.amt = +v.toFixed(2);
    out.mer = mer.join(' ').replace(/[-+]+/g, ' ').trim().slice(0, 60);
  }
  return out;
}
async function pullPings(force) {
  if (!D?.sync || (!force && Date.now() - ACT.pingT < 2 * MIN)) return 0;
  ACT.pingT = Date.now();
  let added = 0;
  const have = new Set(ACT.pings.map(p => p.name));
  for (const mk of new Set([monthKey(Date.now()), monthKey(Date.now() - 3 * DAY)])) {
    try {
      const r = await ghApi('GET', null, `pings/${mk}`);
      if (r.status === 404) continue;
      if (!r.ok) throw new Error('pings ' + r.status);
      for (const f of await r.json()) { if (have.has(f.name)) continue; const p = parsePing(f.name); if (p) { ACT.pings.push(p); have.add(f.name); added++; } }
    } catch (e) { logError(e, 'pullPings'); }
  }
  if (added) { ACT.pings.sort((a, b) => a.t - b.t); ACT.pingsLast = Date.now(); actSave(); }
  return added;
}
// one file per day in the data repo; conflicts union by time so nothing is lost
async function actPush(force) {
  if (!D?.sync || !ACT.dirty || actPush.busy) return;
  if (Date.now() - ACT.pushT < (force ? MIN : 5 * MIN)) return;   // at most one commit a minute, even on every app switch
  actPush.busy = true; ACT.pushT = Date.now();
  try {
    actTrim();
    const since = ACT.pushedT || 0, days = new Set();
    for (const k of ['ev', 'pts', 'pings']) for (const x of ACT[k]) if ((x.t2 || x.t) >= since) days.add(dayKey(x.t));
    const stamp = Date.now();
    for (const d of [...days].sort()) {
      const pick = k => ACT[k].filter(x => dayKey(x.t) === d);
      let body = { date: d, v: 1, ev: pick('ev'), pts: pick('pts'), pings: pick('pings').map(({ name, ...p }) => p), visits: Object.values(ACT.seen).filter(v => dayKey(v.s || v.t) === d) };
      const put = () => ghApi('PUT', { message: `activity ${d}`, content: toB64(JSON.stringify(body) + '\n'), sha: ACT.up[d] || undefined }, `activity/${d}.json`);
      let r = await put();
      if (r.status === 409 || r.status === 422 || (r.status === 404 && ACT.up[d])) {
        const g = await ghApi('GET', null, `activity/${d}.json`);
        if (g.ok) {
          const j = await g.json(); ACT.up[d] = j.sha;
          try { const old = JSON.parse(fromB64(j.content || '')); const u = (a, b, k) => [...new Map([...(a || []), ...(b || [])].map(x => [k(x), x])).values()].sort((x, y) => x.t - y.t);
            body = { ...body, ev: u(old.ev, body.ev, x => x.t + x.e), pts: u(old.pts, body.pts, x => x.t), pings: u(old.pings, body.pings, x => x.t + x.ev) }; } catch {}
        } else delete ACT.up[d];
        r = await put();
      }
      if (!r.ok) throw new Error('activity ' + r.status);
      ACT.up[d] = (await r.json()).content.sha;
    }
    ACT.pushedT = stamp; ACT.dirty = 0; actSave();
  } catch (e) { ACT.err = e.message; }
  finally { actPush.busy = false; }
}

// ---------- auto-tracking: turn stays (breadcrumbs + car off/on pings) into what he did
// stays: [{s, e, lat, lng, src}] — a crumb that lasted, or the time between parking (off) and driving again (on)
function stays(since = Date.now() - 3 * DAY) {
  const out = [];
  for (const p of ACT.pts) if ((p.t2 || p.t) > since && (p.t2 || p.t) - p.t >= 15 * MIN) out.push({ s: p.t, e: p.t2, lat: p.lat, lng: p.lng, src: 'gps' });
  const pg = ACT.pings.filter(p => p.t > since - DAY);
  for (let i = 0; i < pg.length; i++) {
    if (pg[i].ev !== 'off') continue;
    const on = pg.slice(i + 1).find(p => p.ev === 'on');
    if (on && on.t - pg[i].t >= 10 * MIN && on.t - pg[i].t < 20 * HOUR) out.push({ s: pg[i].t, e: on.t, lat: pg[i].lat, lng: pg[i].lng, src: 'car' });
  }
  // the same stay seen by both sources: keep the car one (exact times), extended by any GPS overlap
  out.sort((a, b) => a.s - b.s);
  const merged = [];
  for (const x of out) {
    const m = merged.find(y => hav(y, x) < 0.15 && x.s < y.e + 20 * MIN && x.e > y.s - 20 * MIN);
    if (m) { if (x.src === 'car' && m.src !== 'car') Object.assign(m, { lat: x.lat, lng: x.lng, src: 'car' }); m.s = Math.min(m.s, x.s); m.e = Math.max(m.e, x.e); }
    else merged.push({ ...x });
  }
  return merged;
}
// what a stay at a place most likely was
function classifyStay(st) {
  const min = (st.e - st.s) / MIN, p = nearbyPoi(st, 0.1), night = spansNight(st.s, st.e);
  if (night && min >= 180) return { k: 'night', p, min };
  if (!p) return null;
  // a long stay at a PF lot is car-office work, not a 4h workout
  if (p.caps.gym && min >= 30 && min <= 150) return { k: 'gym', p, min, t: 'gym' };
  if (isRun(p) && min >= 25 && min <= 180) return { k: 'run', p, min, t: 'run' };
  if ((isCafe(p) || isPanera(p) || isLibrary(p) || isKava(p) || isBookCafe(p)) && min >= 40) return { k: 'dev', p, min, t: isPanera(p) ? 'panera' : isLibrary(p) ? 'library' : isKava(p) ? 'kava' : 'cafe' };
  if (isWater(p) && min >= 30) return { k: 'water', p, min, t: min >= 90 ? 'water_work' : 'water_s' };
  if (hasCap('laundry')(p) && min >= 40) return { k: 'laundry', p, min, t: 'laundry' };
  // restaurant waits during a DoorDash shift aren't meals
  if (isRestaurant(p) && min >= 20 && min <= 120 && !dashing(st.s)) return { k: 'meal', p, min, t: 'meal' };
  return null;
}
const dashing = ts => (getDay(dayKey(ts))?.blocks || []).some(b => b.t === 'dash' && (b.st === 'active' || (b.st === 'done' && b.s0 <= ts && ts <= (b.s1 || 0))));
// Apple Pay purchases (from the Transaction automation): what, where, which kind of spending
const SPEND_KINDS = [['Gas', /murphy|shell|chevron|exxon|mobil|\bbp\b|sunoco|circle k|racetrac|wawa|speedway|marathon|citgo|valero|pilot|flying j|love'?s|buc-?ee/i, p => isGas(p)],
  ['Groceries', /publix|aldi|trader joe|sprouts|whole foods|walmart|winn|target|kroger|food lion/i, p => !!p.caps.groceries],
  ['Food', /pizza|grill|cafe|coffee|restaurant|kitchen|diner|bbq|taco|sushi|pho|burger|chicken|panera|starbucks|dunkin|mcdonald|wendy|chick|subway|kava/i, p => p.c === 'food' || p.c === 'work' || p.c === 'social'],
  ['Gym', /planet fitness|fitness/i, p => !!p.caps.gym], ['Laundry', /laundr|wash/i, p => !!p.caps.laundry], ['Vape', /vape|smoke/i, p => !!p.caps.vape]];
function purchases(since = weekStart()) {
  return ACT.pings.filter(p => p.ev === 'pay' && p.t >= since).map(p => {
    const poi = nearbyPoi(p, 0.1);
    const kind = (SPEND_KINDS.find(([, rx, m]) => rx.test(p.mer || '') || (poi && m(poi))) || ['Other'])[0];
    return { ...p, poi, kind };
  });
}
const spansNight = (s, e) => { for (let t = s; t <= e; t += 30 * MIN) { const h = new Date(t).getHours(); if (h >= 1 && h < 6) return true; } return false; };
// several quick stops at restaurants within a few hours = a DoorDash shift
function dashRuns(sts) {
  const quick = sts.filter(x => x.e - x.s <= 15 * MIN && nearbyPoi(x, 0.1, isRestaurant)).sort((a, b) => a.s - b.s);
  const runs = [];
  for (const x of quick) { const r = runs[runs.length - 1]; if (r && x.s - r.e < 60 * MIN) { r.e = x.e; r.n++; } else runs.push({ s: x.s, e: x.e, n: 1 }); }
  return runs.filter(r => r.n >= 3);
}
// Apply finished stays to the timeline. Returns the list of things it logged (for a toast / the Today card).
function autoTrack() {
  if (!S.settings.autotrack || !D) return [];
  const done = [], sts = stays(), now = Date.now(), liveAt = liveLoc(20 * MIN);
  for (const st of sts) {
    const key = 'st' + Math.round(st.s / MIN);
    if (ACT.seen[key]) continue;
    const ongoing = liveAt && hav(liveAt, st) < 0.1 && now - st.e < 20 * MIN;
    if (ongoing) continue;                 // still there: handled by arrive/leave below
    const c = classifyStay(st);
    ACT.seen[key] = { t: now, s: st.s, e: st.e, k: c?.k || null, poi: c?.p?.id || null, src: st.src };
    if (!c) continue;
    const date = dayKey(st.s);
    if (c.k === 'night') {
      if (c.p && !S.nights.some(n => !n.del && n.day === date)) { S.nights.push({ poi: c.p.id, t: st.e, day: date, auto: 1 }); done.push(`Night at ${c.p.n}`); }
      else if (!c.p) { ACT.seen[key].ask = 'night'; ACT.seen[key].lat = st.lat; ACT.seen[key].lng = st.lng; }
      continue;
    }
    const day = getDay(date);
    // a planned block of the same kind at the same place (or no place yet) → mark it done with the real times
    let b = day?.blocks.find(x => (x.st === 'plan' || x.st === 'active') && (x.poi === c.p.id || (!x.poi && x.t === c.t)) && (BT[x.t]?.m?.(c.p) || x.t === c.t));
    if (!b) {
      const d = ensureDay(date);
      b = { id: uid(), t: c.t, dur: Math.round(c.min), st: 'plan', poi: c.p.id, pinned: true };
      const at = d.blocks.findIndex(x => x.st !== 'done' && !(x.s0 && x.s0 < st.s));
      d.blocks.splice(at < 0 ? d.blocks.length : at, 0, b);
      const si = d.blocks.findIndex(x => x.t === 'sleep'); if (si >= 0 && si < d.blocks.length - 1) d.blocks.push(...d.blocks.splice(si, 1));
    }
    b.poi = c.p.id; b.s0 = st.s; b.st = 'active';
    completeBlock(b, st.e, st.src);
    done.push(`${BT[b.t].n}: ${c.p.n} (${fmtDur(c.min)})`);
  }
  for (const r of dashRuns(sts)) {
    const key = 'dd' + Math.round(r.s / MIN);
    if (ACT.seen[key] || now - r.e < 30 * MIN) continue;
    ACT.seen[key] = { t: now, s: r.s, e: r.e, k: 'dash', ask: 'dash', n: r.n };
  }
  if (done.length) save();
  actSave();
  return done;
}
// arrive / leave while the app is open: start the next planned block when he's at its place; finish the active one when he's left
function arriveLeave() {
  const l = liveLoc(10 * MIN), day = getDay(today());
  if (!S.settings.autotrack || !l || (l.acc || 0) > 250 || !day) return null;
  const act = day.blocks.find(b => b.st === 'active' && b.poi && P[b.poi] && ptOf(P[b.poi]) && !BT[b.t]?.night);
  const apt = act && ptOf(P[act.poi]);
  // only end it if he was actually there during the block (he may have tapped Start before driving over)
  const wasThere = apt && (act.auto === 'arrived' || ACT.pts.some(p => (p.t2 || p.t) > act.s0 && hav(p, apt) < 0.12) || ACT.pings.some(p => p.t > act.s0 - 10 * MIN && hav(p, apt) < 0.2));
  if (act && wasThere && hav(l, apt) > 0.3 && Date.now() - act.s0 > 15 * MIN) {
    const pt = apt;
    const on = ACT.pings.find(p => p.ev === 'on' && p.t > act.s0 && hav(p, pt) < 0.2);
    const seen = ACT.pts.filter(p => (p.t2 || p.t) > act.s0 && hav(p, pt) < 0.12).reduce((a, p) => Math.max(a, p.t2 || p.t), act.s0);
    const end = on ? on.t : Math.max(seen, Math.min(act.s0 + act.dur * MIN, Date.now()));
    const msg = completeBlock(act, end, 'left');
    save();
    return { kind: 'left', b: act, msg };
  }
  if (act) return null;
  const next = day.blocks.find(b => b.st === 'plan' && b.poi && P[b.poi] && BT[b.t]?.m);
  if (next && hav(l, ptOf(P[next.poi])) < 0.1 && !next.noAuto) {
    const arrived = ACT.pts.filter(p => hav(p, l) < 0.1 && (p.t2 || p.t) > Date.now() - 6 * HOUR).reduce((a, p) => Math.min(a, p.t), Date.now());
    const off = ACT.pings.filter(p => p.ev === 'off' && hav(p, l) < 0.2 && p.t > Date.now() - 6 * HOUR).pop();
    next.st = 'active'; next.s0 = off ? off.t : arrived; next.auto = 'arrived';
    save();
    return { kind: 'arrived', b: next };
  }
  return null;
}

// ---------- look up any place (OpenStreetMap via Photon: free, no key, CORS-enabled)
const PHOTON = 'https://photon.komoot.io';
async function photon(path) {
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 12000);
  try { const r = await fetch(PHOTON + path, { signal: ctl.signal }); if (!r.ok) throw new Error('lookup failed (' + r.status + ')'); return (await r.json()).features || []; }
  finally { clearTimeout(tm); }
}
function photonPlace(f) {
  const p = f.properties || {}, [lng, lat] = f.geometry?.coordinates || [];
  const street = [p.housenumber, p.street].filter(Boolean).join(' '), city = p.city || p.town || p.village || p.district || '';
  const st = p.state === 'Florida' ? 'FL' : p.state || '';
  return { n: p.name || street || 'Unnamed spot', a: [street, city, [st, p.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', '), city, lat, lng,
    osm: (p.osm_type || '') + (p.osm_id || ''), key: p.osm_key, val: p.osm_value };
}
async function searchPlaces(q, near = here()) {
  return (await photon(`/api/?q=${encodeURIComponent(q)}&lat=${near.lat.toFixed(4)}&lon=${near.lng.toFixed(4)}&limit=15`)).map(photonPlace).filter(x => x.lat != null);
}
async function placesAround(pt) {
  const list = (await photon(`/reverse?lat=${pt.lat.toFixed(5)}&lon=${pt.lng.toFixed(5)}&limit=15&radius=0.5`)).map(photonPlace);
  return list.filter(x => x.lat != null && x.key !== 'highway' && x.key !== 'place' && x.key !== 'boundary');
}
function guessKind(x) {
  const n = (x.n || '').toLowerCase(), v = x.val || '', k = x.key || '';
  if (/walmart/.test(n)) return 'walmart';
  if (/cracker barrel/.test(n)) return 'cracker';
  if (/pilot|flying j|love'?s travel|travel ?center|petro |truck stop/.test(n)) return 'truck';
  if (/planet fitness/.test(n) || v === 'fitness_centre') return 'gym';
  if (k === 'tourism' && /hotel|motel|guest_house|hostel/.test(v)) return 'hotel';
  if (v === 'camp_site' || v === 'caravan_site') return 'camp';
  if (/kava|tea house|teahouse/.test(n)) return 'kava';
  if (v === 'cafe' || /coffee|café|cafe/.test(n)) return 'cafe';
  if (v === 'library') return 'library';
  if (/pizz/.test(n)) return 'pizza';
  if (v === 'cinema' || (/cinema|theatre|theater|drive-in/.test(n) && k === 'amenity')) return 'movie';
  if (v === 'amusement_arcade' || /arcade|pinball/.test(n)) return 'arcade';
  if (['restaurant', 'fast_food', 'food_court'].includes(v)) return 'food';
  if (['bar', 'pub', 'nightclub', 'biergarten'].includes(v)) return 'bar';
  if (['supermarket', 'grocery', 'greengrocer'].includes(v)) return 'groc';
  if (v === 'fuel') return 'gas';
  if (v === 'laundry' || v === 'dry_cleaning') return 'laundry';
  if (v === 'nature_reserve' || /trail|preserve/.test(n)) return 'run';
  if (/beach|marina|slipway|pier/.test(v) || /beach|landing|boat ramp|pier|causeway/.test(n) || v === 'park') return 'water';
  if (v === 'parking') return 'lot';
  return 'other';
}

// ---------- directions
const destOf = p => p.q || p.a || `${p.lat},${p.lng}`;
function zoneDest(z) { return `${z.lat},${z.lng}`; }
function webDir(ds) {
  let u = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(ds[ds.length - 1]);
  if (ds.length > 1) u += '&waypoints=' + ds.slice(0, -1).map(encodeURIComponent).join('%7C');
  return u;
}
function openUrl(u) {
  if (/^https?:/.test(u)) window.open(u, '_blank', 'noopener'); else location.href = u;
}
function navigate(ds, mode = S.settings.maps) {
  ds = ds.filter(Boolean);
  if (!ds.length) return;
  if (mode === 'gapp') return openUrl('comgooglemaps://?daddr=' + ds.map(encodeURIComponent).join('+to:') + '&directionsmode=driving');
  if (mode === 'apple') return openUrl('https://maps.apple.com/?daddr=' + encodeURIComponent(ds[ds.length - 1]) + '&dirflg=d');
  openUrl(webDir(ds));
}
const mapsSearch = p => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(destOf(p));

// ---------- weather (Open-Meteo) + NWS alerts, cached
const WXC = c => c === 0 ? ['Clear', '☀️'] : c <= 2 ? ['Partly cloudy', '⛅'] : c === 3 ? ['Cloudy', '☁️'] : c <= 48 ? ['Fog', '🌫️'] : c <= 57 ? ['Drizzle', '🌦️'] : c <= 67 ? ['Rain', '🌧️'] : c <= 77 ? ['Snow', '❄️'] : c <= 82 ? ['Showers', '🌦️'] : ['Storms', '⛈️'];
async function getWeather(pt) {
  const key = `${pt.lat.toFixed(1)},${pt.lng.toFixed(1)}`, c = store.get('wx');
  if (c && c.key === key && Date.now() - c.t < 30 * MIN) return c.d;
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${pt.lat.toFixed(3)}&longitude=${pt.lng.toFixed(3)}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=2`;
  try {
    const d = await (await fetch(u)).json();
    if (!d.current) throw 0;
    store.set('wx', { key, t: Date.now(), d });
    return d;
  } catch { return c?.d || null; }
}
async function getAlerts(pt) {
  const key = `${pt.lat.toFixed(2)},${pt.lng.toFixed(2)}`, c = store.get('nws');
  if (c && c.key === key && Date.now() - c.t < 15 * MIN) return c.d;
  try {
    const j = await (await fetch(`https://api.weather.gov/alerts/active?point=${pt.lat.toFixed(4)},${pt.lng.toFixed(4)}`, { headers: { Accept: 'application/geo+json' } })).json();
    const d = (j.features || []).map(f => f.properties).filter(a => a.status === 'Actual' && a.messageType !== 'Cancel')
      .map(a => ({ ev: a.event, head: a.headline, sev: a.severity, ends: a.ends || a.expires, desc: a.description, ins: a.instruction }));
    store.set('nws', { key, t: Date.now(), d });
    return d;
  } catch { return c?.d || []; }
}
function wxInsights(w) {
  if (!w) return [];
  const out = [], H = w.hourly, now = Date.now();
  const idx = H.time.map((t, i) => [new Date(t + ':00').getTime(), i]);
  const next3 = idx.filter(([t]) => t >= now - HOUR && t <= now + 3 * HOUR).map(([, i]) => i);
  const night = idx.filter(([t]) => { const h = new Date(t).getHours(); return t > now - HOUR && t < now + 20 * HOUR && (h >= 22 || h <= 6); }).map(([, i]) => i);
  const rainSoon = Math.max(0, ...next3.map(i => H.precipitation_probability[i] ?? 0));
  const stormSoon = next3.some(i => H.weather_code[i] >= 95);
  const feels = w.current.apparent_temperature;
  if (stormSoon) out.push('⛈️ Storms in the next few hours: indoor block first, avoid parking under trees.');
  else if (rainSoon >= 60) out.push(`🌧️ ${rainSoon}% rain soon: do an indoor block first, laptop stays in the car.`);
  if (feels >= 98) out.push(`🥵 Feels ${Math.round(feels)}°: AC blocks midday; do water blocks early or near sunset.`);
  if (night.length) {
    const nf = Math.max(...night.map(i => H.apparent_temperature[i])), nl = Math.min(...night.map(i => H.temperature_2m[i]));
    const nr = Math.max(...night.map(i => H.precipitation_probability[i] ?? 0));
    if (nf >= 84) out.push(`🌙 Hot night (feels ${Math.round(nf)}° at bedtime): stay in the 24h PF late, windows cracked + fan, park in open air.`);
    else if (nf >= 76) out.push(`🌙 Muggy night, low ${Math.round(nl)}°: crack windows with bug screens, run the fan.`);
    else if (nl <= 50) out.push(`🌙 Cool night, low ${Math.round(nl)}°: layers + blanket.`);
    else out.push(`🌙 Comfortable night, low ${Math.round(nl)}°.`);
    if (nr >= 50) out.push(`☔ ${nr}% rain overnight: pick a lot that drains well; windows mostly up.`);
  }
  const uv = w.daily.uv_index_max?.[0];
  if (uv >= 8 && new Date().getHours() < 16) out.push(`🧴 UV ${Math.round(uv)} today: shade for the laptop, sunscreen for you.`);
  return out;
}
