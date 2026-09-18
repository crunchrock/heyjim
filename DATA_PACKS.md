# Data packs

A data pack is one JSON file in `packs/` using the same schema as `florida_mobile_dev_agent_bundle_v3.json`. Packs are merged in filename order; any record whose `id` already exists is replaced, so a pack can add a new region or correct old records. Name new packs so they sort after the base, e.g. `packs/2026-10-georgia-coast.json`.

The app asks for a new pack when the user is more than 45 miles from every zone. Its "Need a new area?" sheet copies a ready-made research prompt (`packPrompt` in `docs/core.js`, with the private lifestyle context from `packs/_profile.json`). Paste that prompt into ChatGPT Pro and save the JSON it returns into `packs/`.

## Fields the build reads

Everything else in a pack is kept in the pack for provenance but ignored by the app. `null` always means *unknown*; never write `false` or `0` for "not researched".

**zones[]**: `id` (kebab-case), `name`, `region`, `center.latitude/longitude` (optional; otherwise the centroid of its located places is used), `route_order` (int; the coastal loop order), `timezone` (`America/New_York` or `America/Chicago`), `recommended_stay_days {min,max}`, `best_for[]`, `weaknesses[]`, `recommended_*_ids[]` (researcher picks), `navigation_query`.

**pois[]**: `id` (`<zone_id>_<slug>`), `zone_id`, `name`, `category` (waterfront | work | gym | food | overnight_candidate | car_maintenance | camping | mail | fun | social | life_support), `subcategory` (for work: library | independent_cafe | regional_cafe | chain_cafe; gym: planet_fitness), `address`, `city`, `latitude/longitude` (optional), `website`, `phone`, `hours {monday..sunday}`, `amenities[]` (grill, restroom, shade, pavilion, boat_ramp, pier, beach_access, shower, wifi…), `tags[]` (car_office, beach_work, door_dash, social, joy, creative_retreat…), `traveler_notes`, `operational_status` (listed_by_source | temporarily_closed | announced_not_open | current_status_unverified…), `recommended_use_status` (candidate | known_unavailable), `truly_24_7`, `hours_exceptions[]`, `schedule_warning`, `parking {free, notes}`, `waterfront_details.amenity_support_score`, `navigation.search_query` ("Name, street, city, FL zip"), `source_ids[]`.

Hours strings: `"07:00-21:00"`, split ranges `"11:00-14:30;17:00-22:00"`, overnight `"16:00-02:00"`, sun tokens `"sunrise-sunset"`, `"dawn-23:00"`, `"daylight"`, `"closed"`, or `null` if unknown.

**capabilities[]**: what a place is good for, with evidence. Drives almost all matching. `id` (`<poi_id>__<capability>`), `poi_id`, `capability`, `evidence_level` (documented | reported | inferred), `assessment_note`, `conditions[]`. Capabilities the app uses: `work_indoor, work_outdoors, wifi, gym, shower, sleep_candidate, tent_camp, paid_lodging, meal, protein_food, ramen, buffet, all_you_can_eat, groceries, buy_drinking_water, water_source_candidate, laundry, mail, auto_parts, repair_support, auto_service, loan_tools, public_grill, restroom, restroom_candidate, recreation`.

**overnight_candidates[]** (keyed to a poi): `poi_id`, `type`, `status` (uncertain | mixed_reports | prohibited), `gray_area`, `permission_status`, `confidence`, `notes`, `field_check[]`, `tow_reports`, `security_knock_reports`, `open_24h_nearby`, `assessment {priority: inspect_first | alternative | extra_friction | not_for_auto_selection, rationale}`, `reports[]`, `latest_report_date`.

**camping[]**: `poi_id`, `land_manager`, `cost`, `reservation_required`, `reservation_url`, `vehicle_access`, `sleeping_rules`, `stay_limit`, `road_condition`, `vehicle_sleeping_status`, `amenities[]`, `notes`, `alerts[]`, `latitude/longitude`.

**mail_options[]**: `poi_id`, `service_type`, `general_delivery_listed`, `general_delivery_confirmed`, `carrier_hold_confirmed`, `physical_office_zip`, `phone`, `address_template`, `contact_prompt`, `general_delivery_pickup_hours`.

**recreation[]**: `poi_id`, `activities[]`, `suggested_duration_minutes {min,max}`, `entry_cost`, `notes`, `alerts[]`, `reservation_url`.

**food_options[] / meal_offers[]**: `food_options`: `id`, `poi_id`, `primary_food_kind`, `has_ramen`, `is_buffet`, `is_all_you_can_eat`, `menu_examples[]`, `menu_url`, `cost_summary.min_documented_complete_meal_base_usd`. `meal_offers`: `food_option_id`, `label`, `food_kind`, `price {amount, unit}`, `service_channel`.

**doordash_markets[]**: `id`, `zone_id`, `name`, `recommended_windows[]` ("11:00-14:00"), `avoid_windows[]`, `target_subzones[] {name, poi_id}` (the hotspot restaurants the Dash block sends you to), `scores.overall`, `confidence`, `advantages[]`, `problems[]`, `demographics.median_household_income_usd`, `window_basis`.

**Food value (on food POIs)**: `food_value {cuisine, asian, price_level (1–4 = $–$$$$), typical_meal_usd, rating, rating_count, rating_source, rating_checked, known_for_cheap, cheap_evidence}`. The app ranks meals by value: high rating + cheap + known for cheap wins, Asian gets a nudge, $$$ is flagged "Pricey".

**Bars (category `social`)**: `bar_details {kind: dive|hipster_dive|barcade|craft_beer|cocktail|live_music, vibe, games, food, price_level, rating, rating_count, rating_source}` and `bar_specials [{label, days: ["tuesday",…], start "HH:MM", end "HH:MM", items: ["$5 Old Fashioned", …], posted_date (when the source set/updated it), checked_date, confidence: official|social_post|third_party|review_mention, source_id}]`. Always record posted/checked dates; the app shows them. Bar rules in the app: Mon–Thu surface specials, Fri/Sat plain dive bars are fine, never suggest bars on Sunday.

**poi_patches[]**: `[{id, ...fields}]` shallow-merges fields into an existing place without replacing it (e.g. add `food_value` ratings to a restaurant from an older pack).

**sources[]**: `id`, `url`, `title`, `publisher`, `retrieved_date`. Every record's `source_ids` must resolve here.

## Checklist for a new pack

- Ids are unique and stable. Don't reuse an existing zone id for a different area.
- Every POI has a street address and `navigation.search_query`; directions work without coordinates.
- Hours are per day and honest (`null` beats a guess). Note gates that close at sunset.
- Waterfront spots record free parking, restrooms, shade, grills and whether the car parks close to the water; causeways, boat ramps and Intracoastal parks are preferred.
- After adding: `node build/geocode.mjs && node build/build.mjs && node build/test/smoke.mjs`, then commit and push.
