/* APSRTC live bus tracker — static, no backend.
   Pieces: direct Firestore serviceDetails query (2 calls/town, true master routes),
   tiered Firestore batchGet poller (on-screen buses first), Leaflet canvas map. */
"use strict";
const C = window.CONFIG;
const FS_ROOT = `projects/${C.FS_PROJECT}/databases/(default)/documents`;
const FS = `https://firestore.googleapis.com/v1/${FS_ROOT}`;
// Only the fields the map and popup use — keeps each batch response small.
const TRACK_FIELDS = ["latitude", "longitude", "locationTime", "refreshedAt", "speed",
  "locationBearing", "busNumber", "vehicleNumber", "depotName"];
const SERVICE_FIELDS = ["oprsNo", "serviceType", "sourceName", "destinationName",
  "routeName", "serviceStartTime", "serviceEndTime", "depotName", "wayPointString", "currentSeqNo"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ---------- small helpers ---------- */
const [PID, LINK, NAME, MANDAL, DIST, LAT, LON, FLAGS] = [0, 1, 2, 3, 4, 5, 6, 7];
function haversine(a, b) {
  const R = 6371, dLat = (b[LAT] - a[LAT]) * Math.PI / 180, dLon = (b[LON] - a[LON]) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[LAT] * Math.PI / 180) * Math.cos(b[LAT] * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function nearestDepots(town, count) {
  return PLACES
    .filter(p => (p[FLAGS] & 2) && p[PID] !== town[PID])
    .map(p => [p, haversine(town, p)])
    .sort((a, b) => a[1] - b[1])
    .slice(0, count)
    .map(x => x[0]);
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx], idx); } catch (_) { /* aborted or network error: skip */ }
    }
  }));
}
function uv(v) { // unwrap one Firestore typed value
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return +v.integerValue;
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, uv(x)]));
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(uv);
  return null;
}
function unwrapFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, uv(v)]));
}

// Format IST date as "DD-MMM-YYYY" (matches Firestore serviceDetails.journeyDate).
function formatISTDate(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "numeric", year: "numeric"
  }).formatToParts(new Date(ms));
  const get = t => parts.find(p => p.type === t)?.value;
  return `${get("day")}-${MONTHS[+get("month") - 1]}-${get("year")}`;
}
function nowHourIST() {
  return +new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false
  }).format(new Date());
}

/* ---------- Firestore API ---------- */
async function queryServiceDetails(fieldPath, placeId, dates, signal) {
  const dateFilter = dates.length === 1
    ? { fieldFilter: { field: { fieldPath: "journeyDate" }, op: "EQUAL", value: { stringValue: dates[0] } } }
    : { fieldFilter: { field: { fieldPath: "journeyDate" }, op: "IN", value: { arrayValue: { values: dates.map(d => ({ stringValue: d })) } } } };

  const body = {
    structuredQuery: {
      select: { fields: SERVICE_FIELDS.map(f => ({ fieldPath: f })) },
      from: [{ collectionId: "serviceDetails" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            { fieldFilter: { field: { fieldPath }, op: "EQUAL", value: { integerValue: String(placeId) } } },
            dateFilter,
          ],
        },
      },
      limit: 5000,
    },
  };

  const r = await fetch(`${FS}:runQuery?key=${C.FS_KEY}`, {
    method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) return [];
  const rows = [];
  for (const item of await r.json()) {
    if (!item.document) continue;
    const docId = item.document.name.slice(item.document.name.lastIndexOf("/") + 1);
    const f = unwrapFields(item.document.fields);
    rows.push({
      serviceDocId: docId,
      oprsNo: f.oprsNo || "",
      serviceType: f.serviceType || "",
      sourceName: f.sourceName || "",
      destinationName: f.destinationName || "",
      routeName: f.routeName || "",
      serviceStartTime: f.serviceStartTime || "",
      serviceEndTime: f.serviceEndTime || "",
      depotName: f.depotName || "",
      wayPointString: f.wayPointString || "",
      currentSeqNo: +(f.currentSeqNo || 0),
    });
  }
  return rows;
}

async function fetchTownTrips(town, signal) {
  const now = Date.now();
  const dates = [formatISTDate(now)];
  // Before 09:00 IST, include yesterday's date to catch overnight long-distance buses.
  if (nowHourIST() < 9) dates.push(formatISTDate(now - 86400000));

  const useExactId = town[LINK] > 0;
  const [fromRows, toRows] = await Promise.all([
    queryServiceDetails(useExactId ? "sourceId" : "sourceLinkId", town[PID], dates, signal),
    queryServiceDetails(useExactId ? "destinationId" : "destinationLinkId", town[PID], dates, signal),
  ]);

  const trips = new Map();
  for (const svc of fromRows) trips.set(svc.serviceDocId, { dir: "from", svc });
  for (const svc of toRows) {
    if (!trips.has(svc.serviceDocId)) trips.set(svc.serviceDocId, { dir: "to", svc });
  }

  // For intermediate villages/non-depot stops (or towns with few direct trips),
  // also check the 5 nearest depot towns and keep any trip whose wayPointString passes through here.
  if (!(town[FLAGS] & 2) || trips.size < 15) {
    const pidStr = String(town[PID]);
    const depots = nearestDepots(town, 5);
    const extraJobs = depots.flatMap(d => [
      queryServiceDetails("sourceLinkId", d[PID], dates, signal),
      queryServiceDetails("destinationLinkId", d[PID], dates, signal),
    ]);
    const batches = await Promise.all(extraJobs);
    for (const rows of batches) {
      for (const svc of rows) {
        if (trips.has(svc.serviceDocId) || !svc.wayPointString) continue;
        const wps = svc.wayPointString.split(",");
        const idx = wps.indexOf(pidStr);
        if (idx === -1) continue;
        // currentSeqNo is 1-based; if bus is already past this stop, mark as departing ("from").
        const dir = svc.currentSeqNo && svc.currentSeqNo > idx + 1 ? "from" : "to";
        trips.set(svc.serviceDocId, { dir, svc });
      }
    }
  }

  return [...trips.values()];
}

// Many tracking docs in few requests: Firestore batchGet + field mask.
// Returns Map(docId -> fields) for docs that exist; missing docs are simply absent.
// Response order is not guaranteed, so results are keyed by document name.
async function batchTracking(ids, signal) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < ids.length; i += C.BATCH_SIZE) chunks.push(ids.slice(i, i + C.BATCH_SIZE));
  await pool(chunks, C.BATCH_PARALLEL, async chunk => {
    const r = await fetch(`${FS}:batchGet?key=${C.FS_KEY}`, {
      method: "POST", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documents: chunk.map(id => `${FS_ROOT}/trackingDetailsV2/${id}`),
        mask: { fieldPaths: TRACK_FIELDS },
      }),
    });
    if (!r.ok) return;
    for (const x of await r.json()) {
      if (!x.found) continue;
      const id = x.found.name.slice(x.found.name.lastIndexOf("/") + 1);
      out.set(id, unwrapFields(x.found.fields));
    }
  });
  return out;
}

/* ---------- map ---------- */
let map, canvasRenderer, townMarker = null;
const buses = new Map(); // docId -> {dir, marker, from, to, t0, k, pulseUntil, svc, t}
const COLORS = { from: "#2563eb", to: "#ea580c" }; // departing = blue, arriving = orange
const RADIUS = 7;

function initMap() {
  map = L.map("map", { preferCanvas: true, zoomControl: true }).setView([15.9, 80.4], 8);
  canvasRenderer = L.canvas({ padding: 0.5 });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
  // After the user pans/zooms, refresh what's now on screen right away (debounced).
  let t = null;
  map.on("moveend", () => { clearTimeout(t); t = setTimeout(() => { setCounts(); engine.bumpView(); }, 250); });
}
function viewBounds() { return map.getBounds().pad(C.VIEW_PAD); }

function tooltipHtml(svc, t) {
  const spd = t && t.speed != null ? ` · ${Math.round(+t.speed)} km/h` : "";
  return `<b>${svc.oprsNo || "?"}</b> · ${svc.sourceName || ""} → ${svc.destinationName || ""}${spd}`;
}

function popupHtml(dir, svc, t) {
  const upd = t && t.locationTime ? new Date(+t.locationTime).toLocaleTimeString() : "—";
  const spd = t && t.speed != null ? Math.round(+t.speed) + " km/h" : "";
  const bus = t && (t.busNumber || t.vehicleNumber) || "?";
  const depot = (t && t.depotName) || svc.depotName || "";
  const route = svc.routeName ? ` (${svc.routeName})` : "";
  return `<b>${svc.oprsNo || "?"}</b> · ${svc.serviceType || ""}${route}<br>
    ${dir === "from" ? "Departing" : "Arriving at"} <b>${window.SELECTED.name}</b><br>
    ${svc.sourceName || ""} → ${svc.destinationName || ""}<br>
    Bus ${bus} · ${spd}<br>
    <small>${depot ? depot + " depot · " : ""}dep ${svc.serviceStartTime || "?"} · GPS ${upd}</small>`;
}

function upsertBus(docId, dir, svc, t) {
  const lat = +t.latitude, lng = +t.longitude;
  let b = buses.get(docId);
  if (!b) {
    const marker = L.circleMarker([lat, lng], {
      renderer: canvasRenderer, radius: RADIUS, weight: 2, color: "#fff",
      fillColor: COLORS[dir], fillOpacity: 0.95,
    }).addTo(map);
    b = { dir, marker, from: [lat, lng], to: [lat, lng], t0: 0, k: 1, pulseUntil: 0, svc, t };
    marker.bindTooltip(tooltipHtml(svc, t), { direction: "top", offset: [0, -6] });
    marker.on("click", () => marker.bindPopup(popupHtml(b.dir, b.svc, b.t)).openPopup());
    buses.set(docId, b);
  } else {
    if (b.to[0] !== lat || b.to[1] !== lng) {
      const ll = b.marker.getLatLng();
      b.from = [ll.lat, ll.lng];
      b.to = [lat, lng];
      b.t0 = performance.now();
      b.k = 0;
      kick();
    }
    b.svc = svc; b.t = t;
    b.marker.setTooltipContent(tooltipHtml(svc, t));
  }
  if (b.marker.isPopupOpen()) b.marker.setPopupContent(popupHtml(b.dir, b.svc, b.t));
}
function removeBus(docId) {
  const b = buses.get(docId);
  if (b) { map.removeLayer(b.marker); buses.delete(docId); }
}

// Animation loop that only runs while something is moving or pulsing, and only
// interpolates markers near the screen; off-screen ones jump straight to their new spot.
let animating = false;
function kick() { if (!animating) { animating = true; requestAnimationFrame(animate); } }
function animate() {
  const now = performance.now(), view = viewBounds();
  let busy = false;
  for (const b of buses.values()) {
    if (b.k < 1) {
      if (!view.contains(b.to) && !view.contains(b.from)) {
        b.marker.setLatLng(b.to); b.k = 1;
      } else {
        b.k = Math.min(1, (now - b.t0) / C.ANIM_MS);
        b.marker.setLatLng([b.from[0] + (b.to[0] - b.from[0]) * b.k, b.from[1] + (b.to[1] - b.from[1]) * b.k]);
        if (b.k < 1) busy = true;
      }
    }
    if (b.pulseUntil > now) {
      b.marker.setRadius(RADIUS + 5 * Math.abs(Math.sin((b.pulseUntil - now) / 180)));
      busy = true;
    } else if (b.marker.getRadius() !== RADIUS) {
      b.marker.setRadius(RADIUS);
    }
  }
  if (busy) requestAnimationFrame(animate); else animating = false;
}

/* ---------- start/stop event feed ---------- */
function logEvent(kind, dir, svc, timeMs) {
  const feed = document.getElementById("feed");
  const li = document.createElement("li");
  li.className = kind; // "start" | "stop" | "init"
  const verb = kind === "stop" ? "ended" : (dir === "from" ? "to" : "from");
  const ts = new Date(timeMs || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const target = dir === "from" ? svc.destinationName : svc.sourceName;
  li.innerHTML = `<span class="t">${ts}</span>
    <i class="dot" style="background:${COLORS[dir]}"></i>
    <b>${svc.oprsNo || "?"}</b> ${verb} <span class="rt">${target || ""}</span>`;
  feed.prepend(li);
  while (feed.children.length > 15) feed.lastChild.remove();
}

/* ---------- status ---------- */
function setStatus(msg) { document.getElementById("status").textContent = msg; }
function setCounts() {
  let f = 0, t = 0, v = 0;
  const view = map.getBounds();
  for (const b of buses.values()) {
    b.dir === "from" ? f++ : t++;
    if (view.contains(b.to)) v++;
  }
  document.getElementById("countFrom").textContent = f;
  document.getElementById("countTo").textContent = t;
  document.getElementById("countLive").textContent = buses.size;
  document.getElementById("countView").textContent = v;
}
function stamp() {
  setStatus(`${buses.size} live · updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
}

/* ---------- live-position engine ----------
   Three tiers, each a self-scheduling loop (next run is scheduled only after the
   current one finishes, so slow networks never cause overlapping cycles):
     view      live buses inside the padded viewport   every VIEW_MS
     off       live buses elsewhere                    every OFFVIEW_MS
     discover  re-query serviceDetails for new trips   every SLOW_MS
   All loops pause while the tab is hidden. */
const engine = (() => {
  let plan = [], town = null, ctl = null, timers = {}, running = {};
  const TIERS = {
    view: { ms: () => C.VIEW_MS, pick: () => { const vb = viewBounds(); return plan.filter(p => p.live && vb.contains(buses.get(p.docId).to)); } },
    off: { ms: () => C.OFFVIEW_MS, pick: () => { const vb = viewBounds(); return plan.filter(p => p.live && !vb.contains(buses.get(p.docId).to)); } },
    discover: { ms: () => C.SLOW_MS },
  };

  // Fetch a set of trips in batches and apply the results.
  async function refresh(items, seed) {
    if (!items.length) return;
    const signal = ctl.signal;
    const got = await batchTracking(items.map(p => p.docId), signal);
    if (signal.aborted) return;
    const now = Date.now();
    const seededLive = [];
    for (const p of items) {
      const t = got.get(p.docId);
      const lt = t ? (+t.locationTime || +t.refreshedAt || 0) : 0;
      // isOnline is sticky and unreliable; trust recency of the last GPS ping.
      const fresh = t && +t.latitude && +t.longitude && lt && (now - lt) / 60000 <= C.FRESH_MIN;
      if (fresh) {
        const wasLive = p.live;
        upsertBus(p.docId, p.dir, p.svc, t);
        p.live = true;
        if (seed) {
          seededLive.push({ p, lt });
        } else if (!wasLive) { // not-live -> live: a bus just started
          buses.get(p.docId).pulseUntil = performance.now() + 9000;
          kick();
          logEvent("start", p.dir, p.svc);
        }
      } else if (p.live) { // was live, signal gone: left the road
        removeBus(p.docId);
        p.live = false;
        if (!seed) logEvent("stop", p.dir, p.svc);
      }
    }
    if (seed && seededLive.length) {
      seededLive.sort((a, b) => a.lt - b.lt);
      for (const { p, lt } of seededLive.slice(-5)) logEvent("init", p.dir, p.svc, lt);
    }
    setCounts();
  }

  async function discover() {
    if (!town) return;
    const signal = ctl.signal;
    const latest = await fetchTownTrips(town, signal);
    if (signal.aborted) return;
    const known = new Set(plan.map(p => p.docId));
    const added = [];
    for (const item of latest) {
      const docId = item.svc.serviceDocId;
      if (!known.has(docId)) {
        const entry = { dir: item.dir, svc: item.svc, docId, live: false };
        plan.push(entry);
        added.push(entry);
      }
    }
    if (added.length) {
      document.getElementById("countSched").textContent = plan.length;
      await refresh(added, false);
    }
  }

  let rerun = {};
  async function run(name) {
    clearTimeout(timers[name]);
    if (!ctl || document.hidden) return;
    if (running[name]) { rerun[name] = true; return; }
    running[name] = true;
    const mine = ctl;
    try {
      if (name === "discover") await discover();
      else await refresh(TIERS[name].pick(), false);
    } finally { running[name] = false; }
    if (mine !== ctl || mine.signal.aborted) return;
    if (name === "view") stamp();
    if (rerun[name]) { rerun[name] = false; return run(name); }
    if (!document.hidden) timers[name] = setTimeout(() => run(name), TIERS[name].ms());
  }
  function stopTimers() { for (const k in timers) clearTimeout(timers[k]); timers = {}; }

  document.addEventListener("visibilitychange", () => {
    if (!ctl) return;
    if (document.hidden) stopTimers();
    else { run("view"); run("off"); run("discover"); }
  });

  return {
    signal: () => ctl.signal,
    reset() { if (ctl) ctl.abort(); stopTimers(); running = {}; rerun = {}; plan = []; town = null; ctl = new AbortController(); },
    async start(selectedTown, newPlan) {
      town = selectedTown;
      plan = newPlan;
      const mine = ctl;
      await refresh(plan, true);
      if (mine !== ctl || mine.signal.aborted) return;
      stamp();
      run("view"); run("off");
      timers.discover = setTimeout(() => run("discover"), TIERS.discover.ms());
    },
    bumpView() { if (ctl && !ctl.signal.aborted) run("view"); },
  };
})();

/* ---------- town selection ---------- */
async function selectTown(town) {
  engine.reset();
  const signal = engine.signal();
  for (const id of [...buses.keys()]) removeBus(id);
  document.getElementById("feed").innerHTML = "";
  document.getElementById("countSched").textContent = "…";
  window.SELECTED = { id: town[PID], name: town[NAME], row: town };

  map.setView([town[LAT], town[LON]], 11);
  if (townMarker) map.removeLayer(townMarker);
  townMarker = L.circleMarker([town[LAT], town[LON]], { radius: 6, color: "#111", weight: 2, fillColor: "#fde047", fillOpacity: 1 })
    .addTo(map).bindTooltip(town[NAME]);
  setCounts();
  setStatus(`Loading trips for ${town[NAME]}…`);

  const plan = await fetchTownTrips(town, signal);
  if (signal.aborted) return;
  for (const p of plan) { p.docId = p.svc.serviceDocId; p.live = false; }
  document.getElementById("countSched").textContent = plan.length;
  setStatus(`${plan.length} trips today. Checking live GPS…`);
  await engine.start(town, plan);
}

/* ---------- searchable town dropdown ---------- */
function setupSearch() {
  const input = document.getElementById("town");
  const list = document.getElementById("suggest");
  function render(raw) {
    const q = raw.trim().toUpperCase();
    if (q.length < 2) { list.hidden = true; return; }
    const rank = i => { const p = PLACES[i]; return (p[NAME].startsWith(q) ? 0 : 1) - (p[FLAGS] & 2 ? 0.3 : 0) - (p[FLAGS] & 1 ? 0.1 : 0); };
    const hits = [];
    for (let i = 0; i < PLACES.length; i++) if (PLACES[i][NAME].includes(q)) hits.push(i);
    hits.sort((a, b) => rank(a) - rank(b) || PLACES[a][NAME].length - PLACES[b][NAME].length);
    list.innerHTML = hits.slice(0, 40).map(i =>
      `<li data-i="${i}">${PLACES[i][NAME]}<span>${PLACES[i][DIST]}${PLACES[i][FLAGS] & 2 ? " · depot" : ""}</span></li>`).join("");
    list.hidden = hits.length === 0;
  }
  input.addEventListener("input", () => render(input.value));
  input.addEventListener("focus", () => render(input.value));
  list.addEventListener("mousedown", e => {
    const li = e.target.closest("li"); if (!li) return;
    const p = PLACES[+li.dataset.i];
    input.value = p[NAME]; list.hidden = true; input.blur();
    selectTown(p);
  });
  document.addEventListener("click", e => { if (!e.target.closest(".search")) list.hidden = true; });
}

window.addEventListener("DOMContentLoaded", () => {
  initMap(); setupSearch();
  setStatus(`${PLACES.length.toLocaleString()} towns loaded. Pick one to begin.`);
});
