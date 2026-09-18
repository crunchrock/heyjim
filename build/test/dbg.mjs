import fs from 'node:fs'; import vm from 'node:vm';
const ls = new Map();
const ctx = vm.createContext({ console, crypto: globalThis.crypto, TextEncoder, Blob, Response, DecompressionStream, Intl, Date, Math, JSON, atob, btoa, structuredClone,
  localStorage: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) }, navigator: {}, document: {},
  fetch: async () => ({ ok: true, arrayBuffer: async () => fs.readFileSync('docs/data.enc') }), setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync('docs/core.js', 'utf8') + '\n;globalThis.__ = { S, P, fetchEnc, keyFromPassword, decryptData, indexData, hoursState, BT, sunFor, ptOf };', ctx);
const $ = ctx.__, secret = JSON.parse(fs.readFileSync('build/secret.json', 'utf8'));
const buf = await $.fetchEnc(); $.indexData(await $.decryptData(buf, await $.keyFromPassword(secret.password, buf)));
for (const p of Object.values($.P)) { try { $.hoursState(p); } catch (e) { console.log(p.id, p.lat, p.lng, p.z, JSON.stringify($.ptOf(p))); break; } }
