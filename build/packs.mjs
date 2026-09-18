// Loads every data pack in packs/*.json (sorted by filename) and merges them into one bundle.
// Collections merge by `id` (later files override earlier ones), so a pack can add new places
// or correct existing ones. Files starting with "_" are not packs (e.g. _profile.json).
import fs from 'node:fs';
import path from 'node:path';

export const COLLECTIONS = ['zones', 'pois', 'capabilities', 'overnight_candidates', 'camping', 'mail_options', 'recreation',
  'food_options', 'meal_offers', 'doordash_markets', 'operating_clusters', 'planning_actions', 'research_gaps', 'sources', 'policies'];

export function loadPacks(root) {
  const dir = path.join(root, 'packs');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort();
  if (!files.length) throw new Error('No packs found in ' + dir);
  const out = { manifest: {}, packs: [] };
  const maps = Object.fromEntries(COLLECTIONS.map(c => [c, new Map()]));
  for (const f of files) {
    const b = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const c of COLLECTIONS) for (const r of b[c] || []) {
      const k = r.id ?? JSON.stringify(r), prev = maps[c].get(k);
      // upsert: a later pack's non-null facts win, but it never erases known facts with null
      if (prev && typeof prev === 'object') {
        const merged = { ...prev };
        for (const [f, v] of Object.entries(r)) if (v != null && !(Array.isArray(v) && !v.length && prev[f]?.length)) merged[f] = v;
        if (prev.source_ids && r.source_ids) merged.source_ids = [...new Set([...prev.source_ids, ...r.source_ids])];
        maps[c].set(k, merged);
      } else maps[c].set(k, r);
    }
    if (b.manifest) {
      out.manifest.version = b.manifest.version || out.manifest.version;
      out.manifest.research_date = [out.manifest.research_date, b.manifest.research_date].filter(Boolean).sort().pop();
      if (b.manifest.route_visit_sequence) out.manifest.route_visit_sequence = b.manifest.route_visit_sequence;
      if (b.manifest.optional_inland_zone_ids) out.manifest.optional_inland_zone_ids = [...(out.manifest.optional_inland_zone_ids || []), ...b.manifest.optional_inland_zone_ids];
    }
    out.packs.push(f);
  }
  for (const c of COLLECTIONS) out[c] = [...maps[c].values()];
  // poi_patches: [{id, ...fields}] shallow-merge fields into an existing place (e.g. add ratings/prices)
  const byId = new Map(out.pois.map(p => [p.id, p]));
  for (const f of files) {
    const b = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const pt of b.poi_patches || []) { const p = byId.get(pt.id); if (p) Object.assign(p, { ...pt, id: p.id }); }
  }
  const profPath = path.join(dir, '_profile.json');
  out.profile = fs.existsSync(profPath) ? JSON.parse(fs.readFileSync(profPath, 'utf8')) : {};
  return out;
}
