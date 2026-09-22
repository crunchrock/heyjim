# Hey Jim

A private, phone-first day planner for life on the road in Florida. You build a day out of blocks (water work, café, dev session, DoorDash, gym + shower, meals, bars, travel, night spot). The app picks real places that are open when you'll get there, close by, and cheap and good, then sends the whole route to Google Maps. It also scouts night spots with you, tracks your week, and syncs your notes automatically.

- **It follows you.** Today's plan re-picks places around wherever you actually are; future days build from their own plan.
- **Add anything.** Places → ＋ Add (or "This spot isn't in the app" on Today): search OpenStreetMap or pick from what's around you. Night spots included ("I'm parked here for the night").
- **Auto-tracking.** While the app is open it starts/ends blocks when you arrive/leave. For full tracking, set up the car automation (Week → Auto-tracking): your iPhone pings when the car connects/disconnects, and the app turns stays into gym / night / work / DoorDash logs.
- **Lists:** Guy's picks (Diners, Drive-ins and Dives), Tony's picks (Anthony Bourdain), pizza, cravings (Skyline, Cane's, White Castle…), trail runs, springs & sinkholes, movies (showtimes one tap away), arcades, goth nights, bars with dated specials.
- **Pull down to refresh** re-syncs, grabs a fresh GPS fix and re-plans around you.

- **App:** https://crunchrock.github.io/heyjim/ (password protected; the data is encrypted). On the iPhone: Safari → Share → Add to Home Screen.
- **Your synced data:** the private repo `crunchrock/heyjim-data`. It saves automatically, with nothing to export.
- **For agents and future work:** [CLAUDE.md](CLAUDE.md) (how everything works), [DATA_PACKS.md](DATA_PACKS.md) (adding data).

## Getting more data in

1. For a new area, use the app: Places → "Need an area that isn't here?" copies a research prompt. For gaps, adapt `packs/_RESEARCH_PROMPT_gaps.md`.
2. Paste the prompt into ChatGPT Pro (deep research) and save the JSON it returns into `packs/`.
3. Ask Claude Code: "merge the new pack, rebuild and deploy." Then open, close and reopen the app on your phone.

## Rebuild by hand

```bash
node build/geocode.mjs        # only if new places lack coordinates
node build/build.mjs && node build/test/smoke.mjs && node build/test/move.mjs
git add -A && git commit -m "update" && git push
```

`packs/` (research data) and `build/secret.json` (password, sync key) exist only on this computer. Back them up somewhere private.
