# Hey Jim

A private, phone-first day planner for life on the road in Florida. You build a day out of blocks (water work, café, dev session, DoorDash, gym + shower, meals, bars, travel, night spot). The app picks real places that are open when you'll get there, close by, and cheap and good, then sends the whole route to Google Maps. It also scouts night spots with you, tracks your week, and syncs your notes automatically.

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
node build/build.mjs && node build/test/smoke.mjs
git add -A && git commit -m "update" && git push
```

`packs/` (research data) and `build/secret.json` (password, sync key) exist only on this computer. Back them up somewhere private.
