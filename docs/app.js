'use strict';
// UI layer. Logic/data helpers live in core.js.
let tab = 'today', sel = null, wx = null, alerts = [], placesQ = '', placesCat = '', mapFilter = 'all', toastT;
const sheetStack = [];
const A = {}; // click actions: data-a="name"
const DUE = { shower: [24, 'Shower'], laundry: [168, 'Laundry'], water_refill: [72, 'Water jug'], groceries: [96, 'Groceries'], mail: [168, 'Mail'] };
const SUPPLIES = ['Whey', 'Peanut butter', 'Bread / tortillas', 'Jelly', 'Tuna', 'Bananas / fruit', 'Multivitamin', 'Instant coffee', 'Charcoal', 'Tinfoil', 'Lighter', 'Toiletries', 'Paper towels'];
const CAT_NAMES = { waterfront: 'Waterfront', work: 'Work', gym: 'Gym', food: 'Food', overnight_candidate: 'Overnight', car_maintenance: 'Car', camping: 'Camping', mail: 'Mail', fun: 'Fun', social: 'Social', life_support: 'Laundry / travel center', doordash_cluster: 'DoorDash' };

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
    try { return start(await decryptData(buf, await importKey(raw))); } catch { store.del('key'); }
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
      start(data);
    } catch {
      const n = store.get('fails', 0) + 1; store.set('fails', n);
      if (n >= 5) store.set('lockout', Date.now() + 30000 * (n - 4));
      $('#lockMsg').textContent = 'Wrong password.';
      f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
    } finally { btn.disabled = false; btn.textContent = 'Unlock'; }
  };
}
function start(data) {
  indexData(data); pruneDays(); sel = today();
  if (!S.settings.name && D.profile?.name) S.settings.name = D.profile.name;
  $('#lock').hidden = true; $('#app').hidden = false;
  render();
  locate().then(l => { if (l) { applyTheme(); render(); refreshWx(); } });
  refreshWx();
  setInterval(() => { applyTheme(); if (tab === 'today' && !sheetStack.length) render(); }, MIN);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return saveNow();
    if (sel < today()) sel = today();
    locate().then(() => { if (!sheetStack.length) render(); });
    refreshWx();
  });
}
async function refreshWx() {
  const pt = here();
  const [w, a] = await Promise.all([getWeather(pt), getAlerts(pt)]);
  wx = w; alerts = a || [];
  if (tab === 'today' && !sheetStack.length) render();
}

// ---------- render plumbing
const VIEWS = { today: vToday, map: vMap, places: vPlaces, me: vWeek };
function render() {
  const y = window.scrollY, same = render.last === tab;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  document.body.classList.toggle('map-on', tab === 'map');
  if (tab !== 'map' && $('#mapBox')) $('#mapBox').hidden = true;
  $('#view').innerHTML = VIEWS[tab]();
  if (tab === 'map') initMap();
  window.scrollTo(0, same ? y : 0);
  render.last = tab;
}
function openSheet(fn) { sheetStack.push(fn); drawSheet(true); }
function drawSheet(fresh) {
  const fn = sheetStack[sheetStack.length - 1];
  if (!fn) { $('#sheetWrap').hidden = true; document.body.style.overflow = ''; return; }
  const sc = $('#sheet').scrollTop;
  $('#sheetBody').innerHTML = fn();
  $('#sheetWrap').hidden = false; document.body.style.overflow = 'hidden';
  $('#sheet').scrollTop = fresh ? 0 : sc;
}
function closeSheet(all) { if (all) sheetStack.length = 0; else sheetStack.pop(); drawSheet(true); render(); }
function refresh() { if (sheetStack.length) drawSheet(); render(); }
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
document.addEventListener('click', e => {
  const tb = e.target.closest('#tabs button');
  if (tb) { tab = tb.dataset.tab; closeSheet(true); return; }
  if (e.target.id === 'sheetBack') return closeSheet(true);
  const el = e.target.closest('[data-a]');
  if (!el) return;
  e.preventDefault(); e.stopPropagation();
  A[el.dataset.a]?.(el.dataset, el);
});
document.addEventListener('change', e => { const el = e.target.closest('[data-c]'); if (el) C[el.dataset.c]?.(el); });
document.addEventListener('input', e => { if (e.target.id === 'placesQ') { placesQ = e.target.value; $('#placesResults').innerHTML = placesResults(); } });
// swipe the sheet down to dismiss
(() => {
  let y0 = null;
  const sh = $('#sheet');
  sh.addEventListener('touchstart', e => { y0 = sh.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  sh.addEventListener('touchmove', e => { if (y0 != null) { const dy = e.touches[0].clientY - y0; if (dy > 0) sh.style.transform = `translateY(${dy}px)`; } }, { passive: true });
  sh.addEventListener('touchend', e => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0; sh.style.transform = ''; y0 = null;
    if (dy > 110) closeSheet(true);
  });
})();

// ---------- shared bits
const chip = (t, c = '') => `<span class="chip ${c}">${esc(t)}</span>`;
function hoursChip(p, ts = Date.now(), dur = 0, quiet) {
  const f = fit(p, ts, dur);
  if (f.k === 'unk') return quiet ? '' : chip('Hours not listed');
  return chip(f.txt, f.k === 'ok' ? 'ok' : f.k === 'short' ? 'warn' : 'bad');
}
// Rows only show chips that change a decision: real hours, confirmed/reported evidence, overnight risk, waterfront perks.
function placeChips(p, type, ts, dur) {
  const out = [];
  if (type === 'sleep') { if (is247(p)) out.push(chip('24h restroom access', 'ok')); }
  else { const hc = hoursChip(p, ts, dur, true); if (hc) out.push(hc); }
  const tc = trustChip(p, type && BT[type]?.caps?.length ? BT[type].caps : null);
  if (type !== 'sleep' && tc[1]) out.push(chip(tc[0], tc[1]));
  const sk = (!type || type === 'sleep') && sketchChip(p); if (sk) out.push(chip(sk[0], sk[1]));
  for (const [t, c] of wfChips(p).slice(0, type && /water|grill/.test(type) ? 4 : 2)) out.push(chip(t, c));
  const ln = lastNight(p.id); if (ln && Date.now() - ln < 10 * DAY) out.push(chip('Slept here ' + fmtAgo(ln), 'warn'));
  if (S.fav[p.id]) out.push(chip('★ Saved', 'acc'));
  if (p.gq === 'city' || !p.lat) out.push(chip('No map pin'));
  return out.join(' ');
}
const catLabel = p => (p.sc ? p.sc.replace(/_/g, ' ') : CAT_NAMES[p.c] || p.c);
function placeRow(r, type, extra = '') {
  const p = r.p;
  return `<div class="place" data-a="openPlace" data-id="${p.id}"${type ? ` data-t="${type}"` : ''}>
    <div class="main"><div class="nm">${esc(p.n)}</div><div class="meta">${esc(catLabel(p))} · ${esc(p.city || p._z?.n || '')}</div>
    <div class="chips" style="margin-top:6px">${placeChips(p, type, r.at, r.dur)}</div></div>
    <div class="side"><span class="dist">${r.approx || (r.p.lat == null) ? '<span class="tiny muted">no pin</span>' : r.mi != null ? fmtMi(r.mi) : ''}</span>${extra || `<button class="btn sm go" data-a="nav" data-id="${p.id}">Go</button>`}</div></div>`;
}
function locLabel() {
  const short = z => z.n.split(' / ')[0];
  if (S.zone && Z[S.zone]) return 'Planning: ' + short(Z[S.zone]);
  if (S.loc) return (S.loc.acc > 3000 ? '≈ ' : '') + short(nearestZone(S.loc));
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
    `<button class="pill ${k === sel ? 'on' : ''}" data-a="selDay" data-d="${k}">${dayLabel(k)}${S.days[k]?.blocks.length ? ' ·' + S.days[k].blocks.length : ''}</button>`).join('')}</div>`;
  if (sel === t) h += alertsHtml() + coverageHtml() + wxHtml();
  h += dayHtml(sel);
  if (sel === t) h += attentionHtml() + findHtml();
  return h;
}
A.selDay = ({ d }) => { sel = d; render(); };
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
    if (!r) return '';
    const f = fit(r.p, Date.now(), BT[t].dur);
    return `<div class="place" data-a="openPlace" data-id="${r.p.id}" data-t="${t}"><span style="font-size:22px;width:28px">${BT[t].ic}</span>
      <div class="main"><div class="nm">${BT[t].n} <span class="muted small" style="font-weight:500">· ${esc(why)}</span></div>
      <div class="meta ell">${esc(r.p.n)} · ${fmtMi(r.mi)}${f.k !== 'unk' ? ' · ' + esc(f.txt) : ''}</div></div>
      <div class="side"><button class="btn sm primary" data-a="addBlock" data-t="${t}" data-poi="${r.p.id}" data-next="1">+ Add</button><button class="btn sm ghost" data-a="nav" data-id="${r.p.id}">Go</button></div></div>`;
  }).join('')}</div>`;
}
function findHtml() {
  const items = [['restroom', 'Restroom'], ['water', 'Water'], ['shower', 'Shower'], ['meal', 'Food'], ['office', 'Wi-Fi + power'], ['sleep', 'Sleep spot'], ['groc', 'Groceries'], ['laundry', 'Laundry'], ['grill', 'Grill'], ['car', 'Auto parts']];
  return `<h2>Find nearby</h2><div class="scroller">${items.map(([t, l]) => `<button class="pill" data-a="needList" data-t="${t}">${BT[t].ic} ${l}</button>`).join('')}</div>`;
}
A.tabTo = ({ t }) => { tab = t; render(); };
A.needList = ({ t }) => openSheet(() => listSheet(t));
function listSheet(t, limit = 25) {
  const rows = rank(t, { dur: t === 'sleep' ? 0 : BT[t].dur }).slice(0, limit);
  const note = t === 'sleep' ? `<p class="note">Practical shortlist, not permission. Sketchy / gray-area spots are labeled. Newest iOverlander check-ins break ties.</p>` : '';
  return sheetHead(`${BT[t].ic} ${BT[t].n}`, 'Best matches near ' + esc(locLabel().replace('Near ', ''))) + note +
    `<div class="list">${rows.map(r => placeRow(r, t)).join('') || '<div class="empty">Nothing in range.</div>'}</div>`;
}
function suggest() {
  const now = new Date(), h = now.getHours() + now.getMinutes() / 60, out = [];
  const sun = sunToday(), toSunset = (sun.set - now) / HOUR;
  const age = k => (S.last[k] ? (Date.now() - S.last[k]) / HOUR : 999);
  if (age('shower') > 22) out.push(['gym', S.last.shower ? 'Last shower ' + fmtAgo(S.last.shower) : 'Lift + shower']);
  if (toSunset > 0.3 && toSunset < 2.3) out.push(['water_s', 'Sunset at ' + fmtTime(sun.set)]);
  if (h >= 5 && h < 10) out.push(['water_s', 'Morning water block'], ['cafe', 'Café to start the day']);
  const dzs = D.dd[zoneOfPoint(here())?.id] || [];
  const inWin = dzs.some(m => (m.win || []).some(w => { const [a, b] = w.split('-').map(x => +x.split(':')[0] + +x.split(':')[1] / 60); return h >= a - 0.5 && h < b; }));
  if (inWin) out.push(['dash', 'DoorDash peak window']);
  if (h >= 8 && h < 18) out.push(['office', 'Plugged-in work block']);
  if ((h >= 11 && h < 14) || (h >= 17 && h < 20.5)) out.push(['meal', 'Meal time']);
  if (h >= 16 && h < 19.5) out.push(['grill', 'Grill dinner by the water']);
  if (h >= 20 || h < 3) out.push(['sleep', 'Line up tonight’s spot']);
  if (age('water_refill') > 72) out.push(['water', 'Jug refill due']);
  if (age('laundry') > 168) out.push(['laundry', 'Laundry due']);
  if (SUPPLIES.some(s => S.supplies[s])) out.push(['groc', 'Supplies running low']);
  const seen = new Set();
  return out.filter(([t]) => !seen.has(t) && seen.add(t)).slice(0, 3);
}
function suggestHtml() {
  const list = suggest();
  if (!list.length) return '';
  return `<h2>Good right now</h2><div class="stack">${list.map(([t, why]) => {
    const r = rank(t)[0];
    if (!r) return '';
    return `<div class="card" data-a="openPlace" data-id="${r.p.id}" data-t="${t}"><div class="row"><span style="font-size:22px">${BT[t].ic}</span>
      <div class="grow"><b>${BT[t].n}</b> <span class="muted small">· ${esc(why)}</span><div class="small ell">${esc(r.p.n)} · ${fmtMi(r.mi)}</div></div></div>
      <div class="chips" style="margin-top:8px">${placeChips(r.p, t)}</div>
      <div class="blk-acts"><button class="btn sm primary" data-a="addBlock" data-t="${t}" data-poi="${r.p.id}" data-next="1">+ Add as next</button><button class="btn sm" data-a="nav" data-id="${r.p.id}">Go now</button><button class="btn sm ghost" data-a="needList" data-t="${t}">More</button></div></div>`;
  }).join('')}</div>`;
}

// ---------- day timeline
let showAllTpl = false;
function tplScore(tpl, date) {
  const now = new Date(), h = date === today() ? now.getHours() + now.getMinutes() / 60 : 8;
  const left = (24 - h) * 60;
  const total = tpl.b.reduce((a, x) => { const [t, d] = x.split(':'); return a + (t === 'sleep' ? 0 : (d ? +d : BT[t].dur) + 10); }, 0);
  let s = -Math.abs(total - Math.min(left, 14 * 60)) / 60;
  if (tpl.id === 'blank' || tpl.id === 'car' || tpl.id === 'move') s -= 2;
  if (h < 10 && /water_l/.test(tpl.b.join())) s += 1;
  if (h >= 16 && tpl.id === 'tired') s += 2;
  if (h < 16 && tpl.id === 'cash' && (D.dd[zoneOfPoint(here())?.id] || []).length) s += 0.5;
  return s;
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
  return b.label || BT[b.t].n;
}
function blockHtml(r, day, isNext, isToday, prevPoi) {
  const b = r.b, def = BT[b.t], p = b.poi && P[b.poi];
  const cls = b.st === 'active' ? 'active' : b.st === 'done' ? 'done' : r.skip ? 'skipped' : '';
  const leg = !r.skip && r.travel ? `<div class="travel">🚗 ${fmtDur(r.travel)} · ${fmtMi(r.miles)}</div>` : '';
  let chips = '';
  if (p && b.st !== 'done' && !r.skip) chips = placeChips(p, b.t, r.s, b.t === 'sleep' ? 0 : b.dur);
  if (b.t === 'travel' && r.miles) chips = chip(fmtMi(r.miles) + ' ' + (Z[b.toZone] ? bearing(dayOrigin(day).pt, Z[b.toZone]) : ''), 'blue');
  const warns = (r.warn || []).map(w => `<div class="warnline">⚠️ ${esc(w)}${p && /Closed|closes|Gate/.test(w) ? ` <button class="btn sm" data-a="fixBlk" data-id="${b.id}">Fix</button>` : ''}</div>`).join('');
  let acts = '';
  if (isToday && b.st === 'active') acts = `<div class="blk-acts"><button class="btn sm primary" data-a="doneBlk" data-id="${b.id}">✓ Done</button><button class="btn sm" data-a="extend" data-id="${b.id}">+30m</button>${p ? `<button class="btn sm" data-a="nav" data-id="${p.id}">Directions</button>` : ''}</div>`;
  else if (isToday && isNext) acts = `<div class="blk-acts">${p || b.t === 'travel' ? `<button class="btn sm primary" data-a="goBlk" data-id="${b.id}">Go</button>` : ''}<button class="btn sm" data-a="startBlk" data-id="${b.id}">Start</button><button class="btn sm ghost" data-a="doneBlk" data-id="${b.id}">Done</button></div>`;
  const time = r.skip ? '' : b.t === 'sleep' ? fmtTime(r.s) : `${fmtTime(r.s)}<small>${fmtDur(b.st === 'done' ? (r.e - r.s) / MIN : b.dur)}</small>`;
  return leg + `<div class="blk ${cls}"><div class="blk-time">${time}</div>
    <div class="blk-body" data-a="openBlock" data-id="${b.id}">
      <div class="blk-title"><span class="ic">${def.ic}</span><span class="grow ell">${esc(blockTitle(b))}</span>${b.st === 'active' ? chip(r.over ? 'Over' : 'Now', 'acc') : ''}${b.st === 'done' ? chip('Done', 'ok') : ''}${r.skip ? chip('Skipped') : ''}</div>
      ${p ? `<div class="blk-place"><span class="grow ell">${prevPoi === p.id ? `<span class="muted">Stay put · ${esc(p.n)}</span>` : `<span class="nm">${esc(p.n)}</span> <span class="muted">· ${esc(p.city || '')}</span>`}</span></div>` : ''}
      ${chips ? `<div class="chips" style="margin-top:6px">${chips}</div>` : ''}${warns}${acts}</div></div>`;
}
function findBlock(id) {
  for (const day of Object.values(S.days)) { const i = day.blocks.findIndex(b => b.id === id); if (i >= 0) return { day, b: day.blocks[i], i }; }
  return {};
}
A.useTpl = ({ id }) => {
  const n = newDay(id, sel);
  save(); render();
  toast(n ? `Trimmed ${n} block${n > 1 ? 's' : ''} to fit the rest of the day` : 'Day built. Tap any block to change it.');
};
A.copyDay = ({ from, to }) => {
  const src = getDay(from);
  S.days[to] = { date: to, startMin: 480, tpl: src.tpl, blocks: src.blocks.map(b => ({ id: uid(), t: b.t, dur: b.dur, st: 'plan', poi: b.pinned ? b.poi : null, pinned: b.pinned, toZone: b.toZone, durSet: b.durSet, label: b.label })) };
  autofill(S.days[to]); render();
};
A.fixBlk = ({ id }) => {
  const { day, b } = findBlock(id);
  const alt = fixBlock(day, b);
  toast(alt ? 'Swapped to ' + alt.p.n : 'No open alternative nearby. Move the block instead.');
  refresh();
};
A.route = () => {
  const day = getDay(sel), rows = flow(day), ds = [];
  let last = null;
  for (const r of rows) {
    if (r.skip || r.b.st === 'done') continue;
    const d = r.b.poi ? destOf(P[r.b.poi]) : r.b.t === 'travel' && Z[r.b.toZone] ? zoneDest(Z[r.b.toZone]) : null;
    if (d && d !== last) ds.push(d);
    last = d || last;
  }
  if (!ds.length) return toast('No places in this plan yet');
  if (ds.length > 10) toast('Google Maps takes 10 stops. Routing the first 10.');
  navigate(ds.slice(0, 10));
};
A.goBlk = ({ id }) => {
  const { b } = findBlock(id);
  if (b.poi) navigate([destOf(P[b.poi])]); else if (b.toZone) navigate([zoneDest(Z[b.toZone])]);
};
A.startBlk = ({ id }) => {
  const { day, b, i } = findBlock(id);
  for (const x of day.blocks) if (x.st === 'active' && x !== b) finishBlock(x, true);
  const fi = day.blocks.findIndex(x => x.st === 'plan');
  if (fi >= 0 && fi < i) { day.blocks.splice(i, 1); day.blocks.splice(fi, 0, b); }
  b.st = 'active'; b.s0 = Date.now(); save();
  if (sheetStack.length) closeSheet(true); else render();
};
A.extend = ({ id }) => { const { b } = findBlock(id); b.dur += 30; b.durSet = true; save(); refresh(); };
A.doneBlk = ({ id }) => {
  const { b } = findBlock(id);
  const undo = finishBlock(b);
  if (sheetStack.length) closeSheet(true); else render();
  if (b.t === 'dash') openSheet(() => dashSheet(b.id));
  else toast(undo.msg, undo.fn);
};
// marks a block done, logs time/needs; returns {msg, fn: undo}
function finishBlock(b, silent) {
  const now = Date.now(), prev = JSON.stringify(b), prevS = { last: { ...S.last }, workout: S.workout, nights: S.nights.length, log: S.log.length };
  if (b.st !== 'active') b.s0 = now - b.dur * MIN;
  b.s1 = now; b.st = 'done';
  const min = (b.s1 - b.s0) / MIN, k = BT[b.t].log;
  let msg = BT[b.t].n + ' done';
  if (k === 'dev' || k === 'water' || k === 'car') { logEntry(k, min); msg = `Logged ${fmtDur(min)} ${k === 'dev' ? 'game dev' : k === 'water' ? 'on the water' : 'car work'}`; }
  if (k === 'gym') { logEntry('gym', min); S.last.shower = now; msg = `${WORKOUTS[S.workout % 5].n} logged. Shower ✓`; S.workout = (S.workout + 1) % 5; }
  if (['shower', 'laundry', 'water_refill', 'groceries', 'mail'].includes(k)) S.last[k] = now;
  if (k === 'groceries') for (const s of SUPPLIES) delete S.supplies[s];
  if (b.t === 'sleep' && b.poi) { S.nights.push({ poi: b.poi, t: now }); msg = 'Night logged. Rotation updated.'; }
  save();
  const fn = () => { Object.assign(b, JSON.parse(prev)); if (!JSON.parse(prev).s1) delete b.s1; S.last = prevS.last; S.workout = prevS.workout; S.nights.length = prevS.nights; S.log.length = prevS.log; };
  return silent ? null : { msg, fn };
}
A.dayMenu = () => openSheet(() => {
  const day = getDay(sel);
  return sheetHead(dayLabel(sel), 'Day options') + `<div class="stack">
    ${sel !== today() ? `<label class="lbl">Start time</label><input class="field" type="time" data-c="startMin" value="${pad(Math.floor((day.startMin ?? 480) / 60) % 24)}:${pad((day.startMin ?? 480) % 60)}">` : ''}
    <button class="btn big" data-a="reopt">↻ Re-pick best places (keeps your picks)</button>
    <button class="btn big" data-a="copyDay" data-from="${sel}" data-to="${addDays(sel, 1)}">Copy blocks to ${dayLabel(addDays(sel, 1))}</button>
    <button class="btn big" data-a="routeWeb">Route in browser (Google Maps web)</button>
    <button class="btn big" data-a="clearDay" style="color:var(--bad)">Clear this day</button></div>`;
});
const C = {};
C.startMin = el => { const [h, m] = el.value.split(':').map(Number); getDay(sel).startMin = h * 60 + m; autofill(getDay(sel)); refresh(); };
A.reopt = () => { autofill(getDay(sel), true); closeSheet(true); toast('Places re-picked for the current times'); };
A.routeWeb = () => { const m = S.settings.maps; S.settings.maps = 'web'; A.route(); S.settings.maps = m; };
A.clearDay = () => { const d = S.days[sel]; delete S.days[sel]; save(); closeSheet(true); toast('Day cleared', () => { S.days[sel] = d; }); };

// ---------- block sheet
A.openBlock = ({ id }) => openSheet(() => blockSheet(id));
function blockSheet(id) {
  const { day, b, i } = findBlock(id);
  if (!b) return sheetHead('Gone') + '<p class="muted">This block was removed.</p>';
  const def = BT[b.t], rows = flow(day), r = rows.find(x => x.b === b) || {}, p = b.poi && P[b.poi];
  const isToday = day.date === today();
  let h = sheetHead(`${def.ic} ${esc(blockTitle(b))}`, r.s ? `${dayLabel(day.date)} · ${fmtTime(r.s)}${b.t === 'sleep' ? '' : '–' + fmtTime(r.e)}` : dayLabel(day.date));
  h += `<div class="row wrap" style="margin-bottom:10px">${b.t !== 'sleep' ? `<div class="dur"><button data-a="dur" data-id="${id}" data-v="-15">−</button><span>${fmtDur(b.dur)}</span><button data-a="dur" data-id="${id}" data-v="15">+</button></div>
    ${b.t.startsWith('water') ? `<button class="btn sm" data-a="durSet" data-id="${id}" data-v="75">S</button><button class="btn sm" data-a="durSet" data-id="${id}" data-v="150">M</button><button class="btn sm" data-a="durSet" data-id="${id}" data-v="270">L</button>` : ''}` : ''}
    <span class="grow"></span><button class="btn sm" data-a="moveBlk" data-id="${id}" data-v="-1" ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn sm" data-a="moveBlk" data-id="${id}" data-v="1" ${i === day.blocks.length - 1 ? 'disabled' : ''}>↓</button><button class="btn sm" data-a="blockMenu" data-id="${id}">•••</button></div>`;
  if (def.hint) h += `<p class="note">${esc(def.hint)}</p>`;
  for (const w of r.warn || []) h += `<div class="warnline" style="margin-bottom:6px">⚠️ ${esc(w)}${p && /Closed|closes|Gate/.test(w) ? ` <button class="btn sm" data-a="fixBlk" data-id="${b.id}">Swap to an open place</button>` : ''}</div>`;
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
    const prevPt = (() => { let pt = dayOrigin(day).pt; for (const x of rows) { if (x.b === b) break; const q = !x.skip && blockPoint(x.b); if (q) pt = q; } return pt; })();
    const alts = rank(b.t, { from: prevPt, at: r.s || Date.now(), dur: b.dur }).filter(x => x.p.id !== b.poi).slice(0, 12);
    h += `<h2>${p ? 'Swap for' : 'Pick a place'}</h2><div class="list">${alts.map(x => placeRow({ ...x, at: r.s, dur: b.dur }, b.t, `<button class="btn sm primary" data-a="pickPlace" data-blk="${id}" data-id="${x.p.id}">Use</button>`)).join('') || '<div class="empty">Nothing nearby.</div>'}</div>`;
  }
  return h;
}
A.blockMenu = ({ id }) => openSheet(() => {
  const { day, b } = findBlock(id);
  return sheetHead(esc(blockTitle(b)), 'Block options') + `<div class="stack">
    ${day.date === today() && b.st === 'plan' ? `<button class="btn big" data-a="doneBlk" data-id="${id}">✓ Mark done</button>` : ''}
    <button class="btn big" data-a="skipBlk" data-id="${id}">${b.st === 'skip' ? 'Unskip' : 'Skip for today'}</button>
    <button class="btn big" data-a="nextDayBlk" data-id="${id}">Move to ${dayLabel(addDays(day.date, 1))}</button>
    <button class="btn big" data-a="dupBlk" data-id="${id}">Duplicate</button>
    <button class="btn big" data-a="delBlk" data-id="${id}" style="color:var(--bad)">Delete block</button></div>`;
});
A.dur = ({ id, v }) => { const { b } = findBlock(id); b.dur = Math.max(5, b.dur + +v); b.durSet = true; save(); refresh(); };
A.durSet = ({ id, v }) => { const { b } = findBlock(id); b.dur = +v; b.durSet = true; if (b.t === 'water_s' && +v >= 180) b.t = 'water_l'; else if (b.t === 'water_l' && +v < 180) b.t = 'water_s'; save(); refresh(); };
A.pickPlace = ({ blk, id }) => { const { b } = findBlock(blk); b.poi = id; b.pinned = true; save(); closeSheet(); toast('Set: ' + P[id].n); };
A.moveBlk = ({ id, v }) => { const { day, i } = findBlock(id); const j = i + +v; if (j < 0 || j >= day.blocks.length) return; [day.blocks[i], day.blocks[j]] = [day.blocks[j], day.blocks[i]]; save(); refresh(); };
A.skipBlk = ({ id }) => { const { b } = findBlock(id); b.st = b.st === 'skip' ? 'plan' : 'skip'; save(); closeSheet(true); };
A.reopenBlk = ({ id }) => { const { b } = findBlock(id); b.st = 'plan'; delete b.s0; delete b.s1; save(); refresh(); };
A.delBlk = ({ id }) => { const { day, b, i } = findBlock(id); day.blocks.splice(i, 1); save(); closeSheet(true); toast('Block deleted', () => day.blocks.splice(i, 0, b)); };
A.dupBlk = ({ id }) => { const { day, b, i } = findBlock(id); day.blocks.splice(i + 1, 0, { ...b, id: uid(), st: 'plan', s0: undefined, s1: undefined }); save(); closeSheet(true); };
A.nextDayBlk = ({ id }) => {
  const { day, b, i } = findBlock(id), nd = addDays(day.date, 1);
  day.blocks.splice(i, 1);
  const target = S.days[nd] ||= { date: nd, startMin: 480, blocks: [mkBlock('sleep')] };
  const si = target.blocks.findIndex(x => x.t === 'sleep');
  Object.assign(b, { st: 'plan' }); delete b.s0; delete b.s1;
  target.blocks.splice(si < 0 ? target.blocks.length : si, 0, b);
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
A.setZone = ({ blk, z }) => { const { day, b } = findBlock(blk); b.toZone = z; b.durSet = false; autofill(day); refresh(); toast('Later blocks re-picked around ' + Z[z].n); };

// add blocks
const PALETTE = ['water_s', 'water_l', 'cafe', 'office', 'deep', 'light', 'dash', 'gym', 'meal', 'grill', 'travel', 'sleep', 'car', 'water', 'groc', 'laundry', 'mail', 'shower', 'restroom', 'fun', 'social', 'free'];
A.addBlockSheet = () => openSheet(() => sheetHead('Add a block', dayLabel(sel)) + `<div class="palette">${PALETTE.map(t => `<button data-a="addBlock" data-t="${t}"><span class="ic">${BT[t].ic}</span>${esc(BT[t].n)}${BT[t].dur ? `<span class="tiny faint" style="display:block">${fmtDur(BT[t].dur)}</span>` : ''}</button>`).join('')}</div>`);
A.addBlock = ({ t, poi, dur, next }) => {
  const date = sel;
  const day = S.days[date] ||= { date, startMin: date === today() ? new Date().getHours() * 60 + new Date().getMinutes() : 480, blocks: [] };
  const b = mkBlock(t);
  if (dur) b.dur = +dur;
  if (poi) { b.poi = poi; b.pinned = true; }
  if (t === 'travel') b.toZone = nextZone(1, dayOrigin(day).pt)?.id;
  let at = day.blocks.findIndex(x => x.t === 'sleep');
  if (next) at = day.blocks.findIndex(x => x.st === 'plan');
  if (t === 'sleep' || at < 0) at = day.blocks.length;
  day.blocks.splice(at, 0, b);
  autofill(day);
  closeSheet(true);
  toast(`${BT[t].n} added${b.poi ? ': ' + P[b.poi].n : ''}`);
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
A.dashGo = ({ id }) => { const { b } = findBlock(id); const dest = destOf(P[b.poi]); if (b.st === 'plan' && findBlock(id).day.date === today()) A.startBlk({ id }); navigate([dest]); };
function dashCompare() {
  const by = {};
  for (const e of S.log) if (e.k === 'dash') { const o = by[e.z] ||= { n: 0, gross: 0, min: 0, miles: 0 }; o.n++; o.gross += e.gross || 0; o.min += e.min; o.miles += e.miles || 0; }
  const rows = Object.entries(by);
  if (!rows.length) return '';
  return `<h2>Your markets</h2><div class="list">${rows.map(([z, o]) => `<div class="place"><div class="main"><div class="nm">${esc(Z[z]?.n || z)}</div><div class="meta">${o.n} shift${o.n > 1 ? 's' : ''} · $${o.gross.toFixed(0)}</div></div>
    <div class="side"><span class="dist">$${(o.gross / Math.max(1, o.min / 60)).toFixed(2)}/h</span><span class="tiny muted">${o.miles ? '$' + (o.gross / o.miles).toFixed(2) + '/mi' : ''}</span></div></div>`).join('')}</div>`;
}
function dashSheet(blockId) {
  const b = blockId && findBlock(blockId).b;
  const hrs = b?.s0 ? ((b.s1 - b.s0) / HOUR).toFixed(1) : '';
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
    `<button class="btn big primary" data-a="useGps">📍 Use my GPS location</button><p class="note">Or plan as if you're in a zone (route order):</p>
    <div class="list">${zs.map(({ z, mi }) => `<div class="place" data-a="setHome" data-z="${z.id}"><div class="main"><div class="nm">${z.o}. ${esc(z.n)}</div><div class="meta">${esc(z.r || '')}${z.stay ? ` · stay ${z.stay[0]}–${z.stay[1]}d` : ''}</div></div><div class="side"><span class="dist">${S.loc ? fmtMi(mi) : ''}</span></div></div>`).join('')}</div>`;
});
A.useGps = async () => { S.zone = null; save(); closeSheet(true); const l = await locate(true); toast(l ? 'Location updated' : 'Location unavailable: allow it in Settings › Privacy'); applyTheme(); render(); refreshWx(); };
A.setHome = ({ z }) => { S.zone = z; save(); closeSheet(true); refreshWx(); };
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

// ---------- place sheet
function placeSheet(id, type, blk) {
  const p = P[id];
  const st = hoursState(p), sk = sketchChip(p), tc = trustChip(p);
  const types = Object.keys(BT).filter(t => BT[t].m && BT[t].m(p));
  let h = sheetHead(esc(p.n), `${esc(catLabel(p))} · ${esc(p.city || '')} · ${esc(p._z?.n || '')}`);
  h += `<div class="chips">${chip(st.txt, st.k === 'open' || st.k === '24h' ? (st.soon ? 'warn' : 'ok') : st.k === 'closed' ? 'bad' : '')} ${chip(tc[0], tc[1])} ${sk ? chip(sk[0], sk[1]) : ''} ${wfChips(p).map(([t, c]) => chip(t, c)).join(' ')}</div>`;
  h += `<div class="acts"><button class="btn primary" data-a="nav" data-id="${id}">Directions</button><button class="btn" data-a="fav" data-id="${id}">${S.fav[id] ? '★ Saved' : '☆ Save'}</button>
    <a class="btn" href="${mapsSearch(p)}" target="_blank" rel="noopener">Photos / reviews</a>${p.ph ? `<a class="btn" href="tel:${esc(p.ph.replace(/[^\d+]/g, ''))}">Call</a>` : p.web ? `<a class="btn" href="${esc(p.web)}" target="_blank" rel="noopener">Website</a>` : ''}</div>`;
  if (blk) h += `<button class="btn big primary" data-a="pickPlace" data-blk="${blk}" data-id="${id}">Use for this block</button>`;
  else if (types.length) h += `<label class="lbl">Add to ${dayLabel(sel)} as</label><div class="chips">${types.map(t => `<button class="chip acc" data-a="addBlock" data-t="${t}" data-poi="${id}">${BT[t].ic} ${BT[t].n}</button>`).join('')}</div>`;
  if (p.a) h += `<h2>Address</h2><div class="row"><div class="grow">${esc(p.a)}${!p.lat || p.gq === 'city' ? '<div class="tiny faint">Map pin approximate. Directions use the name + address.</div>' : ''}</div><button class="btn sm" data-a="copy" data-v="${esc(p.a)}">Copy</button></div>`;
  if (p.h) {
    const { dow } = tzParts(new Date(), p.ct);
    h += `<h2>Hours${p.ct ? ' (Central)' : ''}</h2><table class="hours-tbl">${[1, 2, 3, 4, 5, 6, 0].map(i => `<tr class="${i === dow ? 'today' : ''}"><td>${WD[i]}</td><td style="text-align:right">${esc(p.h[i] ?? 'unknown')}</td></tr>`).join('')}</table>`;
    if (p.x.hx || p.x.warn) h += `<p class="note">${esc([].concat(p.x.hx || [], p.x.warn || []).join(' · '))}</p>`;
  }
  if (p._ov) h += ovHtml(p);
  if (p._camp) h += campHtml(p._camp);
  if (p._mail) h += mailHtml(p);
  if (p._food) h += foodHtml(p._food);
  if (p._rec) h += recHtml(p._rec);
  if (p.tn) h += `<h2>Notes</h2><p class="note">${esc(p.tn)}</p>`;
  if (p.capn?.length) h += `<h2>What it's good for</h2>${p.capn.map(([c, n, cond]) => {
    const e = p.caps[c];
    return `<div class="obs"><b>${esc(c.replace(/_/g, ' '))}</b> ${chip(e === 'd' ? 'Confirmed' : e === 'r' ? 'Reported' : 'Unconfirmed', e === 'd' ? 'ok' : e === 'r' ? 'blue' : '')}<div class="note">${esc(n)}${cond?.length ? ' · Needs: ' + esc(cond.join(', ')) : ''}</div></div>`;
  }).join('')}`;
  h += obsHtml(p);
  if (p.src?.length) h += `<h2>Sources</h2>${p.src.map(s => D.sources[s]).filter(Boolean).map(([t, u]) => `<div class="obs"><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a></div>`).join('')}`;
  h += `<button class="btn big ghost" data-a="avoid" data-id="${id}" style="margin-top:14px">${S.avoid[id] ? 'Unhide this place' : 'Hide this place from suggestions'}</button>`;
  return h;
}
function ovHtml(p) {
  const o = p._ov, n = S.nights.filter(x => x.poi === p.id).length;
  const pr = { inspect_first: 'Inspect first', alternative: 'Alternative', extra_friction: 'Extra friction', not_for_auto_selection: 'Do not use' }[o.pr] || o.pr;
  return `<h2>Overnight</h2><div class="card"><div class="chips">${chip(pr || 'Candidate')} ${chip('Permission: ' + (o.perm || 'unknown'), o.perm === 'prohibited' ? 'bad' : '')} ${o.gray ? chip('Gray area', 'warn') : ''} ${o.o24 ? chip('24h nearby', 'ok') : ''}</div>
    ${o.why ? `<p class="note">${esc(o.why)}</p>` : ''}${o.notes ? `<p class="note">${esc(o.notes)}</p>` : ''}
    ${o.fc?.length ? `<p class="note"><b>Check on arrival:</b> ${o.fc.map(esc).join(' · ')}</p>` : ''}
    ${o.tow || o.knock ? `<p class="note" style="color:var(--warn)">Reports: ${esc([o.tow && 'tow: ' + o.tow, o.knock && 'knocks: ' + o.knock].filter(Boolean).join(' · '))}</p>` : ''}
    <p class="note">You've slept here ${n}×${n ? ', last ' + fmtAgo(lastNight(p.id)) : ''}.</p>
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
A.slept = ({ id }) => { S.nights.push({ poi: id, t: Date.now() }); save(); refresh(); toast('Night logged', () => S.nights.pop()); };
A.copy = async ({ v }) => { try { await navigator.clipboard.writeText(v); toast('Copied'); } catch { toast('Copy failed'); } };

// ---------- PLACES
function vPlaces() {
  const cats = [['', 'Nearby'], ['water_s', 'Water'], ['office', 'Work'], ['cafe', 'Cafés'], ['gym', 'PF'], ['meal', 'Food'], ['sleep', 'Sleep'], ['grill', 'Grills'], ['car', 'Car'], ['laundry', 'Laundry'], ['mail', 'Mail'], ['fun', 'Fun'], ['social', 'Bars'], ['fav', '★ Saved']];
  return `<div class="top"><h1>Places</h1><button class="btn sm" data-a="zonePick">📍 ${esc(locLabel())}</button></div>
    <div class="search"><input class="field" id="placesQ" type="search" placeholder="Search ${D.pois.length} places, cities, zones" value="${esc(placesQ)}"></div>
    <div class="scroller" style="margin-top:10px">${cats.map(([k, l]) => `<button class="pill ${placesCat === k ? 'on' : ''}" data-a="placesCat" data-k="${k}">${l}</button>`).join('')}</div>
    <div id="placesResults">${placesResults()}</div>`;
}
A.placesCat = ({ k }) => { placesCat = k; render(); };
function placesResults() {
  const from = here(), q = placesQ.trim().toLowerCase();
  if (q) {
    const words = q.split(/\s+/);
    const hits = D.pois.filter(p => words.every(w => p._txt.includes(w))).map(p => { const pt = ptOf(p); return { p, mi: pt ? hav(from, pt) : null, approx: pt?.approx }; }).sort((a, b) => a.mi - b.mi).slice(0, 60);
    const zh = D.zones.filter(z => z.n.toLowerCase().includes(q));
    return (zh.length ? `<h2>Zones</h2><div class="list">${zh.map(zoneRow).join('')}</div>` : '') + `<h2>${hits.length} places</h2><div class="list">${hits.map(r => placeRow(r)).join('') || '<div class="empty">No matches. Not covered? <button class="btn sm" data-a="packReq">Get a data-pack prompt</button></div>'}</div>`;
  }
  if (placesCat === 'fav') {
    const favs = Object.keys(S.fav).map(id => P[id]).filter(Boolean).map(p => ({ p, mi: hav(from, ptOf(p)) })).sort((a, b) => a.mi - b.mi);
    return `<div class="list" style="margin-top:10px">${favs.map(r => placeRow(r)).join('') || '<div class="empty">Save places with ☆ to see them here.</div>'}</div>`;
  }
  if (placesCat) return `<div class="list" style="margin-top:10px">${rank(placesCat).slice(0, 40).map(r => placeRow(r, placesCat)).join('')}</div>`;
  const cz = zoneOfPoint(from);
  return `<h2>You're in</h2><div class="list">${zoneRow(cz)}</div><h2>Along the route</h2><div class="list">${D.zones.slice().sort((a, b) => a.o - b.o).map(zoneRow).join('')}</div>
    <button class="btn big ghost" data-a="packReq" style="margin-top:12px">Need an area that isn't here? →</button>
    <p class="faint tiny" style="text-align:center">Data v${esc(D.v)} · researched ${esc(D.researched)} · ${D.pois.length} places · ${D.zones.length} zones</p>`;
}
function zoneRow(z) {
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
    <div class="acts"><button class="btn primary" data-a="setHome" data-z="${id}">Plan from here</button><button class="btn" data-a="navZone" data-z="${id}">Directions</button></div>
    ${D.dd[id] ? '<h2>DoorDash</h2>' + dashInfo(z) : ''}
    ${z.rec?.length ? `<h2>Researcher picks</h2><div class="list">${z.rec.map(i => P[i]).filter(Boolean).map(p => placeRow({ p, mi: hav(here(), ptOf(p)) })).join('')}</div>` : ''}
    ${Object.entries(by).map(([c, list]) => `<h2>${esc(CAT_NAMES[c] || c)} · ${list.length}</h2><div class="list">${list.map(p => placeRow({ p })).join('')}</div>`).join('')}`;
}
A.navZone = ({ z }) => navigate([zoneDest(Z[z])]);

// ---------- MAP (Leaflet, lazy)
let map, tiles, markers, planLayer;
const CAT_COLOR = { waterfront: '#2F80ED', work: '#8E6CEF', gym: '#E8475F', food: '#F2994A', overnight_candidate: '#5B5BD6', car_maintenance: '#7D7D7D', camping: '#27AE60', mail: '#B8741A', fun: '#16A085', social: '#D35400', life_support: '#3AB0D8', doordash_cluster: '#E8475F' };
const MAP_FILTERS = [['all', 'All'], ['water_s', 'Water'], ['grill', 'Grills'], ['office', 'Work'], ['gym', 'PF'], ['meal', 'Food'], ['sleep', 'Sleep'], ['car', 'Car'], ['laundry', 'Laundry'], ['fun', 'Fun'], ['fav', '★']];
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
  const m = mapFilter === 'all' ? () => true : mapFilter === 'fav' ? p => S.fav[p.id] : BT[mapFilter].m;
  for (const p of D.pois) {
    if (p.lat == null || !m(p) || S.avoid[p.id]) continue;
    L.circleMarker([p.lat, p.lng], { radius: S.fav[p.id] ? 9 : 7, color: '#fff', weight: 2, fillColor: CAT_COLOR[p.c] || '#888', fillOpacity: 0.95 })
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
    <div class="grid2">${bar(w.gym, 5, 5, '🏋️ Gym')}${bar(w.car, 1, 1, '🔧 Car')}</div>${bar(w.waterDays.size, 5, 7, '🌊 Water days')}</div>
    <div class="row" style="margin-top:10px"><button class="btn" data-a="dashLog">+ Dash shift</button></div>
    ${dashCompare()}
    <h2>Lift rotation</h2><div class="list">${WORKOUTS.map((x, i) => `<div class="place" data-a="setWorkout" data-i="${i}"><div class="main"><div class="nm">${i + 1}. ${esc(x.n)} ${i === S.workout % 5 ? chip('Next', 'acc') : ''}</div><div class="meta">${x.ex.map(esc).join(' · ')}</div></div></div>`).join('')}</div>
    <h2>Upkeep</h2><div class="list">${Object.entries(DUE).map(([k, [hrs, l]]) => `<div class="place"><div class="main"><div class="nm">${l}</div><div class="meta">${S.last[k] ? fmtAgo(S.last[k]) : 'not logged'} · every ${hrs >= 48 ? hrs / 24 + ' days' : hrs + 'h'}</div></div><div class="side"><button class="btn sm" data-a="quickLog" data-k="${k}">Log now</button></div></div>`).join('')}</div>
    <h2>Car staples</h2><p class="note" style="margin-top:-4px">Check what's running low. It shows up on your Groceries block.</p><div class="list">${SUPPLIES.map(s => `<label class="check"><input type="checkbox" data-c="supply" data-k="${esc(s)}" ${S.supplies[s] ? 'checked' : ''}>${esc(s)}</label>`).join('')}</div>
    <h2>Recent nights</h2><div class="list">${S.nights.slice(-8).reverse().map(n => P[n.poi] ? `<div class="place" data-a="openPlace" data-id="${n.poi}"><div class="main"><div class="nm">${esc(P[n.poi].n)}</div><div class="meta">${new Date(n.t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div></div></div>` : '').join('') || '<div class="empty">Log nights from a sleep block or place.</div>'}</div>
    <h2>Recent log</h2><div class="list">${S.log.slice(-8).reverse().map(e => `<div class="place"><div class="main"><div class="nm">${esc({ dev: 'Game dev', dash: 'DoorDash', gym: 'Gym', car: 'Car work', water: 'Water time' }[e.k] || e.k)} · ${fmtDur(e.min)}</div><div class="meta">${new Date(e.t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}${e.gross ? ' · $' + e.gross : ''}</div></div><div class="side"><button class="btn sm ghost" data-a="delLog" data-id="${e.id}">✕</button></div></div>`).join('') || '<div class="empty">Finish blocks to log time.</div>'}</div>
    <h2>Settings</h2><div class="card stack"><div><span class="lbl">Theme</span>${seg('theme', [['auto', 'Auto (sun)'], ['light', 'Day'], ['dark', 'Night']])}</div>
    <div><span class="lbl">Directions open in</span>${seg('maps', [['gapp', 'Google Maps app'], ['web', 'Google web'], ['apple', 'Apple Maps']])}</div>
    <div>${tog('club', 'Planet Fitness Black Card (any club)')}${tog('tent', 'Tent on board (show tent camps)')}${tog('hotel', 'Hotel nights OK (paid lodging)')}</div>
    <div><span class="lbl">Name for General Delivery mail</span><input class="field" data-c="name" value="${esc(set.name)}" placeholder="FIRST LAST" autocapitalize="characters"></div></div>
    <h2>Backup</h2><div class="row wrap"><button class="btn" data-a="export">Export my data</button><label class="btn">Import<input type="file" accept="application/json" data-c="import" hidden></label><button class="btn" data-a="lock" style="color:var(--bad)">Lock app</button></div>
    <p class="faint tiny" style="margin-top:14px">Your plans, notes and logs live only on this phone. Export now and then. Data v${esc(D.v)} (${esc(D.researched)}).</p>`;
}
A.setOpt = ({ k, v }) => { S.settings[k] = v; save(); applyTheme(); render(); };
C.tog = el => { S.settings[el.dataset.k] = el.checked; save(); };
C.name = el => { S.settings.name = el.value.trim().toUpperCase(); save(); };
C.supply = el => { if (el.checked) S.supplies[el.dataset.k] = true; else delete S.supplies[el.dataset.k]; save(); };
A.setWorkout = ({ i }) => { S.workout = +i; save(); render(); };
A.delLog = ({ id }) => { const i = S.log.findIndex(e => e.id === id), e = S.log[i]; S.log.splice(i, 1); save(); render(); toast('Entry removed', () => S.log.splice(i, 0, e)); };
A.logTime = () => openSheet(() => sheetHead('Log time', 'Work you did outside a block') + `<div class="grid2"><div><label class="lbl">What</label><select class="field" id="ltK"><option value="dev">Game dev</option><option value="water">Water time</option><option value="car">Car work</option><option value="gym">Gym</option></select></div>
  <div><label class="lbl">Hours</label><input class="field" id="ltH" type="number" inputmode="decimal" value="2"></div></div><button class="btn big primary" data-a="saveTime" style="margin-top:12px">Save</button>`);
A.saveTime = () => { const k = $('#ltK').value, h = parseFloat($('#ltH').value) || 0; if (!h) return; logEntry(k, h * 60); if (k === 'gym') { S.last.shower = Date.now(); S.workout = (S.workout + 1) % 5; } closeSheet(true); toast('Logged'); };
A.export = () => {
  const blob = new Blob([JSON.stringify(S)], { type: 'application/json' });
  const f = new File([blob], `heyjim-backup-${today()}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [f] })) navigator.share({ files: [f] }).catch(() => {});
  else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = f.name; a.click(); }
};
C.import = async el => {
  try {
    const j = JSON.parse(await el.files[0].text());
    if (!j.settings || !j.days) throw 0;
    S = Object.assign(structuredClone(DEFAULT_STATE), j); saveNow(); render(); toast('Backup restored');
  } catch { toast('That file is not a Hey Jim backup'); }
};
A.lock = () => { store.del('key'); location.reload(); };

boot();
