#!/usr/bin/env node
// build/geocode.mjs
// Geocodes POIs missing latitude/longitude from florida_mobile_dev_agent_bundle_v3.json
// Strategy: camping fallback -> US Census batch geocoder -> Nominatim (with sanity checks).
// Resumable: skips ids already present in build/geocodes.json or build/geocode_misses.json.
// Does NOT modify the source bundle file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
import { loadPacks } from './packs.mjs';
const OUT_DIR = path.join(ROOT, 'build');
const GEOCODES_PATH = path.join(OUT_DIR, 'geocodes.json');
const MISSES_PATH = path.join(OUT_DIR, 'geocode_misses.json');

const FL_BBOX = { latMin: 24.3, latMax: 31.1, lngMin: -87.7, lngMax: -79.8 };
const MAX_ZONE_DIST_MILES = 60;
const CENSUS_CHUNK = 250;
const NOMINATIM_DELAY_MS = 1500;
const NOMINATIM_UA = 'heyjim-personal-geocoder/1.0 (personal use)';
const LOCK_PATH = path.join(OUT_DIR, '.geocode.lock');

// ---- single-instance lock (prevents concurrent runs hammering Nominatim) ----
function acquireLock() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (fs.existsSync(LOCK_PATH)) {
    const pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
    let alive = false;
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e) {
        alive = false;
      }
    }
    if (alive) {
      console.error(`Another geocode.mjs instance appears to be running (pid ${pid}). Exiting.`);
      process.exit(1);
    }
    log(`Stale lock file found (pid ${pid} not running); removing.`);
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  const release = () => {
    try {
      if (fs.readFileSync(LOCK_PATH, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(LOCK_PATH);
      }
    } catch (e) {
      /* ignore */
    }
  };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
}
acquireLock();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function loadJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function saveJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function inFloridaBbox(lat, lng) {
  return (
    lat >= FL_BBOX.latMin &&
    lat <= FL_BBOX.latMax &&
    lng >= FL_BBOX.lngMin &&
    lng <= FL_BBOX.lngMax
  );
}

function sanityCheck(lat, lng, zoneCenter) {
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    Number.isNaN(lat) ||
    Number.isNaN(lng)
  ) {
    return false;
  }
  if (!inFloridaBbox(lat, lng)) return false;
  if (zoneCenter && zoneCenter.latitude != null) {
    const dist = haversineMiles(lat, lng, zoneCenter.latitude, zoneCenter.longitude);
    if (dist > MAX_ZONE_DIST_MILES) return false;
  }
  return true;
}

// ---- CSV helpers ----
function csvField(v) {
  const s = (v ?? '').toString();
  return '"' + s.replace(/"/g, '""') + '"';
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function stripUnit(street) {
  if (!street) return street;
  return street
    .replace(/\s*[,]?\s*\b(Ste|Suite|Unit|Apt|Apartment|Bldg|Building|#)\.?\s*[\w-]*\s*$/i, '')
    .trim();
}

// ---- load bundle (read-only) ----
log('Loading bundle...');
const bundle = loadPacks(ROOT);

const zonesById = new Map();
for (const z of bundle.zones || []) {
  if (z.center) zonesById.set(z.id, z.center);
}

const campingByPoiId = new Map();
for (const c of bundle.camping || []) {
  if (c.latitude != null && c.longitude != null) {
    campingByPoiId.set(c.poi_id, { lat: c.latitude, lng: c.longitude });
  }
}

const allPois = bundle.pois || [];
const targets = allPois.filter((p) => p.latitude == null || p.longitude == null);
log(`Total POIs: ${allPois.length}, missing coords: ${targets.length}`);

// ---- resumable state ----
const results = loadJSON(GEOCODES_PATH, {});
const misses = loadJSON(MISSES_PATH, []);
const missIds = new Set(misses.map((m) => m.id));

function persist() {
  saveJSON(GEOCODES_PATH, results);
  saveJSON(MISSES_PATH, misses);
}

function recordMiss(poi, reason) {
  if (!missIds.has(poi.id)) {
    misses.push({ id: poi.id, name: poi.name, address: poi.address ?? null, reason });
    missIds.add(poi.id);
  }
}

function recordHit(poi, lat, lng, src, q) {
  results[poi.id] = { lat, lng, src, q };
  if (missIds.has(poi.id)) {
    missIds.delete(poi.id);
    const idx = misses.findIndex((m) => m.id === poi.id);
    if (idx >= 0) misses.splice(idx, 1);
  }
}

let pending = targets.filter((p) => !(p.id in results) && !missIds.has(p.id));
log(`Pending after resuming from existing outputs: ${pending.length}`);

// ---- Step 0: camping fallback ----
let campingHits = 0;
for (const poi of pending) {
  const c = campingByPoiId.get(poi.id);
  if (c) {
    const zoneCenter = zonesById.get(poi.zone_id);
    if (sanityCheck(c.lat, c.lng, zoneCenter)) {
      recordHit(poi, c.lat, c.lng, 'camping', 'place');
      campingHits++;
    }
  }
}
log(`Camping fallback hits: ${campingHits}`);
persist();
pending = pending.filter((p) => !(p.id in results));

// ---- Step 1: Census batch geocoder for street_address kind ----
const censusCandidates = pending.filter(
  (p) => p.navigation?.address_kind === 'street_address' && p.address
);

function buildCensusRow(poi) {
  const addr = poi.address;
  const firstComma = addr.indexOf(',');
  let street = firstComma >= 0 ? addr.slice(0, firstComma) : addr;
  street = stripUnit(street);
  const city = poi.city || '';
  const state = poi.state || 'FL';
  let zip = poi.postal_code || '';
  if (zip) zip = zip.toString().split('-')[0];
  if (!zip) {
    const m = addr.match(/\b(\d{5})(-\d{4})?\b/);
    if (m) zip = m[1];
  }
  return [poi.id, street, city, state, zip];
}

async function censusBatch(rows) {
  const csvLines = rows.map((r) => r.map(csvField).join(','));
  const csvContent = csvLines.join('\n') + '\n';
  const blob = new Blob([csvContent], { type: 'text/csv' });
  const form = new FormData();
  form.append('benchmark', 'Public_AR_Current');
  form.append('addressFile', blob, 'addresses.csv');

  const res = await fetch('https://geocoding.geo.census.gov/geocoder/locations/addressbatch', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Census batch failed: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

if (censusCandidates.length > 0) {
  log(`Census candidates: ${censusCandidates.length}`);
  for (let i = 0; i < censusCandidates.length; i += CENSUS_CHUNK) {
    const chunk = censusCandidates.slice(i, i + CENSUS_CHUNK);
    const rows = chunk.map(buildCensusRow);
    log(`Census batch ${Math.floor(i / CENSUS_CHUNK) + 1}: ${chunk.length} rows`);
    let text;
    try {
      text = await censusBatch(rows);
    } catch (e) {
      log('Census batch error, will fall back to Nominatim for this chunk:', e.message);
      continue; // these ids remain in `pending` after this step, handled by Nominatim
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const byId = new Map();
    for (const line of lines) {
      const fields = parseCsvLine(line);
      byId.set(fields[0], fields);
    }
    for (const poi of chunk) {
      const fields = byId.get(poi.id);
      if (!fields) continue;
      const matchStatus = fields[2]; // Match / No_Match / Tie
      if (matchStatus !== 'Match') continue;
      const coordStr = fields[5]; // "lon,lat"
      if (!coordStr) continue;
      const [lonStr, latStr] = coordStr.split(',');
      const lon = parseFloat(lonStr);
      const lat = parseFloat(latStr);
      const zoneCenter = zonesById.get(poi.zone_id);
      if (sanityCheck(lat, lon, zoneCenter)) {
        recordHit(poi, lat, lon, 'census', 'interpolated');
      }
    }
    persist();
  }
}

pending = pending.filter((p) => !(p.id in results));
log(`After census: resolved=${Object.keys(results).length}, pending=${pending.length}`);

// ---- Step 2: Nominatim ----
let lastRequestTime = 0;
const NOMINATIM_MAX_RETRIES = 4;

async function nominatimSearch(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(
    query
  )}`;
  for (let attempt = 0; attempt <= NOMINATIM_MAX_RETRIES; attempt++) {
    const now = Date.now();
    const wait = NOMINATIM_DELAY_MS - (now - lastRequestTime);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestTime = Date.now();

    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA } });
    } catch (e) {
      log(`Nominatim fetch error (attempt ${attempt}):`, e.message);
      if (attempt === NOMINATIM_MAX_RETRIES) return null;
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }

    if (res.status === 429 || res.status === 503) {
      const retryAfterHeader = res.headers.get('retry-after');
      let backoffMs = 5000 * Math.pow(2, attempt); // 5s,10s,20s,40s,80s
      if (retryAfterHeader) {
        const secs = parseInt(retryAfterHeader, 10);
        if (Number.isFinite(secs) && secs > 0) backoffMs = Math.max(backoffMs, secs * 1000);
      }
      backoffMs = Math.min(backoffMs, 90000);
      log(`Nominatim ${res.status} for query: ${query} — backing off ${backoffMs}ms (attempt ${attempt + 1}/${NOMINATIM_MAX_RETRIES + 1})`);
      // consume body to free the connection
      try { await res.text(); } catch (e) { /* ignore */ }
      if (attempt === NOMINATIM_MAX_RETRIES) return null;
      await new Promise((r) => setTimeout(r, backoffMs));
      lastRequestTime = Date.now(); // count the backoff itself toward spacing
      continue;
    }

    if (!res.ok) {
      log(`Nominatim error ${res.status} for query: ${query}`);
      return null;
    }

    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr[0];
  }
  return null;
}

const CITY_TYPES = new Set([
  'city',
  'town',
  'village',
  'hamlet',
  'municipality',
  'county',
  'state',
  'administrative',
  'suburb',
  'borough',
]);

function classifyResult(r) {
  const type = r.type;
  const addresstype = r.addresstype;
  const cls = r.class;
  if (CITY_TYPES.has(type) || CITY_TYPES.has(addresstype)) return 'city';
  if (cls === 'building' || type === 'house' || addresstype === 'building' || addresstype === 'house')
    return 'rooftop';
  return 'place';
}

let nomIdx = 0;
const nomTotal = pending.length;
log(`Nominatim candidates: ${nomTotal}`);
for (const poi of pending) {
  nomIdx++;
  const zoneCenter = zonesById.get(poi.zone_id);
  const queries = [];
  if (poi.navigation?.search_query) queries.push(poi.navigation.search_query);
  if (poi.name) {
    queries.push(poi.city ? `${poi.name}, ${poi.city}, FL` : `${poi.name}, FL`);
  }
  if (poi.address) queries.push(poi.address);

  let hit = null;
  for (const q of queries) {
    if (!q) continue;
    let result;
    try {
      result = await nominatimSearch(q);
    } catch (e) {
      log('Nominatim fetch error:', e.message);
      continue;
    }
    if (!result) continue;
    const lat = parseFloat(result.lat);
    const lng = parseFloat(result.lon);
    if (sanityCheck(lat, lng, zoneCenter)) {
      hit = { lat, lng, q: classifyResult(result) };
      break;
    }
  }

  if (hit) {
    recordHit(poi, hit.lat, hit.lng, 'nominatim', hit.q);
  } else {
    recordMiss(poi, 'no strategy produced a sanity-checked match');
  }

  if (nomIdx % 20 === 0 || nomIdx === nomTotal) {
    log(`Nominatim progress: ${nomIdx}/${nomTotal}`);
    persist();
  }
}

persist();

// ---- summary ----
const bySrc = {};
const byQ = {};
for (const id of Object.keys(results)) {
  const r = results[id];
  bySrc[r.src] = (bySrc[r.src] || 0) + 1;
  byQ[r.q] = (byQ[r.q] || 0) + 1;
}
log('Done.');
log('By source:', JSON.stringify(bySrc));
log('By q:', JSON.stringify(byQ));
log('Total resolved:', Object.keys(results).length);
log('Total misses:', misses.length);
