// What does "Food" surface at a few places? Prints the top meal picks with value info.
import fs from 'node:fs'; import vm from 'node:vm';
const ls = new Map();
const ctx = vm.createContext({ console, crypto: globalThis.crypto, TextEncoder, Blob, Response, DecompressionStream, Intl, Date, Math, JSON, atob, btoa, structuredClone,
  localStorage: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) }, navigator: {}, document: {},
  fetch: async () => ({ ok: true, arrayBuffer: async () => fs.readFileSync('docs/data.enc') }), setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync('docs/core.js', 'utf8') + '\n;globalThis.__ = { S, P, fetchEnc, keyFromPassword, decryptData, indexData, rank };', ctx);
const $ = ctx.__, secret = JSON.parse(fs.readFileSync('build/secret.json', 'utf8'));
const buf = await $.fetchEnc(); $.indexData(await $.decryptData(buf, await $.keyFromPassword(secret.password, buf)));
const t = process.argv[2] || 'meal';
for (const [n, lat, lng] of [['MountDora', 28.80, -81.64], ['Ormond', 29.285, -81.055], ['PalmCoast', 29.55, -81.21]]) {
  const at = new Date().setHours(12, 30, 0, 0);
  console.log(`\n${n} ${t}:`); $.rank(t, { from: { lat, lng }, at }).slice(0, 7).forEach(r => { const f = r.p.fv || {}; console.log(`  ${r.p.n.slice(0, 34).padEnd(34)} ${r.mi.toFixed(1).padStart(4)}mi  ${f.pl ? '$'.repeat(f.pl) : '  '} ${f.r || ''} (${f.rc || ''}) ${f.cheap ? 'cheap' : ''} ${f.asian ? 'asian' : ''} ${r.f.k}`); });
}
