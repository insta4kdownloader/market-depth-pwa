# Live Market Depth Viewer — PWA

A phone-friendly, installable web app version of the desktop market depth viewer.
No backend: your iPhone talks directly to Binance's public REST/WebSocket API.
Nothing you do in this app is sent to any third party other than Binance.

## 1. Host it on GitHub Pages (free, no server to maintain)

1. Go to [github.com](https://github.com) and create a free account if you don't have one
   (this is unrelated to Apple's paid Developer Program — just a normal GitHub account).
2. Click **New repository**. Name it anything, e.g. `market-depth-pwa`. Leave it **Public**
   (GitHub Pages on a free account requires the repo to be public — the code has no secrets
   or API keys in it, so this is safe).
3. On the new repo's page, click **Add file → Upload files**, and drag in every file from
   this folder (`index.html`, `style.css`, `app.js`, `manifest.json`, `service-worker.js`,
   and the `icons` folder with its two PNGs). Commit the upload.
4. Go to **Settings → Pages** (left sidebar). Under "Build and deployment", set
   **Source: Deploy from a branch**, branch **main**, folder **/ (root)**. Click **Save**.
5. Wait about a minute, then refresh — GitHub will show you a URL like:
   `https://<your-username>.github.io/market-depth-pwa/`

## 2. Install it on your iPhone

1. Open that URL in **Safari** on your iPhone (must be Safari, not Chrome — "Add to Home
   Screen" for a web app only works from Safari on iOS).
2. Tap the **Share** button (square with an arrow) → **Add to Home Screen** → **Add**.
3. You'll now have an app icon on your home screen. Opening it launches full-screen,
   no browser chrome, like a native app.

## 3. Using it

1. Tap **Select CSV** and pick your pair-mapping CSV file (same format as the desktop
   app: `coindcxPair,binancePair` per row, header row skipped). You can pick it from
   Files app, iCloud Drive, or wherever you saved it on your phone.
2. Pick a pair from the dropdown.
3. Watch the live bid/ask bands update, bucketed by the % size and band count you choose.

## 4. Live open positions (optional, from CoinDCX)

You can pull your open positions directly instead of typing Entry/TP/SL by hand:

1. **Create a read-only API key on CoinDCX** — go to your CoinDCX API dashboard and
   create a **new** key with only view/read permissions (no trading, no withdrawal).
   Don't reuse a key that has trading or withdrawal rights for this.
2. Make a small local JSON file (see `sample-keys.json` in this folder) with your key
   and secret:
   ```json
   { "apiKey": "your_key", "apiSecret": "your_secret" }
   ```
   Save it somewhere on your phone (Files app / iCloud Drive) — **do not** upload this
   file to GitHub or anywhere else.
3. In the app, tap **Select Keys File** and pick it, then tap **Refresh Positions**.
4. Tap any listed open position to auto-fill Entry, Direction, TP, and SL into the
   Trade Depth Analyzer. If CoinDCX shows no TP or SL set on that position, those
   fields are left blank for you to fill in manually.

**How this is kept as safe as a client-only app can be:**
- The keys file is read fresh from disk each time you select it and held only in the
  page's memory for that session — it's never written to localStorage, never cached
  by the service worker, and never committed to the GitHub repo.
- Reloading the page or closing the tab clears it; you'd need to reselect the file.
- Requests go straight from your phone to CoinDCX's API — there's no relay server.

**Known limitation:** this may simply not work. CoinDCX might not allow browser-based
(CORS) requests to its private/authenticated endpoints at all, in which case tapping
Refresh Positions will show an error and you'll need to keep entering trades manually.
This is a live open question I couldn't test from where this was built — try it and
see what happens.

## Notes

- You need an internet connection every time you use it, since it's live market data —
  there's no "offline" trading data, obviously. The app *shell* (the page itself) is
  cached by a service worker so it opens instantly even on a flaky connection.
- If you ever want to update the app, just re-upload the changed files to the same
  GitHub repo — Safari/iOS will pick up the new version next time you open it (the
  service worker checks for updates on load).
- If your CSV has 150+ pairs, note this app only maintains the full order book for
  whichever pair is currently selected (same as the desktop version) — not all pairs
  simultaneously — to stay well within Binance's rate limits.
