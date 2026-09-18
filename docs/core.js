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
  settings: { theme: 'auto', maps: 'gapp', club: true, tent: true, hotel: false, name: '' },
  fav: {}, avoid: {}, obs: [], last: {}, nights: [], days: {}, log: [], wishes: [],
  workout: 0, supplies: {}, zone: null, loc: null,
};
let S = Object.assign(structuredClone(DEFAULT_STATE), store.get('state', {}));
S.settings = Object.assign({}, DEFAULT_STATE.settings, S.settings);
let saveT;
function save() { clearTimeout(saveT); saveT = setTimeout(() => store.set('state', S), 120); }
function saveNow() { clearTimeout(saveT); store.set('state', S); }

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
function indexData(data) {
  D = data;
  for (const z of D.zones) Z[z.id] = z;
  for (const p of D.pois) {
    P[p.id] = p;
    p.caps ||= {}; p.am ||= []; p.tags ||= []; p.x ||= {};
    p._z = Z[p.z];
    p._ov = D.ovn[p.id]?.[0]; p._camp = D.camp[p.id]?.[0]; p._mail = D.mail[p.id]?.[0];
    p._rec = D.rec[p.id]?.[0]; p._food = D.food[p.id]?.[0];
    p._txt = [p.n, p.city, p.a, p.sc, p.c, p.tags.join(' '), p._z?.n].join(' ').toLowerCase();
  }
  // DoorDash market hotspots point at restaurant POIs
  for (const [zid, ms] of Object.entries(D.dd || {})) for (const m of ms) { m.z = zid; for (const s of m.subs || []) if (s.poi && P[s.poi]) P[s.poi]._dd = m; }
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
function nearestZone(pt) {
  let best = null, bd = 1e9;
  for (const z of D.zones) { const d = hav(pt, z); if (d < bd) { bd = d; best = z; } }
  return best;
}
function here() {
  if (S.zone && Z[S.zone]) return { lat: Z[S.zone].lat, lng: Z[S.zone].lng, zone: S.zone };
  if (S.loc) return S.loc;
  return { lat: 28.793, lng: -81.307, zone: 'sanford-lake-mary' };
}
function locate(fresh) {
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(pos => {
      S.loc = { lat: pos.coords.latitude, lng: pos.coords.longitude, t: Date.now(), acc: Math.round(pos.coords.accuracy || 0) };
      save(); res(S.loc);
    }, () => res(null), { enableHighAccuracy: !!fresh, timeout: 12000, maximumAge: fresh ? 0 : 5 * MIN });
  });
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
  signal: ['📶 Good signal', 1], nosignal: ['📵 Bad signal', -1], outlets: ['🔌 Outlets', 1], shade: ['🌳 Shade', 1],
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
function lastNight(id) { let t = 0; for (const n of S.nights) if (n.poi === id && n.t > t) t = n.t; return t; }
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
  if (p.sc === 'fast_food') s -= 1;
  return s;
}
// bar specials on a given moment (in the bar's timezone): {today: [...], now: special|null}
function specialsAt(p, ts = Date.now()) {
  if (!p.sp?.length) return { today: [], now: null };
  const { dow, min } = tzParts(new Date(ts), p.ct);
  const today = p.sp.filter(x => !x.d?.length || x.d.includes(dow));
  const hm = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const now = today.find(x => x.s && x.e && min >= hm(x.s) && min < (hm(x.e) <= hm(x.s) ? hm(x.e) + 1440 : hm(x.e))) || null;
  return { today, now };
}
const dayNames = ds => { const n = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; return ds?.length ? ds.map(d => n[d]).join('/') : 'Daily'; };
function barBonus(p, at) {
  const dow = new Date(at).getDay(), sp = specialsAt(p, at);
  let s = sp.now ? 8 : sp.today.length ? 4 : 0;
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
  meal: { n: 'Meal', ic: '🍜', dur: 50, m: p => p.c === 'food' && !/walmart|grocery|trader|publix|sprouts|whole_foods/i.test((p.sc || '') + p.n) && !!(p.caps.meal || p.caps.protein_food || p.caps.ramen || p.caps.buffet || p.caps.all_you_can_eat), b: (p, at) => valueScore(p) + (p.caps.ramen ? 1 : 0) + (specialsAt(p, at).today.length ? 4 : 0), caps: ['meal', 'protein_food', 'ramen', 'buffet'], hint: 'Protein first. A good Dash can fund this.' },
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
  carofc: { n: 'Car office', ic: '🚙', dur: 120, log: 'dev', hint: 'Work from the car wherever you\'re parked (usually tonight\'s spot): inverter + hotspot, windows cracked.' },
  free: { n: 'Free time', ic: '✨', dur: 60, hint: 'Unplanned. Wander, rest, whatever.' },
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
const MAX_MI = { fun: 70, social: 60, sleep: 40 };
function rank(type, { from = here(), at = Date.now(), dur, avoid, anchor, maxMi, adj } = {}) {
  const def = BT[type];
  if (!def?.m) return [];
  if (dur == null) dur = def.dur;
  maxMi ??= MAX_MI[type] || 45;
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
  const keep = (b.recon || []).filter(x => x.st !== 'todo');
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
const LOCAL_T = new Set(['gas', 'kava', 'cafe', 'panera', 'library', 'office', 'deep', 'light', 'water_s', 'water_work', 'water_l', 'meal', 'restroom', 'water', 'groc']);
const WORK_T = new Set(['kava', 'cafe', 'panera', 'library', 'office', 'deep', 'light']);
// work sessions are 2–4h; their duration stepper moves in 30m steps
const WORK_BLOCKS = new Set(['kava', 'water_work', 'water_l', 'cafe', 'panera', 'library', 'office', 'deep', 'carofc', 'dash', 'car']);
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
function getDay(date) { return S.days[date] || null; }
function newDay(tplId, date = today()) {
  const tpl = TEMPLATES.find(t => t.id === tplId) || TEMPLATES[0];
  const blocks = tpl.b.map(mkBlock);
  const isToday = date === today();
  const now = new Date();
  const startMin = isToday ? now.getHours() * 60 + now.getMinutes() + (now.getHours() < 4 ? 1440 : 0) : 8 * 60;
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
  if (day.date <= today()) return { pt: S.zone ? here() : (S.loc || here()), label: S.zone ? Z[S.zone].n : 'your location' };
  for (let i = 1; i <= 14; i++) {
    const prev = getDay(addDays(day.date, -i));
    if (!prev) continue;
    for (let j = prev.blocks.length - 1; j >= 0; j--) {
      const b = prev.blocks[j], pt = b.st !== 'skip' && blockPoint(b);
      if (pt) return { pt, label: b.poi ? P[b.poi].n : b.t === 'sleep' ? 'last night’s spot area' : Z[b.toZone]?.n || 'yesterday’s last stop', fromPrev: true };
    }
  }
  return { pt: here(), label: 'current area' };
}
// Walk a day: compute times, drive legs, warnings, and optionally auto-pick places.
function flow(day, assign) {
  if (!day) return [];
  const now = Date.now(), isToday = day.date === today(), clamp = day.date <= today();
  let t = dateTs(day.date, day.startMin ?? 480), from = dayOrigin(day).pt, anchor = from, prevPoi = null, prevType = null;
  const usedIndoor = new Set(), usedKinds = new Set(), usedPois = new Set();
  let prevKind = null;
  const rows = [];
  for (const b of day.blocks) {
    const r = { b, warn: [] };
    if (b.st === 'skip') { r.skip = true; rows.push(r); continue; }
    if (b.t === 'travel') {
      const to = blockPoint(b);
      r.miles = to ? hav(from, to) : 0;
      if (!b.durSet) b.dur = to ? round5(r.miles * 1.3 / 55 * 60 + 10) : 60;
      if (to && r.miles < 3) r.warn.push('Already in this zone');
    }
    if (b.t === 'sleep') {
      if (assign && b.st === 'plan' && !b.confirmed && (assign === 'all' || !b.recon?.length)) b.recon = pickRecon(b, from, Math.max(t, clamp ? now : 0), anchor);
    } else if (assign && b.st === 'plan' && BT[b.t].m && (assign === 'all' ? !b.pinned : !b.poi)) {
      const at = Math.max(t, clamp ? now : 0) + 10 * MIN;
      const avoid = WORK_T.has(b.t) ? usedIndoor : null; // no marathons: each indoor work venue once a day
      // mix spots across the day: a dev session goes somewhere new, ideally a different kind of place than the last block
      const adj = /^water/.test(b.t) ? p => (usedPois.has(p.id) ? -8 : 0) : b.t === 'deep' ? p => (usedPois.has(p.id) ? -14 : 0) + (devKind(p)[0] === prevKind ? -10 : usedKinds.has(devKind(p)[0]) ? -4 : 0) : null;
      const best = rank(b.t, { from, at, dur: b.dur, anchor, avoid, adj })[0];
      // everyday blocks stay local; if the only match is far away, leave it open and say where the nearest is
      const tooFar = best && LOCAL_T.has(b.t) && hav(anchor, ptOf(best.p)) > 15;
      b.poi = best && !tooFar ? best.p.id : null;
      b.far = tooFar ? best.p.id : null;
    }
    const dest = b.t === 'carofc' ? (nextSleep(day, b) ? blockPoint(nextSleep(day, b)) : null) : blockPoint(b);
    if (b.t !== 'travel') { r.miles = dest ? hav(from, dest) : 0; r.travel = driveMin(r.miles); } else r.travel = 0;
    if (b.st === 'done') { r.s = b.s0; r.e = b.s1; }
    else if (b.st === 'active') { r.s = b.s0; r.e = Math.max(b.s0 + b.dur * MIN, now); r.over = now > b.s0 + b.dur * MIN; }
    else {
      const ready = Math.max(t + r.travel * MIN, clamp ? now : 0);
      r.s = b.at != null ? Math.max(ready, dateTs(day.date, b.at)) : ready;
      r.gap = (r.s - ready) / MIN;
      r.e = r.s + b.dur * MIN;
    }
    if (b.st !== 'done') blockWarnings(b, r);
    if (b.st === 'plan' && dest && b.t !== 'travel' && hav(anchor, dest) > 15) r.warn.push(`Nearest ${lc(BT[b.t].n)} in the data is ${Math.round(hav(anchor, dest))} mi out`);
    t = r.e;
    if (dest) from = dest;
    if (b.t === 'travel' && dest) anchor = dest;
    if (b.poi) prevPoi = b.poi;
    if (b.poi && WORK_T.has(b.t)) usedIndoor.add(b.poi);
    const k = blockKind(b); if (k) usedKinds.add(k);
    prevKind = k; if (b.poi) usedPois.add(b.poi);
    prevType = b.t;
    rows.push(r);
  }
  if (isToday) day._rows = rows;
  return rows;
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
  } else if (b.t === 'sleep') { if (!b.recon?.length) r.warn.push('No night spot options yet'); }
  else if (BT[b.t].m && b.t !== 'travel') r.warn.push(b.far && P[b.far] ? `No ${lc(BT[b.t].n)} within 15 mi (nearest: ${P[b.far].n}, ${P[b.far].city || ''})` : `No ${lc(BT[b.t].n)} in the data near here`);
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
  const prevPt = (() => { let pt = dayOrigin(day).pt; for (const x of rows) { if (x.b === b) break; const q = blockPoint(x.b); if (q) pt = q; } return pt; })();
  const alt = rank(b.t, { from: prevPt, at: r.s, dur: b.dur }).find(c => c.f.k === 'ok' && c.p.id !== b.poi);
  if (alt) { b.poi = alt.p.id; b.pinned = false; save(); }
  return alt;
}

// ---------- coverage + data packs
function coverage(pt = S.loc) {
  if (!pt || !D) return { ok: true };
  const z = nearestZone(pt), mi = hav(pt, z);
  return { ok: mi <= 45, zone: z, mi };
}
function packPrompt(area) {
  const zones = D.zones.map(z => z.n).join('; ');
  return `You are a research worker extending the "Hey Jim" Florida mobile-developer lifestyle dataset (current dataset v${D.v}, researched ${D.researched}).

Target area: ${area}

Produce ONE JSON data pack for this area in the SAME schema as the existing florida_mobile_dev_agent_bundle_v3.json (top-level collections: zones, pois, capabilities, overnight_candidates, camping, mail_options, recreation, food_options, meal_offers, doordash_markets, sources). Keep ids stable and unique: zone ids are kebab-case; poi ids are "<zone_id>_<slug>"; capability ids are "<poi_id>__<capability>". Every fact needs source_ids pointing into sources[] with url + retrieved_date. Unknown stays null (never guess). Give every POI a full street address and navigation.search_query ("Name, street, city, FL zip"); coordinates are welcome but optional.

Existing zones (don't duplicate): ${zones}

${D.profile?.context || 'The user lives on the road in Florida as a game developer and delivery driver.'}
For each new zone (a planning region ~15–30 mi across) research:
- Waterfront car-office spots: causeways, boat ramps, bridges, piers, Intracoastal parks, beach lots. Priority: car parked close to the water, FREE parking, peaceful, views, restrooms, shade, public grills. Give hours (gates often close at sunset).
- Work: independent cafés, Panera, libraries (hours, Wi-Fi, outlets).
- Planet Fitness clubs (exact hours per day, 24/7 or not) for gym + shower.
- Overnight car-sleep candidates (Walmart, Cracker Barrel, hotel clusters, truck stops, PF lots) with permission status, gray-area flags and recent traveler reports (iOverlander); tent/vehicle camping on public land.
- Food: protein-heavy cheap meals, ramen, Chinese buffets, CAVA/Chipotle; Walmart for groceries + water refill machines.
- Laundromats, USPS General Delivery offices, auto parts stores (loan-a-tool, lot repairs), DoorDash market windows.
- Fun: springs, trails, oddities, flea markets, hipster dive bars and weird social spots.
Hours format per day: "HH:MM-HH:MM", multiple ranges joined by ";", overnight like "16:00-02:00", sunrise/sunset/dawn/dusk tokens allowed, "closed", or null when unknown.
Return only the JSON file (downloadable), plus a short list of research gaps.`;
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
function weekStats(ws = weekStart()) {
  const we = ws + 7 * DAY, s = { dev: 0, dash: 0, gym: 0, car: 0, water: 0, waterDays: new Set(), gross: 0, miles: 0, gas: 0, dashActive: 0 };
  for (const e of S.log) {
    if (e.t < ws || e.t >= we) continue;
    if (e.k === 'dev') s.dev += e.min;
    if (e.k === 'dash') { s.dash += e.min; s.gross += e.gross || 0; s.miles += e.miles || 0; s.gas += e.gas || 0; s.dashActive += e.active || 0; }
    if (e.k === 'gym') s.gym++;
    if (e.k === 'car') s.car++;
    if (e.k === 'water') { s.water += e.min; if (e.min >= 40) s.waterDays.add(dayKey(e.t)); }
  }
  return s;
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
