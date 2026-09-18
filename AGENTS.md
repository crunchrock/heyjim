# Hey Jim: agent guide (same as CLAUDE.md)

Personal PWA for one user (iPhone 14 Pro, home-screen web app) who lives on the road in Florida: game dev + DoorDash, sleeps in the car, showers at Planet Fitness, works from waterfronts / cafés / Panera / libraries. The app plans days as **blocks** (water, café, office, deep work, DoorDash, gym+shower, car, meal, grill, travel, sleep…) and auto-picks the best real place for each block from researched **data packs**.

Live: https://crunchrock.github.io/heyjim/ (GitHub Pages, `main` branch, `/docs` folder). Repo is public; the data is not.

## Layout

```
packs/            PRIVATE, gitignored. Research data packs (JSON). Source of truth for places.
  florida_mobile_dev_agent_bundle_v3.json   first pack (536 places, 40 zones)
  _profile.json   private user profile (name for mail, lifestyle context). Not a pack.
build/
  build.mjs       packs → slim JSON → gzip → AES-GCM encrypt → docs/data.enc; icons; bumps sw.js VERSION
  packs.mjs       loads + merges packs (by id, later filename wins)
  geocode.mjs     fills missing coordinates → build/geocodes.json (Census batch, then Nominatim ≤1 req/s)
  secret.json     PRIVATE, gitignored. {"password", "salt"}. Keep the salt stable or the phone gets logged out.
  test/smoke.mjs  headless test: decrypts data.enc and exercises core.js planner logic
docs/             the published site (this folder IS the website — not documentation)
  index.html, styles.css
  core.js         logic: storage, crypto, hours parsing, sun times, ranking (rank), block types (BT),
                  templates, multi-day planner (S.days, newDay, flow, dayOrigin, blockWarnings), directions, weather
  app.js          UI: tabs (Today / Map / Places / Week), bottom sheets, click delegation (data-a → A.*, data-c → C.*)
  sw.js           offline cache; VERSION rewritten by build
  data.enc        encrypted dataset (safe to publish)
DATA_PACKS.md     schema + research prompt for new packs (ChatGPT Pro workers)
```

## Commands

```bash
node build/geocode.mjs        # only when new packs add places without coordinates (slow: Nominatim 1 req/s; run ONE instance)
node build/build.mjs          # always after changing packs/ or docs/*
node build/test/smoke.mjs     # sanity check
git add -A && git commit -m "..." && git push   # Pages redeploys in ~1 min; phone picks it up on next open
```

Never commit `packs/`, `build/secret.json`, or `build/geocodes.json` (see .gitignore). Never print the password into committed files.

## How the app works (read before changing it)

- **Security model**: intentionally light. Data is PBKDF2(310k)+AES-GCM encrypted; the app shell is public. After the first unlock the derived key is kept in localStorage, so the device stays unlocked. "Lock app" in Week › Backup clears it.
- **User state** (`S`, localStorage `hj.state`): settings, `days` (date → {startMin, blocks[]}), `log` (time/dash entries), `obs` (append-only place notes), `nights` (sleep rotation), `last` (upkeep timestamps), `fav`, `avoid`, `supplies`, `workout` index. It lives only on the phone; Export/Import in Week tab.
- **Blocks**: `BT` in core.js defines each block type: matcher `m(poi)`, bonus `b(poi)`, default duration, what it logs. `rank(type, {from, at, dur})` scores places by distance, hours fit at that time, evidence (Confirmed / Reported / Unconfirmed), user notes/favorites, and sleep rotation. `flow(day, assign)` walks a day: timing (clamped to now for today), drive legs, auto-assign places, and warnings (closed, gate closes at sunset, outside DoorDash windows, slept here recently).
- **User's planning rules (from his feedback, keep them)**: work sessions are 2–4h (2h minimum); he works at the water (laptop battery + hotspot + inverter) and from the car in the evening ("Car office" at tonight's spot, after gym/shower); Water work and Car office count as dev time. Panera, library and café are NOT interchangeable: never silently swap venue types; if none is within 15 mi leave the block empty with "No X within 15 mi (nearest …)" and let him pick an alternative. Each indoor work venue at most once a day; everyday blocks stay local (`LOCAL_T`). Never auto-plan inhumane days (e.g. 8h at a library). "Dev session" is activity-first: a grouped picker of work spots (`DEV_KINDS`).
- **Libraries are never favored** (DEV_KINDS bonus −6, "Library day" never recommended); he picks them occasionally himself. Dev sessions in templates rotate kinds of spots (water / café / Panera / restaurant / PF-lot car office) and never repeat a place in a day.
- **Night spot = recon workflow**: the sleep block holds `recon` targets (`{poi, st: todo|good|bad, why[]}`), auto-seeded with 3 nearest of different lot kinds (`pickRecon`), preferring places open all night tonight (`nightChip`). He scouts ("Recon next" navigates to nearest unchecked), then ✓ confirms (sets `poi`, `confirmed`, logs the night for rotation) or ✗ marks bad with reasons (saved as place observations that down-rank it later). "Confirm" skips recon.
- **Editing**: block cards have × (delete, undo toast), a ⋮⋮ drag handle (pointer-event reorder), and an inline −/+ duration stepper.
- **Days**: today starts at GPS (or a chosen "planning" zone); future days start from the previous day's last stop (usually the sleep spot). Day key rolls over at 4am.
- **Hours**: per-day strings `"HH:MM-HH:MM"`, `;` for split ranges, overnight like `16:00-02:00`, tokens `sunrise|sunset|dawn|dusk|daylight`, `closed`, or null = unknown (never treated as open or closed). Central-time zones via `ct`.
- **Directions**: `navigate([...])` → Google Maps app URL scheme (`comgooglemaps://?daddr=A+to:B+to:C`) for multi-stop, or web/Apple Maps per setting. Destinations use "name, address" strings, not coordinates.
- **Coverage**: if GPS is >45 mi from every zone the app says so and offers a copyable research prompt (`packPrompt`) for a new pack.
- Style: vanilla JS, no framework, no build step for the UI. Compact code, template-string rendering, CSS variables with light/dark themes (auto by sunrise/sunset). Design brief from the user: Airbnb-like, calm warm daytime theme, dark at night, **no decorative accent lines/borders**.

## Adding data (the usual future task)

1. Put the new pack JSON in `packs/` (see DATA_PACKS.md for the contract). Later files override earlier ones by `id`.
2. `node build/geocode.mjs` if its places lack coordinates, then `node build/build.mjs`, `node build/test/smoke.mjs`.
3. Spot-check a new zone in the app (Places tab lists zones in route order), commit, push.
