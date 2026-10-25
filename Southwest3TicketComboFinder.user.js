// ==UserScript==
// @name         Southwest 3-Ticket Combo Finder
// @namespace    https://southwest.com
// @version      2.0
// @description  自动搜索 + 收集 Choice Preferred/Extra 票价，实时查找满足价差条件的三票组合
// @match        https://www.southwest.com/*
// @updateURL    https://raw.githubusercontent.com/wtxcn/private/main/Southwest3TicketComboFinder.user.js
// @downloadURL  https://raw.githubusercontent.com/wtxcn/private/main/Southwest3TicketComboFinder.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // ═══════════════════════════════════════════
  // Config
  // ═══════════════════════════════════════════
  const MIN_DIFF = 100;
  const MAX_DIFF = 108;
  const FARE_CODES = ["ANY", "BUS"];
  const FARE_LABELS = { ANY: "Choice Preferred", BUS: "Choice Extra" };
  const STORAGE_KEY = "sw_finder_fares";
  const AUTO_KEY = "sw_finder_auto";
  const WAIT_MS = 10000;       // wait for API response after page load
  const NAV_DELAY_MS = 2000;   // pause between navigations

  // Routes: diverse price tiers for fast combo discovery
  const ROUTES = [
    // Tier 1: cheap
    ["BWI","ATL"],["SFO","LAX"],["LAX","SFO"],["OAK","LAS"],["SMF","LAX"],
    ["LAS","LAX"],["LAX","SEA"],["SAT","DAL"],["OAK","LAX"],["DEN","PHX"],
    ["HOU","DAL"],["DAL","AUS"],["SAN","LAX"],["PHX","LAS"],["HOU","AUS"],
    ["LAS","SFO"],["BUR","OAK"],["LAX","LAS"],["AUS","DAL"],["LAX","OAK"],
    // Tier 2: medium
    ["MDW","LAX"],["SFO","DEN"],["LAX","MCO"],["ATL","LAX"],["DAL","MDW"],
    ["MDW","BWI"],["BWI","MDW"],["ATL","BWI"],["DEN","LAX"],["SFO","SEA"],
    // Tier 3: expensive
    ["BWI","LAX"],["LAX","BWI"],["BWI","SFO"],["MCO","LAX"],["BNA","LAX"],
    ["LAX","ATL"],["SFO","MCO"],["DEN","BWI"],["MSY","LAX"],["DEN","MCO"],
  ];

  const SEARCH_DATE = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 35);
    return d.toISOString().slice(0, 10);
  })();

  // ═══════════════════════════════════════════
  // Data Store (GM_setValue for persistence)
  // ═══════════════════════════════════════════
  function loadFares() {
    try { return JSON.parse(GM_getValue(STORAGE_KEY, "[]")); }
    catch { return []; }
  }
  function saveFares(fares) { GM_setValue(STORAGE_KEY, JSON.stringify(fares)); }
  function clearFares() { saveFares([]); }

  function addFares(newFares) {
    const existing = loadFares();
    const seen = new Set(existing.map(fareKey));
    let added = 0;
    for (const f of newFares) {
      if (!seen.has(fareKey(f))) { seen.add(fareKey(f)); existing.push(f); added++; }
    }
    if (added > 0) saveFares(existing);
    return { total: existing.length, added };
  }

  function fareKey(f) {
    return `${f.origin}-${f.dest}-${f.date}-${f.code}-${f.price}-${f.flight}`;
  }

  // Auto-search state
  function loadAuto() {
    try { return JSON.parse(GM_getValue(AUTO_KEY, "null")); }
    catch { return null; }
  }
  function saveAuto(state) { GM_setValue(AUTO_KEY, JSON.stringify(state)); }
  function clearAuto() { GM_setValue(AUTO_KEY, "null"); }

  // ═══════════════════════════════════════════
  // API Response Parser
  // ═══════════════════════════════════════════
  function parseShoppingResponse(data) {
    const fares = [];
    try {
      const products = data?.data?.searchResults?.airProducts || [];
      for (const prod of products) {
        for (const detail of (prod.details || [])) {
          const adult = detail?.fareProducts?.ADULT;
          if (!adult) continue;
          for (const code of FARE_CODES) {
            const info = adult[code];
            if (!info || info.availabilityStatus !== "AVAILABLE") continue;
            const price = parseFloat(info?.fare?.totalFare?.value || "0");
            if (price <= 0) continue;
            const pid = info.productId || "";
            const parts = pid.split(",");
            let dep = "", arr = "", flight = "", origin = "", dest = "", date = "";
            if (parts.length >= 9) {
              const dm = parts[4]?.match(/T(\d{2}:\d{2})/);
              const am = parts[5]?.match(/T(\d{2}:\d{2})/);
              if (dm) dep = dm[1]; if (am) arr = am[1];
              flight = "WN" + parts[8]; origin = parts[2]; dest = parts[3];
              const dtm = parts[4]?.match(/(\d{4}-\d{2}-\d{2})/);
              if (dtm) date = dtm[1];
            }
            fares.push({ origin, dest, date, dep, arr, flight, code,
                          fareClass: FARE_LABELS[code],
                          price: Math.round(price * 100) / 100 });
          }
        }
      }
    } catch (e) { console.warn("[SW Finder] Parse error:", e); }
    return fares;
  }

  // ═══════════════════════════════════════════
  // Combo Finder
  // ═══════════════════════════════════════════
  function findCombos(fares) {
    const sorted = [...fares].sort((a, b) => a.price - b.price);
    const results = [];
    const n = sorted.length;
    for (let i = 0; i < n; i++) {
      const p1 = sorted[i].price;
      for (let j = i + 1; j < n; j++) {
        const d1 = Math.round((sorted[j].price - p1) * 100) / 100;
        if (d1 <= MIN_DIFF) continue;
        if (d1 >= MAX_DIFF) break;
        for (let k = j + 1; k < n; k++) {
          const d2 = Math.round((sorted[k].price - sorted[j].price) * 100) / 100;
          if (d2 <= MIN_DIFF) continue;
          if (d2 >= MAX_DIFF) break;
          results.push({ t1: sorted[i], t2: sorted[j], t3: sorted[k], d1, d2,
                          total: Math.round((p1 + sorted[j].price + sorted[k].price) * 100) / 100 });
        }
      }
    }
    return results.sort((a, b) => a.total - b.total);
  }

  // ═══════════════════════════════════════════
  // API Interception
  // ═══════════════════════════════════════════
  let apiCaptured = false;   // flag: did we capture data on this page load?

  function hookFetch() {
    const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const orig = win.fetch;
    win.fetch = function (...args) {
      const res = orig.apply(this, args);
      res.then(r => {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
        if (url.includes("air-booking") && url.includes("shopping")) {
          r.clone().json().then(handleApiData).catch(() => {});
        }
      }).catch(() => {});
      return res;
    };
  }

  function hookXHR() {
    const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const origOpen = win.XMLHttpRequest.prototype.open;
    const origSend = win.XMLHttpRequest.prototype.send;
    win.XMLHttpRequest.prototype.open = function (m, url, ...r) {
      this._swUrl = url; return origOpen.apply(this, [m, url, ...r]);
    };
    win.XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        if (this._swUrl?.includes("air-booking") && this._swUrl?.includes("shopping")) {
          try { handleApiData(JSON.parse(this.responseText)); } catch {}
        }
      });
      return origSend.apply(this, args);
    };
  }

  function handleApiData(data) {
    const newFares = parseShoppingResponse(data);
    if (newFares.length === 0) return;
    apiCaptured = true;
    const { total, added } = addFares(newFares);
    console.log(`[SW Finder] +${added} new fares (total: ${total})`);
    updatePanel();
  }

  // ═══════════════════════════════════════════
  // Auto Search Engine
  // ═══════════════════════════════════════════
  function buildSearchUrl(origin, dest, date) {
    return `https://www.southwest.com/air/booking/select.html`
      + `?adultPassengersCount=1&departureDate=${date}`
      + `&destinationAirportCode=${dest}&fareType=USD`
      + `&originationAirportCode=${origin}`
      + `&passengerType=ADULT&tripType=oneway&reset=true`;
  }

  function startAutoSearch() {
    const state = { active: true, index: 0, date: SEARCH_DATE, startedAt: Date.now() };
    saveAuto(state);
    navigateToRoute(state);
  }

  function stopAutoSearch() {
    clearAuto();
    updatePanel();
  }

  function navigateToRoute(state) {
    if (state.index >= ROUTES.length) {
      clearAuto();
      updatePanel();
      return;
    }
    const [origin, dest] = ROUTES[state.index];
    const url = buildSearchUrl(origin, dest, state.date);
    console.log(`[SW Finder] Auto-search [${state.index + 1}/${ROUTES.length}]: ${origin}→${dest}`);
    window.location.href = url;
  }

  function continueAutoSearch() {
    const state = loadAuto();
    if (!state || !state.active) return;

    const [origin, dest] = ROUTES[state.index] || [];
    console.log(`[SW Finder] Waiting for API data: ${origin}→${dest} ...`);

    // Wait for API data or timeout
    const deadline = Date.now() + WAIT_MS;
    const check = setInterval(() => {
      const fares = loadFares();
      const combos = findCombos(fares);

      if (apiCaptured || Date.now() > deadline) {
        clearInterval(check);

        if (combos.length > 0) {
          // Found combos! Stop.
          console.log(`[SW Finder] 🎯 Found ${combos.length} combos! Stopping.`);
          clearAuto();
          updatePanel();
          // Auto-open panel
          document.getElementById("sw-finder-panel")?.classList.add("open");
          return;
        }

        // Move to next route
        state.index++;
        if (state.index >= ROUTES.length) {
          console.log("[SW Finder] All routes searched. No combos found.");
          clearAuto();
          updatePanel();
          document.getElementById("sw-finder-panel")?.classList.add("open");
          return;
        }

        // Skip routes that are same as already-collected routes
        // (optimization: if we already have fares for this route, skip)
        const existingRoutes = new Set(fares.map(f => `${f.origin}-${f.dest}`));
        while (state.index < ROUTES.length) {
          const [o, d] = ROUTES[state.index];
          if (!existingRoutes.has(`${o}-${d}`)) break;
          console.log(`[SW Finder] Skipping ${o}→${d} (already have data)`);
          state.index++;
        }

        if (state.index >= ROUTES.length) {
          clearAuto();
          updatePanel();
          document.getElementById("sw-finder-panel")?.classList.add("open");
          return;
        }

        saveAuto(state);
        updatePanel();

        // Brief pause then navigate
        setTimeout(() => navigateToRoute(state), NAV_DELAY_MS);
      }
    }, 500);
  }

  // ═══════════════════════════════════════════
  // Booking URL
  // ═══════════════════════════════════════════
  function bookingUrl(f) {
    return `https://www.southwest.com/air/booking/select.html`
      + `?adultPassengersCount=1&departureDate=${f.date}`
      + `&destinationAirportCode=${f.dest}&fareType=USD`
      + `&originationAirportCode=${f.origin}`
      + `&passengerType=ADULT&tripType=oneway`;
  }

  // ═══════════════════════════════════════════
  // UI
  // ═══════════════════════════════════════════
  function createPanel() {
    GM_addStyle(`
      #sw-finder-btn {
        position:fixed; bottom:20px; right:20px; z-index:99999;
        width:56px; height:56px; border-radius:50%;
        background:linear-gradient(135deg,#304CB2,#1a2e6e);
        color:#fff; border:none; cursor:pointer; font-size:22px;
        box-shadow:0 4px 16px rgba(0,0,0,.3);
        display:flex; align-items:center; justify-content:center;
        transition:transform .2s;
      }
      #sw-finder-btn:hover{transform:scale(1.1)}
      #sw-finder-btn .badge{
        position:absolute;top:-4px;right:-4px;
        background:#e53935;color:#fff;font-size:11px;
        min-width:20px;height:20px;border-radius:10px;
        display:flex;align-items:center;justify-content:center;
        font-weight:700;padding:0 5px;
      }
      #sw-finder-panel{
        position:fixed;bottom:88px;right:20px;z-index:99998;
        width:500px;max-height:75vh;
        background:#fff;border-radius:12px;
        box-shadow:0 8px 32px rgba(0,0,0,.25);
        display:none;flex-direction:column;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
        font-size:13px;color:#333;overflow:hidden;
      }
      #sw-finder-panel.open{display:flex}
      .sw-hdr{
        background:linear-gradient(135deg,#304CB2,#1a2e6e);
        color:#fff;padding:12px 16px;font-size:15px;font-weight:700;
        display:flex;justify-content:space-between;align-items:center;
      }
      .sw-hdr-btns{display:flex;gap:6px}
      .sw-hdr-btns button{
        background:rgba(255,255,255,.2);border:none;color:#fff;
        padding:5px 10px;border-radius:5px;cursor:pointer;font-size:12px;
        font-weight:600;transition:background .15s;
      }
      .sw-hdr-btns button:hover{background:rgba(255,255,255,.35)}
      .sw-hdr-btns button.go{background:#4CAF50}
      .sw-hdr-btns button.go:hover{background:#43A047}
      .sw-hdr-btns button.stop{background:#e53935}
      .sw-hdr-btns button.stop:hover{background:#c62828}
      .sw-stats{
        padding:8px 16px;background:#f5f5f5;display:flex;gap:14px;
        font-size:12px;color:#666;border-bottom:1px solid #e0e0e0;
        flex-wrap:wrap;
      }
      .sw-stats b{color:#304CB2}
      .sw-progress{
        padding:8px 16px;background:#E3F2FD;border-bottom:1px solid #BBDEFB;
        font-size:12px;color:#1565C0;display:flex;align-items:center;gap:8px;
      }
      .sw-progress .spinner{
        width:14px;height:14px;border:2px solid #90CAF9;
        border-top-color:#1565C0;border-radius:50%;
        animation:sw-spin .8s linear infinite;
      }
      @keyframes sw-spin{to{transform:rotate(360deg)}}
      .sw-body{overflow-y:auto;padding:0;flex:1}
      .sw-combo{padding:12px 16px;border-bottom:1px solid #eee}
      .sw-combo:hover{background:#fafafa}
      .sw-combo-title{
        font-weight:700;font-size:14px;margin-bottom:8px;
        display:flex;justify-content:space-between;
      }
      .sw-combo-title .total{color:#e53935}
      .sw-ticket{
        display:grid;grid-template-columns:24px 1fr auto;
        gap:4px 8px;align-items:center;margin:4px 0;font-size:12px;
      }
      .sw-ticket .lbl{
        background:#304CB2;color:#fff;border-radius:3px;
        width:22px;height:18px;display:flex;
        align-items:center;justify-content:center;
        font-size:10px;font-weight:700;
      }
      .sw-ticket a{color:#1565C0;text-decoration:none;font-weight:600}
      .sw-ticket a:hover{text-decoration:underline}
      .sw-ticket .diff{color:#e53935;font-weight:600;font-size:11px}
      .sw-ticket .price{font-weight:700}
      .sw-empty{padding:28px 16px;text-align:center;color:#999}
      .sw-empty h3{color:#666;margin:0 0 10px}
      .sw-empty p{margin:4px 0;font-size:12px;line-height:1.5}
      .sw-foot{
        padding:8px 16px;background:#f5f5f5;border-top:1px solid #e0e0e0;
        font-size:11px;color:#888;
      }
    `);

    const btn = document.createElement("div");
    btn.id = "sw-finder-btn";
    btn.innerHTML = `🎫<span class="badge" id="sw-badge">0</span>`;
    btn.addEventListener("click", () =>
      document.getElementById("sw-finder-panel")?.classList.toggle("open")
    );

    const panel = document.createElement("div");
    panel.id = "sw-finder-panel";
    panel.innerHTML = `
      <div class="sw-hdr">
        <span>🎫 3-Ticket Combo Finder</span>
        <div class="sw-hdr-btns">
          <button class="go" id="sw-auto-btn">▶ Auto Search</button>
          <button id="sw-export-btn">📥</button>
          <button id="sw-clear-btn">🗑</button>
        </div>
      </div>
      <div id="sw-progress-bar"></div>
      <div class="sw-stats" id="sw-stats"></div>
      <div class="sw-body" id="sw-body"></div>
      <div class="sw-foot">
        Gap: $${MIN_DIFF} &lt; diff &lt; $${MAX_DIFF} · Fare: Choice Preferred / Choice Extra
      </div>
    `;

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    document.getElementById("sw-auto-btn").addEventListener("click", () => {
      const auto = loadAuto();
      if (auto?.active) { stopAutoSearch(); }
      else { startAutoSearch(); }
    });
    document.getElementById("sw-clear-btn").addEventListener("click", () => {
      if (confirm("Clear all collected fare data?")) { clearFares(); updatePanel(); }
    });
    document.getElementById("sw-export-btn").addEventListener("click", exportResults);

    updatePanel();
  }

  function updatePanel() {
    const fares = loadFares();
    const combos = findCombos(fares);
    const auto = loadAuto();

    // Badge
    const badge = document.getElementById("sw-badge");
    if (badge) {
      badge.textContent = combos.length > 0 ? `${combos.length}✓` : String(fares.length);
      badge.style.background = combos.length > 0 ? "#4CAF50" : "#e53935";
    }

    // Auto button
    const autoBtn = document.getElementById("sw-auto-btn");
    if (autoBtn) {
      if (auto?.active) {
        autoBtn.textContent = "⏹ Stop";
        autoBtn.className = "stop";
      } else {
        autoBtn.textContent = "▶ Auto Search";
        autoBtn.className = "go";
      }
    }

    // Progress bar
    const progBar = document.getElementById("sw-progress-bar");
    if (progBar) {
      if (auto?.active) {
        const idx = auto.index;
        const [o, d] = ROUTES[idx] || ["?", "?"];
        progBar.innerHTML = `<div class="sw-progress">
          <div class="spinner"></div>
          Searching [${idx + 1}/${ROUTES.length}] ${o}→${d} (${auto.date}) …
        </div>`;
      } else {
        progBar.innerHTML = "";
      }
    }

    // Stats
    const routes = new Set(fares.map(f => `${f.origin}→${f.dest}`));
    const prices = fares.map(f => f.price).sort((a, b) => a - b);
    const statsEl = document.getElementById("sw-stats");
    if (statsEl) {
      statsEl.innerHTML = `
        <span>Fares: <b>${fares.length}</b></span>
        <span>Routes: <b>${routes.size}</b></span>
        ${prices.length ? `<span>$${prices[0].toFixed(2)}–$${prices[prices.length-1].toFixed(2)}</span>` : ""}
        <span>Combos: <b style="color:${combos.length?'#4CAF50':'#999'}">${combos.length}</b></span>
      `;
    }

    // Body
    const body = document.getElementById("sw-body");
    if (!body) return;

    if (combos.length === 0) {
      const rl = [...routes].join(", ");
      body.innerHTML = `<div class="sw-empty">
        <h3>${fares.length === 0 ? "还没有数据" : "还没找到满足条件的组合"}</h3>
        <p>${fares.length === 0
          ? "点击 <b>▶ Auto Search</b> 自动搜索，或手动搜索航班"
          : `已收集 ${fares.length} 条票价，${routes.size} 条航线`}</p>
        ${fares.length > 0 ? `<p style="font-size:11px;color:#bbb;margin-top:6px">${rl}</p>` : ""}
      </div>`;
      return;
    }

    body.innerHTML = combos.slice(0, 20).map((c, i) => `
      <div class="sw-combo">
        <div class="sw-combo-title">
          <span>🎫 #${i+1}</span>
          <span class="total">$${c.total.toFixed(2)}</span>
        </div>
        ${tktHtml(c.t1, "T1", null)}
        ${tktHtml(c.t2, "T2", c.d1)}
        ${tktHtml(c.t3, "T3", c.d2)}
      </div>
    `).join("") + (combos.length > 20
      ? `<div class="sw-empty"><p>… +${combos.length - 20} more (export to see all)</p></div>` : "");
  }

  function tktHtml(t, label, diff) {
    const url = bookingUrl(t);
    return `<div class="sw-ticket">
      <span class="lbl">${label}</span>
      <span>
        <a href="${url}" target="_blank">${t.origin}→${t.dest}</a>
        ${t.date} ${t.dep||""} ${t.flight||""} · ${t.fareClass}
        · <span class="price">$${t.price.toFixed(2)}</span>
      </span>
      <span class="diff">${diff != null ? `+$${diff.toFixed(2)}` : ""}</span>
    </div>`;
  }

  function exportResults() {
    const fares = loadFares();
    const combos = findCombos(fares);
    const blob = new Blob([JSON.stringify({
      exported: new Date().toISOString(),
      config: { MIN_DIFF, MAX_DIFF },
      fares, combos: combos.map(c => ({
        ticket1:{...c.t1, url:bookingUrl(c.t1)},
        ticket2:{...c.t2, url:bookingUrl(c.t2)},
        ticket3:{...c.t3, url:bookingUrl(c.t3)},
        diff12:c.d1, diff23:c.d2, total:c.total,
      })),
    }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sw_combos_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
  }

  // ═══════════════════════════════════════════
  // Init
  // ═══════════════════════════════════════════
  hookFetch();
  hookXHR();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    createPanel();

    // If auto-search is active, continue after page load
    const auto = loadAuto();
    if (auto?.active) {
      console.log("[SW Finder] Auto-search active, continuing...");
      // Auto-open panel
      setTimeout(() => {
        document.getElementById("sw-finder-panel")?.classList.add("open");
        continueAutoSearch();
      }, 1500);
    }

    console.log("[SW Finder] ✅ v2.0 loaded | Fares: " + loadFares().length);
  }
})();

