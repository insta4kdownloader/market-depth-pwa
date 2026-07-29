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

// CoinDCX credentials - loaded fresh from a local file each session, held only in memory.
// Never written to localStorage, never sent anywhere except directly to CoinDCX.
let coindcxApiKey = null;
let coindcxApiSecret = null;

// ---------------- DOM refs ----------------
const el = (id) => document.getElementById(id);
const btnSelectCsv = el("btnSelectCsv");
const csvInput = el("csvInput");
const csvName = el("csvName");
const btnSelectKeys = el("btnSelectKeys");
const keysFileInput = el("keysFileInput");
const keysFileName = el("keysFileName");
const btnRefreshPositions = el("btnRefreshPositions");
const positionsStatusEl = el("positionsStatus");
const positionsListEl = el("positionsList");
const pairSearchInput = el("pairSearchInput");
const pairDropdown = el("pairDropdown");
const bucketSelect = el("bucketSelect");
const bandsSelect = el("bandsSelect");

const tradeEntryEl = el("tradeEntry");
const tradeDirectionEl = el("tradeDirection");
const tradeTpEl = el("tradeTp");
const tradeSlEl = el("tradeSl");
const tradeWarningEl = el("tradeWarning");
const tpSideEl = el("tpSide");
const tpRangeLabelEl = el("tpRangeLabel");
const tpQtyEl = el("tpQty");
const tpLevelsEl = el("tpLevels");
const slSideEl = el("slSide");
const slRangeLabelEl = el("slRangeLabel");
const slQtyEl = el("slQty");
const slLevelsEl = el("slLevels");

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
    pairSearchInput.disabled = false;
    pairSearchInput.value = "";
    // Auto-select the first pair
    const firstKey = pairMap.keys().next().value;
    selectPair(firstKey);
  };
  reader.readAsText(file);
});

// ---------------- CoinDCX keys file + live open positions ----------------
//
// Security model: the keys file is read fresh from disk each time you tap
// "Select Keys File". Its contents are held only in memory (coindcxApiKey /
// coindcxApiSecret variables above) for the current page session - never
// written to localStorage, never cached by the service worker, never sent
// anywhere except directly from your device to CoinDCX to sign your own
// requests. Reloading the page clears them; you'd need to reselect the file.
// Use a READ-ONLY CoinDCX API key for this, not a trade/withdraw-capable one.

btnSelectKeys.addEventListener("click", () => keysFileInput.click());

keysFileInput.addEventListener("change", () => {
  const file = keysFileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || "{}"));
      if (!parsed.apiKey || !parsed.apiSecret) {
        throw new Error("File must contain \"apiKey\" and \"apiSecret\" fields.");
      }
      coindcxApiKey = parsed.apiKey;
      coindcxApiSecret = parsed.apiSecret;
      keysFileName.textContent = `Keys loaded (${file.name})`;
      btnRefreshPositions.disabled = false;
      positionsStatusEl.textContent = "Ready - tap Refresh Positions.";
    } catch (ex) {
      alert("Could not read keys file: " + ex.message);
    }
  };
  reader.readAsText(file);
  // Clear so re-selecting the same file still fires change, and so the
  // browser doesn't hold an extra reference to it longer than necessary.
  keysFileInput.value = "";
});

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// CoinDCX represents "no TP/SL set" as the literal string "None" (or sometimes 0).
function parseTrigger(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim().toLowerCase() === "none") return null;
  const n = parseFloat(v);
  if (isNaN(n) || n === 0) return null;
  return n;
}

async function fetchOpenPositions() {
  if (!coindcxApiKey || !coindcxApiSecret) {
    alert("Select your CoinDCX keys file first.");
    return;
  }
  positionsStatusEl.textContent = "Fetching...";
  positionsListEl.innerHTML = "";

  try {
    const body = { timestamp: Date.now(), page: "1", size: "50" };
    const jsonBody = JSON.stringify(body);
    const signature = await hmacSha256Hex(coindcxApiSecret, jsonBody);

    const resp = await fetch("https://api.coindcx.com/exchange/v1/derivatives/futures/positions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AUTH-APIKEY": coindcxApiKey,
        "X-AUTH-SIGNATURE": signature
      },
      body: jsonBody
    });

    if (!resp.ok) {
      positionsStatusEl.textContent = `Error (${resp.status}) - check your keys / permissions.`;
      return;
    }

    const data = await resp.json();
    const positions = Array.isArray(data) ? data : [];
    const openPositions = positions.filter((p) => parseFloat(p.active_pos) !== 0);

    renderPositions(openPositions);
    positionsStatusEl.textContent = openPositions.length
      ? `${openPositions.length} open position(s) - tap one to load it below.`
      : "No open positions.";

  } catch (ex) {
    // Most likely cause: CoinDCX's private endpoint doesn't allow browser-based
    // (CORS) requests. This is a network-level failure, not a code bug.
    positionsStatusEl.textContent = "Request failed - possibly blocked by CORS. You can still enter trades manually below.";
  }
}

function renderPositions(positions) {
  positionsListEl.innerHTML = "";
  for (const p of positions) {
    const activePos = parseFloat(p.active_pos);
    const direction = activePos > 0 ? "long" : "short";
    const entry = parseFloat(p.avg_price);
    const tp = parseTrigger(p.take_profit_trigger);
    const sl = parseTrigger(p.stop_loss_trigger);

    const row = document.createElement("div");
    row.className = "position-row";
    row.innerHTML =
      `<span class="pos-pair">${p.pair}</span>` +
      `<span class="pos-dir ${direction}">${direction.toUpperCase()}</span>` +
      `<span class="pos-entry">Entry ${formatPrice(entry)}</span>` +
      `<span class="pos-tpsl">TP ${tp !== null ? formatPrice(tp) : "-"} / SL ${sl !== null ? formatPrice(sl) : "-"}</span>`;
    row.addEventListener("click", () => loadPositionIntoAnalyzer(p, direction, entry, tp, sl));
    positionsListEl.appendChild(row);
  }
}

function loadPositionIntoAnalyzer(p, direction, entry, tp, sl) {
  tradeEntryEl.value = isNaN(entry) ? "" : entry;
  tradeDirectionEl.value = direction;
  tradeTpEl.value = tp !== null ? tp : "";
  tradeSlEl.value = sl !== null ? sl : "";
  updateTradeAnalysis();

  const coindcxPair = p.pair;
  if (pairMap.has(coindcxPair)) {
    pairSearchInput.value = coindcxPair;
    selectPair(coindcxPair);
    tradeWarningEl.textContent = "";
  } else {
    tradeWarningEl.textContent = `Loaded ${coindcxPair} position data, but it isn't in your loaded CSV - select the matching pair manually above.`;
  }
}

btnRefreshPositions.addEventListener("click", fetchOpenPositions);

// ---------------- Searchable pair combobox ----------------

function renderDropdown(filterText) {
  const filter = (filterText || "").trim().toLowerCase();
  const keys = [...pairMap.keys()];
  const matches = filter
    ? keys.filter((k) => k.toLowerCase().includes(filter))
    : keys;

  pairDropdown.innerHTML = "";

  if (matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "dropdown-empty";
    empty.textContent = "No matching pairs";
    pairDropdown.appendChild(empty);
  } else {
    // Cap rendered rows for performance on very large CSVs; search still covers everything typed.
    for (const key of matches.slice(0, 200)) {
      const item = document.createElement("div");
      item.className = "dropdown-item";
      item.textContent = key;
      if (filter) {
        const idx = key.toLowerCase().indexOf(filter);
        if (idx >= 0) {
          item.innerHTML = key.slice(0, idx) + "<mark>" + key.slice(idx, idx + filter.length) + "</mark>" + key.slice(idx + filter.length);
        }
      }
      item.addEventListener("mousedown", (e) => {
        // mousedown (not click) so it fires before the input's blur hides the dropdown
        e.preventDefault();
        pairSearchInput.value = key;
        hideDropdown();
        selectPair(key);
      });
      pairDropdown.appendChild(item);
    }
  }
  pairDropdown.classList.remove("hidden");
}

function hideDropdown() {
  pairDropdown.classList.add("hidden");
}

pairSearchInput.addEventListener("input", () => {
  renderDropdown(pairSearchInput.value);
});

pairSearchInput.addEventListener("focus", () => {
  if (pairMap.size > 0) renderDropdown(pairSearchInput.value);
});

pairSearchInput.addEventListener("blur", () => {
  // Slight delay so a mousedown on a dropdown item can register first.
  setTimeout(hideDropdown, 150);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".combo-wrap")) hideDropdown();
});

function selectPair(coindcxPair) {
  if (!coindcxPair) return;
  const binanceSymbol = pairMap.get(coindcxPair);
  if (!binanceSymbol || binanceSymbol === activeSymbol) return;

  activeSymbol = binanceSymbol;
  statPair.textContent = coindcxPair;
  statSymbol.textContent = binanceSymbol;
  clearDepthDisplay();
  startFullDepthPipeline(binanceSymbol, 0);
}

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

// ---------------- Trade Depth Analyzer (entry price, direction, TP, SL) ----------------
//
// Rule: whichever direction price needs to move (up or down) determines which side of the
// book it has to "eat through" to get there.
//   Long,  TP (above entry) -> upward move  -> ASK side, range [entry, TP]
//   Long,  SL (below entry) -> downward move -> BID side, range [SL, entry]
//   Short, TP (below entry) -> downward move -> BID side, range [TP, entry]
//   Short, SL (above entry) -> upward move  -> ASK side, range [entry, SL]

function computeRangeTotal(book, min, max) {
  let total = 0;
  let levels = 0;
  for (const [priceStr, qtyStr] of book) {
    const p = parseFloat(priceStr);
    if (p >= min && p <= max) {
      total += parseFloat(qtyStr);
      levels++;
    }
  }
  return { total, levels };
}

function formatQty(n) {
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function updateTargetResult(book, entry, target, sideLabel, sideEl, rangeLabelEl, qtyEl, levelsEl) {
  sideEl.textContent = `(${sideLabel})`;
  if (isNaN(entry) || isNaN(target) || book.size === 0) {
    rangeLabelEl.textContent = "-";
    qtyEl.textContent = "-";
    levelsEl.textContent = "-";
    return;
  }
  const lo = Math.min(entry, target);
  const hi = Math.max(entry, target);
  const r = computeRangeTotal(book, lo, hi);
  rangeLabelEl.textContent = `${formatPrice(lo)} \u2013 ${formatPrice(hi)}`;
  qtyEl.textContent = formatQty(r.total);
  levelsEl.textContent = String(r.levels);
}

function updateTradeAnalysis() {
  const entry = parseFloat(tradeEntryEl.value);
  const direction = tradeDirectionEl.value; // "long" or "short"
  const tp = parseFloat(tradeTpEl.value);
  const sl = parseFloat(tradeSlEl.value);

  const warnings = [];
  if (!isNaN(entry) && !isNaN(tp)) {
    if (direction === "long" && tp <= entry) warnings.push("TP should be above entry for a long.");
    if (direction === "short" && tp >= entry) warnings.push("TP should be below entry for a short.");
  }
  if (!isNaN(entry) && !isNaN(sl)) {
    if (direction === "long" && sl >= entry) warnings.push("SL should be below entry for a long.");
    if (direction === "short" && sl <= entry) warnings.push("SL should be above entry for a short.");
  }
  tradeWarningEl.textContent = warnings.join(" ");

  if (direction === "long") {
    updateTargetResult(askBook, entry, tp, "ask side", tpSideEl, tpRangeLabelEl, tpQtyEl, tpLevelsEl);
    updateTargetResult(bidBook, entry, sl, "bid side", slSideEl, slRangeLabelEl, slQtyEl, slLevelsEl);
  } else {
    updateTargetResult(bidBook, entry, tp, "bid side", tpSideEl, tpRangeLabelEl, tpQtyEl, tpLevelsEl);
    updateTargetResult(askBook, entry, sl, "ask side", slSideEl, slRangeLabelEl, slQtyEl, slLevelsEl);
  }
}

// Recompute immediately on every keystroke/selection, not just on the 300ms refresh tick.
[tradeEntryEl, tradeTpEl, tradeSlEl].forEach((input) => {
  input.addEventListener("input", updateTradeAnalysis);
});
tradeDirectionEl.addEventListener("change", updateTradeAnalysis);

function refreshTables() {
  updateTradeAnalysis();

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
