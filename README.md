# Hey Jim

A private, phone-first day planner for life on the road in Florida: build a day out of blocks (water time, café, Panera, deep work, DoorDash, gym + shower, car work, meals, grilling, travel, sleep spot), and the app picks real places that are open when you'll get there, then hands the whole route to Google Maps.

- App: https://crunchrock.github.io/heyjim/ (password protected; data is encrypted)
- For agents and future work: see [CLAUDE.md](CLAUDE.md) and [DATA_PACKS.md](DATA_PACKS.md)

## Rebuild after changes

```bash
node build/build.mjs && node build/test/smoke.mjs
git add -A && git commit -m "update" && git push
```

`packs/` (research data) and `build/secret.json` (password) stay on this computer only.
