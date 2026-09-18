// Prints tonight's auto-picked recon targets and the full nearby night options at a few places.
import fs from 'node:fs'; import vm from 'node:vm';
const ls = new Map();
const ctx = vm.createContext({ console, crypto: globalThis.crypto, TextEncoder, Blob, Response, DecompressionStream, Intl, Date, Math, JSON, atob, btoa, structuredClone,
  localStorage: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) }, navigator: {}, document: {},
  fetch: async () => ({ ok: true, arrayBuffer: async () => fs.readFileSync('docs/data.enc') }), setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync('docs/core.js', 'utf8') + '\n;globalThis.__ = { S, P, fetchEnc, keyFromPassword, decryptData, indexData, pickRecon, nightOptions, nightChip, lotKind };', ctx);
const $ = ctx.__, secret = JSON.parse(fs.readFileSync('build/secret.json', 'utf8'));
const buf = await $.fetchEnc(); $.indexData(await $.decryptData(buf, await $.keyFromPassword(secret.password, buf))); vm.runInContext('D.sync = null', ctx);
for (const [n, lat, lng] of [['Ormond', 29.285, -81.055], ['PalmCoast', 29.55, -81.21], ['Tavares', 28.804, -81.726], ['StAug', 29.89, -81.31]]) {
  const from = { lat, lng }, at = new Date().setHours(21, 0, 0, 0);
  const recon = $.pickRecon({}, from, at, from).map(x => $.P[x.poi].n);
  const opts = $.nightOptions(from, at, from).sort((a, b) => a.mi - b.mi);
  const kinds = {}; opts.forEach(o => { const k = $.lotKind(o.p); kinds[k] = (kinds[k] || 0) + 1; });
  console.log(`\n${n}: recon → ${recon.join(' | ')}\n  ${opts.length} options within 25 mi: ${JSON.stringify(kinds)}\n  nearest: ${opts.slice(0, 6).map(o => `${o.p.n.slice(0, 22)} ${o.mi.toFixed(1)}mi ${($.nightChip(o.p, at) || [''])[0]}`).join(' ; ')}`);
}
