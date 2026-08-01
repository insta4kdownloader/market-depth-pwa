# Funding Rate Tracker — PWA

Live funding rate, next funding time, and countdown for every Binance USDS-M
Futures pair. Client-only, no backend — your device streams directly from
Binance's public market data.

## Deploying an update to your existing GitHub repo

This replaces the market-depth app entirely with a funding rate tracker.

1. Go to your repo → **Add file → Upload files**.
2. Drag in `index.html`, `style.css`, `app.js`, `manifest.json`, `service-worker.js`
   (same filenames as before, so they replace the old ones).
3. For the two icon files: drag `icon-192.png` and `icon-512.png` into the upload
   zone, then **before committing**, click each one's filename in the upload list
   and rename it to `icons/icon-192.png` and `icons/icon-512.png` respectively
   (this puts them in the `icons/` subfolder, same as before).
4. Commit. GitHub Pages redeploys automatically within about a minute.
5. Reopen the installed app on your phone — the service worker cache version was
   bumped, so it'll pick up the new version automatically.

## Using it

- The table lists every pair with its live **Funding Rate** (green = positive,
  red = negative), **Next Funding** time (in your local time), and **Time Left**
  as a live HH:MM:SS countdown.
- Tap **Funding Rate** or **Time Left** column headers to sort — tap once for
  ascending, tap again for descending.
- Use the filter box to narrow the list (e.g. type "BTC" to show only BTC pairs).
- Data refreshes continuously (funding rate/time from a live WebSocket; the
  countdown ticks every second locally).

## Notes

- Needs an internet connection every time you use it, since it's live data.
- Uses Binance's new routed WebSocket path (`/market/ws/...`), required since
  their April 2026 architecture migration — the old unrouted URL stopped
  pushing this data.
