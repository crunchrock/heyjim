'use strict';
// UI layer. Logic/data helpers live in core.js.
let tab = 'today', sel = null, wx = null, alerts = [], placesQ = '', placesCat = '', mapFilter = 'all', toastT;
const sheetStack = [];
const A = {}; // click actions: data-a="name"
const DUE = { shower: [24, 'Shower'], laundry: [168, 'Laundry'], water_refill: [72, 'Water jug'], groceries: [96, 'Groceries'], mail: [168, 'Mail'] };
const SUPPLIES = ['Whey', 'Peanut butter', 'Bread / tortillas', 'Jelly', 'Tuna', 'Bananas / fruit', 'Multivitamin', 'Instant coffee', 'Charcoal', 'Tinfoil', 'Lighter', 'Toiletries', 'Paper towels'];
const CAT_NAMES = { mine: 'Your places', shop: 'Shop', waterfront: 'Waterfront', work: 'Work', gym: 'Gym', food: 'Food', overnight_candidate: 'Overnight', car_maintenance: 'Car', camping: 'Camping', mail: 'Mail', fun: 'Fun', social: 'Social', life_support: 'Laundry / travel center', doordash_cluster: 'DoorDash' };

// ---------- theme
function applyTheme() {
  const m = S.settings.theme;
  let dark = m === 'dark';
  if (m === 'auto') { const s = sunToday(), n = Date.now(); dark = n < s.rise - 20 * MIN || n > s.set + 20 * MIN; }
  const t = dark ? 'dark' : 'light';
  if (document.documentElement.dataset.theme !== t) {
    document.documentElement.dataset.theme = t;
    $('meta[name=theme-color]').content = dark ? '#121315' : '#EFEBE4';
    if (map) setTiles();
  }
}

// ---------- boot / lock
async function boot() {
  applyTheme();
  if ('serviceWorker' in navigator) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !boot.re) { boot.re = 1; location.reload(); } });
  }
  let buf;
  try { buf = await fetchEnc(); } catch { return showLock('Could not load the data. Check your connection.'); }
  const raw = store.get('key');
  if (raw) {
    let data = null;
    try { data = await decryptData(buf, await importKey(raw)); } catch {}
    // a startup bug must never log him out: only a key that can't decrypt the data is dropped
    if (data) { try { return start(data); } catch (e) { logError(e, 'start'); return showLock('The app hit a startup bug (logged). Reload to try again.'); } }
    store.del('key');
  }
  showLock('', buf);
}
function showLock(msg, buf) {
  $('#lock').hidden = false; $('#app').hidden = true;
  $('#lockMsg').textContent = msg || '';
  $('#a2hs').hidden = !!navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const f = $('#lockForm');
  f.onsubmit = async e => {
    e.preventDefault();
    const until = store.get('lockout', 0);
    if (Date.now() < until) { $('#lockMsg').textContent = `Too many tries. Wait ${Math.ceil((until - Date.now()) / 1000)}s.`; return; }
    const btn = f.querySelector('button');
    btn.disabled = true; btn.textContent = 'Unlocking…';
    try {
      buf ||= await fetchEnc();
      const key = await keyFromPassword($('#pw').value.trim(), buf);
      const data = await decryptData(buf, key);
      store.set('key', await exportKey(key)); store.del('fails');
      try { start(data); } catch (e) { logError(e, 'start'); $('#lockMsg').textContent = 'Unlocked, but the app hit a startup bug (logged). Reload.'; }
      return;
    } catch {
      const n = store.get('fails', 0) + 1; store.set('fails', n);
      if (n >= 5) store.set('lockout', Date.now() + 30000 * (n - 4));
      $('#lockMsg').textContent = 'Wrong password.';
      f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
    } finally { btn.disabled = false; btn.textContent = 'Unlock'; }
  };
}
function start(data) {
  indexData(data); pruneDays(); migrate(); sanitize(); sel = today();
  trackEvent('open', { v: D.v, standalone: !!navigator.standalone });
  syncPull().then(changed => { if (changed) { pruneDays(); safeRender(); } syncPush(); onFresh(); });
  if (!S.settings.name && D.profile?.name) S.settings.name = D.profile.name;
  $('#lock').hidden = true; $('#app').hidden = false;
  render();
  locListeners.push(onMove);
  locate().then(l => { if (l) { applyTheme(); refreshWx(); } safeRender(); });
  watchLoc(true);
  refreshWx();
  setInterval(() => { applyTheme(); if (tab === 'today' && !sheetStack.length && !dragging()) render(); }, MIN);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { trackEvent('hide'); watchLoc(false); saveNow(); store.set('act', ACT); if (sync.dirty) syncPush(); actPush(true); return; }
    trackEvent('show');
    watchLoc(true);
    if (sel < today()) sel = today();
    sanitize();
    syncPull().then(changed => { if (changed && !sheetStack.length) safeRender(); onFresh(); });
    locate().then(() => { if (!sheetStack.length) safeRender(); });
    refreshWx();
  });
}
// after sync: fetch car pings, turn finished stays into logged blocks, upload today's activity
async function onFresh() {
  try {
    await pullPings();
    const done = autoTrack();
    if (done.length) { toast('Auto-tracked: ' + done.slice(0, 2).join(' · ') + (done.length > 2 ? ` +${done.length - 2}` : '')); safeRender(); }
    actPush();
  } catch (e) { logError(e, 'onFresh'); }
}
// every GPS fix: follow him (re-pick today's stale places), start/finish blocks on arrive/leave
let lastAnchor = null, lastMoveRender = 0;
function onMove(l) {
  if (!D) return;
  const al = arriveLeave();
  if (al?.kind === 'arrived') toast(`You're at ${P[al.b.poi].n}: ${BT[al.b.t].n} started`, () => { al.b.st = 'plan'; delete al.b.s0; al.b.noAuto = 1; });
  if (al?.kind === 'left') toast(al.msg + ' (you left ' + (P[al.b.poi]?.n || 'the spot') + ')');
  if (!lastAnchor || hav(lastAnchor, l) > 3) {
    lastAnchor = l;
    const n = reanchor();
    if (n) toast(`You're near ${zoneOfPoint(l)?.n.split(' / ')[0] || 'a new area'} now: re-picked ${n} block${n > 1 ? 's' : ''} around you`);
  }
  // GPS fixes stream in while driving: redraw at most every 20s unless something changed
  if (tab === 'today' && !dragging() && (al || (!sheetStack.length && Date.now() - lastMoveRender > 20000))) { lastMoveRender = Date.now(); safeRender(); }
}
function migrate() {
  if ((S.ver || 0) < 3) {
    for (const day of Object.values(S.days)) {
      if (!day?.blocks || day.date < today()) continue;
      for (const b of day.blocks) {
        if (b.t === 'office') b.t = 'panera';
        if (b.st === 'plan' && !b.pinned) b.poi = null;
        if (b.t === 'sleep' && !b.confirmed) { b.poi = null; b.pinned = false; }
      }
      autofill(day, true);
    }
    S.ver = 3; save();
  }
  if (S.ver < 4) { S.mine ||= []; S.ver = 4; save(); }
}
async function refreshWx() {
  const pt = here();
  const [w, a] = await Promise.all([getWeather(pt), getAlerts(pt)]);
  wx = w; alerts = a || [];
  if (tab === 'today' && !sheetStack.length) render();
}

// ---------- render plumbing
const VIEWS = { today: vToday, map: vMap, places: vPlaces, me: vWeek };
// Error boundary: a bug in one screen must never leave the app blank or stuck. It's logged (and synced) for fixing.
function render() {
  const y = window.scrollY, same = render.last === tab;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  document.body.classList.toggle('map-on', tab === 'map');
  if (tab !== 'map' && $('#mapBox')) $('#mapBox').hidden = true;
  let html;
  try { html = VIEWS[tab](); }
  catch (e) {
    logError(e, 'render ' + tab);
    html = `<div class="card" style="margin-top:30px"><b>This screen hit a bug</b><p class="note">It's been logged so it can be fixed. Your plans are safe.</p>
      <div class="blk-acts"><button class="btn sm primary" data-a="reload">Reload app</button><button class="btn sm" data-a="tabTo" data-t="${tab === 'today' ? 'places' : 'today'}">Go to ${tab === 'today' ? 'Places' : 'Today'}</button><button class="btn sm ghost" data-a="repairToday">Repair today</button></div></div>`;
  }
  const v = $('#view');
  v.innerHTML = html;
  if (!same) { v.classList.remove('view-in'); void v.offsetWidth; v.classList.add('view-in'); }
  if (tab === 'map') initMap().catch(e => logError(e, 'map'));
  window.scrollTo(0, same ? y : 0);
  render.last = tab;
}
function safeRender() { try { render(); } catch (e) { logError(e, 'safeRender'); } }
function openSheet(fn) { sheetStack.push(fn); drawSheet(true); }
let sheetCloseT;
function drawSheet(fresh) {
  const fn = sheetStack[sheetStack.length - 1], wrap = $('#sheetWrap');
  if (!fn) {
    document.body.style.overflow = '';
    if (wrap.hidden) return;
    // slide away instead of vanishing
    clearTimeout(sheetCloseT); wrap.classList.add('closing');
    sheetCloseT = setTimeout(() => { wrap.hidden = true; wrap.classList.remove('closing'); $('#sheet').style.transform = ''; }, 190);
    return;
  }
  clearTimeout(sheetCloseT); wrap.classList.remove('closing');
  const sc = $('#sheet').scrollTop;
  let html;
  try { html = fn(); }
  catch (e) {
    logError(e, 'sheet');
    html = sheetHead('Something went wrong') + `<p class="note">This view hit a bug (logged). Close it and try again.</p><button class="btn big" data-a="close">Close</button>`;
  }
  $('#sheetBody').innerHTML = html;
  $('#sheetWrap').hidden = false; document.body.style.overflow = 'hidden';
  $('#sheet').scrollTop = fresh ? 0 : sc;
}
function closeSheet(all) { if (all) sheetStack.length = 0; else sheetStack.pop(); drawSheet(true); safeRender(); }
function refresh() { if (sheetStack.length) drawSheet(); safeRender(); }
const dragging = () => !!document.querySelector('.blk.dragging');
A.reload = () => location.reload();
A.repairToday = () => { sanitize(); const d = getDay(today()); if (d) flow(d, 'missing'); save(); sheetStack.length = 0; drawSheet(); tab = 'today'; safeRender(); toast('Repaired'); };
window.addEventListener('error', e => logError(e.error || e.message, 'window'));
window.addEventListener('unhandledrejection', e => logError(e.reason, 'promise'));
function sheetHead(title, sub) {
  return `<div class="sheet-head"><div class="grow"><h2>${title}</h2>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
    <button class="x" data-a="${sheetStack.length > 1 ? 'back' : 'close'}">${sheetStack.length > 1 ? '‹' : '×'}</button></div>`;
}
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (undo ? ' <button data-a="undo">Undo</button>' : '');
  t.hidden = false; toast.undo = undo;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; toast.undo = null; }, undo ? 6000 : 3000);
}
A.undo = () => { const u = toast.undo; $('#toast').hidden = true; if (u) { u(); save(); refresh(); } };
A.close = () => closeSheet(true);
A.back = () => closeSheet();
let dragEnd = 0, lastTap = { k: '', t: 0 };
// read-only / navigation actions may repeat; everything else ignores an identical second tap within 600ms (no duplicate blocks)
const REPEATABLE = new Set(['dur', 'moveBlk', 'back', 'close', 'selDay', 'placesCat', 'mapFilter', 'tabTo', 'reconBad', 'reconWhy', 'kindPick']);
document.addEventListener('click', e => {
  if (Date.now() - dragEnd < 350) { e.preventDefault(); e.stopPropagation(); return; }
  const tb = e.target.closest('#tabs button');
  if (tb) { tab = tb.dataset.tab; trackEvent('tab', { tab }); closeSheet(true); return; }
  if (e.target.id === 'sheetBack') return closeSheet(true);
  const el = e.target.closest('[data-a]');
  if (!el) return;
  e.preventDefault(); e.stopPropagation();
  const name = el.dataset.a, fn = A[name];
  if (!fn) return;
  const key = name + JSON.stringify(el.dataset);
  if (!REPEATABLE.has(name) && key === lastTap.k && Date.now() - lastTap.t < 600) return;
  lastTap = { k: key, t: Date.now() };
  const { a, ...d } = el.dataset;
  trackEvent('tap', { a: name, ...Object.fromEntries(Object.entries(d).filter(([k]) => ['t', 'id', 'poi', 'k', 'z', 'blk', 'v', 'd'].includes(k))), tab });
  try { const r = fn(el.dataset, el); if (r?.catch) r.catch(err => { logError(err, 'action ' + name); toast('That didn’t work (logged). Try again?'); }); }
  catch (err) { logError(err, 'action ' + name); toast('That didn’t work (logged). Try again?'); try { drawSheet(); safeRender(); } catch {} }
});
document.addEventListener('change', e => { const el = e.target.closest('[data-c]'); if (el) try { C[el.dataset.c]?.(el); } catch (err) { logError(err, 'change ' + el.dataset.c); } });
document.addEventListener('input', e => { if (e.target.id === 'placesQ') { placesQ = e.target.value; $('#placesResults').innerHTML = placesResults(); } });
// drag a block card by its ⋮⋮ handle to reorder the day
(() => {
  let d = null;
  const pageY = e => e.clientY + scrollY;
  document.addEventListener('pointerdown', e => {
    const h = e.target.closest('[data-drag]');
    if (!h || d) return;
    e.preventDefault();
    const list = [...document.querySelectorAll('.tl .blk')], el = h.closest('.blk');
    if (list.indexOf(el) < 0) return;
    const boxes = list.map(x => { const r = x.getBoundingClientRect(); return { top: r.top + scrollY, h: r.height }; });
    d = { el, list, boxes, idx: list.indexOf(el), to: list.indexOf(el), y0: pageY(e), pid: e.pointerId };
    el.classList.add('dragging');
    try { h.setPointerCapture(e.pointerId); } catch {}
  });
  document.addEventListener('pointermove', e => {
    if (!d || e.pointerId !== d.pid) return;
    if (e.clientY < 90) scrollBy(0, -14); else if (e.clientY > innerHeight - 140) scrollBy(0, 14);
    const dy = pageY(e) - d.y0, me = d.boxes[d.idx], mid = me.top + me.h / 2 + dy;
    d.el.style.transform = `translateY(${dy}px)`;
    let to = 0;
    d.boxes.forEach((b, i) => { if (i !== d.idx && b.top + b.h / 2 < mid) to++; });
    d.to = to;
    const shift = me.h + 8;
    d.list.forEach((x, i) => {
      if (i === d.idx) return;
      x.style.transform = d.idx < i && i <= to ? `translateY(${-shift}px)` : to <= i && i < d.idx ? `translateY(${shift}px)` : '';
    });
  });
  const end = () => {
    if (!d) return;
    const { idx, to, list } = d;
    list.forEach(x => { x.style.transform = ''; x.classList.remove('dragging'); });
    d = null; dragEnd = Date.now();
    if (to === idx) return;
    const day = getDay(sel);
    if (!day || idx >= day.blocks.length || to >= day.blocks.length) return safeRender();
    const [b] = day.blocks.splice(idx, 1);
    day.blocks.splice(to, 0, b);
    autofill(day); render(); toast(`${BT[b.t].n} moved`);
  };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
})();
// pull down to refresh (home-screen apps have none): re-sync, fresh GPS, weather, car pings, re-plan around him
(() => {
  let y0 = null, x0 = 0, pull = 0, busy = false;
  const ind = document.createElement('div'); ind.id = 'ptr'; ind.innerHTML = '<i></i>'; document.body.appendChild(ind);
  const set = (py, anim) => {
    const v = $('#view');
    v.style.transition = ind.style.transition = anim ? 'transform .25s ease, opacity .25s' : 'none';
    v.style.transform = py ? `translateY(${py}px)` : '';
    ind.style.opacity = py ? Math.min(1, py / 50) : 0;
    ind.style.transform = `translateY(${Math.max(-40, py - 30)}px) rotate(${py * 5}deg)`;
  };
  addEventListener('touchstart', e => {
    y0 = null;
    if (busy || sheetStack.length || tab === 'map' || scrollY > 2 || e.touches.length > 1 || e.target.closest('[data-drag], .scroller, input, textarea, select, #sheetWrap')) return;
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; pull = 0;
  }, { passive: true });
  addEventListener('touchmove', e => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0, dx = e.touches[0].clientX - x0;
    if (!pull && (dy <= 4 || Math.abs(dx) > dy)) { if (dy < 0 || Math.abs(dx) > 10) y0 = null; return; }
    if (e.cancelable) e.preventDefault();
    pull = Math.min(110, (dy - 4) * 0.5);
    set(pull); ind.classList.toggle('ready', pull >= 60);
  }, { passive: false });
  const end = async () => {
    if (y0 == null) return;
    y0 = null;
    const go = pull >= 60; pull = 0; ind.classList.remove('ready');
    if (!go) return set(0, true);
    busy = true; ind.classList.add('spin'); set(48, true);
    try { await pullRefresh(); } catch (e) { logError(e, 'pullRefresh'); }
    busy = false; ind.classList.remove('spin'); set(0, true);
  };
  addEventListener('touchend', end); addEventListener('touchcancel', end);
})();
async function pullRefresh() {
  trackEvent('pull', { tab });
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);
  const [changed] = await Promise.all([withTimeout(syncPull(), 8000), withTimeout(locate(true), 8000), withTimeout(refreshWx(), 8000), withTimeout(pullPings(true), 8000)]);
  if (changed) { pruneDays(); sanitize(); }
  const done = autoTrack(), n = reanchor();
  syncPush(); actPush(true);
  render();
  toast(done.length ? 'Auto-tracked: ' + done[0] : n ? `Re-picked ${n} block${n > 1 ? 's' : ''} around you` : sync.err ? 'Refreshed (sync: ' + sync.err + ')' : 'Up to date · ' + locLabel());
}
// swipe the sheet down to dismiss
(() => {
  let y0 = null;
  const sh = $('#sheet');
  sh.addEventListener('touchstart', e => { y0 = sh.scrollTop <= 0 ? e.touches[0].clientY : null; sh.style.transition = 'none'; }, { passive: true });
  sh.addEventListener('touchmove', e => { if (y0 != null) { const dy = e.touches[0].clientY - y0; if (dy > 0) sh.style.transform = `translateY(${dy}px)`; } }, { passive: true });
  sh.addEventListener('touchend', e => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0; y0 = null; sh.style.transition = '';
    if (dy > 110) closeSheet(true); else sh.style.transform = '';
  });
  sh.addEventListener('touchcancel', () => { y0 = null; sh.style.transform = ''; });
})();

// ---------- shared bits
const chip = (t, c = '') => `<span class="chip ${c}">${esc(t)}</span>`;
function hoursChip(p, ts = Date.now(), dur = 0, quiet) {
  const f = fit(p, ts, dur);
  if (f.k === 'unk') return quiet ? '' : chip('Hours not listed');
  return chip(f.txt, f.k === 'ok' ? 'ok' : f.k === 'short' ? 'warn' : 'bad');
}
// Guy Fieri's Diners, Drive-ins and Dives: a flame with shades
const GUY_SVG = '<svg class="guy-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8.2.6c.5 2.6 4.4 3.9 4.4 8.2A4.6 4.6 0 0 1 8 13.6a4.6 4.6 0 0 1-4.6-4.7c0-1.9 1-3.2 1.9-4 .1 1.3.7 2.2 1.5 2.7C6.7 5.4 7.2 2.7 8.2.6z" fill="#F4511E"/><path d="M8.1 6.3c.3 1.4 2.3 2.2 2.3 4.4A2.4 2.4 0 0 1 8 13.2a2.4 2.4 0 0 1-2.4-2.5c0-1 .5-1.7 1-2.1.1.7.4 1.1.8 1.4 0-1.4.3-2.6.7-3.7z" fill="#FFC53D"/><rect x="3.9" y="8.6" width="3.6" height="2.1" rx="1" fill="#1d1d1f"/><rect x="8.5" y="8.6" width="3.6" height="2.1" rx="1" fill="#1d1d1f"/><path d="M7.4 9.3h1.2" stroke="#1d1d1f" stroke-width=".8"/></svg>';
const guyChip = () => `<span class="chip guy">${GUY_SVG}Guy's pick</span>`;
// Anthony Bourdain: a chef's knife
const TONY_SVG = '<svg class="guy-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.2 11.9 10.6 2.5c1-1 2.6-1 3.6 0 .4.4.2 1-.2 1.4L6 11.3l-1.5.3-3.3.3z" fill="#D8D6D0"/><path d="M1.2 11.9 10.6 2.5c.6-.6 1.4-.8 2.1-.7L5.1 9.9 1.2 11.9z" fill="#fff" opacity=".55"/><rect x="4.6" y="10.4" width="6.4" height="2.6" rx="1.1" transform="rotate(-45 7.8 11.7)" fill="#2B2B2E"/><circle cx="8.3" cy="12.9" r=".45" fill="#C9A45C"/><circle cx="9.6" cy="11.6" r=".45" fill="#C9A45C"/></svg>';
const tonyChip = () => `<span class="chip tony">${TONY_SVG}Tony's pick</span>`;
const money = v => (v == null ? '' : '$' + (+v % 1 ? (+v).toFixed(2) : +v));
function buffetChip(p) {
  const b = p.x.buffet;
  if (!b) return '';
  const h = new Date().getHours(), wk = [0, 6].includes(new Date().getDay());
  const [lbl, v] = wk && b.w != null ? ['Weekend', b.w] : h < 16 && b.l != null ? ['Lunch', b.l] : b.d != null ? ['Dinner', b.d] : b.l != null ? ['Lunch', b.l] : [null, null];
  return v != null ? chip(`🍽️ ${lbl} buffet ${money(v)}`, 'ok') : chip('Buffet · price unknown');
}
// Rows only show chips that change a decision: real hours, confirmed/reported evidence, overnight risk, waterfront perks.
function placeChips(p, type, ts, dur) {
  const out = [];
  if (isGuy(p)) out.push(guyChip());
  if (isTony(p)) out.push(tonyChip());
  if (p.x.buffet) out.push(buffetChip(p));
  if (p.x.theater) { const t = p.x.theater; if (t.alist && S.settings.alist) out.push(chip('A-List', 'acc')); if (t.fmt?.length) out.push(chip(t.fmt.slice(0, 2).join(' · '))); }
  if (isGoth(p)) out.push(chip('🦇 Goth', 'acc'));
  if (p.mine) out.push(chip('Your place', 'acc'));
  if (p.tags.includes('quirky')) out.push(chip('Quirky', 'acc'));
  if (p.x.trail) { const t = p.x.trail; if (t.mi) out.push(chip(`${t.mi} mi trails`, 'blue')); if (t.terrain) out.push(chip(t.terrain)); }
  if (p.x.wonder) { const w = p.x.wonder; out.push(chip(w.k || 'Wonder', 'blue')); if (w.swim) out.push(chip('Swim', 'ok')); }
  if (type === 'sleep') {
    const lc = lotChip(p); if (lc) out.push(chip(lc[0], lc[1]));
    const nc = nightChip(p, ts); if (nc) out.push(chip(nc[0], nc[1]));
    const neg = obsFor(p.id).filter(o => Date.now() - o.t < 120 * DAY).flatMap(o => o.tags).filter(t => OBS_TAGS[t]?.[1] < 0);
    if (neg.length) out.push(chip('You noted: ' + OBS_TAGS[neg[neg.length - 1]][0], 'bad'));
  }
  else { const hc = hoursChip(p, ts, dur, true); if (hc) out.push(hc); }
  const tc = trustChip(p, type && BT[type]?.caps?.length ? BT[type].caps : null);
  if (type !== 'sleep' && tc[1]) out.push(chip(tc[0], tc[1]));
  const sk = (!type || type === 'sleep') && sketchChip(p); if (sk) out.push(chip(sk[0], sk[1]));
  if (p.fv) {
    const f = p.fv;
    if (f.pl) out.push(chip('$'.repeat(f.pl), f.pl >= 3 ? 'warn' : ''));
    if (f.r) out.push(chip(`★${f.r}${f.rc ? ' (' + (f.rc >= 1000 ? (f.rc / 1000).toFixed(1) + 'k' : f.rc) + ')' : ''}`, f.r >= 4.5 ? 'ok' : ''));
    if (f.cheap) out.push(chip('Known for cheap', 'ok'));
    if (f.pl >= 3) out.push(chip('Pricey', 'warn'));
  }
  if (p.sp?.length || p.bd) {
    const ss = specialState(p, ts || Date.now());
    if (ss.now) out.push(liveChip(ss.now, p));
    else if (ss.next) out.push(chip(`${specialLabel(ss.next.x, p)} ${fmtClock(ss.next.start)}${ss.next.end != null ? '–' + fmtClock(ss.next.end) : ''} · ${specialWhat(ss.next.x)}`, 'acc'));
    else if (ss.today.length) out.push(chip('Today: ' + ss.today.map(specialWhat).slice(0, 2).join(' · '), 'acc'));
    else if (p.sp?.some(x => !x.dt)) out.push(chip('Specials ' + [...new Set(p.sp.filter(x => !x.dt).map(x => dayNames(x.d)))].join(', ')));
    const ev = (p.sp || []).filter(x => x.dt && x.dt >= dayKey()).sort((a, z) => a.dt.localeCompare(z.dt))[0];
    if (ev && !ss.today.includes(ev)) out.push(chip(`${new Date(ev.dt + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${ev.l || 'Event'}`, 'acc'));
    if (p.bd?.k) out.push(chip(p.bd.k.replace(/_/g, ' ')));
  }
  for (const [t, c] of wfChips(p).slice(0, type && /water|grill/.test(type) ? 4 : 2)) out.push(chip(t, c));
  const ln = lastNight(p.id); if (ln && Date.now() - ln < 10 * DAY) out.push(chip('Slept here ' + sleptAgo(p.id), 'warn'));
  else if (type === 'sleep' && alive(S.nights).some(n => n.poi === p.id && n.day === today())) out.push(chip('Tonight’s spot', 'ok'));
  if (S.fav[p.id]) out.push(chip('★ Saved', 'acc'));
  if (p.gq === 'city' || !p.lat) out.push(chip('No map pin'));
  return out.join(' ');
}
// a special running right now: lit up, with when it ends
const liveChip = (n, p) => `<span class="chip live"><i class="dot"></i>${esc(specialLabel(n.x, p))} now · until ${fmtClock(n.until)}${n.x.items?.[0] ? ' · ' + esc(n.x.items[0]) : ''}</span>`;
const isLive = (p, ts) => !!(p.sp?.length && specialState(p, ts || Date.now()).now);
const catLabel = p => (p.sc ? p.sc.replace(/_/g, ' ') : CAT_NAMES[p.c] || p.c);
function placeRow(r, type, extra = '') {
  const p = r.p;
  return `<div class="place${isLive(p, r.at) ? ' live' : ''}" data-a="openPlace" data-id="${p.id}"${type ? ` data-t="${type}"` : ''}>
    <div class="main"><div class="nm">${esc(p.n)}</div><div class="meta">${esc(catLabel(p))} · ${esc(p.city || p._z?.n || '')}</div>
    <div class="chips" style="margin-top:6px">${placeChips(p, type, r.at, r.dur)}</div></div>
    <div class="side"><span class="dist">${r.approx || (r.p.lat == null) ? '<span class="tiny muted">no pin</span>' : r.mi != null ? fmtMi(r.mi) : ''}</span>${extra || `<button class="btn sm go" data-a="nav" data-id="${p.id}">Go</button>`}</div></div>`;
}
function locLabel() {
  const short = z => z.n.split(' / ')[0], z = zoneOverride();
  if (z) return 'Planning: ' + short(z);
  if (S.loc) return (S.loc.acc > 3000 ? '≈ ' : '') + short(nearestZone(S.loc)) + (liveLoc() ? '' : ' · ' + fmtAgo(S.loc.t));
  return 'Set location';
}
function greeting() { const h = new Date().getHours(); return h < 4 ? 'Late night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening'; }
A.nav = ({ id }) => navigate([destOf(P[id])]);
A.openPlace = ({ id, t, blk }) => openSheet(() => placeSheet(id, t, blk));

// ---------- TODAY
function vToday() {
  const t = today();
  if (!sel || sel < t) sel = t;
  const d = new Date();
  let h = `<div class="top"><div><div class="sub">${WD[d.getDay()]} ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${fmtTime(Date.now())}</div><h1>${sel === t ? greeting() : dayLabel(sel)}</h1></div>
    <button class="btn sm loc" data-a="zonePick">📍 ${esc(locLabel())}</button></div>`;
  h += `<div class="scroller">${Array.from({ length: 10 }, (_, i) => addDays(t, i)).map(k =>
    `<button class="pill ${k === sel ? 'on' : ''}" data-a="selDay" data-d="${k}">${dayLabel(k)}${S.days[k]?.blocks.length ? '<i class="pdot"></i>' : ''}</button>`).join('')}</div>`;
  if (sel === t) h += zoneBanner() + alertsHtml() + coverageHtml() + hereHtml() + wxHtml() + specialsStrip();
  h += dayHtml(sel);
  if (sel === t) h += attentionHtml() + findHtml();
  return h;
}
A.selDay = ({ d }) => { sel = d; render(); };
// "Specials now": one scrolling row, lit-up cards for what's on now, then what starts soon
function specialsStrip() {
  const { on, soon } = specialsNear(liveLoc() || here());
  const items = [...on, ...soon].slice(0, 8);
  if (!items.length) return '';
  return `<div class="scroller spx-row">${items.map(({ p, mi, ss }) => {
    const n = ss.now, x = n ? n.x : ss.next.x;
    const when = n ? `until ${fmtClock(n.until)}` : `${fmtClock(ss.next.start)}${ss.next.end != null ? '–' + fmtClock(ss.next.end) : ''}`;
    return `<div class="spx${n ? ' live' : ''}" data-a="openPlace" data-id="${p.id}"><div class="spx-t">${n ? '<i class="dot"></i>' : ''}${esc(specialLabel(x, p))} · ${when}</div><div class="spx-n ell">${esc(p.n)}</div><div class="spx-i ell">${esc(specialWhat(x))}</div><div class="spx-m">${fmtMi(mi)} · ${esc(catLabel(p))}</div></div>`;
  }).join('')}<button class="spx more" data-a="needList" data-t="specials">All specials →</button></div>`;
}
function zoneBanner() {
  const z = zoneOverride();
  if (!z) return '';
  return `<div class="here">🧭 <span class="grow ell">Planning as if you're in <b>${esc(z.n.split(' / ')[0])}</b> (until ${fmtTime(S.zoneT + ZONE_TTL)})</span><button class="btn sm" data-a="useGps">Use GPS</button></div>`;
}
// the block type that best fits doing something at this place right now
const HERE_ORDER = ['gym', 'panera', 'library', 'kava', 'cafe', 'movie', 'arcade', 'run', 'wonder', 'water_work', 'pizza', 'meal', 'social', 'groc', 'laundry', 'car', 'gas', 'mail', 'books', 'vape', 'mall', 'fun', 'storage'];
const bestTypeFor = p => HERE_ORDER.find(t => BT[t]?.m?.(p)) || null;
const sleepish = p => !!(p.caps.sleep_candidate || p.caps.tent_camp || p.caps.paid_lodging || p._ov);
const evening = () => { const h = new Date().getHours(); return h >= 19 || h < 4; };
// "You're at X" + what the phone noticed while he was away (auto-tracking asks)
function hereHtml() {
  let h = '';
  for (const [k, v] of Object.entries(ACT.seen)) {
    if (!v.ask || v.done || Date.now() - v.t > 2 * DAY) continue;
    if (v.ask === 'night') h += `<div class="here">🌙 <span class="grow">You parked overnight (${fmtTime(v.s)}–${fmtTime(v.e)}) at a spot that isn't in the app.</span><button class="btn sm primary" data-a="addPlaceAt" data-lat="${v.lat}" data-lng="${v.lng}" data-seen="${k}">Save it</button><button class="bx" data-a="dismissAsk" data-k="${k}" aria-label="Dismiss">×</button></div>`;
    if (v.ask === 'dash') h += `<div class="here">🚗 <span class="grow">Looks like a DoorDash run, ${fmtTime(v.s)}–${fmtTime(v.e)} (${v.n} restaurant stops).</span><button class="btn sm primary" data-a="logDashRun" data-k="${k}">Log it</button><button class="bx" data-a="dismissAsk" data-k="${k}" aria-label="Dismiss">×</button></div>`;
  }
  const l = liveLoc(15 * MIN);
  if (!l || (l.acc || 0) > 400) return h;
  const p = nearbyPoi(l), day = getDay(today()), act = day?.blocks.find(b => b.st === 'active');
  // morning at a lot / unknown spot and last night isn't logged: one tap to log it
  const hr = new Date().getHours(), lastNightDay = addDays(today(), -1);
  // he's been parked here since early morning (or it's still early): probably where he slept
  const crumb = ACT.pts[ACT.pts.length - 1], settled = hr < 9 || (crumb && hav(crumb, l) < 0.1 && Date.now() - crumb.t > 45 * MIN);
  let asked = false;
  if (hr >= 4 && hr < 11 && settled && !alive(S.nights).some(n => n.day === lastNightDay || (n.t > Date.now() - 14 * HOUR && !n.day))) {
    asked = true;
    if (p && sleepish(p)) h += `<div class="here">🌙 <span class="grow ell">Slept at <b>${esc(p.n)}</b> last night?</span><button class="btn sm primary" data-a="sleptLast" data-id="${p.id}">✓ Log it</button></div>`;
    else if (!p && (l.acc || 0) <= 150) h += `<div class="here">🌙 <span class="grow ell">Slept here last night?</span><button class="btn sm primary" data-a="addPlace" data-around="1" data-night-day="${lastNightDay}" data-kind="hotel">Save + log it</button></div>`;
  }
  if (p) {
    const t = bestTypeFor(p), running = act && act.poi === p.id;
    h += `<div class="here" data-a="openPlace" data-id="${p.id}">📍 <span class="grow ell">At <b>${esc(p.n)}</b></span>
      ${running ? chip(BT[act.t].n + ' · ' + fmtDur((Date.now() - act.s0) / MIN), 'acc') : t ? `<button class="btn sm" data-a="hereStart" data-id="${p.id}" data-t="${t}">▶ ${esc(BT[t].n)}</button>` : ''}
      ${evening() && sleepish(p) ? `<button class="btn sm" data-a="sleepHere" data-id="${p.id}">🌙 Sleep here</button>` : ''}</div>`;
  } else if ((l.acc || 0) <= 150 && !asked) {
    h += `<div class="here">📍 <span class="grow ell muted">This spot isn't in the app</span>${evening() ? `<button class="btn sm" data-a="sleepHere">🌙 Sleep here</button>` : ''}<button class="btn sm" data-a="addPlace" data-around="1">+ Save it</button></div>`;
  }
  return h;
}
// "I'm doing X here, now": start the matching planned block (or add one) at this place
A.hereStart = ({ id, t }) => {
  const day = ensureDay(today()), p = P[id];
  if (!p || !BT[t]) return;
  for (const x of day.blocks) if (x.st === 'active') finishBlock(x, true);
  let b = day.blocks.find(x => x.st === 'plan' && (x.poi === id || (x.t === t && !x.pinned)));
  if (!b) { b = mkBlock(t); const at = day.blocks.findIndex(x => x.st === 'plan'); day.blocks.splice(at < 0 ? day.blocks.length : at, 0, b); }
  const fi = day.blocks.findIndex(x => x.st === 'plan');
  if (fi >= 0 && day.blocks.indexOf(b) > fi) { day.blocks.splice(day.blocks.indexOf(b), 1); day.blocks.splice(fi, 0, b); }
  b.poi = id; b.pinned = true; b.st = 'active'; b.s0 = Date.now();
  sanitize(); save(); closeSheet(true); toast(`${BT[b.t].n} started at ${p.n}`);
};
// log (or correct) last night's spot
A.sleptLast = ({ id }) => {
  const d = addDays(today(), -1);
  if (!P[id]) return;
  dropNights(n => n.day === d || (!n.day && n.t > Date.now() - 14 * HOUR));
  const n = { poi: id, t: Date.now(), day: d };
  S.nights.push(n); save(); sheetStack.length = 0; drawSheet(); safeRender();
  toast('Last night: ' + P[id].n, () => { n.del = Date.now(); });
};
A.delNight = ({ k }) => { const n = S.nights.find(x => !x.del && String(x.t) === k); if (!n) return; n.del = Date.now(); save(); render(); toast('Night removed', () => { delete n.del; }); };
A.dismissAsk = ({ k }) => { if (ACT.seen[k]) ACT.seen[k].done = 1; actSave(); render(); };
A.addPlaceAt = ({ lat, lng, seen }) => { A.addPlace({ lat, lng, seen, night: '1' }); };
A.logDashRun = ({ k }) => {
  const v = ACT.seen[k]; if (!v) return;
  v.done = 1; actSave();
  openSheet(() => dashSheet(null, ((v.e - v.s) / HOUR + 0.25).toFixed(1)));
};
function alertsHtml() {
  if (!alerts.length) return '';
  return '<div class="stack" style="margin-bottom:10px">' + alerts.slice(0, 3).map((a, i) =>
    `<div class="alert" data-a="alertOpen" data-i="${i}">⚠️ ${esc(a.ev)}${a.ends ? ' · until ' + esc(new Date(a.ends).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })) : ''}</div>`).join('') + '</div>';
}
A.alertOpen = ({ i }) => { const a = alerts[i]; openSheet(() => sheetHead(esc(a.ev), esc(a.sev || '')) + `<p><b>${esc(a.head)}</b></p><p class="note" style="white-space:pre-wrap">${esc(a.desc)}</p>${a.ins ? `<p class="note" style="white-space:pre-wrap"><b>What to do:</b> ${esc(a.ins)}</p>` : ''}`); };
function coverageHtml() {
  const c = coverage();
  if (c.ok) return '';
  return `<div class="card" style="margin-bottom:10px"><b>You're outside the mapped area</b><p class="note">${Math.round(c.mi)} mi from the nearest zone (${esc(c.zone.n)}). Nothing near you is in the data yet.</p>
    <button class="btn sm primary" data-a="packReq">Get a research prompt for this area</button></div>`;
}
function wxHtml() {
  const sun = sunToday();
  if (!wx) return `<div class="wxline"><span>Sunset ${fmtTime(sun.set)}</span></div>`;
  const c = wx.current, [txt, ic] = WXC(c.weather_code);
  const night = Date.now() > sun.set || Date.now() < sun.rise;
  const tip = wxInsights(wx)[0];
  return `<div class="wxline" data-a="wxOpen"><span class="wxt">${night && ic === '☀️' ? '🌙' : ic} ${Math.round(c.temperature_2m)}°</span><span class="grow ell muted">${txt} · feels ${Math.round(c.apparent_temperature)}° · sunset ${fmtTime(sun.set)}</span><span class="faint">›</span></div>${tip ? `<div class="wxnote">${esc(tip)}</div>` : ''}`;
}
A.wxOpen = () => openSheet(() => {
  const c = wx.current, dl = wx.daily, sun = sunToday(), [txt, ic] = WXC(c.weather_code);
  return sheetHead(`${ic} ${Math.round(c.temperature_2m)}° ${txt}`, `Feels ${Math.round(c.apparent_temperature)}° · wind ${Math.round(c.wind_speed_10m)} mph`) +
    `<dl class="kv"><dt>Today</dt><dd>H ${Math.round(dl.temperature_2m_max[0])}° · L ${Math.round(dl.temperature_2m_min[0])}° · rain ${dl.precipitation_probability_max[0] ?? 0}% · UV ${Math.round(dl.uv_index_max?.[0] ?? 0)}</dd>
    <dt>Tomorrow</dt><dd>H ${Math.round(dl.temperature_2m_max[1])}° · L ${Math.round(dl.temperature_2m_min[1])}° · rain ${dl.precipitation_probability_max[1] ?? 0}%</dd>
    <dt>Sun</dt><dd>sets ${fmtTime(sun.set)} · rises ${fmtTime(sunTimes(new Date(Date.now() + DAY), here().lat, here().lng).rise)}</dd></dl>` +
    wxInsights(wx).map(t => `<p class="note">${esc(t)}</p>`).join('');
});
// "Worth doing now": one deduped list; skips anything already coming up in today's plan
function attentionHtml() {
  const day = getDay(today());
  const planned = new Set((day?.blocks || []).filter(b => b.st === 'plan' || b.st === 'active').map(b => b.t));
  const list = suggest().filter(([t]) => !planned.has(t) && !(t === 'shower' && planned.has('gym'))).slice(0, 3);
  if (!list.length) return '';
  return `<h2>Worth doing now</h2><div class="list">${list.map(([t, why]) => {
    const r = rank(t)[0];
    if (!r || r.mi > 15) return '';
    const f = fit(r.p, Date.now(), BT[t].dur);
    return `<div class="place" data-a="openPlace" data-id="${r.p.id}" data-t="${t}"><span style="font-size:22px;width:28px">${BT[t].ic}</span>
      <div class="main"><div class="nm">${BT[t].n} <span class="muted small" style="font-weight:500">· ${esc(why)}</span></div>
      <div class="meta ell">${esc(r.p.n)} · ${fmtMi(r.mi)}${f.k !== 'unk' ? ' · ' + esc(f.txt) : ''}</div></div>
      <div class="side"><button class="btn sm primary" data-a="addBlock" data-t="${t}" data-poi="${r.p.id}" data-next="1">+ Add</button><button class="btn sm ghost" data-a="nav" data-id="${r.p.id}">Go</button></div></div>`;
  }).join('')}</div>`;
}
function findHtml() {
  const items = [['specials', 'Specials now'], ['deep', 'Work spot'], ['water_s', 'Water spot'], ['restroom', 'Restroom'], ['gas', 'Gas'], ['meal', 'Food'], ['ddd', "Guy's picks"], ['pizza', 'Pizza'], ['crave', 'Cravings'], ['meat', 'Meat deals'], ['run', 'Trail runs'], ['wonder', 'Springs & wonders'], ['movie', 'Movies'], ['arcade', 'Arcades'], ['tony', "Tony's picks"], ['mall', 'Malls'], ['kava', 'Kava / tea'], ['panera', 'Panera'], ['sleep', 'Sleep spot'], ['shower', 'Shower'], ['water', 'Drinking water'], ['library', 'Library'], ['grill', 'Grill'], ...(new Date().getDay() ? [['social', 'Bars'], ['goth', 'Goth'], ['ladies', "Ladies' nights"], ['clubs', 'Clubs']] : []), ['books', 'Bookstores'], ['groc', 'Supply run'], ['vape', 'Vape shops'], ['laundry', 'Laundry'], ['car', 'Auto parts']];
  return `<h2>Find nearby</h2><div class="scroller">${items.map(([t, l]) => `<button class="pill" data-a="needList" data-t="${t}">${t === 'ddd' ? GUY_SVG : t === 'tony' ? TONY_SVG : { crave: '🍔', ladies: '💃', clubs: '🍸', goth: '🦇', specials: '🍹' }[t] || BT[t].ic} ${l}</button>`).join('')}<button class="pill" data-a="addPlace">＋ Add a place</button></div>`;
}
// lists by tag (not block types): Guy Fieri picks, cult chains + quirky spots
const TAG_LISTS = {
  ddd: [p => isGuy(p), "Guy's picks", 'Diners, Drive-ins and Dives spots near you'],
  crave: [p => p.tags.includes('crave') || p.tags.includes('quirky'), 'Cravings', 'Cult chains and quirky one-offs'],
  ladies: [p => (p.sp || []).some(x => /ladies/i.test(x.l || '')), "Ladies' nights", 'Which night, what the deal is, when it was posted'],
  clubs: [p => isClub(p), 'Clubs', 'Gentlemen’s clubs: drink specials, free-entry windows'],
  tony: [p => isTony(p), "Tony's picks", 'Places Anthony Bourdain went on camera or recommended'],
  goth: [p => isGoth(p), 'Goth', 'Goth / darkwave / industrial bars, clubs and nights'],
};
function tagRows(k, from = here()) {
  const [m] = TAG_LISTS[k];
  return D.pois.filter(p => m(p) && !S.avoid[p.id]).map(p => { const pt = ptOf(p); return { p, mi: pt ? hav(from, pt) : 999, approx: pt?.approx }; }).sort((a, b) => a.mi - b.mi);
}
const notListed = (t, blk) => `<button class="btn big ghost" data-a="addPlace" ${blk ? `data-blk="${blk}"` : ''} ${t ? `data-kind="${t}"` : ''} style="margin-top:10px">Not listed? Search any place or save where you are →</button>`;
A.tabTo = ({ t }) => { tab = t; render(); };
A.needList = ({ t }) => openSheet(() => listSheet(t));
function listSheet(t, limit = 25) {
  if (t === 'specials') {
    const from = liveLoc() || here(), { on, soon } = specialsNear(from, Date.now(), 15, 12 * 60);
    const row = ({ p, mi, ss }) => placeRow({ p, mi }, p.c === 'social' ? 'social' : 'meal');
    return sheetHead('🍹 Specials', 'Lunch specials and happy hours near ' + esc(locLabel())) +
      `<h2>On now · ${on.length}</h2><div class="list">${on.map(row).join('') || '<div class="empty">Nothing running right now nearby.</div>'}</div>` +
      `<h2>Later today · ${soon.length}</h2><div class="list">${soon.map(row).join('') || '<div class="empty">No more known specials today nearby.</div>'}</div>` +
      '<p class="tiny faint" style="margin-top:10px">Each special shows when it was posted and a link to its source on the place page.</p>';
  }
  if (TAG_LISTS[t]) {
    const [, n, sub] = TAG_LISTS[t], rows = tagRows(t).slice(0, 40);
    return sheetHead(({ ddd: GUY_SVG, tony: TONY_SVG, crave: '🍔', ladies: '💃', clubs: '🍸', goth: '🦇' }[t] || '') + ' ' + n, sub) + `<div class="list">${rows.map(r => placeRow(r, ['ladies', 'clubs', 'goth'].includes(t) ? 'social' : 'meal')).join('') || '<div class="empty">None in the data yet.</div>'}</div>` + notListed('food');
  }
  if (t === 'gas') return sheetHead('⛽ Gas', 'Murphy USA first: usually cheapest') + `<a class="btn big" target="_blank" rel="noopener" href="https://www.gasbuddy.com/home?search=${encodeURIComponent((zoneOfPoint(here())?.n.split(' / ')[0] || '') + ', FL')}">Live prices on GasBuddy</a>` + `<div class="list" style="margin-top:10px">${rank('gas').slice(0, 20).map(r => placeRow(r, 'gas')).join('') || '<div class="empty">No gas stations in the data near here yet.</div>'}</div>` + notListed('gas');
  if (t === 'deep') return sheetHead('🎮 Work spots', 'Near ' + esc(locLabel())) + devOptions(here(), Date.now(), x => `<button class="btn sm go" data-a="nav" data-id="${x.p.id}">Go</button>`) + notListed('cafe');
  if (t === 'movie') {
    const rows = rank('movie', { dur: 0 }).slice(0, limit);
    return sheetHead('🎬 Movies', S.settings.alist ? 'A-List: reserve free in the AMC app · showtimes open the theater page' : 'Showtimes open each theater’s page') +
      `<div class="list">${rows.map(r => placeRow(r, 'movie', showtimesBtn(r.p) + `<button class="btn sm ghost" data-a="nav" data-id="${r.p.id}">Go</button>`)).join('') || '<div class="empty">No theaters in the data near here.</div>'}</div>` + notListed('movie');
  }
  const rows = rank(t, { dur: t === 'sleep' ? 0 : BT[t].dur }).slice(0, limit);
  const note = t === 'sleep' ? `<p class="note">Practical shortlist, not permission. Sketchy / gray-area spots are labeled. Newest iOverlander check-ins break ties.</p>` : '';
  return sheetHead(`${BT[t].ic} ${BT[t].n}`, 'Best matches near ' + esc(locLabel().replace('Near ', ''))) + note +
    `<div class="list">${(t === 'sleep' ? rows.slice().sort((a, z) => a.mi - z.mi) : rows).map(r => placeRow(r, t, t === 'sleep' ? `<button class="btn sm primary" data-a="reconQuick" data-id="${r.p.id}">+ Recon</button><button class="btn sm ghost" data-a="nav" data-id="${r.p.id}">Go</button>` : '')).join('') || '<div class="empty">Nothing in range.</div>'}</div>` + notListed(MINE_FOR[t]);
}
// block type → the kind a new place of that sort gets
// live showtimes can't be fetched from the phone (AMC blocks it), so each theater gets a one-tap link to its own showtimes page
const showtimesUrl = p => p.x.theater?.url || (p.web ? p.web : 'https://www.google.com/search?q=' + encodeURIComponent(p.n + ' showtimes today'));
const showtimesBtn = p => `<a class="btn sm primary" href="${esc(showtimesUrl(p))}" target="_blank" rel="noopener">🎟️ Showtimes</a>`;
const MINE_FOR = { movie: 'movie', arcade: 'arcade', sleep: 'hotel', cafe: 'cafe', kava: 'kava', panera: 'cafe', library: 'library', deep: 'cafe', light: 'cafe', water_s: 'water', water_work: 'water', water_l: 'water', grill: 'water', meal: 'food', meat: 'food', pizza: 'pizza', social: 'bar', gym: 'gym', shower: 'gym', run: 'run', fun: 'fun', wonder: 'fun', groc: 'groc', gas: 'gas', laundry: 'laundry' };
function suggest() {
  const now = new Date(), h = now.getHours() + now.getMinutes() / 60, out = [];
  const sun = sunToday(), toSunset = (sun.set - now) / HOUR;
  const age = k => (S.last[k] ? (Date.now() - S.last[k]) / HOUR : 999);
  if (age('shower') > 22) out.push(['gym', S.last.shower ? 'Last shower ' + fmtAgo(S.last.shower) : 'Lift + shower']);
  if (toSunset > 0.3 && toSunset < 2.3) out.push(['water_s', 'Sunset at ' + fmtTime(sun.set)]);
  if (h >= 5 && h < 9) out.push(['water_s', 'Morning at the water']);
  const dzs = D.dd[zoneOfPoint(here())?.id] || [];
  const inWin = dzs.some(m => (m.win || []).some(w => { const [a, b] = w.split('-').map(x => +x.split(':')[0] + +x.split(':')[1] / 60); return h >= a - 0.5 && h < b; }));
  if (inWin) out.push(['dash', 'DoorDash peak window']);
  if (h >= 7 && toSunset > 2.3) out.push(['water_work', 'Work by the water']);
  if (h >= 9 && h < 17) out.push(['cafe', 'Café session']);
  if (h >= 9 && h < 20) out.push(['panera', 'Powered work session']);
  if ((h >= 11 && h < 14) || (h >= 17 && h < 20.5)) out.push(['meal', 'Meal time']);
  if (h >= 16 && h < 19.5) out.push(['grill', 'Grill dinner by the water']);
  const dow = now.getDay();
  if (dow >= 1 && dow <= 4 && h >= 15 && h < 21) { const b = rank('social', { at: Date.now() })[0]; if (b && b.mi <= 15 && specialsAt(b.p).today.length) out.push(['social', specialsAt(b.p).now ? 'Specials on right now' : 'Specials tonight']); }
  if ((dow === 5 || dow === 6) && h >= 20) out.push(['social', 'Dive bar night']);
  if (h >= 20 || h < 3) out.push(['sleep', 'Line up tonight’s spot']);
  if (age('water_refill') > 72) out.push(['water', 'Jug refill due']);
  if (age('laundry') > 168) out.push(['laundry', 'Laundry due']);
  if (SUPPLIES.some(s => S.supplies[s])) out.push(['groc', 'Supplies running low']);
  const seen = new Set();
  return out.filter(([t]) => !seen.has(t) && seen.add(t)).slice(0, 3);
}

// ---------- day timeline
let showAllTpl = false;
function tplScore(tpl, date) {
  const now = new Date(), h = date === today() ? now.getHours() + now.getMinutes() / 60 : 8;
  const left = (24 - h) * 60;
  const total = tpl.b.reduce((a, x) => { const [t, d] = x.split(':'); return a + (t === 'sleep' ? 0 : (d ? +d : BT[t].dur) + 10); }, 0);
  let s = -Math.abs(total - Math.min(left, 14 * 60)) / 60;
  if (tpl.id === 'blank' || tpl.id === 'car' || tpl.id === 'move') s -= 2;
  if (tpl.id === 'library') s -= 6;
  if (h < 10 && /water_l/.test(tpl.b.join())) s += 1;
  if (h >= 16 && tpl.id === 'tired') s += 2;
  if (h < 16 && tpl.id === 'cash' && (D.dd[zoneOfPoint(here())?.id] || []).length) s += 0.5;
  // favor day types whose venues actually exist around here
  for (const t of new Set(tpl.b.map(x => x.split(/[:@]/)[0]))) if (LOCAL_T.has(t) && !localAvail(t)) s -= 2;
  return s;
}
const availCache = {};
function localAvail(t) {
  const pt = here(), k = t + (pt.lat).toFixed(2) + (pt.lng).toFixed(2);
  if (!(k in availCache)) { const r = rank(t, { dur: 0 })[0]; availCache[k] = !!r && r.mi <= 15; }
  return availCache[k];
}
function dayHtml(date) {
  const day = getDay(date);
  const isToday = date === today();
  if (!day) {
    const prev = getDay(addDays(date, -1));
    const ranked = TEMPLATES.slice().sort((a, b) => tplScore(b, date) - tplScore(a, date));
    const card = (t, big) => `<button class="tpl${big ? ' big' : ''}" data-a="useTpl" data-id="${t.id}"><b>${esc(t.n)}</b><span>${t.b.map(x => BT[x.split(':')[0]].ic).join(' ')}</span>${big ? `<span>${esc(t.d)}</span>` : ''}</button>`;
    return `<h2>${isToday ? 'Build today' : 'Plan ' + dayLabel(date)}</h2>
      <div class="stack">${ranked.slice(0, 2).map(t => card(t, 1)).join('')}</div>
      <div class="row wrap" style="margin-top:10px">${prev ? `<button class="btn sm" data-a="copyDay" data-from="${prev.date}" data-to="${date}">Copy ${dayLabel(prev.date)}</button>` : ''}<button class="btn sm" data-a="useTpl" data-id="blank">Start blank</button><button class="btn sm ghost" data-a="moreTpl">${showAllTpl ? 'Fewer day types' : 'More day types'}</button></div>
      ${showAllTpl ? `<div class="grid2" style="margin-top:10px">${ranked.slice(2).filter(t => t.id !== 'blank').map(t => card(t)).join('')}</div>` : ''}`;
  }
  const rows = flow(day), o = dayOrigin(day);
  const firstPending = rows.find(r => !r.skip && r.b.st !== 'done');
  let h = `<div class="top" style="margin-top:18px;margin-bottom:6px"><h2 style="margin:0">${isToday ? 'Your day' : dayLabel(date)}</h2>
    <div class="row"><button class="btn sm primary" data-a="route">▶ Route</button><button class="btn sm" data-a="dayMenu">•••</button></div></div>
    <div class="sub" style="margin-bottom:10px">${isToday ? 'From ' : `Starts ${fmtClock(day.startMin ?? 480)} from `}${esc(o.label)}</div><div class="tl">`;
  let prevPoi = null;
  rows.forEach(r => { h += blockHtml(r, day, r === firstPending, isToday, prevPoi); if (!r.skip && r.b.poi) prevPoi = r.b.poi; });
  h += `</div><button class="btn big" data-a="addBlockSheet" style="margin-top:4px">+ Add block</button>`;
  if (isToday && new Date().getHours() >= 17 && !getDay(addDays(date, 1))) h += `<button class="btn big ghost" data-a="selDay" data-d="${addDays(date, 1)}">Plan tomorrow →</button>`;
  return h;
}
A.moreTpl = () => { showAllTpl = !showAllTpl; render(); };
function blockTitle(b) {
  if (b.t === 'travel') return 'Travel → ' + (Z[b.toZone]?.n || 'pick a zone');
  if (b.t === 'gym') return 'Gym + shower · ' + WORKOUTS[S.workout % 5].n;
  if (!BT[b.t].m && !BT[b.t].night && b.t !== 'travel' && b.t !== 'free') return BT[b.t].n + ' · wherever you\'re parked';
  return b.label || BT[b.t].n;
}
const warnActs = (r, b) => (r.acts || []).map(([a, l]) => `<button class="btn sm" data-a="${a}" data-id="${b.id}" data-blk="${b.id}" data-kind="${MINE_FOR[b.t] || ''}">${esc(l)}</button>`).join('');
function blockHtml(r, day, isNext, isToday, prevPoi) {
  const b = r.b, def = BT[b.t], p = b.poi && P[b.poi];
  if (!def) return '';
  const cls = b.st === 'active' ? 'active' : b.st === 'done' ? 'done' : r.skip ? 'skipped' : '';
  const leg = (!r.skip && r.gap > 20 ? `<div class="travel">✨ Free ${fmtDur(r.gap)}${b.at != null ? ' before ' + BT[b.t].n.toLowerCase() + ' at ' + fmtClock(b.at) : ''}</div>` : '') + (!r.skip && r.travel ? `<div class="travel">🚗 ${fmtDur(r.travel)} · ${fmtMi(r.miles)}</div>` : '');
  let chips = '';
  if (p && b.st !== 'done' && !r.skip) chips = placeChips(p, b.t, r.s, b.t === 'sleep' ? 0 : b.dur);
  if (b.t === 'travel' && r.miles) chips = chip(fmtMi(r.miles) + ' ' + (Z[b.toZone] ? bearing(dayOrigin(day).pt, Z[b.toZone]) : ''), 'blue');
  const warns = (r.warn || []).map(w => `<div class="warnline">⚠️ ${esc(w)}${p && /Closed|closes|Gate/.test(w) ? ` <button class="btn sm" data-a="fixBlk" data-id="${b.id}">Fix</button>` : ''}</div>`).join('') +
    (r.acts?.length && b.st !== 'done' ? `<div class="blk-acts">${warnActs(r, b)}</div>` : '');
  // night spot: recon targets until one is confirmed
  let recon = '';
  if (b.t === 'sleep' && !b.confirmed && b.st !== 'done') {
    const tg = (b.recon || []).filter(x => P[x.poi]);
    recon = tg.length ? `<div class="recon">${tg.map(x => `<div class="rrow ${x.st}"><span>${x.st === 'good' ? '✓' : x.st === 'bad' ? '✗' : '○'}</span><span class="grow ell">${esc(P[x.poi].n)}</span><span class="faint small">${esc((lotChip(P[x.poi]) || [''])[0])}</span></div>`).join('')}</div>` : '';
    recon += `<div class="blk-acts">${tg.some(x => x.st === 'todo') ? `<button class="btn sm primary" data-a="reconNext" data-blk="${b.id}">▶ Recon next</button>` : ''}<button class="btn sm" data-a="openBlock" data-id="${b.id}">${tg.length ? 'Options + status' : 'Pick spots to check'}</button></div>`;
  }
  // no good match for this venue type nearby: let him pick what to do instead (never swapped silently)
  const conv = b.st === 'plan' && BT[b.t].alts && (r.warn || []).some(w => /^Nearest|^No /.test(w))
    ? `<div class="blk-acts">${BT[b.t].alts.filter(t => !isToday || localAvail(t)).map(t => `<button class="btn sm" data-a="convBlk" data-id="${b.id}" data-t="${t}">${BT[t].ic} ${BT[t].n} instead</button>`).join('')}${b.far && P[b.far] ? `<button class="btn sm ghost" data-a="pickPlace" data-blk="${b.id}" data-id="${b.far}">Drive to it anyway</button>` : ''}</div>` : '';
  let acts = '';
  if (p && b.t === 'movie' && b.st !== 'done' && !r.skip) acts = `<div class="blk-acts">${showtimesBtn(p)}</div>`;
  if (isToday && b.st === 'active') acts = `<div class="blk-acts"><button class="btn sm primary" data-a="doneBlk" data-id="${b.id}">✓ Done</button><button class="btn sm" data-a="extend" data-id="${b.id}">+30m</button>${p ? `<button class="btn sm" data-a="nav" data-id="${p.id}">Directions</button>` : ''}</div>`;
  else if (isToday && isNext) acts = `<div class="blk-acts">${p || b.t === 'travel' ? `<button class="btn sm primary" data-a="goBlk" data-id="${b.id}">Go</button>` : ''}<button class="btn sm" data-a="startBlk" data-id="${b.id}">Start</button><button class="btn sm ghost" data-a="doneBlk" data-id="${b.id}">Done</button></div>`;
  // resize right on the card
  if (b.st !== 'done' && b.t !== 'sleep' && !r.skip) {
    const st = WORK_BLOCKS.has(b.t) ? 30 : 15;
    const ctl = `<div class="dur"><button data-a="dur" data-id="${b.id}" data-v="-${st}" aria-label="Shorter">−</button><span>${fmtDur(b.dur)}</span><button data-a="dur" data-id="${b.id}" data-v="${st}" aria-label="Longer">+</button></div>`;
    acts = acts ? acts.replace('<div class="blk-acts">', '<div class="blk-acts">' + ctl) : `<div class="blk-acts">${ctl}</div>`;
  }
  if (p && b.st !== 'done' && !r.skip) {
    const ic = amenIcons(p);
    if (ic.length) {
      const row = `<span class="amen">${ic.map(([i, t]) => `<span title="${t}">${i}</span>`).join('')}</span>`;
      acts = acts ? acts.replace(/<\/div>$/, row + '</div>') : `<div class="blk-acts">${row}</div>`;
    }
  }
  const time = r.skip ? '' : b.t === 'sleep' ? fmtTime(r.s) : `${fmtTime(r.s)}<small>${fmtDur(b.st === 'done' ? (r.e - r.s) / MIN : b.dur)}</small>`;
  return leg + `<div class="blk ${cls}" data-bid="${b.id}"><div class="blk-time">${time}</div>
    <div class="blk-body" data-a="openBlock" data-id="${b.id}">
      <div class="blk-title"><span class="ic">${def.ic}</span><span class="grow ell">${esc(blockTitle(b))}</span>${b.st === 'active' ? chip(r.over ? 'Over' : 'Now', 'acc') : ''}${b.st === 'done' ? chip('Done', 'ok') : ''}${r.skip ? chip('Skipped') : ''}<span class="drag" data-drag="${b.id}" aria-label="Drag to reorder">⋮⋮</span><button class="bx" data-a="delBlk" data-id="${b.id}" aria-label="Remove">×</button></div>
      ${def.night ? (() => { const ns = nextSleep(day, b), np = ns?.confirmed && P[ns.poi]; return `<div class="blk-place muted">${np ? 'At tonight\'s spot · ' + esc(np.n) : ns ? 'At or near tonight\'s spot' : 'Wherever you\'re parked'}</div>`; })() : ''}${p ? `<div class="blk-place"><span class="grow ell">${prevPoi === p.id ? `<span class="muted">Stay put · ${esc(p.n)}</span>` : `<span class="nm">${esc(p.n)}</span> <span class="muted">· ${esc(p.city || '')}</span>`}</span></div>` : ''}
      ${b.t === 'sleep' && b.confirmed ? chip('✓ Confirmed', 'ok') + ' ' : ''}${b.auto && b.st !== 'plan' ? chip(b.auto === 'car' || b.auto === 'gps' ? 'Auto-tracked' : b.auto === 'arrived' ? 'Started when you arrived' : b.auto === 'left' ? 'Ended when you left' : 'Auto-closed', 'blue') + ' ' : ''}${chips ? `<div class="chips" style="margin-top:6px">${chips}</div>` : ''}${recon}${warns}${conv}${acts}</div></div>`;
}
function findBlock(id) {
  for (const day of Object.values(S.days)) { const i = day.blocks.findIndex(b => b.id === id); if (i >= 0) return { day, b: day.blocks[i], i }; }
  return {};
}
A.useTpl = ({ id }) => {
  if (getDay(sel)?.blocks.length) return toast('This day already has a plan. Clear it first (••• menu).');
  const n = newDay(id, sel);
  save(); render();
  toast(n ? `Trimmed ${n} block${n > 1 ? 's' : ''} to fit the rest of the day` : 'Day built. Tap any block to change it.');
};
// copying onto a day that already has blocks asks first (replace or append), never silently overwrites
A.copyDay = ({ from, to, mode }) => {
  const src = getDay(from), dst = getDay(to);
  if (!src) return;
  if (dst?.blocks.length && !mode) return openSheet(() => sheetHead('Copy to ' + dayLabel(to) + '?', `${dayLabel(to)} already has ${dst.blocks.length} block${dst.blocks.length > 1 ? 's' : ''}`) +
    `<div class="stack"><button class="btn big" data-a="copyDay" data-from="${from}" data-to="${to}" data-mode="add">Add ${dayLabel(from)}'s blocks to it</button><button class="btn big" data-a="copyDay" data-from="${from}" data-to="${to}" data-mode="replace" style="color:var(--bad)">Replace ${dayLabel(to)}'s plan</button></div>`);
  const copies = src.blocks.filter(b => BT[b.t]).map(b => ({ id: uid(), t: b.t, dur: b.dur, st: 'plan', poi: b.pinned ? b.poi : null, pinned: b.pinned, toZone: b.toZone, durSet: b.durSet, label: b.label }));
  const prev = S.days[to] ? structuredClone(S.days[to]) : null;
  if (mode === 'add' && dst) { dst.blocks.push(...copies.filter(b => b.t !== 'sleep' || !dst.blocks.some(x => x.t === 'sleep'))); sanitize(); autofill(dst); }
  else { S.days[to] = { date: to, startMin: 480, tpl: src.tpl, blocks: copies }; autofill(S.days[to]); }
  sheetStack.length = 0; drawSheet(); render();
  toast(`Copied to ${dayLabel(to)}`, () => { if (prev) S.days[to] = prev; else delete S.days[to]; });
};
// every block action tolerates a block that's gone (deleted on another screen, replaced by a sync merge)
const blk = id => { const f = findBlock(id); if (!f.b) { toast('That block is gone. Refreshed.'); sheetStack.length = 0; drawSheet(); safeRender(); } return f; };
A.fixBlk = ({ id }) => {
  const { day, b } = blk(id); if (!b) return;
  const alt = fixBlock(day, b);
  toast(alt ? 'Swapped to ' + alt.p.n : 'No open alternative nearby. Move the block instead.');
  refresh();
};
// a pinned place he's now far from: drop the pin and pick the best one around where he is
A.repick = ({ id }) => { const { day, b } = blk(id); if (!b) return; b.pinned = false; b.poi = null; autofill(day); refresh(); toast(b.poi ? 'Now: ' + P[b.poi].n : `No ${lc(BT[b.t].n)} nearby in the data`); };
A.nightNear = ({ id }) => { const { day, b } = blk(id); if (!b) return; b.confirmed = false; b.poi = null; b.pinned = false; b.recon = []; dropNights(n => n.day === day.date && !n.auto); autofill(day); openSheet(() => blockSheet(id)); };
A.addPlaceFor = ({ id, kind }) => A.addPlace({ blk: id, kind });
A.route = () => {
  const day = getDay(sel), rows = flow(day), ds = [];
  let last = null;
  for (const r of rows) {
    if (r.skip || r.b.st === 'done') continue;
    const d = r.b.poi && P[r.b.poi] ? destOf(P[r.b.poi]) : r.b.t === 'travel' && Z[r.b.toZone] ? zoneDest(Z[r.b.toZone]) : null;
    if (d && d !== last) ds.push(d);
    last = d || last;
  }
  if (!ds.length) return toast('No places in this plan yet');
  if (ds.length > 10) toast('Google Maps takes 10 stops. Routing the first 10.');
  navigate(ds.slice(0, 10));
};
A.goBlk = ({ id }) => {
  const { b } = blk(id); if (!b) return;
  if (b.poi && P[b.poi]) navigate([destOf(P[b.poi])]); else if (Z[b.toZone]) navigate([zoneDest(Z[b.toZone])]); else toast('Pick a place for this block first');
};
A.startBlk = ({ id }) => {
  const { day, b } = blk(id); if (!b) return;
  if (day.date !== today()) return toast('Only today’s blocks can start');
  for (const x of day.blocks) if (x.st === 'active' && x !== b) finishBlock(x, true);
  const i = day.blocks.indexOf(b), fi = day.blocks.findIndex(x => x.st === 'plan');
  if (fi >= 0 && fi < i) { day.blocks.splice(i, 1); day.blocks.splice(fi, 0, b); }
  b.st = 'active'; b.s0 = Date.now(); delete b.auto; save();
  if (sheetStack.length) closeSheet(true); else render();
};
A.extend = ({ id }) => { const { b } = blk(id); if (!b) return; b.dur += 30; b.durSet = true; save(); refresh(); };
A.doneBlk = ({ id }) => {
  const { b } = blk(id); if (!b || b.st === 'done') return;
  const undo = finishBlock(b);
  if (sheetStack.length) closeSheet(true); else render();
  if (b.t === 'dash') openSheet(() => dashSheet(b.id));
  else toast(undo.msg, undo.fn);
};
// marks a block done, logs time/needs; returns {msg, fn: undo}
function finishBlock(b, silent) {
  const prev = structuredClone(b), prevS = { last: { ...S.last }, workout: S.workout, supplies: { ...S.supplies }, nights: S.nights.length, log: S.log.length };
  const msg = completeBlock(b);
  save();
  const fn = () => { for (const k of Object.keys(b)) delete b[k]; Object.assign(b, prev); S.last = prevS.last; S.workout = prevS.workout; S.supplies = prevS.supplies; S.nights.length = prevS.nights; S.log.length = prevS.log; };
  return silent ? null : { msg, fn };
}
A.dayMenu = () => openSheet(() => {
  const day = getDay(sel);
  if (!day) return sheetHead(dayLabel(sel)) + '<p class="note">No plan for this day yet.</p>';
  return sheetHead(dayLabel(sel), 'Day options') + `<div class="stack">
    ${sel !== today() ? `<label class="lbl">Start time</label><input class="field" type="time" data-c="startMin" value="${pad(Math.floor((day.startMin ?? 480) / 60) % 24)}:${pad((day.startMin ?? 480) % 60)}">` : ''}
    <button class="btn big" data-a="reopt">↻ Re-pick best places (keeps your picks)</button>
    <button class="btn big" data-a="copyDay" data-from="${sel}" data-to="${addDays(sel, 1)}">Copy blocks to ${dayLabel(addDays(sel, 1))}</button>
    <button class="btn big" data-a="routeWeb">Route in browser (Google Maps web)</button>
    <button class="btn big" data-a="clearDay" style="color:var(--bad)">Clear this day</button></div>`;
});
const C = {};
C.startMin = el => { const d = getDay(sel); if (!d || !el.value) return; const [h, m] = el.value.split(':').map(Number); d.startMin = h * 60 + m; autofill(d); refresh(); };
A.reopt = () => { const d = getDay(sel); if (d) autofill(d, true); closeSheet(true); toast('Places re-picked for the current times'); };
A.routeWeb = () => { const m = S.settings.maps; S.settings.maps = 'web'; A.route(); S.settings.maps = m; };
// a tombstone, so a sync from the phone's older copy can't bring the day back
A.clearDay = () => { const date = sel, d = S.days[date]; S.days[date] = { date, del: Date.now(), blocks: [] }; save(); closeSheet(true); toast('Day cleared', () => { S.days[date] = d; }); };

// ---------- block sheet
A.openBlock = ({ id }) => openSheet(() => blockSheet(id));
function blockSheet(id) {
  if (findBlock(id).b?.t === 'sleep') return nightSheet(id);
  const { day, b, i } = findBlock(id);
  if (!b) return sheetHead('Gone') + '<p class="muted">This block was removed.</p>';
  const def = BT[b.t], rows = flow(day), r = rows.find(x => x.b === b) || {}, p = b.poi && P[b.poi];
  if (!def) return sheetHead('Unknown block') + '<p class="note">This block type no longer exists.</p><button class="btn big" data-a="delBlk" data-id="' + id + '">Delete it</button>';
  const isToday = day.date === today();
  let h = sheetHead(`${def.ic} ${esc(blockTitle(b))}`, r.s ? `${dayLabel(day.date)} · ${fmtTime(r.s)}${b.t === 'sleep' ? '' : '–' + fmtTime(r.e)}` : dayLabel(day.date));
  h += `<div class="row wrap" style="margin-bottom:10px">${b.t !== 'sleep' ? `<div class="dur"><button data-a="dur" data-id="${id}" data-v="-${WORK_BLOCKS.has(b.t) ? 30 : 15}">−</button><span>${fmtDur(b.dur)}</span><button data-a="dur" data-id="${id}" data-v="${WORK_BLOCKS.has(b.t) ? 30 : 15}">+</button></div>
    ${b.t.startsWith('water') ? `<button class="btn sm" data-a="durSet" data-id="${id}" data-v="75">S</button><button class="btn sm" data-a="durSet" data-id="${id}" data-v="150">M</button><button class="btn sm" data-a="durSet" data-id="${id}" data-v="270">L</button>` : ''}` : ''}
    <span class="grow"></span><button class="btn sm" data-a="moveBlk" data-id="${id}" data-v="-1" ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn sm" data-a="moveBlk" data-id="${id}" data-v="1" ${i === day.blocks.length - 1 ? 'disabled' : ''}>↓</button><button class="btn sm" data-a="blockMenu" data-id="${id}">•••</button></div>`;
  if (def.hint) h += `<p class="note">${esc(def.hint)}</p>`;
  for (const w of r.warn || []) h += `<div class="warnline" style="margin-bottom:6px">⚠️ ${esc(w)}${p && /Closed|closes|Gate/.test(w) ? ` <button class="btn sm" data-a="fixBlk" data-id="${b.id}">Swap to an open place</button>` : ''}</div>`;
  if (r.acts?.length) h += `<div class="blk-acts" style="margin-bottom:10px">${warnActs(r, b)}</div>`;
  if (b.t === 'gym') h += `<div class="card"><b>${esc(WORKOUTS[S.workout % 5].n)}</b><div class="note">${WORKOUTS[S.workout % 5].ex.map(esc).join(' · ')}</div></div>`;
  if (b.t === 'groc') { const low = SUPPLIES.filter(s => S.supplies[s]); if (low.length) h += `<div class="card"><b>Running low</b><div class="note">${low.map(esc).join(' · ')}</div></div>`; }
  if (b.t === 'dash') h += dashStart(b, r, p);
  if (b.t === 'travel') h += travelPicker(day, b);
  const prim = [];
  if (isToday && b.st === 'plan') prim.push(`<button class="btn primary" data-a="startBlk" data-id="${id}">Start now</button>`);
  if (isToday && b.st === 'active') prim.push(`<button class="btn primary" data-a="doneBlk" data-id="${id}">✓ Done</button>`);
  if (b.st === 'done') prim.push(`<button class="btn" data-a="reopenBlk" data-id="${id}">Reopen</button>`);
  if (p) prim.push(`<button class="btn ${prim.length ? '' : 'primary'}" data-a="nav" data-id="${p.id}">Directions</button>`);
  if (prim.length) h += `<div class="acts">${prim.join('')}</div>`;
  if (def.m) {
    if (p) h += `<h2>Place</h2><div class="list">${placeRow({ p, mi: r.miles, at: r.s, dur: b.dur }, b.t, `<button class="btn sm" data-a="openPlace" data-id="${p.id}" data-t="${b.t}">Info</button>`)}</div>`;
    // options start from where he'll actually be coming from (today: his live position)
    const prevPt = startPoint(day, b, rows);
    const alts = rank(b.t, { from: prevPt, at: r.s || Date.now(), dur: b.dur }).filter(x => x.p.id !== b.poi).slice(0, 12);
    if (b.t === 'deep') return h + `<h2>${p ? 'Or work from' : 'Where to work'}</h2>` + devOptions(prevPt, r.s || Date.now(), x => `<button class="btn sm primary" data-a="pickPlace" data-blk="${id}" data-id="${x.p.id}" data-dur="${x.dur}">Use</button>`, b.poi) + notListed('cafe', id);
    if (p && b.t === 'movie') h += `<a class="btn big primary" href="${esc(showtimesUrl(p))}" target="_blank" rel="noopener" style="margin-bottom:8px">🎟️ Today's showtimes at ${esc(p.n)}</a>`;
    h += `<h2>${p ? 'Swap for' : 'Pick a place'}</h2><div class="list">${alts.map(x => placeRow({ ...x, at: r.s, dur: b.dur }, b.t, (b.t === 'movie' ? showtimesBtn(x.p) : '') + `<button class="btn sm ${b.t === 'movie' ? '' : 'primary'}" data-a="pickPlace" data-blk="${id}" data-id="${x.p.id}">Use</button>`)).join('') || '<div class="empty">Nothing nearby in the data.</div>'}</div>` + notListed(MINE_FOR[b.t], id);
  }
  return h;
}
let reconOpen = null;
function prevPoint(day, b) {
  const liveAt = day.date === today() ? liveLoc() : null;
  let pt = dayOrigin(day).pt, reached = false;
  for (const x of day.blocks) {
    if (x === b) break;
    if (liveAt && !reached && x.st !== 'done' && x.st !== 'skip') { reached = true; pt = liveAt; }
    if (x.st === 'skip' || BT[x.t]?.night) continue;
    const q = blockPoint(x); if (q) pt = q;
  }
  // nothing left before the night spot today: it's picked from where he is
  return liveAt && !reached ? liveAt : pt;
}
function nightSheet(id) {
  const { day, b } = findBlock(id);
  if (!b) return sheetHead('Gone') + '<p class="muted">This block was removed.</p>';
  const rows = flow(day), r = rows.find(x => x.b === b) || {};
  const from = prevPoint(day, b), tg = (b.recon || []).filter(x => P[x.poi]), isToday = day.date === today();
  let h = sheetHead('🌙 Night spot', `${dayLabel(day.date)}${r.s ? ' · arrive ~' + fmtTime(r.s) : ''}`);
  const cp = b.confirmed && b.poi && P[b.poi];
  if (cp) {
    h += `<div class="card"><div class="row"><div class="grow"><b>✓ ${esc(cp.n)}</b><div class="sub">${esc((lotChip(cp) || [''])[0])} · ${esc(cp.city || '')}</div></div></div>
      <div class="blk-acts"><button class="btn sm primary" data-a="nav" data-id="${cp.id}">Directions</button><button class="btn sm" data-a="openPlace" data-id="${cp.id}" data-t="sleep">Info</button><button class="btn sm ghost" data-a="nightChange" data-blk="${id}">Change spot</button></div></div>`;
  }
  // already parked somewhere: one tap, whether or not the app knows the spot
  if (isToday && !cp) h += `<button class="btn big primary" data-a="sleepHere" data-blk="${id}" style="margin-bottom:6px">📍 I'm parked here for the night</button>`;
  for (const w of r.warn || []) h += `<div class="warnline" style="margin-bottom:6px">⚠️ ${esc(w)}</div>`;
  h += `<h2>Recon targets</h2>`;
  if (tg.length) {
    h += `<div class="list">${tg.map(x => {
      const p = P[x.poi], pt = ptOf(p), mi = pt ? hav(from, pt) : null;
      const st = x.st === 'good' ? chip('✓ Good', 'ok') : x.st === 'bad' ? chip('✗ ' + (x.why || []).map(k => OBS_TAGS[k]?.[0].replace(/^\S+\s/, '')).join(', '), 'bad') : chip('To check');
      return `<div class="place" style="display:block"><div class="row"><div class="grow"><div class="nm">${esc(p.n)}</div><div class="meta">${esc(p.city || '')}${mi != null ? ' · ' + fmtMi(mi) : ''}</div></div>
        <button class="btn sm ghost" data-a="reconToggle" data-blk="${id}" data-id="${p.id}" aria-label="Remove">✕</button></div>
        <div class="chips" style="margin-top:6px">${st} ${placeChips(p, 'sleep', r.s)}</div>
        <div class="blk-acts"><button class="btn sm" data-a="nav" data-id="${p.id}">Go</button><button class="btn sm primary" data-a="reconGood" data-blk="${id}" data-id="${p.id}">✓ Good, sleep here</button><button class="btn sm" data-a="reconBad" data-blk="${id}" data-id="${p.id}">✗ Bad</button></div>
        ${reconOpen === p.id ? `<div class="chips" style="margin-top:8px">${['noparking', 'small', 'vibe', 'security', 'signs', 'bright', 'noisy', 'people'].map(k => `<button class="chip ${x.why?.includes(k) ? 'bad' : ''}" data-a="reconWhy" data-blk="${id}" data-id="${p.id}" data-k="${k}">${OBS_TAGS[k][0]}</button>`).join('')}</div>` : ''}</div>`;
    }).join('')}</div>`;
    if (!cp && tg.some(x => x.st === 'todo')) h += `<button class="btn big primary" data-a="reconNext" data-blk="${id}" style="margin-top:10px">▶ Recon next (nearest unchecked)</button>`;
  } else h += `<p class="note">Add 2–3 spots to check, or confirm one you already know is good.</p>`;
  h += `<p class="note">On recon: signs, lot size, where cars park, lighting, security patrols, vibe. Know a spot's good? Confirm it straight away.</p>`;
  const opts = nightOptions(from, r.s || Date.now(), from).sort((a, z) => a.mi - z.mi).slice(0, 25);
  h += `<h2>All options nearby · ${opts.length}</h2><div class="list">${opts.map(o => {
    const inT = tg.some(x => x.poi === o.p.id);
    return placeRow({ ...o, at: r.s }, 'sleep', `<button class="btn sm ${inT ? '' : 'primary'}" data-a="reconToggle" data-blk="${id}" data-id="${o.p.id}">${inT ? '✓ Target' : '+ Recon'}</button><button class="btn sm ghost" data-a="nightConfirm" data-blk="${id}" data-id="${o.p.id}">Confirm</button>`);
  }).join('') || '<div class="empty">No night spots in the data near here yet.</div>'}</div>
  <button class="btn big" data-a="addPlace" data-blk="${id}" data-night="1" data-kind="hotel" style="margin-top:10px">＋ Add a spot that isn't listed (hotel lot, any lot…)</button>
  <a class="btn big ghost" style="margin-top:8px" target="_blank" rel="noopener" href="https://www.google.com/search?q=${encodeURIComponent('iOverlander ' + (zoneOfPoint(from)?.n || ''))}">Check iOverlander reports for this area</a>`;
  return h;
}
// tonight's sleep block (made if missing; never a second one)
function sleepBlock(date = today()) {
  const day = ensureDay(date);
  let b = day.blocks.find(x => x.t === 'sleep');
  if (!b) day.blocks.push(b = mkBlock('sleep'));
  return b;
}
function confirmNight(blk, id) {
  const { day, b } = findBlock(blk);
  if (!b || !P[id]) return toast('That spot is gone. Refreshed.');
  b.recon ||= [];
  let x = b.recon.find(x => x.poi === id);
  if (!x) b.recon.push(x = { poi: id });
  x.st = 'good'; b.poi = id; b.confirmed = true; b.pinned = true;
  dropNights(n => n.day === day.date);
  S.nights.push({ poi: id, t: Date.now(), day: day.date });
  save(); sheetStack.length = 0; drawSheet(); safeRender(); toast('Night spot: ' + P[id].n);
}
A.reconGood = ({ blk, id }) => confirmNight(blk, id);
A.nightConfirm = ({ blk, id }) => confirmNight(blk, id);
// "I'm parked here for the night": use the known spot he's at, or save this one first
A.sleepHere = async ({ id, blk }) => {
  const b = blk ? findBlock(blk).b : sleepBlock();
  if (!b) return;
  if (id && P[id]) return confirmNight(b.id, id);
  toast('Finding where you are…');
  const l = await locate(true) || liveLoc();
  if (!l) return toast('Location unavailable: allow it in Settings › Privacy › Location');
  const p = nearbyPoi(l, 0.1, sleepish) || nearbyPoi(l, 0.06);
  if (p) return confirmNight(b.id, p.id);
  A.addPlace({ blk: b.id, night: '1', around: '1' });
};
A.reconToggle = ({ blk, id }) => {
  const { b } = blk_(blk); if (!b) return;
  b.recon ||= [];
  const i = b.recon.findIndex(x => x.poi === id);
  if (i >= 0) b.recon.splice(i, 1); else b.recon.push({ poi: id, st: 'todo' });
  save(); refresh();
};
A.reconBad = ({ id }) => { reconOpen = reconOpen === id ? null : id; refresh(); };
A.reconWhy = ({ blk, id, k }) => {
  const { day, b } = blk_(blk); if (!b) return;
  let x = (b.recon ||= []).find(x => x.poi === id);
  if (!x) b.recon.push(x = { poi: id });
  x.st = 'bad'; x.why ||= [];
  if (!x.why.includes(k)) { x.why.push(k); S.obs.push({ id: uid(), poi: id, t: Date.now(), tags: [k] }); }
  if (b.poi === id) { b.poi = null; b.confirmed = false; b.pinned = false; dropNights(n => n.day === day.date); }
  save(); refresh(); toast('Noted: ' + OBS_TAGS[k][0]);
};
A.reconNext = ({ blk }) => {
  const { b } = blk_(blk); if (!b) return;
  const from = liveLoc() || S.loc || here();
  const next = (b.recon || []).filter(x => x.st === 'todo' && P[x.poi] && ptOf(P[x.poi])).sort((a, z) => hav(from, ptOf(P[a.poi])) - hav(from, ptOf(P[z.poi])))[0];
  if (!next) return toast('Nothing left to check. Add targets from the options.');
  navigate([destOf(P[next.poi])]);
};
A.nightChange = ({ blk }) => { const { day, b } = blk_(blk); if (!b) return; b.confirmed = false; b.poi = null; b.pinned = false; dropNights(n => n.day === day.date); save(); refresh(); };
// add a spot to tonight's recon list from anywhere (lists, place sheets)
A.reconQuick = ({ id }) => {
  const b = sleepBlock();
  b.recon ||= [];
  if (!b.recon.some(x => x.poi === id)) b.recon.push({ poi: id, st: 'todo' });
  save(); refresh(); toast('Added to tonight\'s recon list');
};
A.blockMenu = ({ id }) => openSheet(() => {
  const { day, b } = findBlock(id);
  if (!b) return sheetHead('Gone') + '<p class="muted">This block was removed.</p>';
  return sheetHead(esc(blockTitle(b)), 'Block options') + `<div class="stack">
    ${day.date === today() && b.st === 'plan' ? `<button class="btn big" data-a="doneBlk" data-id="${id}">✓ Mark done</button>` : ''}
    <button class="btn big" data-a="skipBlk" data-id="${id}">${b.st === 'skip' ? 'Unskip' : 'Skip for today'}</button>
    <button class="btn big" data-a="nextDayBlk" data-id="${id}">Move to ${dayLabel(addDays(day.date, 1))}</button>
    ${b.t !== 'sleep' ? `<button class="btn big" data-a="dupBlk" data-id="${id}">Duplicate</button>` : ''}
    <button class="btn big" data-a="delBlk" data-id="${id}" style="color:var(--bad)">Delete block</button></div>`;
});
const blk_ = id => blk(id);
A.convBlk = ({ id, t }) => { const { day, b } = blk(id); if (!b || !BT[t]) return; b.t = t; b.dur = Math.max(b.dur, BT[t].dur); b.poi = null; b.pinned = false; autofill(day); refresh(); toast(`Now a ${BT[t].n} block` + (b.poi ? ': ' + P[b.poi].n : '')); };
// Dev session options grouped by kind of spot, best 3 of each, nearest-first within the day's area
function devOptions(from, at, btn, skip) {
  const all = rank('deep', { from, at, dur: 120 }).filter(x => x.p.id !== skip && x.mi <= 20);
  return DEV_KINDS.map(([k, ic, label, , mins]) => {
    const list = all.filter(x => devKind(x.p)[0] === k).slice(0, 3).map(x => ({ ...x, at, dur: mins }));
    if (!list.length) return '';
    return `<div class="lbl" style="margin-top:14px">${ic} ${label} · ${fmtDur(mins)}</div><div class="list">${list.map(x => placeRow(x, 'deep', btn(x))).join('')}</div>`;
  }).join('') || '<div class="empty">No work spots in the data near here.</div>';
}
A.devPick = () => openSheet(() => sheetHead('🎮 Dev session', 'Where do you want to work?') +
  `<button class="btn big" data-a="addBlock" data-t="deep" data-auto="1">Let the app choose</button>` +
  devOptions(sel === today() ? here() : startForNew(), Date.now(), x => `<button class="btn sm primary" data-a="addBlock" data-t="deep" data-poi="${x.p.id}" data-dur="${x.dur}" data-auto="1">Add</button>`) + notListed('cafe'));
A.dur = ({ id, v }) => { const { b } = blk(id); if (!b) return; b.dur = Math.max(5, b.dur + +v); b.durSet = true; save(); refresh(); };
A.durSet = ({ id, v }) => { const { b } = blk(id); if (!b) return; b.dur = +v; b.durSet = true; if (b.t === 'water_s' && +v >= 180) b.t = 'water_l'; else if (b.t === 'water_l' && +v < 180) b.t = 'water_s'; save(); refresh(); };
A.pickPlace = ({ blk: bid, id, dur }) => { const { b } = blk(bid); if (!b || !P[id]) return; b.poi = id; b.pinned = true; delete b.far; if (dur && !b.durSet) b.dur = +dur; save(); closeSheet(); toast('Set: ' + P[id].n); };
A.moveBlk = ({ id, v }) => { const { day, i } = blk(id); if (!day) return; const j = i + +v; if (j < 0 || j >= day.blocks.length) return; [day.blocks[i], day.blocks[j]] = [day.blocks[j], day.blocks[i]]; save(); refresh(); };
A.skipBlk = ({ id }) => { const { b } = blk(id); if (!b) return; b.st = b.st === 'skip' ? 'plan' : 'skip'; save(); closeSheet(true); };
A.reopenBlk = ({ id }) => {
  const { b } = blk(id); if (!b) return;
  // undo what finishing logged, so reopening + finishing again doesn't double count
  for (const e of S.log) if (e.blk === b.id && !e.del) e.del = Date.now();
  b.st = 'plan'; delete b.s0; delete b.s1; delete b.auto; save(); refresh();
};
A.delBlk = ({ id }) => {
  const { day, b } = blk(id); if (!b) return;
  const date = day.date;
  day.blocks.splice(day.blocks.indexOf(b), 1); save(); closeSheet(true);
  toast('Block deleted', () => { const d = ensureDay(date); if (!d.blocks.some(x => x.id === b.id)) { d.blocks.push(b); sanitize(); } });
};
A.dupBlk = ({ id }) => {
  const { day, b } = blk(id); if (!b) return;
  if (b.t === 'sleep') return toast('One night spot per day');
  const c = structuredClone(b); c.id = uid(); c.st = 'plan'; delete c.s0; delete c.s1; delete c.auto;
  day.blocks.splice(day.blocks.indexOf(b) + 1, 0, c); save(); closeSheet(true);
};
A.nextDayBlk = ({ id }) => {
  const { day, b } = blk(id); if (!b) return;
  const nd = addDays(day.date, 1), target = ensureDay(nd);
  day.blocks.splice(day.blocks.indexOf(b), 1);
  b.st = 'plan'; delete b.s0; delete b.s1; delete b.auto;
  const ex = target.blocks.find(x => x.t === 'sleep');
  if (b.t === 'sleep' && ex) { for (const x of b.recon || []) if (!(ex.recon ||= []).some(y => y.poi === x.poi)) ex.recon.push(x); }
  else {
    const si = target.blocks.findIndex(x => x.t === 'sleep');
    target.blocks.splice(si < 0 || b.t === 'sleep' ? target.blocks.length : si, 0, b);
    if (!target.blocks.some(x => x.t === 'sleep')) target.blocks.push(mkBlock('sleep'));
  }
  autofill(target); closeSheet(true); toast('Moved to ' + dayLabel(nd));
};
function travelPicker(day, b) {
  const rows = flow(day);
  let from = dayOrigin(day).pt;
  for (const x of rows) { if (x.b === b) break; const q = !x.skip && blockPoint(x.b); if (q) from = q; }
  const nx = nextZone(1, from), pv = nextZone(-1, from);
  const zs = D.zones.map(z => ({ z, mi: hav(from, z) })).filter(x => x.mi > 3).sort((a, c) => a.mi - c.mi).slice(0, 14);
  const zb = (z, mi, tag) => `<button class="place" style="width:100%;text-align:left" data-a="setZone" data-blk="${b.id}" data-z="${z.id}"><div class="main"><div class="nm">${tag ? tag + ' · ' : ''}${esc(z.n)}</div><div class="meta">${esc(z.r || '')} · ${(z.best || []).slice(0, 3).join(', ')}</div></div><div class="side"><span class="dist">${fmtMi(mi)} ${bearing(from, z)}</span><span class="tiny muted">~${fmtDur(round5(mi * 1.3 / 55 * 60 + 10))}</span></div></button>`;
  return `<h2>Where to?</h2><div class="list">${nx ? zb(nx, hav(from, nx), 'Next on route') : ''}${pv ? zb(pv, hav(from, pv), 'Back down the route') : ''}${zs.map(x => zb(x.z, x.mi)).join('')}</div>
    <button class="btn big ghost" data-a="packReq" style="margin-top:8px">Somewhere not listed? It needs a data pack →</button>`;
}
A.setZone = ({ blk: bid, z }) => { const { day, b } = blk(bid); if (!b || !Z[z]) return; b.toZone = z; b.durSet = false; autofill(day); refresh(); toast('Later blocks re-picked around ' + Z[z].n); };

// add blocks
const PALETTE = [
  ['Work', ['deep', 'water_work', 'cafe', 'kava', 'panera', 'library', 'carofc', 'light', 'dash']],
  ['Water & outdoors', ['water_s', 'water_l', 'run', 'wonder', 'grill']],
  ['Fun', ['movie', 'arcade', 'fun', 'books']],
  ['Food & drink', ['meal', 'pizza', 'meat', 'mall', 'carmeal', 'social']],
  ['Body & car', ['gym', 'shower', 'restroom', 'car', 'gas']],
  ['Errands', ['groc', 'water', 'laundry', 'mail', 'vape']],
  ['Evening at your spot', ['gaming', 'agentic', 'bedtime', 'nap']],
  ['Moving & night', ['travel', 'sleep', 'free']],
  ['Rare', ['storage']],
];
A.addBlockSheet = () => openSheet(() => sheetHead('Add a block', dayLabel(sel) + (sel === today() ? ' · picked around where you are' : ' · picked along this day’s plan')) + PALETTE.map(([g, ts]) => `<div class="lbl" style="margin-top:14px">${g}</div><div class="palette">${ts.map(t => `<button data-a="addBlock" data-t="${t}"><span class="ic">${BT[t].ic}</span>${esc(BT[t].n)}${BT[t].dur ? `<span class="tiny faint" style="display:block">${fmtDur(BT[t].dur)}</span>` : ''}</button>`).join('')}</div>`).join(''));
// Where a newly added block's options start. Today: where he is now (changes follow where he ended up).
// Future days: the last stop of that day's own plan, so a day he's building chains logically (Travel, last night's spot).
function startForNew(date = sel) {
  if (date === today()) return liveLoc() || here();
  const day = getDay(date);
  let pt = dayOrigin(day || { date }).pt;
  for (const b of day?.blocks || []) { if (b.t === 'sleep' || b.st === 'skip' || BT[b.t]?.night) continue; const q = blockPoint(b); if (q) pt = q; }
  return pt;
}
A.addBlock = ({ t, poi, dur, next, auto }) => {
  if (!BT[t]) return;
  if (t === 'sleep' && poi) return A.reconQuick({ id: poi });
  if (t === 'deep' && !poi && !auto) return A.devPick();
  const date = sel, day = ensureDay(date);
  // one night spot per day: adding another just opens it
  const sl = day.blocks.find(x => x.t === 'sleep');
  if (t === 'sleep' && sl) { sheetStack.length = 0; return openSheet(() => blockSheet(sl.id)); }
  const b = mkBlock(t);
  if (dur) b.dur = +dur;
  if (poi && P[poi]) { b.poi = poi; b.pinned = true; }
  if (t === 'travel') b.toZone = nextZone(1, startForNew(date))?.id;
  let at = day.blocks.findIndex(x => x.t === 'sleep');
  if (next) at = day.blocks.findIndex(x => x.st === 'plan');
  if (t === 'sleep' || at < 0) at = day.blocks.length;
  day.blocks.splice(at, 0, b);
  autofill(day);
  closeSheet(true);
  toast(`${BT[t].n} added${b.poi && P[b.poi] ? ': ' + P[b.poi].n : ''}`);
};

// ---------- DoorDash
function dashInfo(pt) {
  const z = zoneOfPoint(pt || here()), ms = D.dd[z?.id] || [];
  if (!ms.length) return `<p class="note">No researched DoorDash market for ${esc(z?.n || 'this zone')}. Test one peak block (11–2 or 5–8) and log it.</p>`;
  return ms.map(m => `<div class="card"><b>${esc(m.n)}</b> ${m.score ? chip('Score ' + m.score) : ''} ${m.conf != null ? chip('Confidence ' + Math.round(m.conf * 100) + '%') : ''}
    <div class="note">Windows: ${esc((m.win || []).join(', ') || '—')}${m.avoid?.length ? ' · Avoid ' + esc(m.avoid.join(', ')) : ''}</div>
    ${m.subs?.length ? `<div class="note">Hotspots: ${esc(m.subs.map(x => x.n).join('; '))}</div>` : ''}
    ${(m.adv || []).map(a => `<div class="note">+ ${esc(a)}</div>`).join('')}${(m.prob || []).slice(0, 2).map(a => `<div class="note">– ${esc(a)}</div>`).join('')}</div>`).join('') + dashCompare();
}
function dashStart(b, r, p) {
  const m = p?._dd || (D.dd[zoneOfPoint(p ? ptOf(p) : here())?.id] || [])[0];
  const s = new Date(r.s || Date.now()), sm = s.getHours() * 60 + s.getMinutes();
  const toMin = x => { const [hh, mm] = x.split(':'); return +hh * 60 + +mm; };
  const wins = (m?.win || []).map(w => { const [a, c] = w.split('-').map(toMin); return { w, hit: sm < c && sm + b.dur > a }; });
  let h = `<div class="card"><b>Where to start</b>`;
  if (p) h += `<div style="margin-top:6px"><div class="nm"><b>${esc(p.n)}</b></div><div class="sub">${esc(p.a || p.city || '')}</div></div>
    <div class="blk-acts"><button class="btn sm primary" data-a="dashGo" data-id="${b.id}">Drive there + start shift</button><button class="btn sm" data-a="nav" data-id="${p.id}">Directions only</button></div>`;
  else h += `<p class="note">No researched hotspot in this zone. Pick a busy restaurant strip below or test the main corridor.</p>`;
  if (wins.length) h += `<div class="chips" style="margin-top:10px">${wins.map(x => chip('Peak ' + x.w, x.hit ? 'ok' : '')).join(' ')}${wins.some(x => x.hit) ? '' : ' ' + chip('Block is outside peak', 'warn')}</div>`;
  h += `<p class="note">1. Head to the hotspot. 2. Go online in the Dasher app about 5 min out. 3. Wait parked near the restaurant cluster, not in a drive-thru lane. 4. Stay on this corridor; don't chase red zones 20 miles away. 5. Log gross, hours, active hours, miles, gas when you finish.</p></div>`;
  const others = (m?.subs || []).filter(x => x.poi && P[x.poi] && x.poi !== p?.id);
  if (others.length) h += `<h2>Other starting points</h2><div class="list">${others.map(x => placeRow({ p: P[x.poi], mi: p ? hav(ptOf(p), ptOf(P[x.poi])) : null }, 'dash', `<button class="btn sm primary" data-a="pickPlace" data-blk="${b.id}" data-id="${x.poi}">Use</button>`)).join('')}</div>`;
  if (p) {
    const c = ptOf(p);
    const near = D.pois.filter(q => q.c === 'food' && q.id !== p.id && q.lat != null && !/walmart|grocery/i.test(q.n + (q.sc || '')) && hav(c, q) < 3).sort((a, z) => hav(c, a) - hav(c, z));
    if (near.length) h += `<p class="note">Other restaurants in the data within 3 mi: ${near.slice(0, 6).map(q => esc(q.n)).join(', ')}.</p>`;
  }
  if (m) h += `<div class="card"><b>${esc(m.n)}</b> ${m.score ? chip('Market score ' + m.score) : ''} ${m.conf != null ? chip('Confidence ' + Math.round(m.conf * 100) + '%') : ''}${m.inc ? ' ' + chip('Median income $' + Math.round(m.inc / 1000) + 'k') : ''}
    ${(m.adv || []).map(a => `<div class="note">+ ${esc(a)}</div>`).join('')}${(m.prob || []).slice(0, 2).map(a => `<div class="note">– ${esc(a)}</div>`).join('')}${m.basis ? `<div class="tiny faint" style="margin-top:6px">${esc(m.basis)}</div>` : ''}</div>`;
  return h + dashCompare();
}
A.dashGo = ({ id }) => { const { b } = blk(id); if (!b || !P[b.poi]) return; const dest = destOf(P[b.poi]); if (b.st === 'plan' && findBlock(id).day.date === today()) A.startBlk({ id }); navigate([dest]); };
function dashCompare() {
  const by = {};
  for (const e of S.log) if (e.k === 'dash' && !e.del) { const o = by[e.z] ||= { n: 0, gross: 0, min: 0, miles: 0 }; o.n++; o.gross += e.gross || 0; o.min += e.min; o.miles += e.miles || 0; }
  const rows = Object.entries(by);
  if (!rows.length) return '';
  return `<h2>Your markets</h2><div class="list">${rows.map(([z, o]) => `<div class="place"><div class="main"><div class="nm">${esc(Z[z]?.n || z)}</div><div class="meta">${o.n} shift${o.n > 1 ? 's' : ''} · $${o.gross.toFixed(0)}</div></div>
    <div class="side"><span class="dist">$${(o.gross / Math.max(1, o.min / 60)).toFixed(2)}/h</span><span class="tiny muted">${o.miles ? '$' + (o.gross / o.miles).toFixed(2) + '/mi' : ''}</span></div></div>`).join('')}</div>`;
}
function dashSheet(blockId, preHrs) {
  const b = blockId && findBlock(blockId).b;
  const hrs = b?.s0 && b.s1 ? ((b.s1 - b.s0) / HOUR).toFixed(1) : preHrs || '';
  return sheetHead('🚗 Log DoorDash shift', 'Gross / hours / miles / gas') + `<div class="grid2">
    <div><label class="lbl">Gross $</label><input class="field" id="dGross" type="number" inputmode="decimal"></div>
    <div><label class="lbl">Total hours</label><input class="field" id="dHours" type="number" inputmode="decimal" value="${hrs}"></div>
    <div><label class="lbl">Active hours</label><input class="field" id="dActive" type="number" inputmode="decimal"></div>
    <div><label class="lbl">Miles</label><input class="field" id="dMiles" type="number" inputmode="decimal"></div>
    <div><label class="lbl">Gas $</label><input class="field" id="dGas" type="number" inputmode="decimal"></div>
    <div><label class="lbl">Deliveries</label><input class="field" id="dDel" type="number" inputmode="numeric"></div></div>
    <button class="btn big primary" data-a="saveDash" style="margin-top:14px">Save shift</button>`;
}
A.dashLog = () => openSheet(() => dashSheet());
A.saveDash = () => {
  const v = id => parseFloat($('#' + id).value) || 0;
  const hrs = v('dHours');
  if (!hrs) return toast('Enter total hours');
  const e = logEntry('dash', hrs * 60, { gross: v('dGross'), active: v('dActive'), miles: v('dMiles'), gas: v('dGas'), dels: v('dDel') });
  closeSheet(true);
  toast(`$${(e.gross / hrs).toFixed(2)}/h${e.miles ? ' · $' + (e.gross / e.miles).toFixed(2) + '/mi' : ''}${e.gas ? ' · net $' + (e.gross - e.gas).toFixed(0) : ''}`);
};

// ---------- quick logs / zone / data packs
A.quickLog = ({ k }) => { const prev = S.last[k]; S.last[k] = Date.now(); save(); render(); toast(DUE[k][1] + ' logged', () => { S.last[k] = prev; }); };
A.zonePick = () => openSheet(() => {
  const from = S.loc || here();
  const zs = D.zones.map(z => ({ z, mi: hav(from, z) })).sort((a, b) => a.z.o - b.z.o);
  return sheetHead('Location', S.zone ? 'Planning from ' + esc(Z[S.zone].n) : S.loc ? `Using GPS${S.loc.acc ? ' (±' + (S.loc.acc > 1600 ? Math.round(S.loc.acc / 1609) + ' mi' : S.loc.acc + ' m') + ')' : ''} · ${fmtAgo(S.loc.t)}` : 'No location yet') +
    `<button class="btn big primary" data-a="useGps">📍 Use my GPS location</button><p class="note">Or plan as if you're in a zone for the next 12 hours (then it goes back to GPS):</p>
    <div class="list">${zs.map(({ z, mi }) => `<div class="place" data-a="setHome" data-z="${z.id}"><div class="main"><div class="nm">${z.o}. ${esc(z.n)}</div><div class="meta">${esc(z.r || '')}${z.stay ? ` · stay ${z.stay[0]}–${z.stay[1]}d` : ''}</div></div><div class="side"><span class="dist">${S.loc ? fmtMi(mi) : ''}</span></div></div>`).join('')}</div>`;
});
A.useGps = async () => { S.zone = null; S.zoneT = 0; save(); closeSheet(true); const l = await locate(true); toast(l ? 'Location updated' : 'Location unavailable: allow it in Settings › Privacy'); applyTheme(); render(); refreshWx(); };
A.setHome = ({ z }) => { if (!Z[z]) return; S.zone = z; S.zoneT = Date.now(); save(); closeSheet(true); refreshWx(); toast('Planning as if you are in ' + Z[z].n.split(' / ')[0] + ' for 12h'); };
A.packReq = () => openSheet(() => sheetHead('Need a new area?', 'Get a research prompt for ChatGPT Pro') +
  `<p class="note">The app only knows the zones in its data packs. For somewhere new: copy this prompt into ChatGPT Pro, save the JSON it returns into <b>heyjim/packs/</b> on the PC, then ask Claude Code to rebuild and deploy.</p>
  <label class="lbl">Area</label><textarea class="field" id="packArea" rows="3" placeholder="e.g. Georgia coast: Brunswick → Savannah, plus Jekyll Island"></textarea>
  <button class="btn big primary" data-a="copyPack" style="margin-top:12px">Copy research prompt</button>
  ${S.wishes.length ? `<h2>Requested before</h2>${S.wishes.map(w => `<div class="obs">${esc(w.area)} <span class="faint small">· ${new Date(w.t).toLocaleDateString()}</span></div>`).join('')}` : ''}`);
A.copyPack = async () => {
  const area = $('#packArea').value.trim() || (S.loc ? `around ${S.loc.lat.toFixed(3)}, ${S.loc.lng.toFixed(3)}` : 'new area');
  S.wishes.push({ area, t: Date.now() }); save();
  try { await navigator.clipboard.writeText(packPrompt(area)); toast('Prompt copied. Paste it into ChatGPT Pro.'); }
  catch { openSheet(() => sheetHead('Copy this') + `<textarea class="field" rows="16">${esc(packPrompt(area))}</textarea>`); }
};

// ---------- add a place he found himself (OpenStreetMap search / what's around me / pin the exact spot)
let AP = null;
const isTop = fn => sheetStack[sheetStack.length - 1] === fn;
A.addPlace = ({ blk: bid, night, kind, around, lat, lng, seen, q, nightDay } = {}) => {
  AP = { blk: bid, night: !!night && !nightDay, nightDay, kind: kind || (night || nightDay ? 'hotel' : ''), q: q || '', res: null, busy: false, pick: null, seen, name: null, note: '' };
  openSheet(addPlaceSheet);
  if (q) return apSearch();
  if (lat != null && lat !== '') { AP.pt = { lat: +lat, lng: +lng }; apAround(); }
  else if (around) apAround(true);
};
async function apAround(fresh) {
  if (!AP) return;
  AP.busy = 'Looking around you…'; AP.err = null; AP.pick = null; if (isTop(addPlaceSheet)) drawSheet();
  try {
    const pt = AP.pt || (fresh ? await locate(true) : liveLoc(10 * MIN)) || await locate(true);
    if (!pt) throw new Error('Location unavailable: allow it in Settings › Privacy › Location Services, or search by name.');
    AP.pt = pt;
    AP.res = (await placesAround(pt)).map(x => ({ ...x, mi: hav(pt, x) })).sort((a, b) => a.mi - b.mi);
    AP.mode = 'around';
  } catch (e) { AP.err = /abort/i.test(e.message) ? 'The lookup timed out. Check your signal and try again.' : e.message; }
  AP.busy = false; if (isTop(addPlaceSheet)) drawSheet();
}
async function apSearch() {
  if (!AP) return;
  const q = (AP.q || '').trim();
  if (!q) return toast('Type a name or address');
  AP.busy = 'Searching…'; AP.err = null; AP.pick = null; drawSheet();
  try {
    const near = AP.pt || startForNew();
    AP.res = (await searchPlaces(q, near)).map(x => ({ ...x, mi: hav(near, x) }));
    AP.mode = 'search';
  } catch (e) { AP.err = /abort/i.test(e.message) ? 'The search timed out. Check your signal and try again.' : e.message; }
  AP.busy = false; if (isTop(addPlaceSheet)) drawSheet();
}
A.apSearch = () => apSearch();
A.apAround = () => { if (AP) AP.pt = null; apAround(true); };
const normName = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, '').replace(/\b(the|by|hilton|inn|suites?|and)\b/g, ' ').replace(/\s+/g, ' ').trim();
// the same place is already in the app (close by, similar name)
function matchKnown(x) {
  const nx = normName(x.n).split(' ')[0];
  let best = null, bd = 0.08;
  for (const p of D.pois) {
    if (p.lat == null) continue;
    const d = hav(p, x);
    if (d < bd && (d < 0.02 || (nx && normName(p.n).includes(nx)))) { bd = d; best = p; }
  }
  return best;
}
function addPlaceSheet() {
  if (!AP) return sheetHead('Add a place') + '<p class="note">Start again from Places.</p>';
  if (AP.pick) return apKindSheet();
  let h = sheetHead(AP.nightDay ? '🌙 Where did you sleep last night?' : AP.night ? '🌙 Add a night spot' : '＋ Add a place', 'Anything missing from the app: search it or save where you are');
  h += `<div class="row"><input class="field grow" id="apQ" type="search" enterkeyhint="search" autocomplete="off" placeholder="Name or address, e.g. Home2 Suites" value="${esc(AP.q)}"><button class="btn primary" data-a="apSearch">Search</button></div>
    <button class="btn big" data-a="apAround" style="margin-top:10px">📍 What's around me</button>`;
  if (AP.busy) h += `<div class="empty">${esc(AP.busy)}</div>`;
  else if (AP.err) h += `<div class="empty">${esc(AP.err)}</div>`;
  else if (AP.res) {
    h += `<h2>${AP.mode === 'around' ? 'Right around you' : 'Results'}</h2><div class="list">${AP.res.map((x, i) => {
      const known = matchKnown(x);
      return `<div class="place" data-a="apPick" data-i="${i}"><div class="main"><div class="nm">${esc(x.n)}</div><div class="meta">${esc(x.a || (x.val || '').replace(/_/g, ' '))}</div>${known ? `<div class="chips" style="margin-top:4px">${chip('Already in the app', 'ok')}</div>` : ''}</div><div class="side"><span class="dist">${fmtMi(x.mi)}</span></div></div>`;
    }).join('') || '<div class="empty">Nothing found. Try another name, or pin your exact spot.</div>'}</div>`;
  }
  if (AP.pt || liveLoc()) h += `<button class="btn big ghost" data-a="apPin" style="margin-top:10px">📌 Pin my exact spot instead</button>`;
  h += `<p class="tiny faint" style="margin-top:12px">Search by OpenStreetMap. Your places sync to your data repo and get folded into the next data rebuild.</p>`;
  return h;
}
A.apPick = ({ i }) => {
  const x = AP?.res?.[+i];
  if (!x) return;
  const known = matchKnown(x);
  if (known) return useKnown(known);
  AP.pick = x; AP.name = x.n; AP.kind ||= guessKind(x); drawSheet(true);
};
A.apPin = async () => {
  const pt = liveLoc(10 * MIN) || AP.pt || await locate(true);
  if (!pt) return toast('Location unavailable');
  AP.pick = { n: '', a: '', city: '', lat: pt.lat, lng: pt.lng, pin: 1 }; AP.name = ''; AP.kind ||= AP.night ? 'lot' : 'other'; drawSheet(true);
  placesAround(pt).then(r => { const x = r[0]; if (x && AP?.pick?.pin && !AP.pick.a) { AP.pick.a = x.a; AP.pick.city = x.city; if (isTop(addPlaceSheet)) drawSheet(); } }).catch(() => {});
};
A.apBack = () => { if (AP) { AP.pick = null; drawSheet(true); } };
A.kindPick = ({ k }) => { if (AP && MINE_KINDS[k]) { AP.kind = k; drawSheet(); } };
function apKindSheet() {
  const x = AP.pick, k = MINE_KINDS[AP.kind];
  let h = sheetHead('What is it?', esc(x.a || `${x.lat.toFixed(5)}, ${x.lng.toFixed(5)}`));
  h += `<label class="lbl">Name</label><input class="field" id="apName" value="${esc(AP.name ?? x.n)}" placeholder="e.g. Quiet lot behind the Home2">`;
  h += `<label class="lbl">Kind</label><div class="chips">${Object.entries(MINE_KINDS).map(([key, [ic, l]]) => `<button class="chip ${AP.kind === key ? 'acc' : ''}" data-a="kindPick" data-k="${key}">${ic} ${esc(l)}</button>`).join('')}</div>`;
  h += `<label class="lbl">Note (optional)</label><input class="field" id="apNote" placeholder="parking, vibe, what's good…" value="${esc(AP.note)}">`;
  if (k && (k[2] === 'overnight_candidate' || AP.kind === 'camp')) h += `<label class="check" style="margin-top:6px"><input type="checkbox" id="apTonight" ${AP.night ? 'checked' : ''}> I'm sleeping here tonight</label>`;
  h += `<button class="btn big primary" data-a="apSave" style="margin-top:12px">Save place</button><button class="btn big ghost" data-a="apBack">‹ Back</button>`;
  return h;
}
// a result that's already in the app: use it directly
function useKnown(p) {
  const c = AP || {};
  AP = null;
  if (c.nightDay) return A.sleptLast({ id: p.id });
  if (c.night) { const b = c.blk ? findBlock(c.blk).b : sleepBlock(); if (b) return confirmNight(b.id, p.id); }
  if (c.blk) {
    const { b } = findBlock(c.blk);
    if (b?.t === 'sleep') { if (!(b.recon ||= []).some(x => x.poi === p.id)) b.recon.push({ poi: p.id, st: 'todo' }); save(); sheetStack.length = 0; return openSheet(() => blockSheet(b.id)); }
    if (b && BT[b.t]?.m?.(p)) { b.poi = p.id; b.pinned = true; save(); sheetStack.length = 0; drawSheet(); safeRender(); return toast('Set: ' + p.n); }
  }
  sheetStack.length = 0; openSheet(() => placeSheet(p.id)); toast('Already in the app');
}
A.apSave = () => {
  if (!AP?.pick) return;
  const x = AP.pick, n = ($('#apName')?.value ?? AP.name ?? x.n).trim();
  if (!n) return toast('Give it a name');
  if (!MINE_KINDS[AP.kind]) return toast('Pick what kind of place it is');
  const tonight = !!$('#apTonight')?.checked, note = ($('#apNote')?.value ?? AP.note).trim();
  const p = addMine({ n, a: x.a, city: x.city, lat: x.lat, lng: x.lng, osm: x.osm, note, q: [n, x.a].filter(Boolean).join(', ') }, AP.kind);
  trackEvent('addPlace', { kind: AP.kind, osm: x.osm || null });
  const c = AP; AP = null;
  if (c.seen && ACT.seen[c.seen]) {
    const v = ACT.seen[c.seen]; v.done = 1; actSave();
    if (v.ask === 'night' && !tonight) { S.nights.push({ poi: p.id, t: v.e, day: dayKey(v.s), auto: 1 }); save(); }
  }
  if (c.nightDay) return A.sleptLast({ id: p.id });
  if (tonight) { const b = c.blk ? findBlock(c.blk).b : sleepBlock(); if (b?.t === 'sleep') return confirmNight(b.id, p.id); return confirmNight(sleepBlock().id, p.id); }
  if (c.blk) {
    const { b } = findBlock(c.blk);
    if (b?.t === 'sleep') { (b.recon ||= []).push({ poi: p.id, st: 'todo' }); save(); sheetStack.length = 0; openSheet(() => blockSheet(b.id)); return toast('Saved: added to tonight’s options'); }
    if (b && BT[b.t]?.m?.(p)) { b.poi = p.id; b.pinned = true; delete b.far; save(); sheetStack.length = 0; drawSheet(); safeRender(); return toast('Saved and set: ' + p.n); }
  }
  sheetStack.length = 0; openSheet(() => placeSheet(p.id)); toast('Saved: ' + p.n);
};
A.mineDel = ({ id }) => {
  const m = S.mine.find(x => 'u_' + x.id === id);
  if (!m) return;
  m.del = Date.now(); mountMine(); save(); sheetStack.length = 0; drawSheet(); safeRender();
  toast('Removed ' + m.n, () => { delete m.del; mountMine(); });
};
document.addEventListener('input', e => {
  if (!AP) return;
  if (e.target.id === 'apQ') AP.q = e.target.value;
  if (e.target.id === 'apName') AP.name = e.target.value;
  if (e.target.id === 'apNote') AP.note = e.target.value;
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'apQ') { e.preventDefault(); e.target.blur(); apSearch(); } });

// ---------- place sheet
function placeSheet(id, type, blk) {
  const p = P[id];
  if (!p) return sheetHead('Not in the data anymore') + '<p class="note">This place was removed or merged in a data update.</p><button class="btn big" data-a="close">Close</button>';
  const st = hoursState(p), sk = sketchChip(p), tc = trustChip(p);
  const types = Object.keys(BT).filter(t => BT[t].m && BT[t].m(p));
  let h = sheetHead(esc(p.n), `${esc(catLabel(p))} · ${esc(p.city || '')} · ${esc(p._z?.n || '')}`);
  h += `<div class="chips">${isGuy(p) ? guyChip() + ' ' : ''}${p.mine ? chip('Your place', 'acc') + ' ' : ''}${chip(st.txt, st.k === 'open' || st.k === '24h' ? (st.soon ? 'warn' : 'ok') : st.k === 'closed' ? 'bad' : '')} ${p.mine ? '' : chip(tc[0], tc[1])} ${sk ? chip(sk[0], sk[1]) : ''} ${wfChips(p).map(([t, c]) => chip(t, c)).join(' ')}</div>`;
  h += `<div class="acts"><button class="btn primary" data-a="nav" data-id="${id}">Directions</button><button class="btn" data-a="fav" data-id="${id}">${S.fav[id] ? '★ Saved' : '☆ Save'}</button>
    <a class="btn" href="${mapsSearch(p)}" target="_blank" rel="noopener">Photos / reviews</a>${p.ph ? `<a class="btn" href="tel:${esc(p.ph.replace(/[^\d+]/g, ''))}">Call</a>` : p.web ? `<a class="btn" href="${esc(p.web)}" target="_blank" rel="noopener">Website</a>` : ''}</div>`;
  { const ic = amenIcons(p); if (ic.length) h += `<div class="amenrow">${ic.map(([i, t]) => `<span>${i} ${t}</span>`).join('')}</div>`; }
  if (blk) h += `<button class="btn big primary" data-a="pickPlace" data-blk="${blk}" data-id="${id}">Use for this block</button>`;
  else if (types.length) h += `<label class="lbl">Add to ${dayLabel(sel)} as</label><div class="chips">${types.map(t => `<button class="chip acc" data-a="addBlock" data-t="${t}" data-poi="${id}">${BT[t].ic} ${BT[t].n}</button>`).join('')}</div>`;
  if (sleepish(p) && !blk) h += `<div class="row wrap" style="margin:8px 0"><button class="btn sm" data-a="reconQuick" data-id="${id}">+ Tonight's recon list</button><button class="btn sm" data-a="sleepHere" data-id="${id}">🌙 Sleeping here tonight</button></div>`;
  h += srcLine(p) + theaterHtml(p) + buffetHtml(p) + dddHtml(p) + tonyHtml(p) + trailHtml(p) + wonderHtml(p) + arcadeHtml(p);
  if (p.a) h += `<h2>Address</h2><div class="row"><div class="grow">${esc(p.a)}${!p.lat || p.gq === 'city' ? '<div class="tiny faint">Map pin approximate. Directions use the name + address.</div>' : ''}</div><button class="btn sm" data-a="copy" data-v="${esc(p.a)}">Copy</button></div>`;
  if (!p.h && !p.mine) h += `<h2>Hours</h2><p class="note">Not confirmed. <a href="${esc(p.web || mapsSearch(p))}" target="_blank" rel="noopener">Check ${p.web ? 'their site' : 'Google Maps'} ↗</a></p>`;
  if (p.h) {
    const { dow } = tzParts(new Date(), p.ct);
    h += `<h2>Hours${p.ct ? ' (Central)' : ''}</h2><table class="hours-tbl">${[1, 2, 3, 4, 5, 6, 0].map(i => `<tr class="${i === dow ? 'today' : ''}"><td>${WD[i]}</td><td style="text-align:right">${esc(prettyHours(p.h[i]))}</td></tr>`).join('')}</table>`;
    if (p.x.hx || p.x.warn) h += `<p class="note">${esc([].concat(p.x.hx || [], p.x.warn || []).join(' · '))}</p>`;
  }
  if (p._ov) h += ovHtml(p);
  if (p._camp) h += campHtml(p._camp);
  if (p._mail) h += mailHtml(p);
  if (p._food) h += foodHtml(p._food);
  if (p.fv && (p.fv.r || p.fv.pl)) h += `<h2>Value</h2><div class="card"><div class="chips">${p.fv.cu ? chip(p.fv.cu) : ''} ${p.fv.pl ? chip('$'.repeat(p.fv.pl)) : ''} ${p.fv.usd ? chip('~$' + p.fv.usd + ' a meal', 'ok') : ''} ${p.fv.r ? chip(`★${p.fv.r} · ${p.fv.rc || '?'} reviews`, 'ok') : ''}</div>
    ${p.fv.ev ? `<p class="note">${esc(p.fv.ev)}</p>` : ''}<p class="tiny faint">${esc(p.fv.rs || 'Rating')} checked ${esc(p.fv.rck || '?')}</p></div>`;
  if (p.bd || p.sp?.length) h += barHtml(p);
  if (isKava(p)) h += `<div class="chips" style="margin-top:10px">${p.x.kratom === false ? chip('Kava, no kratom', 'ok') : chip('Kratom: unknown')} ${p.x.laptop ? chip('Laptop-friendly', 'ok') : ''}</div>`;
  if (p._rec) h += recHtml(p._rec);
  if (p.tn) h += `<h2>Notes</h2><p class="note">${esc(p.tn)}</p>`;
  if (p.capn?.length) h += `<h2>What it's good for</h2>${p.capn.map(([c, n, cond]) => {
    const e = p.caps[c];
    return `<div class="obs"><b>${esc(c.replace(/_/g, ' '))}</b> ${chip(e === 'd' ? 'Confirmed' : e === 'r' ? 'Reported' : 'Unconfirmed', e === 'd' ? 'ok' : e === 'r' ? 'blue' : '')}<div class="note">${esc(n)}${cond?.length ? ' · Needs: ' + esc(cond.join(', ')) : ''}</div></div>`;
  }).join('')}`;
  h += obsHtml(p);
  if (p.src?.length) h += `<h2>Sources</h2>${p.src.map(s => D.sources[s]).filter(Boolean).map(([t, u]) => `<div class="obs"><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a></div>`).join('')}`;
  h += `<button class="btn big ghost" data-a="avoid" data-id="${id}" style="margin-top:14px">${S.avoid[id] ? 'Unhide this place' : 'Hide this place from suggestions'}</button>`;
  if (p.mine) h += `<button class="btn big ghost" data-a="mineDel" data-id="${id}" style="color:var(--bad)">Remove your place</button>`;
  return h;
}
// the best source to double-check this place yourself (first cited source, else its website, else Google)
function srcLine(p) {
  if (p.mine) return '';
  const s = (p.src || []).map(id => D.sources[id]).find(Boolean);
  const [t, u] = s || (p.web ? ['Official site', p.web] : ['Google Maps', mapsSearch(p)]);
  return `<p class="tiny faint" style="margin:2px 0 10px">Unsure? Check the source: <a href="${esc(u)}" target="_blank" rel="noopener">${esc(String(t).slice(0, 60))} ↗</a>${(p.src || []).length > 1 ? ` · <a href="#" data-a="srcAll" data-id="${p.id}">all ${p.src.length} sources</a>` : ''}</p>`;
}
function theaterHtml(p) {
  const t = p.x.theater;
  if (!t && !isMovie(p)) return '';
  const kv = [['Chain', t?.chain || p.x.brand], ['Screens', t?.screens], ['Formats', t?.fmt?.join(' · ')], ['Price', t?.price], ['Notes', t?.notes]].filter(([, v]) => v);
  return `<a class="btn big primary" href="${esc(showtimesUrl(p))}" target="_blank" rel="noopener" style="margin:6px 0 4px">🎟️ Today's showtimes</a>
    ${t?.alist && S.settings.alist ? '<p class="note" style="margin-top:4px">AMC A-List: reserve in the AMC app; it counts toward your weekly free movies.</p>' : ''}
    ${kv.length ? `<dl class="kv" style="margin-top:8px">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}`;
}
function buffetHtml(p) {
  const b = p.x.buffet;
  if (!b) return '';
  const src = b.src && D.sources[b.src], row = (l, v) => (v != null ? `<dt>${l}</dt><dd><b>${money(v)}</b></dd>` : '');
  return `<h2>🍽️ Buffet</h2><div class="card"><dl class="kv">${row('Lunch', b.l)}${row('Dinner', b.d)}${row('Weekend', b.w)}${b.lh ? `<dt>Lunch hours</dt><dd>${esc(prettyHours(b.lh))}</dd>` : ''}${b.kids ? `<dt>Kids</dt><dd>${esc(b.kids)}</dd>` : ''}</dl>
    ${b.l == null && b.d == null && b.w == null ? '<p class="note">Price not confirmed yet.</p>' : ''}${b.notes ? `<p class="note">${esc(b.notes)}</p>` : ''}
    <p class="tiny faint">${b.posted ? 'Price posted ' + esc(b.posted) + ' · ' : ''}checked ${esc(b.chk || '?')}${src ? ` · <a href="${esc(src[1])}" target="_blank" rel="noopener">source ↗</a>` : ''}</p></div>`;
}
function tonyHtml(p) {
  const d = p.x.tony;
  if (!d) return '';
  const when = [d.show, d.s != null ? 'S' + d.s : '', d.ep || '', d.ad ? new Date(d.ad + 'T12:00').toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : ''].filter(Boolean).join(' · ');
  const src = d.src && D.sources[d.src];
  return `<h2>${TONY_SVG} Anthony Bourdain</h2><div class="card">${d.et ? `<b>${esc(d.et)}</b>` : ''}${when ? `<div class="sub">${esc(when)}</div>` : ''}${d.what ? `<p class="note">${esc(d.what)}</p>` : ''}
    <p class="tiny faint">${d.open === false ? 'Reported closed' : 'Still open'}${d.chk ? ' · checked ' + esc(d.chk) : ''}${src ? ` · <a href="${esc(src[1])}" target="_blank" rel="noopener">source ↗</a>` : ''}</p></div>`;
}
function arcadeHtml(p) {
  const a = p.x.arcade;
  if (!a) return '';
  const kv = [['Games', a.games], ['Pricing', a.pricing], ['Ages', a.age], ['Notes', a.notes]].filter(([, v]) => v);
  return `<h2>👾 Arcade</h2><div class="card"><dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`;
}
A.srcAll = ({ id }) => { const p = P[id]; if (!p) return; openSheet(() => sheetHead('Sources', esc(p.n)) + (p.src || []).map(s => D.sources[s]).filter(Boolean).map(([t, u]) => `<div class="obs"><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a></div>`).join('')); };
function dddHtml(p) {
  const d = p.x.ddd;
  if (!d) return '';
  const when = [d.s != null ? 'Season ' + d.s : '', d.ep || '', d.ad ? new Date(d.ad + 'T12:00').toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : ''].filter(Boolean).join(' · ');
  return `<h2>${GUY_SVG} Diners, Drive-ins and Dives</h2><div class="card guy-card">${d.et ? `<b>${esc(d.et)}</b>` : ''}${when ? `<div class="sub">${esc(when)}</div>` : ''}
    ${d.dishes?.length ? `<p class="note"><b>Guy ate:</b> ${d.dishes.map(esc).join(' · ')}</p>` : ''}
    <p class="tiny faint">${d.open === false ? 'Reported closed' : 'Still open'}${d.chk ? ' · checked ' + esc(d.chk) : ''}${d.ev ? ' · ' + esc(d.ev) : ''}</p></div>`;
}
function trailHtml(p) {
  const t = p.x.trail;
  if (!t) return '';
  const kv = [['Distance', t.mi ? t.mi + ' mi' : null], ['Loops', t.loops?.join(' · ')], ['Surface', t.surface], ['Terrain', t.terrain], ['Scenery', t.scenery], ['Shade', t.shade], ['Parking', t.parking], ['Fee', t.fee], ['Hours', t.hours], ['Watch for', t.hazards], ['Rating', t.r ? `★${t.r}${t.rc ? ' (' + t.rc + ')' : ''}${t.rs ? ' · ' + t.rs : ''}` : null]].filter(([, v]) => v);
  return `<h2>🏃 Trail run</h2><div class="card">${t.why ? `<p class="note" style="margin-top:0">${esc(t.why)}</p>` : ''}<dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`;
}
function wonderHtml(p) {
  const w = p.x.wonder;
  if (!w) return '';
  const kv = [['Swim', w.swim === true ? 'Yes' : w.swim === false ? 'No' : null], ['Fee', w.fee], ['Best time', w.best]].filter(([, v]) => v);
  return `<h2>🏞️ ${esc((w.k || 'Natural wonder').replace(/^./, c => c.toUpperCase()))}</h2><div class="card">${w.why ? `<p class="note" style="margin-top:0">${esc(w.why)}</p>` : ''}${kv.length ? `<dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}</div>`;
}
function ovHtml(p) {
  const o = p._ov, n = pastNights(p.id).length;
  const pr = { inspect_first: 'Inspect first', alternative: 'Alternative', extra_friction: 'Extra friction', not_for_auto_selection: 'Do not use' }[o.pr] || o.pr;
  return `<h2>Overnight</h2><div class="card"><div class="chips">${chip(pr || 'Candidate')} ${chip('Permission: ' + (o.perm || 'unknown'), o.perm === 'prohibited' ? 'bad' : '')} ${o.gray ? chip('Gray area', 'warn') : ''} ${o.o24 ? chip('24h nearby', 'ok') : ''}</div>
    ${o.why ? `<p class="note">${esc(o.why)}</p>` : ''}${o.notes ? `<p class="note">${esc(o.notes)}</p>` : ''}
    ${o.fc?.length ? `<p class="note"><b>Check on arrival:</b> ${o.fc.map(esc).join(' · ')}</p>` : ''}
    ${o.tow || o.knock ? `<p class="note" style="color:var(--warn)">Reports: ${esc([o.tow && 'tow: ' + o.tow, o.knock && 'knocks: ' + o.knock].filter(Boolean).join(' · '))}</p>` : ''}
    <p class="note">You've slept here ${n}×${n ? ', last ' + sleptAgo(p.id) : ''}${alive(S.nights).some(x => x.poi === p.id && x.day === today()) ? ' · it’s tonight’s spot' : ''}.</p>
    <div class="row wrap"><button class="btn sm primary" data-a="slept" data-id="${p.id}">😴 Slept here tonight</button><a class="btn sm" target="_blank" rel="noopener" href="https://www.google.com/search?q=${encodeURIComponent('iOverlander ' + p.n + ' ' + (p.city || ''))}">iOverlander check-ins</a></div></div>`;
}
function campHtml(c) {
  const kv = [['Manager', c.mgr], ['Cost', c.cost], ['Reserve', c.res == null ? null : c.res ? 'Required' : 'Not required'], ['Vehicle', c.veh], ['Sleeping', c.rules], ['Stay limit', c.limit], ['Road', c.road], ['Arrive', c.arr], ['Town', c.town]].filter(([, v]) => v);
  return `<h2>Camping</h2><dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${c.notes ? `<p class="note">${esc(c.notes)}</p>` : ''}${(c.alerts || []).map(a => `<p class="note" style="color:var(--warn)">${esc(typeof a === 'string' ? a : JSON.stringify(a))}</p>`).join('')}
    ${c.resUrl ? `<a class="btn sm primary" href="${esc(c.resUrl)}" target="_blank" rel="noopener">Reserve</a>` : ''}`;
}
function mailHtml(p) {
  const m = p._mail, name = S.settings.name || 'YOUR NAME';
  const city = (p.city || '').toUpperCase(), zip = m.zip || '';
  const addr = m.tpl ? m.tpl.replace(/\{?\{?\s*(full[ _]?name|name|recipient)[^}\]\n]*\}?\}?|\[[^\]\n]*name[^\]\n]*\]/gi, name).replace(/\[[^\]\n]*\]/g, zip ? zip + '-9999' : '') : m.gd ? `${name}\nGENERAL DELIVERY\n${city} FL ${zip}-9999` : null;
  return `<h2>Mail</h2><div class="card"><div class="chips">${chip((m.ty || '').replace(/_/g, ' '))} ${m.gd ? chip('General Delivery listed', 'ok') : ''} ${m.gdc ? chip('GD confirmed', 'ok') : ''} ${m.hold ? chip('Hold at location', 'ok') : ''}</div>
    ${addr ? `<pre class="note" style="font:600 14px/1.5 ui-monospace,monospace;margin:10px 0">${esc(addr)}</pre><button class="btn sm" data-a="copy" data-v="${esc(addr)}">Copy address</button>` : ''}
    ${m.ask ? `<p class="note">${esc(m.ask)}</p>` : ''}${m.pick ? `<p class="note">Pickup: ${esc(typeof m.pick === 'string' ? m.pick : JSON.stringify(m.pick))}</p>` : ''}${m.ph ? `<a class="btn sm" href="tel:${esc(m.ph.replace(/[^\d+]/g, ''))}">Call ${esc(m.ph)}</a>` : ''}</div>`;
}
// "16:00-00:00;11:00-14:00" -> "4p–12a, 11a–2p"
const prettyHours = h => (h == null ? 'unknown' : h === '00:00-24:00' ? 'Open 24h' : String(h).replace(/(\d{1,2}):(\d{2})(\+1)?/g, (m, hh, mm) => fmtClock(+hh * 60 + +mm)).replace(/-/g, '–').replace(/;/g, ', '));
function barHtml(p) {
  const b = p.bd || {}, fmtD = d => (d ? new Date(d + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null);
  const t = x => (x ? fmtClock(+x.split(':')[0] * 60 + +x.split(':')[1]) : '');
  return (p.bd ? `<h2>Bar</h2><div class="card"><div class="chips">${b.k ? chip(b.k.replace(/_/g, ' ')) : ''} ${b.pl ? chip('$'.repeat(b.pl)) : ''} ${b.r ? chip(`★${b.r}${b.rc ? ' · ' + b.rc : ''}`, 'ok') : ''}</div>
    ${b.vibe ? `<p class="note">${esc(b.vibe)}</p>` : ''}${b.games ? `<p class="note">Games: ${esc(b.games)}</p>` : ''}${b.food ? `<p class="note">Food: ${esc(b.food)}</p>` : ''}</div>` : '') + `
    <h2>${p.c === 'social' ? 'Specials' : 'Deals'}</h2>${p.sp?.length ? p.sp.map(x => `<div class="card"><b>${esc(x.l || 'Special')}</b> <span class="muted small">· ${x.dt ? new Date(x.dt + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : x.unk ? 'day unconfirmed' : dayNames(x.d)}${x.s ? ' ' + t(x.s) + (x.e ? '–' + t(x.e) : '') : ''}</span>
      ${x.items?.length ? `<div class="note">${x.items.map(esc).join(' · ')}</div>` : ''}
      <div class="tiny faint" style="margin-top:4px">${x.posted ? 'Posted ' + fmtD(x.posted) + ' · ' : 'Post date unknown · '}checked ${fmtD(x.checked) || '?'}${x.conf ? ' · ' + x.conf.replace(/_/g, ' ') : ''}${x.src && D.sources[x.src] ? ` · <a href="${esc(D.sources[x.src][1])}" target="_blank" rel="noopener">source</a>` : ''}</div></div>`).join('') : '<p class="note">No current specials found. Worth asking the bartender.</p>'}`;
}
function foodHtml(f) {
  return `<h2>Food</h2><div class="card"><div class="chips">${chip(f.k || 'food')} ${f.ramen ? chip('Ramen', 'acc') : ''} ${f.buf ? chip('Buffet', 'acc') : ''} ${f.ayce ? chip('All you can eat', 'acc') : ''} ${f.min ? chip('from $' + f.min, 'ok') : ''}</div>
    ${f.ex?.length ? `<p class="note">${esc(f.ex.join(' · '))}</p>` : ''}${(f.offers || []).map(o => `<div class="obs">${esc(o.l)} ${o.p != null ? `<b>$${o.p}</b>` : ''} <span class="faint small">${esc(o.u || '')} ${esc(o.ch || '')}</span></div>`).join('')}
    ${f.menu ? `<a class="btn sm" href="${esc(f.menu)}" target="_blank" rel="noopener">Menu</a>` : ''}</div>`;
}
function recHtml(r) {
  return `<h2>Things to do</h2><div class="card"><div class="chips">${(r.act || []).map(a => chip(a.replace(/_/g, ' '))).join(' ')} ${r.dur ? chip(`${fmtDur(r.dur[0])}–${fmtDur(r.dur[1])}`) : ''} ${r.cost ? chip(String(r.cost)) : ''}</div>
    ${r.notes ? `<p class="note">${esc(r.notes)}</p>` : ''}${(r.alerts || []).map(a => `<p class="note" style="color:var(--warn)">${esc(typeof a === 'string' ? a : JSON.stringify(a))}</p>`).join('')}</div>`;
}
function obsHtml(p) {
  const list = obsFor(p.id).slice().reverse();
  const sleepish = p._ov || p.caps.sleep_candidate || p.caps.tent_camp;
  const tags = Object.entries(OBS_TAGS).filter(([k]) => sleepish ? true : !['slept', 'knock', 'noisy', 'bright', 'security'].includes(k));
  return `<h2>Your notes</h2><div class="chips">${tags.map(([k, [l]]) => `<button class="chip" data-a="obsTag" data-id="${p.id}" data-k="${k}">${l}</button>`).join('')}</div>
    <div class="row" style="margin-top:8px"><input class="field grow" id="obsText" placeholder="Add a note (signal, parking, vibe…)"><button class="btn" data-a="obsSave" data-id="${p.id}">Save</button></div>
    ${list.map(o => `<div class="obs">${o.tags.map(t => OBS_TAGS[t]?.[0] || t).join(' ')} ${esc(o.text || '')} <span class="faint small">· ${new Date(o.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></div>`).join('')}`;
}
A.obsTag = ({ id, k }) => { S.obs.push({ id: uid(), poi: id, t: Date.now(), tags: [k] }); save(); refresh(); toast('Noted: ' + OBS_TAGS[k][0]); };
A.obsSave = ({ id }) => { const v = $('#obsText').value.trim(); if (!v) return; S.obs.push({ id: uid(), poi: id, t: Date.now(), tags: [], text: v }); save(); refresh(); };
A.fav = ({ id }) => { if (S.fav[id]) delete S.fav[id]; else S.fav[id] = Date.now(); save(); refresh(); };
A.avoid = ({ id }) => { if (S.avoid[id]) delete S.avoid[id]; else S.avoid[id] = Date.now(); save(); refresh(); };
A.slept = ({ id }) => { const n = { poi: id, t: Date.now(), day: today() }; dropNights(x => x.day === n.day); S.nights.push(n); save(); refresh(); toast('Night logged', () => { n.del = Date.now(); }); };
A.copy = async ({ v }) => { try { await navigator.clipboard.writeText(v); toast('Copied'); } catch { toast('Copy failed'); } };

// ---------- PLACES
function vPlaces() {
  const cats = [['', 'Nearby'], ['water_work', 'Water'], ['cafe', 'Cafés'], ['panera', 'Panera'], ['library', 'Libraries'], ['gym', 'PF'], ['meal', 'Food'], ['ddd', "Guy's picks"], ['pizza', 'Pizza'], ['crave', 'Cravings'], ['sleep', 'Sleep'], ['tony', "Tony's picks"], ['run', 'Trail runs'], ['wonder', 'Springs & wonders'], ['movie', 'Movies'], ['arcade', 'Arcades'], ['grill', 'Grills'], ['car', 'Car'], ['laundry', 'Laundry'], ['mail', 'Mail'], ['fun', 'Fun'], ['social', 'Bars'], ['goth', 'Goth'], ['ladies', "Ladies' nights"], ['clubs', 'Clubs'], ['meat', 'Meat deals'], ['kava', 'Kava / tea'], ['books', 'Bookstores'], ['groc', 'Groceries'], ['vape', 'Vape'], ['mine', 'Your places'], ['fav', '★ Saved']];
  return `<div class="top"><h1>Places</h1><div class="row"><button class="btn sm primary" data-a="addPlace">＋ Add</button><button class="btn sm" data-a="zonePick">📍 ${esc(locLabel())}</button></div></div>
    <div class="search"><input class="field" id="placesQ" type="search" placeholder="Search ${D.pois.length} places, cities, zones" value="${esc(placesQ)}"></div>
    <div class="scroller" style="margin-top:10px">${cats.map(([k, l]) => `<button class="pill ${placesCat === k ? 'on' : ''}" data-a="placesCat" data-k="${k}">${l}</button>`).join('')}</div>
    <div id="placesResults">${placesResults()}</div>`;
}
A.placesCat = ({ k }) => { placesCat = k; render(); };
function placesResults() {
  const from = here(), q = placesQ.trim().toLowerCase();
  if (q) {
    const words = q.split(/\s+/);
    const hits = D.pois.filter(p => words.every(w => p._txt.includes(w))).map(p => { const pt = ptOf(p); return { p, mi: pt ? hav(from, pt) : null, approx: pt?.approx }; }).sort((a, b) => (a.mi ?? 1e9) - (b.mi ?? 1e9)).slice(0, 60);
    const zh = D.zones.filter(z => z.n.toLowerCase().includes(q));
    return (zh.length ? `<h2>Zones</h2><div class="list">${zh.map(zoneRow).join('')}</div>` : '') + `<h2>${hits.length} places</h2><div class="list">${hits.map(r => placeRow(r)).join('') || '<div class="empty">No matches in the app.</div>'}</div><button class="btn big" data-a="addPlace" data-q="${esc(placesQ)}" style="margin-top:10px">Search "${esc(placesQ)}" anywhere + add it →</button>`;
  }
  if (TAG_LISTS[placesCat]) return `<div class="list" style="margin-top:10px">${tagRows(placesCat, from).slice(0, 60).map(r => placeRow(r, 'meal')).join('') || '<div class="empty">None in the data yet.</div>'}</div>`;
  if (placesCat === 'mine') {
    const ms = D.pois.filter(p => p.mine).map(p => ({ p, mi: hav(from, p) })).sort((a, b) => a.mi - b.mi);
    return `<div class="list" style="margin-top:10px">${ms.map(r => placeRow(r)).join('') || '<div class="empty">Places you add show up here (and in every list that fits).</div>'}</div><button class="btn big" data-a="addPlace" style="margin-top:10px">＋ Add a place</button>`;
  }
  if (placesCat === 'fav') {
    const favs = Object.keys(S.fav).map(id => P[id]).filter(p => p && ptOf(p)).map(p => ({ p, mi: hav(from, ptOf(p)) })).sort((a, b) => a.mi - b.mi);
    return `<div class="list" style="margin-top:10px">${favs.map(r => placeRow(r)).join('') || '<div class="empty">Save places with ☆ to see them here.</div>'}</div>`;
  }
  if (placesCat && BT[placesCat]) return `<div class="list" style="margin-top:10px">${rank(placesCat).slice(0, 40).map(r => placeRow(r, placesCat)).join('') || '<div class="empty">Nothing in range.</div>'}</div>` + notListed(MINE_FOR[placesCat]);
  const cz = zoneOfPoint(from);
  return `<h2>You're in</h2><div class="list">${zoneRow(cz)}</div><h2>Along the route</h2><div class="list">${D.zones.slice().sort((a, b) => a.o - b.o).map(zoneRow).join('')}</div>
    <button class="btn big ghost" data-a="packReq" style="margin-top:12px">Need an area that isn't here? →</button>
    <p class="faint tiny" style="text-align:center">Data v${esc(D.v)} · researched ${esc(D.researched)} · ${D.pois.length} places · ${D.zones.length} zones</p>`;
}
function zoneRow(z) {
  if (!z) return '';
  const from = here();
  return `<div class="place" data-a="openZone" data-z="${z.id}"><div class="main"><div class="nm">${z.o}. ${esc(z.n)}</div><div class="meta">${esc(z.r || '')} · ${D.pois.filter(p => p.z === z.id).length} places${z.stay ? ` · stay ${z.stay[0]}–${z.stay[1]}d` : ''}</div></div><div class="side"><span class="dist">${fmtMi(hav(from, z))}</span></div></div>`;
}
A.openZone = ({ z }) => openSheet(() => zoneSheet(z));
function zoneSheet(id) {
  const z = Z[id], ps = D.pois.filter(p => p.z === id);
  const by = {};
  for (const p of ps) (by[p.c] ||= []).push(p);
  return sheetHead(esc(z.n), esc(z.r || '')) + `<div class="chips">${(z.best || []).map(b => chip(b, 'ok')).join(' ')} ${z.stay ? chip(`Stay ${z.stay[0]}–${z.stay[1]} days`) : ''} ${z.ct ? chip('Central time', 'warn') : ''}</div>
    ${(z.weak || []).map(w => `<p class="note">– ${esc(w)}</p>`).join('')}
    <div class="acts"><button class="btn primary" data-a="setHome" data-z="${id}">Plan as if I'm here</button><button class="btn" data-a="navZone" data-z="${id}">Directions</button></div>
    ${D.dd[id] ? '<h2>DoorDash</h2>' + dashInfo(z) : ''}
    ${z.rec?.length ? `<h2>Researcher picks</h2><div class="list">${z.rec.map(i => P[i]).filter(Boolean).map(p => placeRow({ p, mi: hav(here(), ptOf(p)) })).join('')}</div>` : ''}
    ${Object.entries(by).map(([c, list]) => `<h2>${esc(CAT_NAMES[c] || c)} · ${list.length}</h2><div class="list">${list.map(p => placeRow({ p })).join('')}</div>`).join('')}`;
}
A.navZone = ({ z }) => navigate([zoneDest(Z[z])]);

// ---------- MAP (Leaflet, lazy)
let map, tiles, markers, planLayer;
const CAT_COLOR = { mine: '#E8475F', shop: '#9B51E0', waterfront: '#2F80ED', work: '#8E6CEF', gym: '#E8475F', food: '#F2994A', overnight_candidate: '#5B5BD6', car_maintenance: '#7D7D7D', camping: '#27AE60', mail: '#B8741A', fun: '#16A085', social: '#D35400', life_support: '#3AB0D8', doordash_cluster: '#E8475F' };
const MAP_FILTERS = [['all', 'All'], ['water_s', 'Water'], ['grill', 'Grills'], ['cafe', 'Cafés'], ['panera', 'Panera'], ['library', 'Libraries'], ['gym', 'PF'], ['meal', 'Food'], ['ddd', "Guy's"], ['tony', "Tony's"], ['pizza', 'Pizza'], ['sleep', 'Sleep'], ['run', 'Trails'], ['wonder', 'Springs'], ['movie', 'Movies'], ['arcade', 'Arcades'], ['social', 'Bars'], ['car', 'Car'], ['laundry', 'Laundry'], ['fun', 'Fun'], ['mine', 'Yours'], ['fav', '★']];
function vMap() {
  return `<div class="map-ui"><div class="scroller">${MAP_FILTERS.map(([k, l]) => `<button class="pill ${mapFilter === k ? 'on' : ''}" data-a="mapFilter" data-k="${k}">${l}</button>`).join('')}</div></div>
    <button class="map-fab" data-a="mapLocate">◎</button>`;
}
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  return loadLeaflet.p ||= new Promise((res, rej) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'; document.head.appendChild(css);
    const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}
function setTiles() {
  // OSM tiles; night mode darkens them with a CSS filter (see .map-dark in styles.css)
  if (!tiles) tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  $('#mapBox').classList.toggle('map-dark', document.documentElement.dataset.theme === 'dark');
}
async function initMap() {
  let box = $('#mapBox');
  if (!box) { box = document.createElement('div'); box.id = 'mapBox'; document.body.insertBefore(box, $('#app')); }
  box.hidden = false;
  try { await loadLeaflet(); } catch { $('#view').insertAdjacentHTML('beforeend', '<div class="empty" style="padding-top:120px">Map needs a connection the first time.</div>'); return; }
  if (tab !== 'map') return;
  if (!map) {
    const h = here();
    map = L.map(box, { zoomControl: false, attributionControl: true }).setView([h.lat, h.lng], 11);
    setTiles();
    markers = L.layerGroup().addTo(map); planLayer = L.layerGroup().addTo(map);
  } else map.invalidateSize();
  drawMarkers();
}
function drawMarkers() {
  markers.clearLayers(); planLayer.clearLayers();
  const m = mapFilter === 'all' ? () => true : mapFilter === 'fav' ? p => S.fav[p.id] : mapFilter === 'mine' ? p => p.mine : TAG_LISTS[mapFilter] ? TAG_LISTS[mapFilter][0] : BT[mapFilter]?.m || (() => true);
  for (const p of D.pois) {
    if (p.lat == null || !m(p) || S.avoid[p.id]) continue;
    L.circleMarker([p.lat, p.lng], { radius: S.fav[p.id] || isGuy(p) ? 9 : 7, color: isGuy(p) ? '#F4511E' : '#fff', weight: isGuy(p) ? 3 : 2, fillColor: CAT_COLOR[p.c] || '#888', fillOpacity: 0.95 })
      .on('click', () => openSheet(() => placeSheet(p.id))).addTo(markers);
  }
  const pts = [];
  flow(getDay(sel)).forEach(r => { if (r.skip || r.b.st === 'done') return; const pt = blockPoint(r.b); if (pt) pts.push([pt.lat, pt.lng, BT[r.b.t].ic]); });
  if (pts.length > 1) L.polyline(pts.map(x => [x[0], x[1]]), { color: '#E8475F', weight: 3, dashArray: '6 8', opacity: 0.8 }).addTo(planLayer);
  pts.forEach(([a, b, ic], i) => L.marker([a, b], { icon: L.divIcon({ className: '', html: `<div style="background:#fff;color:#222;border-radius:12px;padding:1px 5px;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.3);white-space:nowrap">${i + 1} ${ic}</div>` }) }).addTo(planLayer));
  if (S.loc) L.marker([S.loc.lat, S.loc.lng], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16] }) }).addTo(planLayer);
}
A.mapFilter = ({ k }) => { mapFilter = k; render(); };
A.mapLocate = async () => { const l = await locate(true); if (l && map) map.setView([l.lat, l.lng], 13); else toast('Location unavailable'); drawMarkers(); };

// ---------- WEEK / settings
function bar(v, lo, hi, label, unit = '') {
  const pct = Math.min(100, (v / hi) * 100);
  return `<div class="card"><div class="stat"><span>${label}</span><b>${unit === 'h' ? (v / 60).toFixed(1) + 'h' : v}<span class="muted small"> / ${unit === 'h' ? `${lo / 60}–${hi / 60}h` : lo === hi ? hi : lo + '–' + hi}</span></b></div><div class="bar"><i class="${v >= lo ? 'ok' : ''}" style="width:${pct}%"></i></div></div>`;
}
function vWeek() {
  const w = weekStats(), ws = weekStart();
  const set = S.settings;
  const seg = (k, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${set[k] === v ? 'on' : ''}" data-a="setOpt" data-k="${k}" data-v="${v}">${l}</button>`).join('')}</div>`;
  const tog = (k, l) => `<label class="check"><input type="checkbox" data-c="tog" data-k="${k}" ${set[k] ? 'checked' : ''}>${l}</label>`;
  return `<div class="top"><div><div class="sub">Week of ${new Date(ws).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div><h1>Week</h1></div><button class="btn sm" data-a="logTime">+ Log time</button></div>
    <div class="stack">${bar(w.dev, 45 * 60, 55 * 60, '🎮 ' + esc(D.profile?.project || 'Game dev'), 'h')}${bar(w.dash, 8 * 60, 12 * 60, '🚗 DoorDash', 'h')}
    ${w.dash ? `<div class="card"><div class="stat"><span>Dash earnings</span><b>$${w.gross.toFixed(0)}</b></div><div class="sub">$${(w.gross / Math.max(0.1, w.dash / 60)).toFixed(2)}/h${w.miles ? ' · $' + (w.gross / w.miles).toFixed(2) + '/mi · ' + w.miles.toFixed(0) + ' mi' : ''}${w.gas ? ' · net $' + (w.gross - w.gas).toFixed(0) : ''}</div></div>` : ''}
    <div class="grid2">${bar(w.gym, 5, 5, '🏋️ Gym')}${bar(w.car, 1, 1, '🔧 Car')}</div>${bar(w.waterDays.size, 5, 7, '🌊 Water days')}${w.run ? `<div class="card"><div class="stat"><span>🏃 Trail runs</span><b>${w.run}</b></div></div>` : ''}${S.settings.alist || w.movies ? `<div class="card"><div class="stat"><span>🎬 Movies</span><b>${w.movies}${S.settings.alist ? '<span class="muted small"> / 3 A-List</span>' : ''}</b></div></div>` : ''}</div>
    <div class="row" style="margin-top:10px"><button class="btn" data-a="dashLog">+ Dash shift</button></div>
    ${dashCompare()}
    <h2>Lift rotation</h2><div class="list">${WORKOUTS.map((x, i) => `<div class="place" data-a="setWorkout" data-i="${i}"><div class="main"><div class="nm">${i + 1}. ${esc(x.n)} ${i === S.workout % 5 ? chip('Next', 'acc') : ''}</div><div class="meta">${x.ex.map(esc).join(' · ')}</div></div></div>`).join('')}</div>
    <h2>Upkeep</h2><div class="list">${Object.entries(DUE).map(([k, [hrs, l]]) => `<div class="place"><div class="main"><div class="nm">${l}</div><div class="meta">${S.last[k] ? fmtAgo(S.last[k]) : 'not logged'} · every ${hrs >= 48 ? hrs / 24 + ' days' : hrs + 'h'}</div></div><div class="side"><button class="btn sm" data-a="quickLog" data-k="${k}">Log now</button></div></div>`).join('')}</div>
    <h2>Car staples</h2><p class="note" style="margin-top:-4px">Check what's running low. It shows up on your Groceries block.</p><div class="list">${SUPPLIES.map(s => `<label class="check"><input type="checkbox" data-c="supply" data-k="${esc(s)}" ${S.supplies[s] ? 'checked' : ''}>${esc(s)}</label>`).join('')}</div>
    <h2>Recent nights</h2><div class="list">${alive(S.nights).slice(-8).reverse().map(n => P[n.poi] ? `<div class="place" data-a="openPlace" data-id="${n.poi}"><div class="main"><div class="nm">${esc(P[n.poi].n)} ${n.auto ? chip('Auto', 'blue') : ''}</div><div class="meta">${n.day ? 'Night of ' + new Date(dateTs(n.day, 720)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : new Date(n.t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div></div><div class="side"><button class="btn sm ghost" data-a="delNight" data-k="${n.t}" aria-label="Remove">✕</button></div></div>` : '').join('') || '<div class="empty">Log nights from a sleep block or place.</div>'}</div><button class="btn big ghost" data-a="addPlace" data-night-day="${addDays(today(), -1)}" data-around="1" style="margin-top:8px">🌙 Log / fix last night's spot</button>
    <h2>Recent log</h2><div class="list">${alive(S.log).slice(-8).reverse().map(e => `<div class="place"><div class="main"><div class="nm">${esc({ dev: 'Game dev', dash: 'DoorDash', gym: 'Gym', car: 'Car work', water: 'Water time', run: 'Trail run' }[e.k] || e.k)} · ${fmtDur(e.min)} ${e.auto ? chip('Auto', 'blue') : ''}</div><div class="meta">${new Date(e.t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}${e.gross ? ' · $' + e.gross : ''}</div></div><div class="side"><button class="btn sm ghost" data-a="delLog" data-id="${e.id}">✕</button></div></div>`).join('') || '<div class="empty">Finish blocks to log time.</div>'}</div>
    ${trackCard()}${spendCard()}
    <h2>Settings</h2><div class="card stack"><div><span class="lbl">Theme</span>${seg('theme', [['auto', 'Auto (sun)'], ['light', 'Day'], ['dark', 'Night']])}</div>
    <div><span class="lbl">Directions open in</span>${seg('maps', [['gapp', 'Google Maps app'], ['web', 'Google web'], ['apple', 'Apple Maps']])}</div>
    <div>${tog('club', 'Planet Fitness Black Card (any club)')}${tog('tent', 'Tent on board (show tent camps)')}${tog('hotel', 'Hotel nights OK (paid lodging)')}${tog('alist', 'AMC Stubs A-List (free movies each week)')}</div>
    <div><span class="lbl">Name for General Delivery mail</span><input class="field" data-c="name" value="${esc(set.name)}" placeholder="FIRST LAST" autocapitalize="characters"></div></div>
    <h2>Sync</h2><div class="card"><div class="row"><div class="grow"><b>${D.sync ? (sync.err ? '⚠️ Not synced' : '✓ Saved to GitHub') : 'Sync not set up'}</b>
      <div class="sub">${D.sync ? (sync.err ? esc(sync.err) + ' · ' : '') + (sync.last ? 'Last saved ' + fmtAgo(sync.last) : 'Not saved yet') + ' · ' + esc(D.sync.repo) : 'Plans and notes are only on this phone.'}</div></div>
      ${D.sync ? '<button class="btn sm" data-a="syncNow">Sync now</button>' : ''}</div></div>
    <p class="note">Plans, notes, recon results, logs and settings save automatically a few seconds after each change.</p>
    <div class="row wrap"><button class="btn" data-a="lock" style="color:var(--bad)">Lock app</button></div>
    <p class="faint tiny" style="margin-top:14px">Data v${esc(D.v)} (${esc(D.researched)}) · ${D.pois.length} places.</p>`;
}
A.setOpt = ({ k, v }) => { S.settings[k] = v; save(); applyTheme(); render(); };
C.tog = el => { S.settings[el.dataset.k] = el.checked; save(); };
C.name = el => { S.settings.name = el.value.trim().toUpperCase(); save(); };
C.supply = el => { if (el.checked) S.supplies[el.dataset.k] = true; else delete S.supplies[el.dataset.k]; save(); };
A.setWorkout = ({ i }) => { S.workout = +i; save(); render(); };
// a tombstone, so the merge with the synced copy can't bring it back
A.delLog = ({ id }) => { const e = S.log.find(e => e.id === id); if (!e) return; e.del = Date.now(); save(); render(); toast('Entry removed', () => { delete e.del; }); };
// Apple Pay spending this week, from the Transaction automation's pings
function spendCard() {
  const list = purchases();
  if (!list.length) return '';
  const by = {}; let total = 0;
  for (const x of list) { if (x.amt == null) continue; by[x.kind] = (by[x.kind] || 0) + x.amt; total += x.amt; }
  return `<h2>Spending this week</h2><div class="card"><div class="stat"><span>Apple Pay</span><b>$${total.toFixed(2)}</b></div>
    <div class="chips" style="margin-top:8px">${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => chip(`${k} $${v.toFixed(0)}`)).join(' ')}</div>
    <div style="margin-top:8px">${list.slice(-6).reverse().map(x => `<div class="obs">${esc(x.mer || x.poi?.n || 'Purchase')} <b>${x.amt != null ? '$' + x.amt.toFixed(2) : ''}</b> <span class="faint small">· ${esc(x.kind)} · ${new Date(x.t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span></div>`).join('')}</div></div>`;
}
function trackCard() {
  const on = S.settings.autotrack, lastPt = ACT.pts[ACT.pts.length - 1], lastPing = ACT.pings[ACT.pings.length - 1];
  const tracked = Object.values(ACT.seen).filter(v => v.k && Date.now() - v.t < 7 * DAY).length;
  return `<h2>Auto-tracking</h2><div class="card"><label class="check" style="padding-top:0"><input type="checkbox" data-c="tog" data-k="autotrack" ${on ? 'checked' : ''}>Track where I go and turn stays into logs</label>
    <p class="note">While the app is open it follows your GPS: arriving at the next block's place starts it, leaving ends it, and stays become gym / night / work / water logs. iPhone web apps can't track in the background, so for full tracking add the car automation below (the phone pings when your car connects or disconnects).</p>
    <div class="sub">${lastPt ? 'Last GPS point ' + fmtAgo(lastPt.t2 || lastPt.t) : 'No GPS points yet'} · ${lastPing ? 'last car ping ' + fmtAgo(lastPing.t) : 'car automation not set up'} · ${tracked} stays classified this week</div>
    <div class="blk-acts"><button class="btn sm primary" data-a="trackSetup">Set up car tracking</button><button class="btn sm" data-a="checkPings">Check pings now</button></div>
    ${D.sync ? `<div class="tiny faint" style="margin-top:8px">Activity log (for analysis) uploads to ${esc(D.sync.repo)}/activity/ · ${ACT.err ? 'last upload failed: ' + esc(ACT.err) : ACT.pushedT ? 'last upload ' + fmtAgo(ACT.pushedT) : 'not uploaded yet'}</div>` : ''}</div>`;
}
A.checkPings = async () => { toast('Checking…'); const n = await pullPings(true); const done = autoTrack(); render(); toast(n ? `${n} new ping${n > 1 ? 's' : ''}` + (done.length ? ' · ' + done.join(' · ') : '') : 'No new pings'); };
A.copyToken = async () => { try { await navigator.clipboard.writeText(D.sync.token); toast('Token copied. Paste it only into the Shortcut.'); } catch { toast('Copy failed'); } };
// test the whole pipe: write a ping file the way the Shortcut will, then read it back
A.testPing = async () => {
  const l = liveLoc() || await locate(true) || here();
  const d = new Date(), p2 = n => String(n).padStart(2, '0'), off = -d.getTimezoneOffset();
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${off < 0 ? '-' : '+'}${p2(Math.floor(Math.abs(off) / 60))}${p2(Math.abs(off) % 60)}`;
  const path = `pings/${monthKey(d)}/${stamp}_test_${l.lat.toFixed(5)}_${l.lng.toFixed(5)}.txt`;
  toast('Sending test ping…');
  try {
    const r = await ghApi('PUT', { message: 'test ping', content: 'eA==' }, path);
    if (!r.ok) throw new Error('write ' + r.status);
    const n = await pullPings(true);
    toast(n ? 'Test ping sent and read back ✓' : 'Sent, but reading it back failed');
  } catch (e) { toast('Test failed: ' + e.message); }
};
A.trackSetup = () => openSheet(() => {
  const repo = D.sync?.repo || 'crunchrock/heyjim-data';
  const url = `https://api.github.com/repos/${repo}/contents/pings/`;
  const step = (n, t) => `<div class="obs"><b>${n}.</b> ${t}</div>`;
  return sheetHead('🚗 Car tracking', 'An iPhone Shortcuts automation, no app needed') +
    `<p class="note">When your phone connects to or disconnects from the MDX (Bluetooth or CarPlay), a Shortcut writes a tiny "ping" (time + GPS) to your private data repo. Hey Jim reads the pings: parked 1h at Planet Fitness = gym, parked overnight at a lot = night spot, lots of short restaurant stops = DoorDash. Set it up once; it runs silently.</p>
    ${D.sync ? '' : '<p class="note" style="color:var(--bad)">Sync is not set up in this build, so pings cannot be read.</p>'}
    <h2>Automation 1: car disconnects (you parked)</h2>
    ${step(1, 'Shortcuts app → <b>Automation</b> → <b>+</b> → <b>Bluetooth</b> (or <b>CarPlay</b>) → choose your car → <b>Is Disconnected</b> → <b>Run Immediately</b> (turn off Notify) → Next → <b>New Blank Automation</b>.')}
    ${step(2, 'Add <b>Get Current Location</b>.')}
    ${step(3, 'Add <b>Format Date</b>: Current Date, Date Format <b>Custom</b>, format string <code>yyyy-MM</code>.')}
    ${step(4, 'Add another <b>Format Date</b>: Current Date, Custom <code>yyyyMMdd-HHmmssZ</code>.')}
    ${step(5, 'Add <b>Text</b>, and build the address: paste the start below, then insert the variables (tap them in the variable bar): <code>&lt;start&gt;</code> + <i>Formatted Date</i> (the first one) + <code>/</code> + <i>Formatted Date</i> (the second) + <code>_off_</code> + <i>Current Location › Latitude</i> + <code>_</code> + <i>Current Location › Longitude</i> + <code>.txt</code>')}
    <div class="row" style="margin:6px 0 10px"><code class="grow ell small">${esc(url)}</code><button class="btn sm" data-a="copy" data-v="${esc(url)}">Copy start</button></div>
    ${step(6, 'Add <b>Get Contents of URL</b>: URL = the Text. Show More → Method <b>PUT</b>. Headers: <code>Authorization</code> = <code>Bearer </code> + your token, and <code>Accept</code> = <code>application/vnd.github+json</code>. Request Body <b>JSON</b>: <code>message</code> (Text) = <code>ping</code>, <code>content</code> (Text) = <code>eA==</code>.')}
    <div class="row" style="margin:6px 0 10px"><span class="grow small muted">Token (scoped to your data repo only)</span><button class="btn sm" data-a="copyToken">Copy token</button></div>
    <h2>Automation 2: car connects (you're driving)</h2>
    ${step(1, 'Same thing with <b>Is Connected</b>, and <code>_on_</code> instead of <code>_off_</code> in step 5. Easiest: finish automation 1, then build 2 the same way.')}
    <h2>Optional: Apple Pay purchases</h2>
    <p class="note">Shows what you spend (gas, food, groceries…) on the Week tab and helps confirm where you were. Only Apple Pay taps trigger it (not swiped cards or online orders). No card numbers or bank logins are involved.</p>
    ${step(1, 'Automation → <b>+</b> → <b>Transaction</b> → choose your cards → <b>Run Immediately</b> → New Blank Automation.')}
    ${step(2, 'Same first steps as above: <b>Get Current Location</b> and the two <b>Format Date</b> actions.')}
    ${step(3, 'Add <b>Text</b>: <i>Shortcut Input › Amount</i> + <code>_</code> + <i>Shortcut Input › Merchant</i>. Then <b>Replace Text</b> in it: find <code>[^A-Za-z0-9._]+</code>, replace with <code>-</code>, Regular Expression on.')}
    ${step(4, 'Build the address like step 5 above but with <code>_pay_</code> and, before <code>.txt</code>, <code>_</code> + the <i>Updated Text</i>. Then the same <b>Get Contents of URL</b> (PUT, same headers and JSON body).')}
    <h2>Test</h2>
    <p class="note">Tap below to send a ping from this phone the same way; it should say ✓. After your first real drive, "Check pings now" on the Week tab shows them.</p>
    <button class="btn big primary" data-a="testPing">Send a test ping</button>
    <p class="tiny faint" style="margin-top:10px">Pings live in ${esc(repo)}/pings/ (private). Latitude/longitude with a period decimal (US region) are expected.</p>`;
});
A.logTime = () => openSheet(() => sheetHead('Log time', 'Work you did outside a block') + `<div class="grid2"><div><label class="lbl">What</label><select class="field" id="ltK"><option value="dev">Game dev</option><option value="water">Water time</option><option value="car">Car work</option><option value="gym">Gym</option></select></div>
  <div><label class="lbl">Hours</label><input class="field" id="ltH" type="number" inputmode="decimal" value="2"></div></div><button class="btn big primary" data-a="saveTime" style="margin-top:12px">Save</button>`);
A.saveTime = () => { const k = $('#ltK').value, h = parseFloat($('#ltH').value) || 0; if (!h) return; logEntry(k, h * 60); if (k === 'gym') { S.last.shower = Date.now(); S.workout = (S.workout + 1) % 5; } closeSheet(true); toast('Logged'); };
A.syncNow = async () => { toast('Syncing…'); await syncPull(); await syncPush(); render(); toast(sync.err ? 'Sync failed: ' + sync.err : 'Saved to GitHub'); };
A.lock = () => { store.del('key'); location.reload(); };

boot();
