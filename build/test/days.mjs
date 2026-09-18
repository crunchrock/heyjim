// Prints the auto-built day for several templates at a few places (9am start) to eyeball plan quality.
import fs from 'node:fs'; import vm from 'node:vm';
const ls = new Map(); let NOW = Date.now();
class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }
const ctx = vm.createContext({ console, crypto: globalThis.crypto, TextEncoder, Blob, Response, DecompressionStream, Intl, Date: FakeDate, Math, JSON, atob, btoa, structuredClone,
  localStorage: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) }, navigator: {}, document: {},
  fetch: async () => ({ ok: true, arrayBuffer: async () => fs.readFileSync('docs/data.enc') }), setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync('docs/core.js', 'utf8') + '\n;globalThis.__ = { S, P, fetchEnc, keyFromPassword, decryptData, indexData, newDay, flow, getDay, today };', ctx);
const $ = ctx.__, secret = JSON.parse(fs.readFileSync('build/secret.json', 'utf8'));
const buf = await $.fetchEnc(); $.indexData(await $.decryptData(buf, await $.keyFromPassword(secret.password, buf)));
const spots = (process.argv[2] || 'Ormond:29.285:-81.055,PalmCoast:29.55:-81.21').split(',').map(x => x.split(':'));
const tpls = (process.argv[3] || 'balanced,max,cash,grill').split(',');
const hm = ts => { const d = new Date(ts); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
for (const [name, lat, lng] of spots) for (const tpl of tpls) {
  const d = new Date(); d.setHours(+(process.argv[4] || 9), 0, 0, 0); NOW = d.getTime();
  $.S.loc = { lat: +lat, lng: +lng, t: NOW }; $.S.days = {};
  $.newDay(tpl, $.today());
  const rows = $.flow($.getDay($.today()));
  console.log(`\n${name} / ${tpl}`);
  for (const r of rows) console.log(`  ${hm(r.s)}-${hm(r.e)} ${r.b.t.padEnd(10)} ${r.b.poi ? $.P[r.b.poi].n.slice(0, 34).padEnd(34) : ''.padEnd(34)} ${r.travel ? r.travel + 'm drive' : ''}${r.gap > 20 ? ' gap ' + Math.round(r.gap) + 'm' : ''}${r.warn.length ? ' ⚠ ' + r.warn.join(' | ') : ''}`);
}
