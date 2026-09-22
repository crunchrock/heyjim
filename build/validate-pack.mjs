// Validate a Hey Jim data pack before adding it: node build/validate-pack.mjs <pack.json>
// Checks ids, references, zones, hours syntax, coordinates, and likely duplicates of places already in packs/.
// Exit code 1 on errors. Warnings are printed but don't fail. (Research agents get a copy of this next to their brief.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks } from './packs.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
if (!file) { console.error('usage: node build/validate-pack.mjs <pack.json>'); process.exit(2); }
const errs = [], warns = [];
const E = m => errs.push(m), W = m => warns.push(m);
let b;
try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('JSON parse error:', e.message); process.exit(1); }
// everything already in packs/ except this file itself
const bundle = loadPacks(ROOT, path.resolve(file));
const zones = Object.fromEntries(bundle.zones.map(z => [z.id, z]));
const existing = bundle.pois;
const exIds = new Set(existing.map(p => p.id));
const zoneIds = new Set([...Object.keys(zones), ...(b.zones || []).map(z => z.id)]);
const CATS = new Set(['waterfront', 'work', 'gym', 'food', 'social', 'overnight_candidate', 'car_maintenance', 'camping', 'mail', 'fun', 'shop', 'life_support']);
const CAPS = new Set(['work_indoor', 'work_outdoors', 'wifi', 'gym', 'shower', 'sleep_candidate', 'tent_camp', 'paid_lodging', 'meal', 'protein_food', 'ramen', 'buffet', 'all_you_can_eat', 'groceries', 'daily_supplies', 'buy_drinking_water', 'water_source_candidate', 'laundry', 'mail', 'auto_parts', 'repair_support', 'auto_service', 'loan_tools', 'public_grill', 'restroom', 'restroom_candidate', 'recreation', 'fuel', 'vape', 'trail_run', 'swim']);
const EV = new Set(['documented', 'reported', 'inferred']);
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const TOK = '(\\d{1,2}:\\d{2}(?:\\+1)?|sunrise|sunset|dawn|dusk)';
const RANGE = new RegExp('^\\s*' + TOK + '\\s*-\\s*' + TOK + '\\s*$');
function okHours(v) {
  if (v == null) return true;
  const s = String(v).trim().toLowerCase();
  if (s === 'closed' || s === 'daylight') return true;
  return s.split(';').every(part => {
    const m = part.match(RANGE);
    if (!m) return false;
    return [m[1], m[2]].every(t => !/^\d/.test(t) || (() => { const [h, mm] = t.replace('+1', '').split(':').map(Number); return h <= 24 && mm < 60; })());
  });
}
const srcIds = new Set();
for (const s of b.sources || []) {
  if (!s.id) E('source without id'); else if (srcIds.has(s.id)) E('duplicate source id ' + s.id); else srcIds.add(s.id);
  if (!s.url) W('source without url ' + s.id);
}
const chkSrc = (ids, where) => { for (const id of ids || []) if (!srcIds.has(id)) E(`${where}: source_id ${id} not in sources[]`); };
const poiIds = new Set();
const norm = s => (s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const exByNameCity = new Map(existing.map(p => [norm(p.name) + '|' + norm(p.city), p.id]));
for (const p of b.pois || []) {
  const w = `poi ${p.id}`;
  if (!p.id) { E('poi without id: ' + p.name); continue; }
  if (poiIds.has(p.id)) E('duplicate poi id ' + p.id); poiIds.add(p.id);
  if (exIds.has(p.id)) W(`${w}: id already exists in the dataset (this will UPSERT it; fine if intended)`);
  if (!zoneIds.has(p.zone_id)) E(`${w}: unknown zone_id ${p.zone_id}`);
  else if (!p.id.startsWith(p.zone_id + '_')) E(`${w}: id must start with "${p.zone_id}_"`);
  if (!p.name) E(`${w}: no name`);
  if (!CATS.has(p.category)) E(`${w}: category ${p.category} not in ${[...CATS].join('|')}`);
  if (!p.address) E(`${w}: no address`);
  if (!p.navigation?.search_query) E(`${w}: no navigation.search_query`);
  if (!p.source_ids?.length) E(`${w}: no source_ids`); chkSrc(p.source_ids, w);
  if (p.hours) {
    if (typeof p.hours !== 'object' || Array.isArray(p.hours)) E(`${w}: hours must be an object {monday..sunday}`);
    else for (const [d, v] of Object.entries(p.hours)) {
      if (!DAYS.includes(d)) E(`${w}: hours key ${d} is not a weekday`);
      else if (!okHours(v)) E(`${w}: bad hours for ${d}: ${JSON.stringify(v)}`);
    }
  }
  if (p.latitude != null && (p.latitude < 24 || p.latitude > 31.1 || p.longitude < -87.7 || p.longitude > -79.8)) E(`${w}: coordinates outside Florida (${p.latitude}, ${p.longitude})`);
  if ((p.latitude == null) !== (p.longitude == null)) E(`${w}: latitude and longitude must both be set or both null`);
  const dupe = exByNameCity.get(norm(p.name) + '|' + norm(p.city));
  if (dupe && dupe !== p.id) W(`${w}: looks like existing ${dupe} (same name + city). Use its id (upsert) or poi_patches instead of a new place.`);
  for (const x of p.specials || []) {
    if (!x.label && !x.items?.length) E(`${w}: special needs a label or items ("description" isn't read)`);
    for (const d of x.days || []) if (!DAYS.includes(d)) E(`${w}: special day ${d}`);
    for (const t of [x.start, x.end]) if (t != null && !/^\d{1,2}:\d{2}$/.test(t)) E(`${w}: special time ${t}`);
  }
  const f = p.food_value;
  if (f) {
    if (f.rating != null && (typeof f.rating !== 'number' || f.rating > 5)) E(`${w}: food_value.rating must be a number ≤ 5`);
    if (f.price_level != null && ![1, 2, 3, 4].includes(f.price_level)) E(`${w}: price_level must be 1-4`);
  }
}
const capPois = new Set();
const capIds = new Set();
for (const c of b.capabilities || []) {
  const w = `capability ${c.id}`;
  if (capIds.has(c.id)) E('duplicate capability id ' + c.id); capIds.add(c.id);
  if (!poiIds.has(c.poi_id) && !exIds.has(c.poi_id)) E(`${w}: poi_id ${c.poi_id} not found`);
  if (c.id !== `${c.poi_id}__${c.capability}`) E(`${w}: id must be "<poi_id>__<capability>"`);
  if (!CAPS.has(c.capability)) E(`${w}: unknown capability ${c.capability}`);
  if (!EV.has(c.evidence_level)) E(`${w}: evidence_level must be documented|reported|inferred`);
  chkSrc(c.source_ids, w);
  capPois.add(c.poi_id);
}
for (const id of poiIds) if (!capPois.has(id)) E(`poi ${id}: has no capability`);
for (const k of ['overnight_candidates', 'recreation', 'camping', 'food_options']) for (const r of b[k] || []) if (!poiIds.has(r.poi_id) && !exIds.has(r.poi_id)) E(`${k} ${r.id}: poi_id ${r.poi_id} not found`);
for (const pt of b.poi_patches || []) if (!exIds.has(pt.id) && !poiIds.has(pt.id)) E(`poi_patch ${pt.id}: no such poi`);
console.log(`${file}\n  pois ${poiIds.size} · capabilities ${capIds.size} · sources ${srcIds.size} · patches ${(b.poi_patches || []).length}`);
for (const w of warns.slice(0, 60)) console.log('  WARN', w);
if (warns.length > 60) console.log(`  … ${warns.length - 60} more warnings`);
for (const e of errs.slice(0, 120)) console.log('  ERROR', e);
if (errs.length > 120) console.log(`  … ${errs.length - 120} more errors`);
console.log(errs.length ? `FAILED: ${errs.length} errors` : 'OK');
process.exit(errs.length ? 1 : 0);
