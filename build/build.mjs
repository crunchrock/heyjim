// Builds docs/data.enc (gzipped + AES-GCM encrypted slim dataset) and app icons.
// Usage: node build/build.mjs            (password/salt come from build/secret.json, gitignored)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPacks } from './packs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs');
const ITER = 310000;

const secretPath = path.join(ROOT, 'build', 'secret.json');
if (!fs.existsSync(secretPath)) {
  console.error('Missing build/secret.json {"password": "...", "salt": "<base64 16 bytes>"}');
  process.exit(1);
}
const secret = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
const bundle = loadPacks(ROOT);
const geoPath = path.join(ROOT, 'build', 'geocodes.json');
const geo = fs.existsSync(geoPath) ? JSON.parse(fs.readFileSync(geoPath, 'utf8')) : {};

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const EV = { documented: 'd', inferred: 'i', reported: 'r' };
const clean = o => {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete o[k];
  }
  return o;
};
const hoursArr = h => {
  if (!h || typeof h !== 'object') return null;
  const a = DAYS.map(d => (h[d] == null ? null : String(h[d])));
  return a.some(x => x != null) ? a : null;
};

// ---- capabilities per poi
const capsBy = {};
for (const c of bundle.capabilities) {
  const e = (capsBy[c.poi_id] ||= { caps: {}, notes: [] });
  const prev = e.caps[c.capability];
  const ev = EV[c.evidence_level] || 'i';
  if (!prev || prev === 'i' || (prev === 'r' && ev === 'd')) e.caps[c.capability] = ev;
  if (c.assessment_note || (c.conditions && c.conditions.length)) e.notes.push([c.capability, c.assessment_note || '', c.conditions || []]);
}

// ---- camping coords fallback
const campCoord = {};
for (const c of bundle.camping) if (c.latitude != null && c.longitude != null) campCoord[c.poi_id] = [c.latitude, c.longitude];

const rxCauseway = /causeway|boat ramp|boat launch|landing|bridge|intracoastal|fishing pier|pier|marina|river ?walk|riverfront|bay ?front|waterfront park/i;
const rxBeach = /\bbeach\b|ocean|gulf|dune|surf/i;
const rxFreePark = /free (public )?(beach )?parking|parking is free|free lot|no parking fee|free entry|free admission/i;
const rxPaidPark = /paid parking|parking fee|pay[- ]to[- ]park|metered|\$\d+.{0,20}parking|parking.{0,20}\$\d+/i;

const pois = bundle.pois.map(p => {
  const cb = capsBy[p.id] || { caps: {}, notes: [] };
  let lat = p.latitude, lng = p.longitude, gq = lat != null ? 'exact' : null;
  if (lat == null && campCoord[p.id]) { [lat, lng] = campCoord[p.id]; gq = 'exact'; }
  if (lat == null && geo[p.id]) { lat = geo[p.id].lat; lng = geo[p.id].lng; gq = geo[p.id].q || 'approx'; }
  const text = [p.name, p.traveler_notes, p.parking?.notes, JSON.stringify(p.evidence_notes || {})].join(' ');
  const am = p.amenities || [];
  let wf;
  if (p.category === 'waterfront' || p.waterfront_details || (p.tags || []).includes('beach_work')) {
    const paid = rxPaidPark.test(text) || p.parking?.free === false;
    wf = clean({
      s: p.waterfront_details?.amenity_support_score ?? null,
      cw: rxCauseway.test(p.name + ' ' + (p.traveler_notes || '')) || am.includes('boat_ramp') || am.includes('pier') ? 1 : 0,
      bch: am.includes('beach_access') || rxBeach.test(p.name) ? 1 : 0,
      gr: am.includes('grill') || cb.caps.public_grill ? 1 : 0,
      fp: p.parking?.free === true || rxFreePark.test(text) ? 1 : paid ? -1 : 0,
      sh: am.includes('shade') || am.includes('pavilion') ? 1 : 0,
      rr: am.includes('restroom') || cb.caps.restroom ? 1 : 0,
      mins: p.waterfront_details?.suggested_visit_minutes,
    });
  }
  const x = clean({
    t247: p.truly_24_7 || null,
    hx: p.hours_exceptions,
    warn: p.schedule_warning,
    cost: p.price?.typical_cost ?? p.price?.entry_cost ?? null,
    park: p.parking?.notes,
    closing: p.scheduled_closure_date,
    wifiOut: p.wifi_outdoors,
    tools: p.loan_a_tool_confirmed || null,
    lotRepair: p.lot_repairs_permitted ?? p.parking_lot_repairs_permitted ?? null,
    kratom: p.work_details?.sells_kratom ?? null,
    laptop: p.work_details?.laptop_friendly ?? null,
  });
  const fvS = p.food_value || {};
  const fv = clean({ cu: fvS.cuisine, asian: fvS.asian ? 1 : null, pl: fvS.price_level ?? null, usd: fvS.typical_meal_usd ?? null, r: fvS.rating ?? null, rc: fvS.rating_count ?? null,
    rs: fvS.rating_source, rck: fvS.rating_checked, cheap: fvS.known_for_cheap === true ? 1 : fvS.known_for_cheap === false ? 0 : null, ev: fvS.cheap_evidence });
  const bdS = p.bar_details || {};
  const bd = clean({ k: bdS.kind, vibe: bdS.vibe, games: bdS.games, food: bdS.food, pl: bdS.price_level ?? null, r: bdS.rating ?? null, rc: bdS.rating_count ?? null, rs: bdS.rating_source });
  const sp = (p.bar_specials || p.specials || []).map(x => clean({ l: x.label, d: (x.days || []).map(d => DAYS.indexOf(String(d).toLowerCase())).filter(i => i >= 0), s: x.start, e: x.end,
    items: x.items, posted: x.posted_date, checked: x.checked_date, conf: x.confidence, src: x.source_id }));
  return clean({
    id: p.id, z: p.zone_id, n: p.name, c: p.category, sc: p.subcategory,
    fv, bd, sp,
    a: p.navigation?.formatted_address || p.address, city: p.city,
    lat: lat != null ? +(+lat).toFixed(5) : null, lng: lng != null ? +(+lng).toFixed(5) : null, gq,
    web: p.website, ph: p.phone, h: hoursArr(p.hours),
    ct: p.timezone === 'America/Chicago' ? 1 : null,
    caps: cb.caps, capn: cb.notes, am, tags: p.tags,
    tn: p.traveler_notes,
    st: p.operational_status !== 'listed_by_source' ? p.operational_status : null,
    use: p.recommended_use_status !== 'candidate' ? p.recommended_use_status : null,
    q: p.navigation?.search_query?.trim(),
    wf, x,
    src: p.source_ids,
  });
});

// ---- overlays keyed by poi id
const byPoi = (arr, fn) => { const o = {}; for (const r of arr) { const v = fn(r); if (v) (o[r.poi_id] ||= []).push(v); } return o; };
const ovn = byPoi(bundle.overnight_candidates, o => clean({
  ty: o.type, st: o.status, pr: o.assessment?.priority, why: o.assessment?.rationale, gray: o.gray_area ? 1 : 0,
  perm: o.permission_status, conf: o.confidence, notes: o.notes, fc: o.field_check,
  tow: o.tow_reports, knock: o.security_knock_reports, light: o.lighting, lot: o.lot_character,
  rr: o.restrooms_nearby, o24: o.open_24h_nearby, rep: (o.reports || []).length ? o.reports : null, last: o.latest_report_date,
}));
const camp = byPoi(bundle.camping, c => clean({
  mgr: c.land_manager, cost: c.cost, res: c.reservation_required, resUrl: c.reservation_url, veh: c.vehicle_access,
  rules: c.sleeping_rules, limit: c.stay_limit, am: c.amenities, road: c.road_condition, vs: c.vehicle_sleeping_status,
  tent: c.tent_camping_documented, notes: c.notes, lead: c.reservation_lead_time, arr: c.arrival_constraint,
  alerts: c.alerts, score: c.creative_retreat_score, town: c.nearest_town,
}));
const mail = byPoi(bundle.mail_options, m => clean({
  ty: m.service_type, gd: m.general_delivery_listed, gdc: m.general_delivery_confirmed, hold: m.carrier_hold_confirmed,
  addr: m.physical_office_address, zip: m.physical_office_zip, ph: m.phone, tpl: m.address_template,
  ask: m.contact_prompt, pick: m.general_delivery_pickup_hours, rh: hoursArr(m.retail_hours), basis: m.hours_basis,
  ready: m.shipping_address_ready,
}));
const rec = byPoi(bundle.recreation, r => clean({
  act: r.activities, dur: r.suggested_duration_minutes ? [r.suggested_duration_minutes.min, r.suggested_duration_minutes.max] : null,
  cost: r.entry_cost, am: r.amenities, hq: r.hours_qualifier, alerts: r.alerts, res: r.reservation_required,
  resUrl: r.reservation_url, notes: r.notes,
}));
const offers = {};
for (const m of bundle.meal_offers) (offers[m.food_option_id] ||= []).push(clean({
  l: m.label, k: m.food_kind, p: m.price?.amount, u: m.price?.unit, ch: m.service_channel,
  win: m.availability?.windows?.length ? m.availability.windows : null, n: m.notes,
}));
const food = byPoi(bundle.food_options, f => clean({
  k: f.primary_food_kind, ramen: f.has_ramen, buf: f.is_buffet, ayce: f.is_all_you_can_eat, style: f.service_style,
  ex: f.menu_examples, menu: f.menu_url, min: f.cost_summary?.min_documented_complete_meal_base_usd,
  last: f.last_order_time, notes: f.notes, offers: offers[f.id],
}));

const dd = {};
for (const m of bundle.doordash_markets) (dd[m.zone_id] ||= []).push(clean({
  n: m.name, lat: m.center_lat, lng: m.center_lon, win: m.recommended_windows, avoid: m.avoid_windows,
  score: m.scores?.overall, conf: m.confidence, adv: m.advantages, prob: m.problems,
  subs: (m.target_subzones || []).map(s => clean({ n: s.name, poi: s.poi_id, d: s.description })), inc: m.demographics?.median_household_income_usd,
  basis: m.window_basis,
}));

// zones without a researched center get the centroid of their located places
const centroid = id => {
  const ps = pois.filter(p => p.z === id && p.lat != null && p.gq !== 'city');
  return ps.length ? [+(ps.reduce((a, p) => a + p.lat, 0) / ps.length).toFixed(4), +(ps.reduce((a, p) => a + p.lng, 0) / ps.length).toFixed(4)] : [null, null];
};
const inland = new Set(bundle.manifest.optional_inland_zone_ids?.length ? bundle.manifest.optional_inland_zone_ids : ['lake-county-north', 'clermont-groveland', 'orlando-apopka', 'orlando-central-east', 'ocala-forest']);
const zones = bundle.zones.map(z => {
  const FALLBACK = { 'lake-county-north': [28.8, -81.73], 'clermont-groveland': [28.55, -81.77], 'orlando-apopka': [28.64, -81.53], 'orlando-central-east': [28.56, -81.33], 'ocala-forest': [29.16, -82.1] };
  let [clat, clng] = z.center?.latitude != null ? [z.center.latitude, z.center.longitude] : centroid(z.id);
  if (clat == null && FALLBACK[z.id]) [clat, clng] = FALLBACK[z.id];
  if (clat == null) console.warn('zone without any location:', z.id);
  return clean({
  id: z.id, n: z.name, r: z.region, lat: clat, lng: clng, o: z.route_order, inland: inland.has(z.id) ? 1 : null, q: z.navigation_query,
  ct: z.timezone === 'America/Chicago' ? 1 : null, stay: z.recommended_stay_days ? [z.recommended_stay_days.min, z.recommended_stay_days.max] : null,
  best: z.best_for, weak: z.weaknesses, lb: z.legacy_best_for,
  rec: [...new Set([...(z.recommended_waterfront_ids || []), ...(z.recommended_work_ids || []), ...(z.recommended_pf_ids || []),
    ...(z.recommended_car_ids || []), ...(z.recommended_food_ids || []), ...(z.recommended_social_ids || [])])],
  });
});

// private places from packs/_profile.json (e.g. his storage unit): encrypted like everything else
for (const pl of bundle.profile.places || []) {
  const z = zones.reduce((a, b) => (Math.hypot(b.lat - pl.lat, b.lng - pl.lng) < Math.hypot(a.lat - pl.lat, a.lng - pl.lng) ? b : a));
  pois.push(clean({ id: 'me_' + pl.id, z: z.id, n: pl.name, c: 'mine', sc: pl.kind, a: pl.address, city: pl.city, lat: pl.lat, lng: pl.lng, gq: 'exact',
    web: pl.website, caps: { [pl.kind]: 'd' }, am: [], tags: [], tn: pl.notes, q: pl.search_query, x: {} }));
}
const usedSrc = new Set(pois.flatMap(p => p.src || []));
const sources = {};
for (const s of bundle.sources) if (usedSrc.has(s.id)) sources[s.id] = [s.title || s.publisher || s.url, s.url];

const data = {
  v: bundle.manifest.version, researched: bundle.manifest.research_date, built: new Date().toISOString(),
  packs: bundle.packs, profile: bundle.profile, route: bundle.manifest.route_visit_sequence, zones, pois, ovn, camp, mail, rec, food, dd, sources,
};

// ---- encrypt
const plain = zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 });
const salt = Buffer.from(secret.salt, 'base64');
const key = crypto.pbkdf2Sync(secret.password, salt, ITER, 32, 'sha256');
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
const head = Buffer.alloc(24);
head.write('HJ1', 0, 'ascii'); head.writeUInt8(1, 3); head.writeUInt32BE(ITER, 4); salt.copy(head, 8);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'data.enc'), Buffer.concat([head, iv, ct]));

// ---- icons (simple pin on warm coral, drawn with supersampling)
function png(size) {
  const S = 4, rows = [];
  const bg = [255, 90, 95], fg = [255, 255, 255];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      let cov = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const u = (x + (sx + 0.5) / S) / size, v = (y + (sy + 0.5) / S) / size;
        const cx = 0.5, cy = 0.43, r = 0.2, tip = 0.8;
        const dc = Math.hypot(u - cx, v - cy);
        let inPin = dc <= r;
        if (!inPin && v >= cy && v <= tip) inPin = Math.abs(u - cx) <= r * 0.98 * Math.pow((tip - v) / (tip - cy), 0.9);
        if (inPin && dc <= 0.075) inPin = false;
        if (inPin) cov++;
      }
      const a = cov / (S * S);
      for (let i = 0; i < 3; i++) row[1 + x * 3 + i] = Math.round(bg[i] * (1 - a) + fg[i] * a);
    }
    rows.push(row);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(tb) >>> 0);
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [180, 192, 512]) {
  const f = path.join(OUT, `icon-${s}.png`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, png(s));
}

// ---- bump service worker cache version so phones pick up new code/data
const swPath = path.join(OUT, 'sw.js');
if (fs.existsSync(swPath)) {
  const h = crypto.createHash('sha1');
  for (const f of ['index.html', 'core.js', 'app.js', 'styles.css', 'data.enc']) if (fs.existsSync(path.join(OUT, f))) h.update(fs.readFileSync(path.join(OUT, f)));
  const sw = fs.readFileSync(swPath, 'utf8').replace(/const VERSION = '[^']*'/, `const VERSION = '${h.digest('hex').slice(0, 10)}'`);
  fs.writeFileSync(swPath, sw);
}

const located = pois.filter(p => p.lat != null).length;
console.log(`pois ${pois.length} (located ${located}), zones ${zones.length}, json ${(JSON.stringify(data).length / 1024).toFixed(0)}KB, enc ${(ct.length / 1024).toFixed(0)}KB`);
