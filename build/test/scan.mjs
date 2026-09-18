// Usability scan: what would the app show at real places and times? Flags far/closed/duplicate picks.
import fs from 'node:fs'; import vm from 'node:vm';
const ls = new Map();
let NOW = Date.now();
class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }
const ctx = vm.createContext({ console, crypto: globalThis.crypto, TextEncoder, Blob, Response, DecompressionStream, Intl, Date: FakeDate, Math, JSON, atob, btoa, structuredClone,
  localStorage: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) }, navigator: {}, document: {},
  fetch: async () => ({ ok: true, arrayBuffer: async () => fs.readFileSync('docs/data.enc') }), setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync('docs/core.js', 'utf8') + '\n;globalThis.__ = { S, P, fetchEnc, keyFromPassword, decryptData, indexData, rank, newDay, flow, getDay, today, BT };', ctx);
const $ = ctx.__, secret = JSON.parse(fs.readFileSync('build/secret.json', 'utf8'));
const buf = await $.fetchEnc(); $.indexData(await $.decryptData(buf, await $.keyFromPassword(secret.password, buf)));
const spots = { Tavares: [28.804, -81.726], Sanford: [28.80, -81.27], Ormond: [29.285, -81.055], PalmCoast: [29.55, -81.21], StAug: [29.89, -81.31], Pensacola: [30.42, -87.22], Tampa: [27.95, -82.46] };
const times = { '08:00': 8, '13:00': 13, '19:00': 19, '23:00': 23 };
const tiles = ['restroom', 'water', 'shower', 'meal', 'office', 'sleep', 'groc', 'laundry', 'water_s', 'cafe', 'grill', 'car', 'dash'];
const sh = s => s.length > 24 ? s.slice(0, 23) + '…' : s;
for (const [name, [lat, lng]] of Object.entries(spots)) {
  $.S.loc = { lat, lng, t: NOW };
  console.log(`\n=== ${name}`);
  for (const [tl, h] of Object.entries(times)) {
    const d = new Date(); d.setHours(h, 0, 0, 0); NOW = d.getTime(); $.S.loc.t = NOW;
    const line = tiles.map(t => { const r = $.rank(t); const top = r[0]; if (!top) return `${t}:—`; const flag = (top.mi > 15 ? '!FAR' : '') + (top.f.k === 'closed' ? '!CLOSED' : '') + (top.approx ? '!APPROX' : ''); return `${t}:${sh(top.p.n)} ${top.mi.toFixed(1)}${flag}`; });
    console.log(tl, line.join(' | '));
  }
  const d = new Date(); d.setHours(9, 0, 0, 0); NOW = d.getTime();
  $.S.days = {}; $.newDay('standard', $.today());
  const rows = $.flow($.getDay($.today()));
  console.log('standard@9a:', rows.map(r => `${r.b.t}=${r.b.poi ? sh($.P[r.b.poi].n) : '-'}(${r.miles?.toFixed(1)}mi)${r.warn.length ? '⚠' + r.warn.join(';') : ''}`).join(' ▸ '));
}
