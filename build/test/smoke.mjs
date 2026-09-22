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
vm.runInContext(fs.readFileSync('docs/core.js', 'utf8') + '\n;globalThis.__ = { S, D: () => D, P, Z, fetchEnc, keyFromPassword, decryptData, indexData, rank, newDay, flow, getDay, today, addDays, hoursState, fit, TEMPLATES, BT, weekStats, logEntry, packPrompt, coverage, fixBlock, dayOrigin, nightOut, specialsAt, daySpecials, isDrinkSp, isBuffetSp, isClub, isGoth, barBonus, dateTs, foodSpecials };', ctx);
const $ = ctx.__;
const secret = JSON.parse(fs.readFileSync('build/secret.json', 'utf8'));
const buf = await $.fetchEnc();
const data = await $.decryptData(buf, await $.keyFromPassword(secret.password, buf));
let bad = false; try { await $.decryptData(buf, await $.keyFromPassword('wrong', buf)); bad = true; } catch {}
console.log('decrypt ok; wrong password rejected:', !bad);
$.indexData(data); vm.runInContext('D.sync = null', ctx);
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
// ---- Night out hub: a lookup for any evening (Sunday too); the Bar night auto-pick rules stay exactly as they are
let fails = 0;
const ok = (c, msg) => { console.log((c ? '  ok   ' : '  FAIL ') + msg); if (!c) fails++; };
console.log('\nNight out');
const JAX = { lat: 30.332, lng: -81.656, t: Date.now() }, TPA = { lat: 27.95, lng: -82.457, t: Date.now() }, TLH = { lat: 30.438, lng: -84.281, t: Date.now() };
const dayOn = dow => { let d = $.addDays($.today(), 1); while (new Date($.dateTs(d, 720)).getDay() !== dow) d = $.addDays(d, 1); return d; };
const TUE = dayOn(2), SUN = dayOn(0), MON = dayOn(1), at = (d, h) => $.dateTs(d, h * 60);
$.S.loc = JAX;
const nj = $.nightOut(JAX, TUE);
ok(!nj.tonight && nj.dow === 2, `a Tuesday (${TUE}) is built as that day, not tonight`);
ok(nj.hh.rows.length > 0, `Jacksonville Tuesday: ${nj.hh.rows.length} happy hours within ${nj.hh.r} mi (${nj.hh.rows.slice(0, 3).map(r => r.p.n).join(', ')})`);
ok(nj.hh.rows.every(r => r.sp.length && r.sp.every(e => $.isDrinkSp(e.x, r.p))), 'happy hours: drink specials only (clubs included, they are normal places now)');
const starts = nj.hh.rows.map(r => r.sp[0].s ?? 1e4);
ok(starts.every((s, i) => !i || s >= starts[i - 1]), 'another day: happy hours sorted by start time');
ok(nj.clubs.rows.length > 0 && nj.clubs.rows.every(r => r.mi <= 30), `Jacksonville clubs within 30 mi: ${nj.clubs.rows.map(r => r.p.n).join(', ')}`);
ok(nj.clubs.rows.every(r => r.sp.length === $.specialsAt(r.p, at(TUE, 12)).today.length), 'club rows carry all of that day\'s specials');
const nt = $.nightOut(TPA, TUE);
ok(nt.clubs.rows.every(r => r.sp.every(e => !e.x.d?.length || e.x.d.includes(2))), `Tampa Tuesday club specials are Tuesday's: ${nt.clubs.rows.flatMap(r => r.sp.map(e => r.p.n.split(' ').slice(0, 2).join(' ') + ': ' + (e.x.l || ''))).join(' | ') || 'none'}`);
const ns = $.nightOut(JAX, SUN);
ok(ns.dow === 0 && ns.hh.rows.length + ns.clubs.rows.length + ns.bars.rows.length > 0, `Sunday still shows the hub: ${ns.hh.rows.length} happy hours, ${ns.clubs.rows.length} clubs, ${ns.bars.rows.length} bars`);
ok([...ns.bars.rows, ...nj.bars.rows].every(r => !$.isClub(r.p)), 'the bars section never lists a club');
const nl = $.nightOut(TLH, TUE);
ok(!nl.clubs.rows.length && nl.clubs.nearest.length === 3 && nl.clubs.nearest[0].mi > 30, `Tallahassee: no clubs within 30 mi; nearest ${nl.clubs.nearest.map(r => r.p.n + ' ' + Math.round(r.mi) + ' mi').join(', ')}`);
ok([...nl.goth.rows, ...nj.goth.rows].every(r => $.isGoth(r.p) && r.mi <= 60), 'goth rows are goth venues within 60 mi');
const g = r => (r.sp[0].live ? 0 : r.sp[0].soon ? 1 : 2), tn = $.nightOut(JAX, $.today());
ok(tn.tonight && tn.hh.rows.every((r, i, a) => !i || g(r) >= g(a[i - 1])), `tonight: happy hours on now, then later today, then untimed (${tn.hh.rows.filter(r => r.sp[0].live).length} on now)`);
const monthly = { sp: [{ l: 'Goth night', d: [0], s: '21:00', items: ['2nd Sunday of every month'] }] };
ok($.specialsAt(monthly, new Date(2026, 9, 11, 20).getTime()).today.length === 1 && $.specialsAt(monthly, new Date(2026, 9, 18, 20).getTime()).today.length === 0, '"2nd Sunday of every month" shows on Oct 11, not on Oct 18');
ok($.specialsAt({ sp: [{ l: 'Crux', d: [6], items: ['last Saturday of every other month'] }] }, new Date(2026, 9, 3, 20).getTime()).today.length === 1, 'a cadence the text cannot pin down still shows (the row carries the note)');
ok(!$.isDrinkSp({ l: 'Lunch special', items: ['2 single-topping slices + a drink $11.47'] }, { c: 'food' }) && $.isDrinkSp({ l: 'Sunday brunch specials', items: ['$3 mimosas'] }, { c: 'social' }), 'a meal that comes with a drink is not a happy hour; $3 mimosas is');
const bufClub = { sp: [{ l: 'Lunch buffet', d: [2], s: '12:00', e: '15:00', items: ['$10'] }, { l: '2-for-1 drinks', d: [2], s: '18:00', e: '22:00' }] };
const bs = $.daySpecials(bufClub, at(TUE, 13));
ok($.isBuffetSp(bs[0].x) && bs[0].live && bs[1].soon && !$.isDrinkSp(bs[0].x, { c: 'social' }), 'a club lunch buffet is live at 1p and listed before the evening drink special');
const club = Object.values($.P).find(p => $.isClub(p) && !p.sp?.length && !(p.bd?.r >= 4.5));
const bar = Object.values($.P).find(p => $.BT.social.m(p) && !$.isClub(p) && !p.sp?.length);
ok($.barBonus(club, at(MON, 20)) === 0 && $.barBonus(club, at(SUN, 20)) === -10, `a plain club scores like a plain bar for Bar night (${club.n}: 0 Monday, -10 Sunday)`);
ok($.barBonus(bar, at(SUN, 20)) === $.barBonus(bar, at(MON, 20)) - 10, `Sunday still costs a bar 10 (${bar.n})`);
// a club with a free lunch buffet is a normal lunch option while it's on, and sinks again once it's over
const CLW = { lat: 27.965, lng: -82.8, t: Date.now() };
const oz = $.P['clearwater-largo_oz-gentlemens-club'];
const mealAt = h => $.rank('meal', { from: CLW, at: at(TUE, h), dur: 50 }).findIndex(r => r.p === oz);
ok(oz && $.BT.meal.m(oz) && $.foodSpecials(oz).length > 0, `a club with a food special counts as a Meal option (${oz?.n}: ${$.foodSpecials(oz || {}).map(x => x.l).join(', ')})`);
ok(mealAt(13) >= 0 && mealAt(13) < 12, `its free lunch buffet puts it in the lunch picks at 1p (rank ${mealAt(13) + 1})`);
ok(mealAt(22) < 0 || mealAt(22) > 40, `at 10p, with the buffet over, it is not a lunch pick (rank ${mealAt(22) + 1 || 0})`);
const hhClub = $.nightOut(CLW, TUE).hh.rows.filter(r => $.isClub(r.p));
ok(hhClub.length > 0, `club drink specials show under Happy hours too (${hhClub.slice(0, 2).map(r => r.p.n).join(', ')})`);
if (fails) { console.log(`\n${fails} night-out check(s) FAILED`); process.exit(1); }
console.log('night out: all ok');
