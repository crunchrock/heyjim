// Regression probe for "the plan follows me": build a day in Ormond, drive to St. Augustine, check what re-picks.
// Also: one night spot per day, tombstoned deletes survive a sync merge, car-ping parsing + auto-tracking.
// Read-only (sync disabled). Usage: node build/test/move.mjs
import fs from 'node:fs';
import vm from 'node:vm';
const ls = new Map();
const ctx = vm.createContext({
  console, crypto: globalThis.crypto, TextEncoder, TextDecoder, Blob, Response, DecompressionStream, Intl, Date, Math, JSON, atob, btoa, structuredClone, AbortController,
  localStorage: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) },
  navigator: {}, document: {}, fetch: async () => ({ ok: true, arrayBuffer: async () => fs.readFileSync('docs/data.enc') }),
  setTimeout, clearTimeout,
});
vm.runInContext(fs.readFileSync('docs/core.js', 'utf8') + '\n;globalThis.__ = { get S() { return S; }, set S(v) { S = v; }, D: () => D, P, Z, fetchEnc, keyFromPassword, decryptData, indexData, rank, newDay, flow, getDay, today, addDays, reanchor, sanitize, mergeState, parsePing, stays, autoTrack, ACT, hav, ptOf, mkBlock, ensureDay, BT, nearbyPoi, dropNights, alive, weekStats, lastNight };', ctx);
const $ = ctx.__;
const secret = JSON.parse(fs.readFileSync('build/secret.json', 'utf8'));
const buf = await $.fetchEnc();
$.indexData(await $.decryptData(buf, await $.keyFromPassword(secret.password, buf)));
vm.runInContext('D.sync = null', ctx);
let fails = 0;
const ok = (c, msg) => { console.log((c ? '  ok   ' : '  FAIL ') + msg); if (!c) fails++; };
const P = $.P, fresh = (lat, lng) => ({ lat, lng, t: Date.now(), acc: 30 });
const ORMOND = fresh(29.2847, -81.0553), STAUG = fresh(29.8947, -81.3145);
const show = rows => rows.map(r => `${r.b.t}${r.b.poi ? '@' + P[r.b.poi].n.slice(0, 20) + (P[r.b.poi].city ? ' (' + P[r.b.poi].city + ')' : '') : ''}${r.b.recon ? '[' + r.b.recon.map(x => P[x.poi]?.city).join(',') + ']' : ''}`).join(' ▸ ');

console.log('\n1. Build a day in Ormond, then drive to St. Augustine');
$.S.loc = ORMOND;
const d = $.today();
$.newDay('balanced', d);
const day = $.getDay(d);
console.log('  Ormond :', show($.flow(day)));
// he pinned the gym himself in Ormond
const gym = day.blocks.find(b => b.t === 'gym'); gym.pinned = true;
$.S.loc = STAUG;
const moved = $.reanchor();
const rows = $.flow(day);
console.log('  St Aug :', show(rows), '| re-picked', moved);
for (const r of rows) {
  if (!r.b.poi || r.b.pinned) continue;
  const mi = $.hav(STAUG, $.ptOf(P[r.b.poi]));
  ok(mi < 20, `${r.b.t} now ${mi.toFixed(1)} mi from St. Augustine (${P[r.b.poi].n})`);
}
const gr = rows.find(r => r.b === gym);
ok(gr.warn.some(w => /mi from where you are/.test(w)) && gr.acts.some(a => a[0] === 'repick'), 'pinned Ormond gym warns + offers "Pick one near me": ' + gr.warn.join(' | '));
const sl = day.blocks.find(b => b.t === 'sleep');
ok((sl.recon || []).every(x => $.hav(STAUG, $.ptOf(P[x.poi])) < 25), 'night recon re-picked near St. Augustine: ' + sl.recon.map(x => P[x.poi].n).join(', '));

console.log('\n2. Adding a block today picks around where he is');
const nb = $.mkBlock('meal'); day.blocks.splice(day.blocks.length - 1, 0, nb);
$.flow(day, 'missing');
ok(nb.poi && $.hav(STAUG, $.ptOf(P[nb.poi])) < 15, 'new meal block: ' + (nb.poi ? P[nb.poi].n + ', ' + P[nb.poi].city : 'none'));

console.log('\n3. Future days chain from the plan, not from GPS');
const tmr = $.addDays(d, 1);
$.newDay('balanced', tmr);
const t1 = $.getDay(tmr);
const before = t1.blocks.map(b => b.poi).join();
$.S.loc = ORMOND;   // GPS jumps back to Ormond
$.reanchor();
ok(t1.blocks.map(b => b.poi).join() === before, 'tomorrow untouched by a GPS change');
$.S.loc = STAUG;

console.log('\n4. One night spot per day');
day.blocks.push($.mkBlock('sleep'), $.mkBlock('sleep'));
$.sanitize();
ok(day.blocks.filter(b => b.t === 'sleep').length === 1 && day.blocks[day.blocks.length - 1].t === 'sleep', 'sanitize folds extra sleep blocks and keeps it last');

console.log('\n5. Deletes survive a sync merge (tombstones)');
const somePoi = sl.recon[0].poi;
$.S.nights.push({ poi: somePoi, t: Date.now(), day: d });
const remote = structuredClone($.S); remote.updatedAt = Date.now() - 60000;
$.dropNights(n => n.day === d); $.S.updatedAt = Date.now();
$.S = $.mergeState(remote);
ok($.alive($.S.nights).every(n => n.day !== d), 'a removed night stays removed after merging an older remote copy');
const cleared = structuredClone($.S); $.S.days[tmr] = { date: tmr, del: Date.now(), blocks: [] }; $.S.updatedAt = Date.now();
$.S = $.mergeState(cleared);
ok(!$.getDay(tmr), 'a cleared day stays cleared');

console.log('\n6. Car pings → stays → auto-tracked gym');
const p1 = $.parsePing('20260922-170512-0400_off_29.8947_-81.3145.txt');
ok(p1 && p1.ev === 'off' && new Date(p1.t).toISOString() === '2026-09-22T21:05:12.000Z', 'parsePing reads time zone + coords: ' + JSON.stringify(p1));
ok($.parsePing('garbage.txt') === null, 'bad names are ignored');
const pf = $.D().pois.find(p => p.caps.gym && p.lat != null && $.hav(STAUG, p) < 15);
if (pf) {
  const t0 = Date.now() - 5 * 3600e3;
  $.ACT.pings.push({ t: t0, ev: 'off', lat: pf.lat, lng: pf.lng, name: 'a' }, { t: t0 + 68 * 60000, ev: 'on', lat: pf.lat, lng: pf.lng, name: 'b' });
  $.S.settings.autotrack = true;
  const done = $.autoTrack();
  ok(done.some(x => /Gym/.test(x)), 'PF stay of 68 min logged as gym: ' + done.join(' | '));
  const g = $.getDay($.today()).blocks.find(b => b.t === 'gym' && b.st === 'done');
  ok(g && Math.round((g.s1 - g.s0) / 60000) === 68, 'gym block done with the real times');
  ok($.autoTrack().length === 0, 'the same stay is not logged twice');
} else ok(false, 'no PF near St. Augustine in the data');

console.log('\n7. Tonight\'s confirmed spot is not "slept here 1m ago"');
{
  const d0 = $.getDay($.today()), sb = d0.blocks.find(b => b.t === 'sleep');
  const spot = sb.recon[0].poi;
  sb.poi = spot; sb.confirmed = true; sb.pinned = true;
  $.dropNights(n => n.day === $.today());
  $.S.nights.push({ poi: spot, t: Date.now(), day: $.today() });
  const w = $.flow(d0).find(r => r.b === sb).warn;
  ok(!$.lastNight(spot) && !w.some(x => /slept here/i.test(x)), 'no rotation warning for tonight itself: ' + (w.join(' | ') || 'no warnings'));
  $.S.nights.push({ poi: spot, t: Date.now() - 2 * 86400e3, day: $.addDays($.today(), -2) });
  const w2 = $.flow(d0).find(r => r.b === sb).warn;
  ok(w2.some(x => /slept here 2 nights ago\. Rotate\?/i.test(x)), 'a real night 2 days ago still warns: ' + w2.filter(x => /slept/i.test(x)).join(''));
}

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
