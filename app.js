// =========================================================
// Funding Rate Tracker - client-only, no backend.
// Streams live funding rate + next funding time for every Binance USDS-M
// Futures pair from a single public WebSocket, directly from this device.
// =========================================================

// NOTE: Binance split futures WebSocket streams into routed base URLs
// (/public, /market, /private) - unrouted connections stopped receiving
// @markPrice data after their migration deadline (2026-04-23). This stream
// belongs to the /market category, hence the /market/ws/ path below.
const FSTREAM_URL = "wss://fstream.binance.com/market/ws/!markPrice@arr@1s";
const MAX_BACKOFF_MS = 30000;
const RENDER_INTERVAL_MS = 1000;

// symbol -> { fundingRate: number, nextFundingTime: number(ms), markPrice: number }
let fundingData = new Map();

let ws = null;
let lifecycleToken = null;

let sortColumn = null;   // "symbol" | "fundingRate" | "timeLeft" | null
let sortDirection = 1;   // 1 = asc, -1 = desc
let filterText = "";

// ---------------- DOM refs ----------------
const el = (id) => document.getElementById(id);
const wsStatusEl = el("wsStatus");
const filterInputEl = el("filterInput");
const pairCountEl = el("pairCount");
const fundingBodyEl = el("fundingBody");
const sortableHeaders = document.querySelectorAll("th.sortable");

// ---------------- WebSocket connection ----------------

function connect(backoffMs) {
  lifecycleToken = crypto.randomUUID();
  const localToken = lifecycleToken;

  if (ws) {
    try { ws.close(1000, "reconnecting"); } catch (e) {}
    ws = null;
  }

  setStatus("CONNECTING...", "warn");
  const socket = new WebSocket(FSTREAM_URL);
  ws = socket;

  socket.addEventListener("open", () => {
    if (localToken !== lifecycleToken) { socket.close(1000, "stale"); return; }
    setStatus("CONNECTED", "ok");
  });

  socket.addEventListener("message", (msg) => {
    if (localToken !== lifecycleToken) return;
    handleMessage(msg.data);
  });

  socket.addEventListener("close", () => {
    if (localToken !== lifecycleToken) return;
    scheduleReconnect(backoffMs || 0);
  });

  socket.addEventListener("error", () => {
    if (localToken !== lifecycleToken) return;
    setStatus("WS ERROR", "err");
  });
}

function scheduleReconnect(backoffMs) {
  const nextBackoff = backoffMs === 0 ? 2000 : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  setStatus(`RECONNECTING in ${Math.round(nextBackoff / 1000)}s`, "err");
  setTimeout(() => connect(nextBackoff), nextBackoff);
}

function setStatus(text, cls) {
  wsStatusEl.textContent = text;
  wsStatusEl.className = "val " + (cls || "");
}

function handleMessage(raw) {
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { return; }
  if (!Array.isArray(arr)) return;

  for (const item of arr) {
    if (!item.s || item.r === undefined || item.T === undefined) continue;
    fundingData.set(item.s, {
      fundingRate: parseFloat(item.r),
      nextFundingTime: item.T,
      markPrice: parseFloat(item.p)
    });
  }
}

// ---------------- Sorting ----------------

sortableHeaders.forEach((th) => {
  th.addEventListener("click", () => {
    const col = th.dataset.col;
    if (sortColumn === col) {
      sortDirection *= -1;
    } else {
      sortColumn = col;
      sortDirection = 1;
    }
    updateSortIndicators();
    renderTable();
  });
});

function updateSortIndicators() {
  sortableHeaders.forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.col === sortColumn) {
      th.classList.add(sortDirection === 1 ? "sort-asc" : "sort-desc");
    }
  });
}

filterInputEl.addEventListener("input", () => {
  filterText = filterInputEl.value;
});

// ---------------- Formatting ----------------

function formatHms(ms) {
  const clamped = Math.max(0, ms);
  let totalSec = Math.floor(clamped / 1000);
  const h = Math.floor(totalSec / 3600);
  totalSec %= 3600;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function formatClockTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ---------------- Render loop ----------------

function renderTable() {
  const now = Date.now();
  const filter = filterText.trim().toLowerCase();

  let rows = [];
  for (const [symbol, d] of fundingData) {
    if (filter && !symbol.toLowerCase().includes(filter)) continue;
    rows.push({
      symbol,
      fundingRate: d.fundingRate,
      nextFundingTime: d.nextFundingTime,
      timeLeftMs: d.nextFundingTime - now
    });
  }

  if (sortColumn) {
    rows.sort((a, b) => {
      let av, bv;
      if (sortColumn === "fundingRate") { av = a.fundingRate; bv = b.fundingRate; }
      else if (sortColumn === "timeLeft") { av = a.timeLeftMs; bv = b.timeLeftMs; }
      else { av = a.symbol; bv = b.symbol; }
      if (av < bv) return -1 * sortDirection;
      if (av > bv) return 1 * sortDirection;
      return 0;
    });
  } else {
    rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  pairCountEl.textContent = `${rows.length} pair${rows.length === 1 ? "" : "s"}`;

  fundingBodyEl.innerHTML = rows.map((r) => {
    const ratePct = r.fundingRate * 100;
    const rateClass = r.fundingRate >= 0 ? "rate-positive" : "rate-negative";
    return `<tr>
      <td class="symbol-cell">${r.symbol}</td>
      <td class="${rateClass}">${ratePct >= 0 ? "+" : ""}${ratePct.toFixed(4)}%</td>
      <td>${formatClockTime(r.nextFundingTime)}</td>
      <td>${formatHms(r.timeLeftMs)}</td>
    </tr>`;
  }).join("");
}

setInterval(renderTable, RENDER_INTERVAL_MS);

// ---------------- Boot ----------------

connect(0);

// ---------------- Service worker registration (offline app-shell caching) ----------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
