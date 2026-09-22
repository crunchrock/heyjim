# Hey Jim: guide for agents working on this project

Hey Jim is a personal iPhone home-screen web app (PWA) for one user, "Crunch". He lives out of his car (Acura MDX) on the Florida coast. He's an indie game developer who also DoorDashes, showers at Planet Fitness, and works from waterfronts, cafés, kava bars, Panera and his car. The app plans his days as **blocks** (water work, café, dev session, DoorDash, gym + shower, meals, travel, night spot…). It picks real places for each block from researched **data packs**: open at that time, close by, and cheap and good. It then hands the route to Google Maps.

- Live app: https://crunchrock.github.io/heyjim/ (GitHub Pages serves `main:/docs`). This repo is **public**; the data is encrypted.
- His synced state (plans, notes, logs) lives in the **private** repo `crunchrock/heyjim-data`: `state.json` (plans, notes, logs, his own places), `activity/<date>.json` (usage events, errors, GPS breadcrumbs, classified stays: one file per day, for analyzing how he uses the app), and `pings/<yyyy-MM>/*.txt` (car on/off pings from his iPhone Shortcut; the file name is the data).
- Everything runs from this folder on his Windows PC (Node 24, Git Bash, `gh` logged in as crunchrock).

## Golden rules

1. **Never commit** `packs/`, `build/secret.json`, `build/geocodes.json`, or `build/test/ui/out/` (all gitignored). Never write the password or the sync token into tracked files, commit messages or chat output.
2. **Keep `salt` in `build/secret.json` stable.** Changing it logs his phone out.
3. **Never hand-edit `state.json` (or `activity/`, `pings/`) in heyjim-data**, and never let a test touch it. Tests disable sync (`D.sync = null`) and the UI harness blocks `api.github.com`.
4. **Respect his planning rules** (next section). They came from direct, repeated feedback.
5. Before pushing, always run: `node build/build.mjs && node build/test/smoke.mjs`. After pushing, his phone gets the update on the next open-close-open (service worker).
6. Honest data only: unknown stays `null`. Never invent ratings, prices, hours or specials.

## His planning rules (don't regress these)

- **Work sessions are 2–4h** (2h minimum), and the work stepper moves in 30 min steps. He works at the water (laptop battery + hotspot + inverter), in cafés, kava/tea bars, B&N/Books-A-Million cafés and Panera (outlets + Sip Club), and in the evening from the car at his night spot. Water work, Car office, Agentic chill session and Bedtime dev all count as dev time.
- **Never auto-plan an inhumane day** (e.g. 8h at a library). Libraries are penalized and never recommended; he picks them himself occasionally. An auto-built day uses each indoor venue at most once and rotates kinds of spots.
- **Venue types are not interchangeable.** Panera ≠ library ≠ café. Never silently swap one for another. If none exists within 15 mi, leave the block empty with "No X within 15 mi (nearest: …)" and offer buttons (another type / "Drive to it anyway").
- **Everyday blocks stay local.** A day stays in its zone until a Travel (or Storage) block moves it.
- **Today follows him; future days follow the plan.** Today, the first unfinished block starts from his live GPS and that becomes the day's area: when he drives somewhere new, today's auto-picked places that are now far away get re-picked around him (`reanchor()` on every GPS move of 3+ mi, with a toast), and blocks he adds or changes are picked around where he is. Places he pinned stay, with a warning and a "Pick one near me" button. Future days are built logically from their own plan (the previous day's last stop / tonight's spot, Travel blocks) and are never re-picked because his GPS moved. He asked for exactly this split.
- **Never let the app get stuck in an old area.** "Plan as if I'm in zone X" expires after 12 hours. A stale GPS fix shows its age in the location button.
- **Night spot = recon, but flexible.** Offer several spots of different kinds (Walmart, PF, Cracker Barrel, truck stop, hotel lot, camping) sorted by distance, with tonight's overnight hours. He scouts, then confirms ✓ or marks ✗ with reasons. Bad marks down-rank that spot later. Recon targets left in another town are re-picked when he moves. He can always one-tap "I'm parked here for the night" (known spot → confirmed; unknown → save it first) or add any spot that isn't listed (hotel lots like Home2 Suites).
- **He can add any place himself.** Places tab ＋ Add / "Not listed?" buttons / Today's "📍 This spot isn't in the app": OpenStreetMap search (Photon) or "what's around me", then pick a kind (`MINE_KINDS`). They live in `S.mine` (synced), become `u_<id>` POIs at runtime, and work everywhere (ranking, recon, lists). Fold them into a pack on the next "rebuild with my notes".
- **Food:** cheap and highly rated beats fancy. Asian gets a nudge; $$$ is flagged "Pricey". Guy Fieri's Diners, Drive-ins and Dives places (tag `ddd`) get a nudge and the flame-with-shades "Guy's pick" chip. He's from Columbus, Ohio: cult chains (Skyline, Donato's, White Castle, Raising Cane's, Krystal…, tag `crave`) and quirky one-offs (tag `quirky`) have a Cravings list; local gem dine-in pizza (Hound Dog's is his reference) has a Pizza block/list. **Trail runs:** wild, rugged and scenic over urban (Trail run block, `trail` details). **Natural wonders:** only the best springs, sinkholes, waterfalls. **Tony's picks** (tag `bourdain`, chef's-knife chip) are Anthony Bourdain's places. **Buffets** show their lunch/dinner/weekend price right on the row (`buffet` object, with price date + source).
- **Movies:** he's an AMC Stubs A-List member (a few free movies a week; setting `alist`, counted on the Week tab). AMC first, then Epic Theatres, and he loves drive-ins. Live showtimes can't be fetched from the phone (amctheatres.com blocks bots; Epic uses an encrypted API), so every theater has a one-tap "Showtimes" link to its own page (`theater.showtimes_url`). Arcades/barcades yes, Dave & Buster's-type chains no. Goth bars / clubs / nights have their own list.
- **Let him verify anything.** Every place sheet shows "Unsure? Check the source ↗" (first cited source, else website, else Google Maps), and specials / buffet prices / TV features link their own source with posted + checked dates. Unknown hours link to the site to check. **Bars:** Mon–Thu surface dated specials, Fri/Sat any good dive bar, never Sunday night. Ladies' nights and gentlemen's clubs (`strip_club`) have their own lists; a Bar night block never auto-picks a club. **Groceries:** Trader Joe's > Sprouts/Publix > Walmart > Whole Foods. **Gas:** Murphy USA first.
- **Design:** Airbnb-like, calm warm daytime theme, dark at night (auto by sunset). **No decorative accent lines or borders.** Keep it uncluttered; effectiveness beats polish.

## Layout

```
packs/                     PRIVATE (gitignored). Source of truth for places.
  florida_mobile_dev_agent_bundle_v3.json   base research (40 zones)
  2026-09-18-*.json        added packs (gap-fill, overnight, cheap eats, bars, groceries/vape, gas/malls, gaps, vape, corrections)
  _profile.json            private profile: name for mail, lifestyle context (used in research prompts), private places (storage unit)
  _RESEARCH_PROMPT_gaps.md ready-to-paste ChatGPT Pro prompt template for filling gaps
build/
  build.mjs                packs → slim JSON → gzip → AES-GCM encrypt → docs/data.enc; icons; bumps sw.js VERSION
  packs.mjs                loads and merges packs (field-level upsert by id; poi_patches)
  geocode.mjs              fills missing coordinates → build/geocodes.json (Census batch, then Nominatim ≤1 req/s; lock file = one instance)
  secret.json              PRIVATE: {password, salt, sync_token, sync_repo}
  test/smoke.mjs           decrypts data.enc, exercises the planner (run before every push)
  test/scan.mjs days.mjs night.mjs food.mjs   planner quality probes: print what the app would pick at real places and times
  test/ui/                 screenshot harness for the real UI at iPhone size (see Testing)
docs/                      THE WEBSITE (not documentation). No build step for UI code.
  index.html styles.css    shell + CSS variables (light/dark)
  core.js                  logic: storage, sync, crypto, geo, sun, hours, ranking, block types, templates, planner, directions, weather
  app.js                   UI: tabs Today / Map / Places / Week, bottom sheets, click delegation
  sw.js                    offline cache (VERSION rewritten by build)
  data.enc                 encrypted dataset (safe to publish)
DATA_PACKS.md              the data-pack contract (fields the build reads)
README.md                  human overview
```

## Common jobs

### Add a data pack (the most common request)
1. Save the pack JSON in `packs/`, named to sort after existing packs (e.g. `2026-10-02-georgia-coast.json`). Validate it first: it parses, ids are unique, every `source_id` and `poi_id` resolves, `zone_id`s exist (or the pack adds the zone), and the hours syntax is valid. The validation snippet used for the gaps pack is in git history; write your own if needed.
2. `node build/geocode.mjs` (resumable; skips known ids; can take minutes because of Nominatim throttling).
3. `node build/build.mjs && node build/test/smoke.mjs`, then spot-check with `node build/test/food.mjs meal`, `night.mjs`, `days.mjs`, or the UI harness.
4. Commit and push. Merge semantics: same `id` in a later pack **upserts** (non-null fields win; nulls never erase known facts; `source_ids` union). `poi_patches: [{id, ...fields}]` patches existing places without restating them.

### Research new data
- **New area:** the app's Places tab → "Need an area that isn't here?" copies a research prompt (`packPrompt` in core.js, including his private context) for ChatGPT Pro deep research. It also appears automatically when his GPS is more than 45 mi from every zone.
- **Gaps in covered areas:** adapt `packs/_RESEARCH_PROMPT_gaps.md`.
- **Claude research agents:** give each agent exactly one output file, allow at most 2–3 sub-agents, and have only the parent write the file (parallel forks once raced on the same file). WebSearch has a per-session budget that runs out. Google Maps, Yelp and YellowPages block automated fetches. What has worked: official chain locators, OpenStreetMap (Photon `photon.komoot.io`, Nominatim ≤1 req/s; Overpass was unreachable), restaurantji/TripAdvisor mirrors, and official bar/restaurant sites for dated specials.

### Reconcile his synced data ("rebuild with my notes")
`gh api repos/crunchrock/heyjim-data/contents/state.json --jq .content | base64 -d` gives his state. Useful signals: `obs` (place notes and tags, including night-spot recon failures like `signs`, `security`, `noparking`, plus `cheap`/`good`/`view`), `fav`, `avoid`, `nights`, `wishes` (areas he asked about), and `mine` (places he added: turn each into a real POI with a proper id, research its facts, and add it to the pack). Items with `del` are tombstones (removed; ignore them). Fold durable facts into a new `packs/<date>-from-user.json` as `poi_patches` / `pois`. Never write state.json.

### Analyze how he uses the app ("look at my activity")
`gh api repos/crunchrock/heyjim-data/contents/activity --jq '.[].name'` lists the days; each `activity/<date>.json` has `ev` (every tap: `{t, e:'tap', a:<action>, t/id/…}`, tab switches, opens/hides, add-place, and **errors** `{e:'err', m, s, c}`), `pts` (GPS breadcrumbs while the app was open: `{t, t2, lat, lng}` = a stay from t to t2), `pings` (car on/off) and `visits` (stays the app classified: gym / night / dev / water / meal / dash asks). Start any bug-fix session by grepping recent `err` events.

### Add a feature or block type
1. **Block type:** add an entry to `BT` in core.js: `{ n, ic, dur, m(poi) matcher, b(poi, at) bonus, caps, hint, log?, night?, alts? }`. Placeless blocks omit `m`. `night: 1` means the block happens at tonight's night spot. `log` can be `'dev' | 'water' | 'car' | 'gym' | 'dash'` or an array.
2. Add it to the `PALETTE` groups in app.js. Optionally add it to `findHtml` pills, the Places `cats`, `MAP_FILTERS`, and the sets `LOCAL_T` (stays near the day's area), `WORK_T` (indoor work venue), `WORK_BLOCKS` (30 min stepper).
3. If it's a new kind of work spot, add it to `DEV_KINDS` (order = display order; the last number is the ranking bonus).
4. Run the probes and screenshots, then build, smoke, push. Update this file if you add a rule he asked for.

### Research agents: brief + validator
Copy `packs/_RESEARCH_BRIEF.md` (private: his context, the pack schema, sources that work) and `build/validate-pack.mjs` into the agent's folder and give each agent one output file, a source-id prefix, and uniquely prefixed helper-script names (parallel agents in one folder overwrote each other's `build_pack.mjs`). **WebSearch has one budget shared by every agent in the session**; it ran out mid-run with 12 agents, and the rest worked fine from WebFetch + curl (Photon/Nominatim, restaurantji, official sites). Before importing, scan for admitted guesses ("typical hours", "pattern", "assumed") and null those fields. planetfitness.com, raisingcanes.com, Google/Yelp block fetches; `locations.raisingcanes.com/fl` works.

## How it works

**Data pipeline.** `packs.mjs` merges all packs. `build.mjs` then:
- slims every POI to short keys: `n` name, `c` category, `sc` subcategory, `a` address, `h` hours [Sun..Sat], `ct` Central time, `caps` {cap: d|r|i evidence}, `am` amenities, `wf` waterfront facts, `fv` food value, `bd` bar details, `sp` specials, `x` extras incl. `kratom`/`laptop`;
- attaches overlays keyed by poi: `ovn` overnight, `camp`, `mail`, `rec`, `food`; plus `dd` DoorDash markets, `zones`, `sources`, `profile`, and `sync` settings;
- injects private places from `_profile.json`;
- then gzips, encrypts (PBKDF2-SHA256 310k + AES-GCM) and writes `docs/data.enc`.

**Runtime** (`core.js`, then `app.js`):
- *Unlock.* On the first password entry the derived key is kept in localStorage, so the device stays unlocked. "Lock app" in Week clears it.
- *Ranking.* `rank(type, {from, at, dur, anchor, avoid, adj, maxMi})` scores places. Inputs: distance (closer strongly preferred, hard cap 45 mi by default), whether it's open for the block's time window (`fit` / `hoursState`: tz-aware, sunrise/sunset tokens, overnight ranges), evidence, the block's bonus, favorites and his notes (`obsScore`), and anchor distance.
- *Days.* `S.days[date] = {startMin, blocks[]}` (a cleared day is a tombstone `{del}`; always use `getDay` / `ensureDay`), where a block is `{id, t, dur, st plan|active|done|skip, poi, pinned, at (pinned start), recon[] (sleep), toZone (travel), auto}`. `flow(day, assign)` walks a day: times (clamped to now for today), drive legs, the live-GPS anchor for today, auto-assignment (`'missing'` also re-picks stale far-away auto picks; `'all'`), variety rules, the 15 mi locality rule, and warnings with actions (`r.acts`, e.g. `repick`, `nightNear`, `addPlaceFor`). Future days start from the previous day's last stop. The day key rolls over at 4 am. `sanitize()` runs on every start/sync/resume and repairs state (unknown block types, duplicate ids, one night spot per day kept last, blocks left running on a past day closed and logged as auto). `completeBlock()` is the single place that marks a block done and logs it.
- *Auto-tracking.* `ACT` (localStorage `hj.act`) holds breadcrumbs, pings, events and classified stays. `stays()` merges GPS crumbs and car off→on pings; `classifyStay()` maps a stay at a place to gym / night / dev / water / run / laundry / meal; `autoTrack()` marks the matching planned block done with the real times (or inserts a done block) and logs it; quick restaurant stops in a row become a "Log this DoorDash run?" ask; an overnight stay at an unknown spot becomes "Save it?". `arriveLeave()` starts the next block when he's at its place and ends the running one when he's left (only if he was actually there). iOS web apps get no background GPS; the car automation (Week → Auto-tracking → Set up car tracking) is what makes tracking complete. A native app with CLVisit would be the next step if he wants more.
- *TV-only zone.* `south-florida` (`tv: 1`) holds only Guy's / Tony's picks and far drive-ins. `nearestZone()` skips TV zones, so it never counts as everyday coverage (the new-area research prompt still appears there).
- *Errors.* `render()`, `drawSheet()` and every action are wrapped: a bug shows a recoverable card / toast instead of freezing, and is logged (`logError`) to the activity file. Mutating taps ignore an identical repeat within 600 ms. A startup error never deletes the saved key.
- *Templates.* `TEMPLATES` specs look like `"type:minutes@HH:MM"`. `newDay` trims templates to the hours left; `tplScore` ranks them by time of day and local availability.
- *Night spots.* `pickRecon`, `nightOptions` and `nightChip` pick and label candidates; `lotKind` / `LOT_TYPE` give the lot type.
- *Directions.* `navigate([...])` builds a `comgooglemaps://?daddr=A+to:B` multi-stop link (or web / Apple Maps per his setting) from "name, address" strings.
- *Weather and alerts.* Open-Meteo plus NWS alerts, cached; `wxInsights` gives car-sleeping and heat tips.

**Sync.** `save()` stamps `S.updatedAt` and calls `syncSoon()`, which runs a PUT to heyjim-data about 15 s later (and right away when the app goes to the background). The app pulls on open. `mergeState` unions the append-only lists (`obs`, `log`, `nights`, `wishes`) by id, and on a 409 it pulls, merges and retries. `loc` is never committed. The token is a fine-grained PAT with Contents R/W on heyjim-data only, stored in `build/secret.json` and shipped only inside `data.enc`.

**UI** (`app.js`). Click delegation: `data-a="name"` runs `A.name(dataset)`, and `data-c` routes change events to `C.name`. `render()` redraws the current tab. Sheets are a stack (`openSheet(fn)` / `closeSheet`). Timeline cards have × (delete + undo), a ⋮⋮ drag handle (pointer events), an inline −/+ stepper, amenity icons (🚻 🅿️ 📶 🔌 from `amenIcons`) and warnings with Fix / switch-type buttons.

## Testing

- `node build/test/smoke.mjs`: must pass before every push.
- `node build/test/move.mjs`: "the plan follows me" regression (Ormond → St. Augustine re-picks, pinned warning, tomorrow untouched, one night spot, tombstones survive merges, car pings → auto-tracked gym). Run it too before pushing.
- Probes (read-only; sync disabled):
  - `node build/test/days.mjs "Name:lat:lng,..." "tpl1,tpl2" [startHour]`: auto-built days
  - `night.mjs`: recon picks
  - `food.mjs <type>`: top picks for any block type
  - `scan.mjs`: picks across towns and times
- UI screenshots at 390×844: `node build/test/ui/mk.mjs` (after each build), then `build/test/ui/shot.sh <name> "reset=1&lat=..&lng=..&tpl=balanced&do=block&i=2"` (`do=act&name=<action>` opens any sheet, e.g. `addPlace&around=1`, `trackSetup`). Set `PORT=` to a free port if another session's test server holds 8787: an old server silently serves old code. The PNG lands in `build/test/ui/out/`, and the query options are listed at the top of `shot.sh`. Headless Chrome's virtual clock can't finish real network calls; that's expected.

## Gotchas learned the hard way

- Five inland zones have no researched center; `build.mjs` computes centroids (with fallbacks). Code must never treat a null lat as 0 (that once rejected every geocode).
- Run only ONE `geocode.mjs` at a time (Nominatim will 429). Census batch handles most street addresses.
- Test VMs must set `D.sync = null`, or the sync timer keeps Node alive and could write to his repo.
- Old saved days survive upgrades. `migrate()` in app.js re-plans them when rules change: bump `S.ver` and add the migration.
- Windows CRLF warnings on commit are harmless. The Edit tool can save files with CRLF on this PC; scripts that patch files by exact string should normalize `\r\n` first. `comgooglemaps://` multi-stop links are untested on a real iPhone; the Week settings let him switch to Google web.
- QuikTrip has almost no Florida presence (the first store opened near Tallahassee in 2026). Buc-ee's prohibits overnight parking. Rest areas have a 3-hour limit.
