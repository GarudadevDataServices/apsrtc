/* APSRTC live bus tracker — static, no backend.
   Pieces: q-token encoder (deflate-raw + AES-256-GCM), services/all sweep,
   tiered Firestore batchGet poller (on-screen buses first), Leaflet canvas map. */
"use strict";
const C = window.CONFIG;
const FS_ROOT = `projects/${C.FS_PROJECT}/databases/(default)/documents`;
const FS = `https://firestore.googleapis.com/v1/${FS_ROOT}`;
// Only the fields the map and popup use — keeps each batch response small.
const TRACK_FIELDS = ["latitude", "longitude", "locationTime", "refreshedAt", "speed",
  "locationBearing", "busNumber", "vehicleNumber", "depotName"];

/* ---------- q-token encoder (mirrors the Flutter app) ---------- */
let Q_KEY;
async function qKey() {
  if (!Q_KEY) {
    const raw = Uint8Array.from(atob(C.Q_KEY_B64), c => c.charCodeAt(0));
    Q_KEY = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  }
  return Q_KEY;
}
async function deflateRaw(bytes) {
  const cs = new CompressionStream("deflate-raw");
  const w = cs.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function encodeQ(obj) {
  const comp = await deflateRaw(new TextEncoder().encode(JSON.stringify(obj)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await qKey(), comp));
  const out = new Uint8Array(13 + ct.length);
  out[0] = 1; out.set(iv, 1); out.set(ct, 13);
  return b64url(out);
}

/* ---------- small helpers ---------- */
const [PID, LINK, NAME, MANDAL, DIST, LAT, LON, FLAGS] = [0, 1, 2, 3, 4, 5, 6, 7];
function haversine(a, b) {
  const R = 6371, dLat = (b[LAT] - a[LAT]) * Math.PI / 180, dLon = (b[LON] - a[LON]) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[LAT] * Math.PI / 180) * Math.cos(b[LAT] * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
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

/* ---------- API ---------- */
async function fetchServices(srcId, dstId, signal) {
  const q = await encodeQ({ sourceLinkId: srcId, destinationLinkId: dstId, sourcePlaceId: srcId, destinationPlaceId: dstId });
  const r = await fetch(`${C.API}/services/all?q=${encodeURIComponent(q)}`,
    { signal, headers: { "Accept": "application/json", "userId": C.USER_ID, "x-api-key": C.X_API_KEY } });
  if (!r.ok) return [];
  return (await r.json()).data || [];
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
      out.set(id, Object.fromEntries(Object.entries(x.found.fields || {}).map(([k, v]) => [k, uv(v)])));
    }
  });
  return out;
}

/* ---------- candidate destinations around a town ---------- */
function candidates(town) {
  const pick = (flag, maxKm, cap) => PLACES
    .filter(p => (p[FLAGS] & flag) && p[PID] !== town[PID])
    .map(p => [p, haversine(town, p)])
    .filter(x => x[1] > 0 && x[1] <= maxKm)
    .sort((a, b) => a[1] - b[1]).slice(0, cap).map(x => x[0]);
  const seen = new Set([town[PID]]), out = [];
  for (const p of [...pick(1, C.HQ_RADIUS_KM, C.HQ_CAP), ...pick(2, C.DEPOT_RADIUS_KM, C.DEPOT_CAP)])
    if (!seen.has(p[PID])) { seen.add(p[PID]); out.push(p); }
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

function popupHtml(dir, svc, t) {
  const upd = t && t.locationTime ? new Date(+t.locationTime).toLocaleTimeString() : "—";
  const spd = t && t.speed != null ? Math.round(+t.speed) + " km/h" : "";
  const bus = t && (t.busNumber || t.vehicleNumber) || "?";
  return `<b>${svc.oprsNo || "?"}</b> · ${svc.serviceType || ""}<br>
    ${dir === "from" ? "Departing" : "Arriving at"} <b>${window.SELECTED.name}</b><br>
    ${svc.sourceName || ""} → ${svc.destinationName || ""}<br>
    Bus ${bus} · ${spd}<br>
    <small>${t && t.depotName ? t.depotName + " depot · " : ""}dep ${svc.serviceStartTime || "?"} · GPS ${upd}</small>`;
}

function upsertBus(docId, dir, svc, t) {
  const lat = +t.latitude, lng = +t.longitude;
  let b = buses.get(docId);
  if (!b) {
    const marker = L.circleMarker([lat, lng], {
      renderer: canvasRenderer, radius: RADIUS, weight: 2, color: "#fff",
      fillColor: COLORS[dir], fillOpacity: 0.95,
    }).addTo(map);
    b = { dir, marker, from: [lat, lng], to: [lat, lng], t0: 0, k: 1, pulseUntil: 0 };
    marker.on("click", () => marker.bindPopup(popupHtml(b.dir, b.svc, b.t)).openPopup());
    buses.set(docId, b);
  } else if (b.to[0] !== lat || b.to[1] !== lng) {
    const ll = b.marker.getLatLng();
    b.from = [ll.lat, ll.lng];
    b.to = [lat, lng];
    b.t0 = performance.now();
    b.k = 0;
    kick();
  }
  b.svc = svc; b.t = t;
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
function logEvent(kind, dir, svc) {
  const feed = document.getElementById("feed");
  const li = document.createElement("li");
  li.className = kind; // "start" | "stop"
  const verb = kind === "start" ? (dir === "from" ? "departed" : "inbound to") : "ended";
  li.innerHTML = `<span class="t">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
    <i class="dot" style="background:${COLORS[dir]}"></i>
    <b>${svc.oprsNo || "?"}</b> ${verb} ${window.SELECTED.name} <span class="rt">${svc.destinationName || svc.sourceName || ""}</span>`;
  feed.prepend(li);
  while (feed.children.length > 15) feed.lastChild.remove();
}

/* ---------- schedule helpers (IST) ---------- */
function nowMinIST() { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })); return d.getHours() * 60 + d.getMinutes(); }
function hhmmToMin(t) { const m = /(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; }
function wrap(d) { if (d > 720) d -= 1440; if (d < -720) d += 1440; return d; }
// A not-live trip is worth checking only between (start - PRESTART_MIN) and (end + DONE_GRACE_MIN).
function stillEligible(svc) {
  const now = nowMinIST(), s = hhmmToMin(svc.serviceStartTime), e = hhmmToMin(svc.serviceEndTime);
  if (e != null && wrap(now - e) > C.DONE_GRACE_MIN) return false;
  if (s != null && wrap(s - now) > C.PRESTART_MIN) return false;
  return true;
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
     view    live buses inside the padded viewport   every VIEW_MS
     off     live buses elsewhere                    every OFFVIEW_MS
     pending trips not live yet but due              every SLOW_MS  (catches starts)
   All loops pause while the tab is hidden. */
const engine = (() => {
  let plan = [], ctl = null, timers = {}, running = {};
  const TIERS = {
    view: { ms: () => C.VIEW_MS, pick: () => { const vb = viewBounds(); return plan.filter(p => p.live && vb.contains(buses.get(p.docId).to)); } },
    off: { ms: () => C.OFFVIEW_MS, pick: () => { const vb = viewBounds(); return plan.filter(p => p.live && !vb.contains(buses.get(p.docId).to)); } },
    pending: { ms: () => C.SLOW_MS, pick: () => plan.filter(p => !p.live && stillEligible(p.svc)) },
  };

  // Fetch a set of trips in batches and apply the results.
  async function refresh(items, seed) {
    if (!items.length) return;
    const signal = ctl.signal;
    const got = await batchTracking(items.map(p => p.docId), signal);
    if (signal.aborted) return;
    const now = Date.now();
    for (const p of items) {
      const t = got.get(p.docId);
      const lt = t ? (+t.locationTime || +t.refreshedAt || 0) : 0;
      // isOnline is sticky and unreliable; trust recency of the last GPS ping.
      const fresh = t && +t.latitude && +t.longitude && lt && (now - lt) / 60000 <= C.FRESH_MIN;
      if (fresh) {
        const wasLive = p.live;
        upsertBus(p.docId, p.dir, p.svc, t);
        p.live = true;
        if (!wasLive && !seed) {             // not-live -> live: a bus just started
          buses.get(p.docId).pulseUntil = performance.now() + 9000;
          kick();
          logEvent("start", p.dir, p.svc);
        }
      } else if (p.live) {                     // was live, signal gone: left the road
        removeBus(p.docId);
        p.live = false;
        if (!seed) logEvent("stop", p.dir, p.svc);
      }
    }
    setCounts();
  }

  let rerun = {};
  async function run(name) {
    clearTimeout(timers[name]);
    if (!ctl || document.hidden) return;
    if (running[name]) { rerun[name] = true; return; }   // e.g. user panned mid-refresh: go again right after
    running[name] = true;
    const mine = ctl;
    try { await refresh(TIERS[name].pick(), false); } finally { running[name] = false; }
    if (mine !== ctl || mine.signal.aborted) return;       // town changed meanwhile
    if (name === "view") stamp();
    if (rerun[name]) { rerun[name] = false; return run(name); }
    if (!document.hidden) timers[name] = setTimeout(() => run(name), TIERS[name].ms());
  }
  function stopTimers() { for (const k in timers) clearTimeout(timers[k]); timers = {}; }

  document.addEventListener("visibilitychange", () => {
    if (!ctl) return;
    if (document.hidden) stopTimers();
    else { run("view"); run("off"); run("pending"); }   // catch up immediately on return
  });

  return {
    signal: () => ctl.signal,
    reset() { if (ctl) ctl.abort(); stopTimers(); running = {}; rerun = {}; plan = []; ctl = new AbortController(); },
    async start(newPlan) {
      plan = newPlan;
      // Seed: check every trip once (batched). Many live buses sit outside their
      // timetable window, so the first pass can't rely on the schedule.
      const mine = ctl;
      await refresh(plan, true);
      if (mine !== ctl || mine.signal.aborted) return;
      stamp();
      run("view"); run("off"); run("pending");
    },
    bumpView() { if (ctl && !ctl.signal.aborted) run("view"); },
  };
})();

/* ---------- town selection + schedule sweep ---------- */
const slim = x => ({ // keep only what the app uses (smaller cache, less memory)
  serviceDocId: x.serviceDocId, oprsNo: x.oprsNo, serviceType: x.serviceType,
  sourceName: x.sourceName, destinationName: x.destinationName,
  serviceStartTime: x.serviceStartTime, serviceEndTime: x.serviceEndTime,
});

async function sweep(town, signal) {
  const key = `sweep:${town[PID]}`;
  try {
    const c = JSON.parse(sessionStorage.getItem(key) || "null");
    if (c && Date.now() - c.ts < C.SWEEP_CACHE_MIN * 60000) return c.plan;
  } catch (_) { /* ignore bad cache */ }

  const dests = candidates(town);
  // Both directions in one pool. Key by serviceDocId (unique per trip/direction): a
  // round trip shares one serviceId across both legs, so classify by start/end city.
  const jobs = dests.flatMap(d => [["from", d], ["to", d]]);
  const trips = new Map();
  let step = 0;
  await pool(jobs, C.SWEEP_CONCURRENCY, async ([dir, d]) => {
    const rows = dir === "from" ? await fetchServices(town[PID], d[PID], signal) : await fetchServices(d[PID], town[PID], signal);
    for (const x of rows) {
      if (!x.serviceDocId) continue;
      if (dir === "from" && x.startCityPlaceId === town[PID]) trips.set(x.serviceDocId, { dir, svc: slim(x) });
      if (dir === "to" && x.endCityPlaceId === town[PID] && !trips.has(x.serviceDocId)) trips.set(x.serviceDocId, { dir, svc: slim(x) });
    }
    if (!signal.aborted) setStatus(`Querying schedules… ${++step}/${jobs.length}`);
  });
  const plan = [...trips.values()];
  if (!signal.aborted) {
    try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), plan })); } catch (_) { /* quota: skip cache */ }
  }
  return plan;
}

async function selectTown(town) {
  engine.reset();
  const signal = engine.signal();
  for (const id of [...buses.keys()]) removeBus(id);
  document.getElementById("feed").innerHTML = "";
  window.SELECTED = { id: town[PID], name: town[NAME], row: town };

  map.setView([town[LAT], town[LON]], 11);
  if (townMarker) map.removeLayer(townMarker);
  townMarker = L.circleMarker([town[LAT], town[LON]], { radius: 6, color: "#111", weight: 2, fillColor: "#fde047", fillOpacity: 1 })
    .addTo(map).bindTooltip(town[NAME]);
  setCounts();
  setStatus(`Finding routes around ${town[NAME]}…`);

  const plan = await sweep(town, signal);
  if (signal.aborted) return;
  for (const p of plan) { p.docId = p.svc.serviceDocId; p.live = false; }
  document.getElementById("countSched").textContent = plan.length;
  setStatus(`${plan.length} scheduled trips. Checking live GPS…`);
  await engine.start(plan);
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
