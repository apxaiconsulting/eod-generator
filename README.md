# EOD Generator

Paste raw daily work notes and get a polished End-of-Day report for the AI Systems & Research Operations Specialist role.

Live at https://apxaiconsulting.github.io/eod-generator/

## How it works

- `instructions.md` holds the role reconstruction instructions. The app sends them with every request, and they can be edited per device in Settings.
- Reports are written by Gemini through the shared Cloudflare Worker. The worker only answers the published site, so generation does not work from a local copy.
- Notes, reports and extra outputs are stored in the browser only. Use Export backup in History to move them between devices.
- Dates follow Central time (`America/Chicago`), not the device clock.

## Deploying

Push to `main`. Bump `VERSION` in `sw.js` on every deploy so installed copies pick up the new files.
