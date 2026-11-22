"""
Fetch live APSRTC bus position from Firebase Firestore.

Reverse-engineered from https://apsrtclivetrack.com — the page subscribes to:
  - trackingDetailsV2/{serviceDocId}   (live GPS pings)
  - serviceDetails/{serviceDocId}      (static metadata)

The public web API key is enough to read; no auth.

Usage:
    python apsrtc_track.py 12052026_RK32_3_BAPATLA            # one-shot
    python apsrtc_track.py 12052026_RK32_3_BAPATLA --watch    # poll every 5s
"""

from __future__ import annotations

import argparse
import sys
import time
from typing import Any
from urllib.parse import quote
from urllib.request import Request, urlopen
import json

PROJECT = "apsrtc-uts-prod"
API_KEY = "AIzaSyAzYVdWqkGG2pUtk9McWxAEMwodYAjmm40"
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"


def _unwrap(value: dict[str, Any]) -> Any:
    """Convert one Firestore typed value to a native Python value."""
    if "stringValue" in value:
        return value["stringValue"]
    if "integerValue" in value:
        return int(value["integerValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "booleanValue" in value:
        return value["booleanValue"]
    if "timestampValue" in value:
        return value["timestampValue"]
    if "nullValue" in value:
        return None
    if "mapValue" in value:
        return {k: _unwrap(v) for k, v in value["mapValue"].get("fields", {}).items()}
    if "arrayValue" in value:
        return [_unwrap(v) for v in value["arrayValue"].get("values", [])]
    return value  # unknown shape — return raw


def _get_doc(collection: str, doc_id: str) -> dict[str, Any] | None:
    url = f"{BASE}/{collection}/{quote(doc_id, safe='')}?key={API_KEY}"
    req = Request(url, headers={"Accept": "application/json"})
    with urlopen(req, timeout=10) as r:
        body = json.loads(r.read())
    if "fields" not in body:
        return None
    return {k: _unwrap(v) for k, v in body["fields"].items()}


def get_tracking(service_doc_id: str) -> dict[str, Any] | None:
    """Live GPS + per-ping details for one bus."""
    return _get_doc("trackingDetailsV2", service_doc_id)


def get_service_details(service_doc_id: str) -> dict[str, Any] | None:
    """Static service metadata (route, waypoints, schedule)."""
    return _get_doc("serviceDetails", service_doc_id)


def summarize(tracking: dict[str, Any]) -> str:
    lat = tracking.get("latitude")
    lon = tracking.get("longitude")
    bus = tracking.get("vehicleNumber", "?")
    svc = tracking.get("oprsNo", "?")
    depot = tracking.get("depotName", "?")
    speed = tracking.get("locationSpeed")
    bearing = tracking.get("locationBearing")
    online = tracking.get("isOnline")
    journey = tracking.get("journeyDate", "?")
    ttl_ms = tracking.get("ttl")
    last_seen = (
        time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ttl_ms / 1000))
        if isinstance(ttl_ms, int)
        else "?"
    )
    return (
        f"{bus} | service {svc} | depot {depot} | journey {journey}\n"
        f"  pos: ({lat}, {lon})  speed={speed}  bearing={bearing}  online={online}\n"
        f"  last update: {last_seen}"
    )


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("service_doc_id", help="e.g. 12052026_RK32_3_BAPATLA")
    p.add_argument("--watch", action="store_true", help="poll forever")
    p.add_argument("--interval", type=float, default=5.0, help="seconds between polls")
    p.add_argument("--raw", action="store_true", help="dump full JSON instead of summary")
    p.add_argument("--meta", action="store_true", help="also fetch serviceDetails once")
    args = p.parse_args()

    if args.meta:
        meta = get_service_details(args.service_doc_id)
        print("=== serviceDetails ===")
        print(json.dumps(meta, indent=2, default=str))
        print()

    def fetch_and_print() -> None:
        t = get_tracking(args.service_doc_id)
        if t is None:
            print("(no tracking doc — service may not be live)")
            return
        if args.raw:
            print(json.dumps(t, indent=2, default=str))
        else:
            print(summarize(t))

    if not args.watch:
        fetch_and_print()
        return 0

    print(f"polling every {args.interval}s — Ctrl+C to stop\n")
    try:
        while True:
            fetch_and_print()
            print("-" * 60)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
