# Data packs

A data pack is one JSON file in `packs/` (private, gitignored) using the schema of `florida_mobile_dev_agent_bundle_v3.json`. `build/packs.mjs` merges all packs in filename order, so name new ones to sort last (`2026-10-02-georgia-coast.json`). Files starting with `_` are not packs.

**Merge rules.** A record whose `id` already exists is **upserted**: non-null fields from the later pack win, nulls never erase known facts, and `source_ids` are unioned. To change a few fields of an existing place without restating it, use `poi_patches: [{ "id": "...", ...fields }]` (fields overwrite, except `tags`, `amenities` and `source_ids`, which add up).

**Where packs come from.** ChatGPT Pro deep research, using the app's copyable prompt (Places → "Need an area that isn't here?") or `packs/_RESEARCH_PROMPT_gaps.md`, or Claude research agents (see CLAUDE.md → Research new data). Then run `node build/geocode.mjs && node build/build.mjs && node build/test/smoke.mjs`, commit and push.

## Rules for every pack

- Real, currently open places only. `null` = unknown. Never write `false` or `0` for "not researched", and never invent ratings, prices, hours or specials.
- Every POI has a street address and `navigation.search_query` ("Name, street, city, FL zip"). Directions work without coordinates; the geocoder fills them in.
- Ids are unique and stable: zones in kebab-case, POIs `"<zone_id>_<slug>"`, capabilities `"<poi_id>__<capability>"`, overnight records `"<poi_id>_overnight"`. Every `source_ids` entry resolves to `sources[]`.
- Every POI has at least one capability. Hours are honest and per day; note gates that close at sunset.

## Fields the build reads

Top-level arrays: `zones`, `pois`, `capabilities`, `overnight_candidates`, `camping`, `mail_options`, `recreation`, `food_options`, `meal_offers`, `doordash_markets`, `sources`, `research_gaps`, `poi_patches`, plus `manifest {version, research_date}`. Everything else is kept for provenance but ignored.

**zones[]**: `id`, `name`, `region`, `center {latitude, longitude}` (optional; otherwise the centroid of its located places), `route_order`, `timezone` (`America/New_York` | `America/Chicago`), `recommended_stay_days {min, max}`, `best_for[]`, `weaknesses[]`, `recommended_*_ids[]` (researcher picks), `navigation_query`.

**pois[]**: `id`, `zone_id`, `name`, `category`, `subcategory`, `address`, `city`, `state`, `postal_code`, `latitude/longitude` (optional), `website`, `phone`, `hours {monday..sunday}`, `amenities[]`, `tags[]`, `traveler_notes`, `parking {free, notes}`, `operational_status` (listed_by_source | temporarily_closed | announced_not_open | current_status_unverified), `recommended_use_status` (candidate | known_unavailable), `truly_24_7`, `hours_exceptions[]`, `schedule_warning`, `waterfront_details.amenity_support_score`, `navigation.search_query`, `source_ids[]`. The optional objects are below.

| category | subcategories the app understands |
|---|---|
| waterfront | park, beach_lot, boat_ramp, pier (anything; waterfront = water spot) |
| work | library, independent_cafe, regional_cafe, chain_cafe (Panera is detected by name), kava_bar, tea_house, bookstore_cafe |
| food | local_cheap, pizza, diner, bbq, fast_food, steakhouse, ramen_restaurant, buffet, mall, walmart_supercenter, trader_joes, publix, sprouts, whole_foods, grocery |
| social | dive_bar, hipster_dive, barcade, craft_beer, cocktail_bar, live_music, strip_club (own Clubs list; never auto-picked for a Bar night) |
| gym | planet_fitness |
| overnight_candidate | hotel, walmart, cracker_barrel, truck_stop, rest_area, outdoor_retailer, casino |
| shop | vape_shop, smoke_shop |
| life_support | laundromat, travel_center, murphy_usa, circle_k, quiktrip, bucees |
| fun | used_bookstore, trailhead, nature_preserve, state_park, state_forest, greenway, spring, sinkhole, waterfall, cave, flea_antique_market, … |
| camping, car_maintenance (parts_store), mail | as in the base pack |

Hours strings: `"07:00-21:00"`, split ranges `"11:00-14:30;17:00-22:00"`, overnight `"16:00-02:00"`, sun tokens (`"sunrise-sunset"`, `"dawn-23:00"`, `"daylight"`), `"closed"`, or `null` if unknown. `"00:00-24:00"` means open 24h.

**capabilities[]**: `id`, `poi_id`, `zone_id`, `capability`, `evidence_level` (documented | reported | inferred; shown as Confirmed / Reported / not shown), `assessment_note`, `conditions[]`, `source_ids[]`. Capabilities the app uses: `work_indoor, work_outdoors, wifi, gym, shower, sleep_candidate, tent_camp, paid_lodging, meal, protein_food, ramen, buffet, all_you_can_eat, groceries, daily_supplies, buy_drinking_water, water_source_candidate, laundry, mail, auto_parts, repair_support, auto_service, loan_tools, public_grill, restroom, restroom_candidate, recreation, fuel, vape, trail_run, swim`.

**Optional POI objects**
- `food_value` (ratings for ANY place type): `{cuisine, asian, price_level 1–4, typical_meal_usd, rating, rating_count, rating_source, rating_checked, known_for_cheap, cheap_evidence}`. Meals rank by value: a high rating, being cheap, and "known for cheap" all win; Asian gets a nudge; $$$ is flagged "Pricey".
- `specials` (alias `bar_specials`; `label` + `items` required, a `description` field is not read; `date: "YYYY-MM-DD"` instead of `days` for a one-off event; no days = every day): `[{label, days: ["tuesday",…], start "HH:MM", end "HH:MM", items: ["$5 Old Fashioned"], posted_date (when the source set or updated it), checked_date, confidence: official|social_post|third_party|review_mention, source_id}]`. Used for bar happy hours and meat-deal nights. The app shows the posted and checked dates.
- `bar_details` (bars): `{kind, vibe, games, food, price_level, rating, rating_count, rating_source}`.
- `work_details` (cafés, kava, tea): `{wifi_advertised, outlets_confirmed, laptop_friendly, sells_kratom}`. `sells_kratom: true` hides the place from work spots.

- `ddd` (Guy Fieri's Diners, Drive-ins and Dives; add tag `ddd`): `{season, episode, episode_title, air_date, dishes[], still_open, status_checked, status_evidence, source_id}`. Shown as "Guy's pick".
- `trail` (trail runs; add tag `trail_run` + capability `trail_run`): `{miles, loops[], surface, terrain rugged|rolling|flat, scenery, shade, parking, fee, hours_note, hazards, rating, rating_count, rating_source, why}`. Rugged, dirt and well-rated rank first.
- `wonder` (natural wonders; tags `wonder` + the kind): `{kind waterfall|sinkhole|spring|cave|river|overlook, why, swim, fee, best_time}`.
- `brand` (top level, chains) and tags `crave` (cult chains) / `quirky` (one-of-a-kind spots) / `pizza`, `local_gem`, `dine_in`, `late_night` / `strip_club`. A special labeled "Ladies' night" lands in the Ladies' nights list.
- Places researched twice under different ids (same name, same street or within ~200 m) are merged by the build; the dropped id becomes an alias so saved plans still resolve.

**overnight_candidates[]**: `poi_id`, `type` (walmart | planet_fitness | cracker_barrel | truck_stop | hotel_cluster | rest_area | outdoor_retailer | casino | public_lot), `status` (uncertain | mixed_reports | prohibited), `gray_area`, `permission_status`, `confidence`, `notes`, `field_check[]`, `tow_reports`, `security_knock_reports`, `open_24h_nearby`, `assessment {priority: inspect_first | alternative | extra_friction | not_for_auto_selection, rationale}`, `reports[]`, `latest_report_date`.

**camping[]**: `poi_id`, `land_manager`, `cost`, `reservation_required`, `reservation_url`, `vehicle_access`, `sleeping_rules`, `stay_limit`, `road_condition`, `vehicle_sleeping_status`, `amenities[]`, `notes`, `alerts[]`, `latitude/longitude`.

**mail_options[]**: `poi_id`, `service_type`, `general_delivery_listed`, `general_delivery_confirmed`, `carrier_hold_confirmed`, `physical_office_zip`, `phone`, `address_template`, `contact_prompt`, `general_delivery_pickup_hours`.

**recreation[]**: `poi_id`, `activities[]`, `suggested_duration_minutes {min, max}`, `entry_cost`, `notes`, `alerts[]`, `reservation_url`.

**food_options[] / meal_offers[]**: `food_options {id, poi_id, primary_food_kind, has_ramen, is_buffet, is_all_you_can_eat, menu_examples[], menu_url, cost_summary.min_documented_complete_meal_base_usd}`; `meal_offers {food_option_id, label, food_kind, price {amount, unit}, service_channel}`.

**doordash_markets[]**: `id`, `zone_id`, `name`, `recommended_windows[]` ("11:00-14:00"), `avoid_windows[]`, `target_subzones[] {name, poi_id}` (the hotspots the DoorDash block sends him to), `scores.overall`, `confidence`, `advantages[]`, `problems[]`, `demographics.median_household_income_usd`, `window_basis`.

**sources[]**: `id`, `url`, `title`, `publisher`, `retrieved_date`, `published_date` (optional).

## Private profile (`packs/_profile.json`)

Not a pack. Its fields:
- `name`: for General Delivery addresses.
- `project`: his game.
- `context`: lifestyle text inserted into research prompts.
- `places[]`: private places such as his storage unit, `{id, kind, name, address, city, search_query, lat, lng, website, notes}`. The build turns them into `me_<id>` POIs with capability `<kind>` inside the encrypted data.
