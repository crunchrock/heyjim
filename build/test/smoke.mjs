// Headless smoke test: decrypt data.enc, then exercise the planner logic from docs/core.js.
import fs from 'node:fs';
import vm from 'node:vm';
const ls = new Map();
const ctx = vm.createContext({
  console, crypto: globalThis.crypto, TextEncoder, Blob, Response, DecompressionStream, Intl, Date, Math, JSON, atob, btoa, structuredClone,
  localStorage: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) },
  navigator: {}, document: {}, fetch: async () => ({ ok: true, arrayBuffer: async () => fs.readFileSync('docs/data.enc') }),
  setTimeout, clearTimeout,
});
vm.runInContext(fs.readFileSync('docs/core.js', 'utf8') + '\n;globalThis.__ = { S, D: () => D, P, Z, fetchEnc, keyFromPassword, decryptData, indexData, rank, newDay, flow, getDay, today, addDays, hoursState, fit, TEMPLATES, BT, weekStats, logEntry, packPrompt, coverage, fixBlock, dayOrigin };', ctx);
const $ = ctx.__;
const secret = JSON.parse(fs.readFileSync('build/secret.json', 'utf8'));
const buf = await $.fetchEnc();
const data = await $.decryptData(buf, await $.keyFromPassword(secret.password, buf));
let bad = false; try { await $.decryptData(buf, await $.keyFromPassword('wrong', buf)); bad = true; } catch {}
console.log('decrypt ok; wrong password rejected:', !bad);
$.indexData(data);
$.S.loc = { lat: 29.2847, lng: -81.0553, t: Date.now() }; // Ormond Beach
for (const t of Object.keys($.BT)) {
  if (!$.BT[t].m) continue;
  const r = $.rank(t);
  console.log(t.padEnd(9), String(r.length).padStart(3), r[0] ? `${r[0].p.n} (${r[0].mi.toFixed(1)}mi, ${r[0].f.txt})` : '-');
}
for (const tpl of $.TEMPLATES) {
  const d = $.today();
  $.newDay(tpl.id, d);
  const rows = $.flow($.getDay(d));
  console.log('\n#', tpl.id, rows.map(r => `${r.b.t}${r.b.poi ? '@' + $.P[r.b.poi].n.slice(0, 22) : r.b.toZone ? '→' + r.b.toZone : ''}${r.warn.length ? ' ⚠' + r.warn.join('|') : ''}`).join(' ▸ '));
}
const tm = $.addDays($.today(), 1);
$.newDay('move', tm);
const o = $.dayOrigin($.getDay(tm));
console.log('\ntomorrow origin:', o.label, '| rows:', $.flow($.getDay(tm)).map(r => new Date(r.s).toTimeString().slice(0, 5) + ' ' + r.b.t).join(', '));
const pf = Object.values($.P).find(p => /Palm Coast/.test(p.n) && p.caps.gym);
const fri9 = new Date('2026-09-18T20:30:00-04:00'), sat = new Date('2026-09-19T22:00:00-04:00');
console.log('\nPF Palm Coast hours', pf.h, '\n Fri 8:30p:', $.hoursState(pf, fri9).txt, '| Sat 10p:', $.hoursState(pf, sat).txt);
const park = Object.values($.P).find(p => p.h && /sunset/.test(p.h.join()));
console.log('park', park.n, park.h[5], '| 6:45p fit 90m:', JSON.stringify($.fit(park, new Date('2026-09-18T18:45:00-04:00').getTime(), 90)));
console.log('coverage Miami:', JSON.stringify($.coverage({ lat: 25.76, lng: -80.19 })).slice(0, 80));
