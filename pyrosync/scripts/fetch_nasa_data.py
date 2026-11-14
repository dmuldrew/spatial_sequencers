#!/usr/bin/env python3
"""
Fetch multi-decade NASA meteorology & wildfire datasets for PyroSync:
1. NASA POWER v2 Monthly Surface Meteorology (1991-2026) -> computes 1991-2020
   30-year seasonal normals (mean & std for each calendar month 1-12) and
   standardized fire-weather anomalies (z-scores) for 2001-2026 (309 months).
2. NASA EONET v3 Wildfire Events (2015-2026) -> monthly wildfire counts per biome.
3. NASA FIRMS MODIS C6.1 7-Day Global Active Fire Hotspots -> 3D globe markers.

Outputs compact JSON to public/data/fire_weather_data.json.
"""

import csv
import datetime as dt
import io
import json
import math
import os
import urllib.request
from collections import defaultdict

BIOMES = [
    {
        "id": "california",
        "name": "California & W. US",
        "subtitle": "Mediterranean Chaparral & Conifer",
        "color": "#f43f5e",
        "lat": 37.5,
        "lon": -120.2,
        "bbox": [-124.5, 32.5, -114.0, 42.5],
        "driver": "Warming autumns and lower coastal humidity widen Vapor Pressure Deficit (VPD), priming Diablo/Santa Ana wind outbreaks."
    },
    {
        "id": "boreal",
        "name": "Boreal N. America",
        "subtitle": "Canadian & Alaskan Taiga",
        "color": "#38bdf8",
        "lat": 55.5,
        "lon": -115.0,
        "bbox": [-150.0, 48.0, -70.0, 67.0],
        "driver": "Rapid high-latitude summer warming dries deep boreal duff fuels far beyond 1991-2020 norms."
    },
    {
        "id": "amazon",
        "name": "Amazon & Cerrado",
        "subtitle": "South American Tropical Savanna",
        "color": "#10b981",
        "lat": -10.5,
        "lon": -55.0,
        "bbox": [-73.0, -22.0, -40.0, 4.0],
        "driver": "Dry-season precipitation deficits and hotter surface highs push tropical forest-savanna edges past historical moisture thresholds."
    },
    {
        "id": "africa",
        "name": "Sahel & N. Savanna",
        "subtitle": "Sub-Saharan Northern Fire Belt",
        "color": "#f59e0b",
        "lat": 9.5,
        "lon": 23.0,
        "bbox": [-17.0, 3.0, 40.0, 18.0],
        "driver": "Harmattan dry trade winds cure seasonal grasses from Nov-Mar across Earth's densest active fire belt."
    },
    {
        "id": "mediterranean",
        "name": "Mediterranean Basin",
        "subtitle": "Southern Europe & North Africa",
        "color": "#a855f7",
        "lat": 39.0,
        "lon": 21.5,
        "bbox": [-9.5, 34.0, 34.0, 45.5],
        "driver": "Persistent summer heat domes and Etesian winds drive multi-sigma fire-weather anomalies."
    },
    {
        "id": "australia",
        "name": "Australian Outback",
        "subtitle": "Northern Savanna & Bushland",
        "color": "#ec4899",
        "lat": -17.5,
        "lon": 129.0,
        "bbox": [113.0, -35.0, 153.0, -10.5],
        "driver": "Extreme dry-season heat anomalies and strong trade winds elevate bushfire danger before monsoon onset."
    }
]


def in_bbox(lon, lat, bbox):
    w, s, e, n = bbox
    return w <= lon <= e and s <= lat <= n


def compute_vpd_kpa(temp_c, rh_pct):
    es = 0.6108 * math.exp((17.27 * temp_c) / (temp_c + 237.3))
    rh = max(1.0, min(100.0, rh_pct))
    return round(max(0.0, es * (1.0 - rh / 100.0)), 3)


def compute_ffwi(temp_c, rh_pct, wind_ms):
    temp_f = (temp_c * 9.0) / 5.0 + 32.0
    wind_mph = wind_ms * 2.23694
    rh = max(1.0, min(100.0, rh_pct))

    if rh <= 10.0:
        emc = 0.03229 + 0.281073 * rh - 0.000578 * rh * temp_f
    elif rh <= 50.0:
        emc = 2.22749 + 0.160107 * rh - 0.014784 * temp_f
    else:
        emc = 21.0606 + 0.005565 * (rh ** 2) - 0.00035 * rh * temp_f - 0.483199 * rh

    emc = max(0.0, emc)
    r_ratio = emc / 30.0
    eta = max(0.0, 1.0 - 2.0 * r_ratio + 1.5 * (r_ratio ** 2) - 0.5 * (r_ratio ** 3))
    ffwi = (eta * math.sqrt(1.0 + wind_mph ** 2)) / 0.3002
    return round(min(100.0, max(0.0, ffwi)), 2)


def fetch_power_monthly(lat, lon, start_yr=1991, end_yr=2026):
    url = (
        "https://power.larc.nasa.gov/api/temporal/monthly/point"
        f"?parameters=T2M_MAX,RH2M,WS10M,PRECTOTCORR&community=RE"
        f"&longitude={lon}&latitude={lat}&start={start_yr}&end={end_yr}&format=JSON"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "SpatialSequencers/1.0"})
    with urllib.request.urlopen(req, timeout=35) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["properties"]["parameter"]


def fetch_eonet_range(start_iso, end_iso):
    url = (
        "https://eonet.gsfc.nasa.gov/api/v3/events"
        f"?category=wildfires&status=all&start={start_iso}&end={end_iso}&limit=1000"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "SpatialSequencers/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("events", [])


def fetch_firms_modis_7d():
    url = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_7d.csv"
    req = urllib.request.Request(url, headers={"User-Agent": "SpatialSequencers/1.0"})
    with urllib.request.urlopen(req, timeout=35) as resp:
        text = resp.read().decode("utf-8")
    return list(csv.DictReader(io.StringIO(text)))


def main():
    print("Fetching NASA EONET wildfire events (2015-2026)...")
    all_events = {}
    for yr in range(2015, 2024):
        evts = fetch_eonet_range(f"{yr}-01-01", f"{yr}-12-31")
        for ev in evts:
            all_events[ev["id"]] = ev
        print(f"  {yr}: {len(evts)} events")

    # Query 2024-2026 month-by-month to avoid 1000-event annual truncation
    for yr in range(2024, 2027):
        max_m = 9 if yr == 2026 else 12
        for m in range(1, max_m + 1):
            start = dt.date(yr, m, 1)
            end = dt.date(yr, 12, 31) if m == 12 else dt.date(yr, m + 1, 1) - dt.timedelta(days=1)
            evts = fetch_eonet_range(start.isoformat(), end.isoformat())
            for ev in evts:
                all_events[ev["id"]] = ev
        print(f"  {yr} (monthly): unique total {len(all_events)}")

    biome_ym_fires = {b["id"]: defaultdict(int) for b in BIOMES}
    biome_total_eonet = defaultdict(int)

    for ev in all_events.values():
        geoms = ev.get("geometry") or []
        seen_biome_months = set()
        for g in geoms:
            coords = g.get("coordinates")
            date_str = (g.get("date") or "")[:7]
            if not coords or len(coords) < 2 or len(date_str) != 7:
                continue
            ym_key = date_str.replace("-", "")
            lon, lat = float(coords[0]), float(coords[1])
            for b in BIOMES:
                if in_bbox(lon, lat, b["bbox"]):
                    if (b["id"], ym_key) not in seen_biome_months:
                        biome_ym_fires[b["id"]][ym_key] += 1
                        seen_biome_months.add((b["id"], ym_key))
                    biome_total_eonet[b["id"]] += 1
                    break

    print("Fetching NASA FIRMS MODIS C6.1 7-day global hotspots...")
    modis_rows = fetch_firms_modis_7d()
    biome_modis_counts = defaultdict(int)
    biome_modis_frp = defaultdict(float)
    per_biome_candidates = defaultdict(list)

    for r in modis_rows:
        try:
            lat = float(r["latitude"])
            lon = float(r["longitude"])
            frp = float(r["frp"])
            bright = float(r["brightness"])
            conf = int(float(r["confidence"]))
        except (ValueError, KeyError):
            continue
        if conf < 40:
            continue
        for b in BIOMES:
            if in_bbox(lon, lat, b["bbox"]):
                biome_modis_counts[b["id"]] += 1
                biome_modis_frp[b["id"]] += frp
                per_biome_candidates[b["id"]].append({
                    "biome": b["id"],
                    "lat": round(lat, 3),
                    "lon": round(lon, 3),
                    "frp": round(frp, 1),
                    "brightness": round(bright, 1),
                    "date": r["acq_date"],
                    "time": r["acq_time"],
                    "conf": conf
                })
                break

    sampled_hotspots = []
    for b in BIOMES:
        cands = sorted(per_biome_candidates[b["id"]], key=lambda x: x["frp"], reverse=True)
        sampled_hotspots.extend(cands[:55])

    print("Fetching NASA POWER monthly meteorology (1991-2026) for 30-year norms & 2001-2026 spiral...")
    month_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    biomes_output = []

    for b in BIOMES:
        bid = b["id"]
        params = fetch_power_monthly(b["lat"], b["lon"], 1991, 2026)
        tmax_map = params["T2M_MAX"]
        rh_map = params["RH2M"]
        ws_map = params["WS10M"]
        pr_map = params["PRECTOTCORR"]

        # 1. Build 1991-2020 30-year baseline climatology per calendar month (1..12)
        baseline_vpd = defaultdict(list)
        baseline_ffwi = defaultdict(list)
        baseline_tmax = defaultdict(list)
        baseline_rh = defaultdict(list)
        baseline_ws = defaultdict(list)

        for yr in range(1991, 2021):
            for m in range(1, 13):
                ym = f"{yr}{m:02d}"
                t = tmax_map.get(ym, -999.0)
                rh = rh_map.get(ym, -999.0)
                ws = ws_map.get(ym, -999.0)
                if t > -900 and rh > -900 and ws > -900:
                    baseline_vpd[m].append(compute_vpd_kpa(t, rh))
                    baseline_ffwi[m].append(compute_ffwi(t, rh, ws))
                    baseline_tmax[m].append(t)
                    baseline_rh[m].append(rh)
                    baseline_ws[m].append(ws)

        monthly_norms = {}
        for m in range(1, 13):
            def stats(vals):
                mean = sum(vals) / len(vals)
                var = sum((x - mean) ** 2 for x in vals) / max(1, len(vals) - 1)
                return round(mean, 3), round(max(0.05, math.sqrt(var)), 3)

            v_mean, v_std = stats(baseline_vpd[m])
            f_mean, f_std = stats(baseline_ffwi[m])
            t_mean, _ = stats(baseline_tmax[m])
            r_mean, _ = stats(baseline_rh[m])
            w_mean, _ = stats(baseline_ws[m])
            monthly_norms[m] = {
                "month": m,
                "monthName": month_names[m - 1],
                "vpdMean": v_mean,
                "vpdStd": v_std,
                "ffwiMean": f_mean,
                "ffwiStd": f_std,
                "tmaxMean": round(t_mean, 1),
                "rhMean": round(r_mean, 1),
                "windMean": round(w_mean, 1)
            }

        # 2. Build 2001-2026 monthly spiral records (through 2026-09)
        records = []
        for yr in range(2001, 2027):
            max_m = 9 if yr == 2026 else 12
            for m in range(1, max_m + 1):
                ym = f"{yr}{m:02d}"
                t = tmax_map.get(ym, -999.0)
                rh = rh_map.get(ym, -999.0)
                ws = ws_map.get(ym, -999.0)
                pr = pr_map.get(ym, -999.0)
                if t <= -900 or rh <= -900 or ws <= -900:
                    continue

                vpd = compute_vpd_kpa(t, rh)
                ffwi = compute_ffwi(t, rh, ws)
                norm = monthly_norms[m]
                z_vpd = round((vpd - norm["vpdMean"]) / norm["vpdStd"], 2)
                z_ffwi = round((ffwi - norm["ffwiMean"]) / norm["ffwiStd"], 2)
                # Composite standardized fire-weather deviation from 1991-2020 seasonal norm
                z_score = round(0.6 * z_vpd + 0.4 * z_ffwi, 2)

                records.append({
                    "ym": f"{yr}-{m:02d}",
                    "year": yr,
                    "month": m,
                    "monthName": month_names[m - 1],
                    "tmaxC": round(t, 1),
                    "rhPct": round(rh, 1),
                    "windMs": round(ws, 1),
                    "precipMm": round(max(0.0, pr) if pr > -900 else 0.0, 1),
                    "vpdKpa": round(vpd, 2),
                    "ffwi": round(ffwi, 1),
                    "deltaVpd": round(vpd - norm["vpdMean"], 2),
                    "deltaFfwi": round(ffwi - norm["ffwiMean"], 1),
                    "zScore": z_score,
                    "eonetFires": biome_ym_fires[bid].get(ym, 0) if yr >= 2015 else None
                })

        peak_rec = max(records, key=lambda r: r["zScore"])
        biomes_output.append({
            **b,
            "eonetCount": biome_total_eonet[bid],
            "modis7dCount": biome_modis_counts[bid],
            "modis7dFrpMw": round(biome_modis_frp[bid], 1),
            "peakAnomaly": {
                "ym": peak_rec["ym"],
                "zScore": peak_rec["zScore"],
                "vpdKpa": peak_rec["vpdKpa"]
            },
            "norms": [monthly_norms[m] for m in range(1, 13)],
            "records": records
        })
        print(
            f"  {bid:14s} | months={len(records)} | peak={peak_rec['ym']} ({peak_rec['zScore']:+.2f}σ) "
            f"| EONET={biome_total_eonet[bid]:4d} | MODIS7d={biome_modis_counts[bid]:5d}"
        )

    out = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "baselinePeriod": "1991-2020",
        "period": {"start": "2001-01", "end": "2026-09"},
        "totalModis7dGlobal": len(modis_rows),
        "biomes": biomes_output,
        "hotspots": sampled_hotspots
    }

    os.makedirs("public/data", exist_ok=True)
    out_path = "public/data/fire_weather_data.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    size_kb = os.path.getsize(out_path) / 1024.0
    print(f"Wrote {out_path} ({size_kb:.1f} KB, {len(sampled_hotspots)} globe hotspots)")


if __name__ == "__main__":
    main()
