// ⚠️ SENSITIVE — APSRTC app credentials read from the live site.
// Keep this file private. Do NOT commit it or host it on a public URL.
window.CONFIG = {
  // Cached read API (buses, places). CORS is open (access-control-allow-origin: *).
  API: "https://utsappapicached01.apsrtconline.in/uts-vts-api",
  USER_ID: "1363789069449",
  X_API_KEY: "53693855434468454E714A596D44457A586975414F573833334833596A584D3333735938444A69357131303D",
  // AES-256 key (base64) used to build the encrypted ?q= token.
  Q_KEY_B64: "BizZZ/rESHrW4kwbdQYiFZ4CCJIK3h8IIFsPxkTdouQ=",
  // Firestore (live GPS pings).
  FS_PROJECT: "apsrtc-uts-prod",
  FS_KEY: "AIzaSyAzYVdWqkGG2pUtk9McWxAEMwodYAjmm40",

  // Sweep tuning — which destinations to query around the selected town.
  HQ_RADIUS_KM: 45, HQ_CAP: 18,     // nearby mandal headquarters (local routes)
  DEPOT_RADIUS_KM: 160, DEPOT_CAP: 30, // depot towns farther out (long-distance routes)
  SWEEP_CONCURRENCY: 8,
  SWEEP_CACHE_MIN: 15,              // reuse a town's schedule sweep for this long (sessionStorage)

  // Live-position polling: tiered by what the user can see.
  VIEW_MS: 5000,                    // live buses inside the visible map area (+ padding)
  OFFVIEW_MS: 20000,                // live buses outside the visible area
  SLOW_MS: 60000,                   // trips not live yet — catches buses as they start
  VIEW_PAD: 0.25,                   // grow the visible area by 25% so buses about to enter count as "in view"
  BATCH_SIZE: 100,                  // documents per Firestore batchGet request
  BATCH_PARALLEL: 4,                // batchGet requests in flight at once

  ANIM_MS: 1500,                    // marker glide duration between updates
  FRESH_MIN: 10,                    // a bus is "live" only if its GPS pinged within this many minutes
  DONE_GRACE_MIN: 90,               // stop polling a non-live trip this long after its scheduled end
  PRESTART_MIN: 360,                // ...and don't poll it until this close to its scheduled time
                                    // (wide on purpose: times are per-stop, so long routes go live hours early)
};
