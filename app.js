// =========================================================
// Live Market Depth Viewer - client-only, no backend.
// Talks directly from this device to Binance's public API/WebSocket.
// Ports the same full-order-book sync + rate-limit-safety logic as the
// original desktop app: one snapshot per connect, capped backoff on
// reconnects, throttled resyncs, honoring 429/418 Retry-After.
// =========================================================

const FAPI_REST_BASE = "https://fapi.binance.com";
const FSTREAM_WS_BASE = "wss://fstream.binance.com";
const SNAPSHOT_LIMIT = 1000;           // futures REST depth endpoint max
const MIN_RESYNC_INTERVAL_MS = 5000;   // don't resync more than once per 5s
const MAX_BACKOFF_MS = 30000;
const UI_REFRESH_INTERVAL_MS = 300;

// ---------------- State ----------------
let pairMap = new Map();      // coindcxPair -> binanceSymbol
let activeSymbol = null;
let lifecycleToken = null;
let ws = null;

let synced = false;
let lastUpdateId = -1;
let bidBook = new Map();      // price(string) -> qty(string)
let askBook = new Map();
let pendingBuffer = [];
let lastResyncAtMs = 0;

// ---------------- DOM refs ----------------
const el = (id) => document.getElementById(id);
const btnSelectCsv = el("btnSelectCsv");
const csvInput = el("csvInput");
const csvName = el("csvName");
const pairSelect = el("pairSelect");
const bucketSelect = el("bucketSelect");
const bandsSelect = el("bandsSelect");

const statPair = el("statPair");
const statSymbol = el("statSymbol");
const statWs = el("statWs");
const statBookSize = el("statBookSize");
const statLastUpdate = el("statLastUpdate");
const bestBidEl = el("bestBid");
const bestAskEl = el("bestAsk");
const spreadEl = el("spread");
const bidsTbody = document.querySelector("#bidsTable tbody");
const asksTbody = document.querySelector("#asksTable tbody");

// ---------------- CSV loading ----------------
btnSelectCsv.addEventListener("click", () => csvInput.click());

csvInput.addEventListener("change", () => {
  const file = csvInput.files[0];
  if (!file) return;
  csvName.textContent = file.name;

  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || "");
    const lines = text.split(/\r?\n/);
    const parsed = new Map();
    let first = true;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (first) { first = false; continue; } // skip header
      const parts = line.split(",");
      if (parts.length >= 2) {
        const a = parts[0].trim();
        const b = parts[1].trim();
        if (a && b) parsed.set(a, b.toUpperCase());
      }
    }
    if (parsed.size === 0) {
      alert("No valid rows found in CSV.");
      return;
    }
    pairMap = parsed;
    pairSelect.innerHTML = "";
    for (const key of pairMap.keys()) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = key;
      pairSelect.appendChild(opt);
    }
    // Auto-select the first pair
    pairSelect.selectedIndex = 0;
    pairSelect.dispatchEvent(new Event("change"));
  };
  reader.readAsText(file);
});

pairSelect.addEventListener("change", () => {
  const coindcxPair = pairSelect.value;
  if (!coindcxPair) return;
  const binanceSymbol = pairMap.get(coindcxPair);
  if (!binanceSymbol || binanceSymbol === activeSymbol) return;

  activeSymbol = binanceSymbol;
  statPair.textContent = coindcxPair;
  statSymbol.textContent = binanceSymbol;
  clearDepthDisplay();
  startFullDepthPipeline(binanceSymbol, 0);
});

function clearDepthDisplay() {
  bidsTbody.innerHTML = "";
  asksTbody.innerHTML = "";
  bestBidEl.textContent = "-";
  bestAskEl.textContent = "-";
  spreadEl.textContent = "-";
  statBookSize.textContent = "-";
  setWsStatus("CONNECTING...", "warn");
}

function setWsStatus(text, cls) {
  statWs.textContent = text;
  statWs.className = "val " + (cls || "");
}

// ---------------- Full depth pipeline ----------------

function startFullDepthPipeline(symbol, backoffMs) {
  lifecycleToken = crypto.randomUUID();
  const localToken = lifecycleToken;

  if (ws) {
    try { ws.close(1000, "Switching pair"); } catch (e) {}
    ws = null;
  }

  synced = false;
  lastUpdateId = -1;
  bidBook.clear();
  askBook.clear();
  pendingBuffer = [];

  const endpoint = `${FSTREAM_WS_BASE}/ws/${symbol.toLowerCase()}@depth@100ms`;
  const socket = new WebSocket(endpoint);
  ws = socket;

  socket.addEventListener("open", () => {
    if (localToken !== lifecycleToken) { socket.close(1000, "stale"); return; }
    // Snapshot is fetched once the socket is open, so we don't miss any events in between.
    fetchSnapshotAndSync(symbol, localToken, 0);
  });

  socket.addEventListener("message", (msg) => {
    if (localToken !== lifecycleToken) return;
    handleRawEvent(msg.data, symbol, localToken);
  });

  socket.addEventListener("close", () => {
    if (localToken !== lifecycleToken) return;
    scheduleReconnect(symbol, localToken, backoffMs);
  });

  socket.addEventListener("error", () => {
    if (localToken !== lifecycleToken) return;
    setWsStatus("WS ERROR", "err");
  });
}

function handleRawEvent(raw, symbol, localToken) {
  let evt;
  try { evt = JSON.parse(raw); } catch (e) { return; }
  if (evt.e !== "depthUpdate") return;
  if (!evt.b || !evt.a || evt.U === undefined || evt.u === undefined) return;

  if (!synced) {
    pendingBuffer.push(evt);
    if (pendingBuffer.length > 20000) pendingBuffer.shift(); // safety cap
    return;
  }

  const u = evt.u;
  if (u <= lastUpdateId) return; // stale, already applied

  const pu = evt.pu;
  if (pu !== undefined && pu !== lastUpdateId) {
    triggerResync(symbol, localToken);
    return;
  }

  applyDiffEvent(evt);
  lastUpdateId = u;
}

async function fetchSnapshotAndSync(symbol, localToken, attempt) {
  if (localToken !== lifecycleToken) return;

  try {
    const url = `${FAPI_REST_BASE}/fapi/v1/depth?symbol=${symbol}&limit=${SNAPSHOT_LIMIT}`;
    const resp = await fetch(url);

    if (resp.status === 429 || resp.status === 418) {
      const waitMs = readRetryAfterMs(resp, resp.status);
      setWsStatus(resp.status === 418 ? "IP BANNED - WAITING" : "RATE LIMITED - WAITING", "err");
      if (attempt < 5) {
        setTimeout(() => fetchSnapshotAndSync(symbol, localToken, attempt + 1), waitMs);
      }
      return;
    }

    if (!resp.ok) {
      setWsStatus(`SNAPSHOT ERROR (${resp.status})`, "err");
      return;
    }

    const snapshot = await resp.json();
    if (localToken !== lifecycleToken) return;

    bidBook.clear();
    askBook.clear();
    for (const [price, qty] of snapshot.bids) applyLevel(bidBook, price, qty);
    for (const [price, qty] of snapshot.asks) applyLevel(askBook, price, qty);
    lastUpdateId = snapshot.lastUpdateId;

    // Drop buffered events already older than the snapshot.
    while (pendingBuffer.length && pendingBuffer[0].u <= lastUpdateId) {
      pendingBuffer.shift();
    }

    // Find the first valid event: U <= lastUpdateId+1 <= u
    let firstApplied = false;
    let prevU = null;
    for (const evt of pendingBuffer) {
      const U = evt.U, u = evt.u;
      if (!firstApplied) {
        if (U <= lastUpdateId + 1 && u >= lastUpdateId + 1) {
          applyDiffEvent(evt);
          lastUpdateId = u;
          prevU = u;
          firstApplied = true;
        }
        // else: still older than snapshot, skip
      } else {
        const pu = evt.pu;
        if (pu !== undefined && prevU !== null && pu !== prevU) {
          pendingBuffer = [];
          triggerResync(symbol, localToken);
          return;
        }
        applyDiffEvent(evt);
        lastUpdateId = u;
        prevU = u;
      }
    }
    pendingBuffer = [];
    synced = true;
    setWsStatus("CONNECTED (FULL BOOK)", "ok");

  } catch (ex) {
    setWsStatus("SNAPSHOT FAILED", "err");
  }
}

function readRetryAfterMs(resp, status) {
  const header = resp.headers.get("Retry-After");
  if (header) {
    const seconds = parseInt(header, 10);
    if (!isNaN(seconds)) return seconds * 1000;
  }
  return status === 418 ? 60000 : 5000;
}

function applyDiffEvent(evt) {
  for (const [price, qty] of evt.b) applyLevel(bidBook, price, qty);
  for (const [price, qty] of evt.a) applyLevel(askBook, price, qty);
}

function applyLevel(book, priceStr, qtyStr) {
  const qty = parseFloat(qtyStr);
  if (qty === 0) {
    book.delete(priceStr);
  } else {
    book.set(priceStr, qtyStr);
  }
}

function triggerResync(symbol, localToken) {
  const now = Date.now();
  const sinceLast = now - lastResyncAtMs;
  const waitMs = sinceLast >= MIN_RESYNC_INTERVAL_MS ? 0 : (MIN_RESYNC_INTERVAL_MS - sinceLast);
  lastResyncAtMs = now + waitMs;

  setWsStatus("RESYNCING...", "warn");
  synced = false;
  pendingBuffer = [];

  setTimeout(() => {
    if (localToken === lifecycleToken) fetchSnapshotAndSync(symbol, localToken, 0);
  }, waitMs);
}

function scheduleReconnect(symbol, localToken, backoffMs) {
  const nextBackoff = backoffMs === 0 ? 2000 : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  setWsStatus(`RECONNECTING in ${Math.round(nextBackoff / 1000)}s`, "err");
  setTimeout(() => {
    if (localToken === lifecycleToken) startFullDepthPipeline(symbol, nextBackoff);
  }, nextBackoff);
}

// ---------------- Throttled UI refresh: percentage-band aggregation ----------------

function formatPrice(n) {
  // Trim trailing zeros without falling back to scientific notation.
  let s = n.toFixed(8);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

function refreshTables() {
  if (!activeSymbol || !synced) return;
  if (bidBook.size === 0 || askBook.size === 0) return;

  const bucketPct = parseFloat(bucketSelect.value);
  const maxBands = parseInt(bandsSelect.value, 10);

  // Best bid = highest bid price, best ask = lowest ask price.
  let bestBid = -Infinity, bestAsk = Infinity;
  for (const p of bidBook.keys()) { const v = parseFloat(p); if (v > bestBid) bestBid = v; }
  for (const p of askBook.keys()) { const v = parseFloat(p); if (v < bestAsk) bestAsk = v; }
  if (!isFinite(bestBid) || !isFinite(bestAsk)) return;

  const mid = (bestBid + bestAsk) / 2;

  const askQty = new Array(maxBands).fill(0);
  const askLevels = new Array(maxBands).fill(0);
  const bidQty = new Array(maxBands).fill(0);
  const bidLevels = new Array(maxBands).fill(0);

  for (const [priceStr, qtyStr] of askBook) {
    const price = parseFloat(priceStr);
    const pctAway = ((price - mid) / mid) * 100;
    if (pctAway < 0) continue;
    const idx = Math.floor(pctAway / bucketPct);
    if (idx < 0 || idx >= maxBands) continue;
    askQty[idx] += parseFloat(qtyStr);
    askLevels[idx]++;
  }

  for (const [priceStr, qtyStr] of bidBook) {
    const price = parseFloat(priceStr);
    const pctAway = ((mid - price) / mid) * 100;
    if (pctAway < 0) continue;
    const idx = Math.floor(pctAway / bucketPct);
    if (idx < 0 || idx >= maxBands) continue;
    bidQty[idx] += parseFloat(qtyStr);
    bidLevels[idx]++;
  }

  // Render bid bands
  bidsTbody.innerHTML = "";
  for (let i = 0; i < maxBands; i++) {
    if (bidLevels[i] === 0) continue;
    const lowPct = i * bucketPct, highPct = (i + 1) * bucketPct;
    const rangeHigh = mid * (1 - lowPct / 100);
    const rangeLow = mid * (1 - highPct / 100);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${lowPct.toFixed(1)}%\u2013${highPct.toFixed(1)}%</td>` +
                   `<td>${formatPrice(rangeLow)} \u2013 ${formatPrice(rangeHigh)}</td>` +
                   `<td>${bidQty[i].toFixed(4)}</td><td>${bidLevels[i]}</td>`;
    bidsTbody.appendChild(tr);
  }

  // Render ask bands
  asksTbody.innerHTML = "";
  for (let i = 0; i < maxBands; i++) {
    if (askLevels[i] === 0) continue;
    const lowPct = i * bucketPct, highPct = (i + 1) * bucketPct;
    const rangeLow = mid * (1 + lowPct / 100);
    const rangeHigh = mid * (1 + highPct / 100);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${lowPct.toFixed(1)}%\u2013${highPct.toFixed(1)}%</td>` +
                   `<td>${formatPrice(rangeLow)} \u2013 ${formatPrice(rangeHigh)}</td>` +
                   `<td>${askQty[i].toFixed(4)}</td><td>${askLevels[i]}</td>`;
    asksTbody.appendChild(tr);
  }

  bestBidEl.textContent = formatPrice(bestBid);
  bestAskEl.textContent = formatPrice(bestAsk);
  spreadEl.textContent = formatPrice(bestAsk - bestBid);
  statBookSize.textContent = `${bidBook.size} bids / ${askBook.size} asks`;
  statLastUpdate.textContent = new Date().toLocaleTimeString();
}

setInterval(refreshTables, UI_REFRESH_INTERVAL_MS);

// ---------------- Service worker registration (offline app-shell caching) ----------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
