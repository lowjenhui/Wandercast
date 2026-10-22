"""Fill ERA5 history in data/weather.db from Copernicus instead of Open-Meteo.

Source: the Copernicus Climate Data Store's "ERA5 hourly time-series data on single levels"
(reanalysis-era5-single-levels-timeseries), the same ERA5 reanalysis on the same 0.25° grid the
app gets from Open-Meteo (`models=era5`). One request returns a place's whole history, and it
doesn't count against the Open-Meteo allowance.

Each place is requested at the grid point Open-Meteo chose for it (point_meta.grid_lat/lon), and
the hours are turned into the app's daily values the way Open-Meteo does it, in the place's
local time (point_meta.utc_offset):
  precip  daily sum of total_precipitation, mm. Copernicus stamps each hour's rain one hour later
          than Open-Meteo, so it is moved back an hour. (Sunshine is used as stamped: moving it
          too put the feels-like highs 0.35 °C below Open-Meteo's.)
  tmax    daily max / min of 2m_temperature, °C, plus the place's height correction (below)
  tmin
  rh      daily mean of hourly relative humidity from temperature and dew point (Magnus)
  atmax   daily max / min of hourly apparent temperature (Steadman, with wind and sunshine)
  atmin
  snow    left blank: the point series has no snowfall. The app fills it from Open-Meteo,
          on demand and in the background once everything else is seeded.

Height correction: Open-Meteo adjusts temperature for the gap between the place's own elevation
and the grid cell's (Kuala Lumpur +1.7 °C, Ho Chi Minh City ~0). The grid cell's elevation isn't
in the point series, so each place's correction is measured from the days Open-Meteo already
stored there (the median difference; it varies by under 0.1 °C day to day). Places with fewer
than MIN_OVERLAP such days are skipped and left to Open-Meteo.

Rows are stored with source = 'cds'. No stored value is ever changed: on a day Open-Meteo
already stored, Copernicus only fills values left blank (feels-like on days stored before the
app asked for it), and the row keeps its source. Open-Meteo never overwrites a Copernicus day
either (server/weatherCache.ts). A place is downloaded until every day in the range has every
value Copernicus provides.

Setup (once):
  1. Create a free account at https://cds.climate.copernicus.eu and accept the ERA5 licence on
     the dataset's Download page.
  2. Put your API key in ~/.cdsapirc:
       url: https://cds.climate.copernicus.eu/api
       key: <your key>
  3. pip3 install cdsapi

Usage:
  python3 scripts/import-era5-cds.py --validate          # compare with stored Open-Meteo days, write nothing
  python3 scripts/import-era5-cds.py                     # import every place, Sunny windows order
  python3 scripts/import-era5-cds.py --limit 20          # the first 20 places only
  python3 scripts/import-era5-cds.py --start 2001-01-01  # further back (trip odds use up to 25 years)

Places are the ones the app has already looked up (point_meta), in the weather library's
download order when the app is running at localhost:5173. Places it hasn't seen yet are left to
Open-Meteo, because their grid point and time zone aren't known.
"""

import argparse
import csv
import io
import json
import math
import sqlite3
import statistics
import sys
import tempfile
import urllib.request
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DATASET = "reanalysis-era5-single-levels-timeseries"
VARIABLES = [
    "2m_temperature",
    "2m_dewpoint_temperature",
    "total_precipitation",
    "10m_u_component_of_wind",
    "10m_v_component_of_wind",
    "surface_solar_radiation_downwards",
]
# CSV column names, short (as in GRIB/NetCDF) or long.
COLUMNS = {
    "t2m": ("t2m", "2m_temperature"),
    "d2m": ("d2m", "2m_dewpoint_temperature"),
    "tp": ("tp", "total_precipitation"),
    "u10": ("u10", "10m_u_component_of_wind"),
    "v10": ("v10", "10m_v_component_of_wind"),
    "ssrd": ("ssrd", "surface_solar_radiation_downwards"),
}
TIME_COLUMNS = ("valid_time", "time", "date")
# Days newer than this are refetched by the app anyway (ERA5_SETTLE_DAYS in weatherCache.ts).
SETTLE_DAYS = 10
DAILY_COLS = ["precip", "tmax", "tmin", "rh", "atmax", "atmin"]
# Stamped an hour later than Open-Meteo (checked against stored Open-Meteo days).
ACCUMULATED = ("tp",)
# Open-Meteo days needed to measure a place's height correction.
MIN_OVERLAP = 30
ROOT = Path(__file__).resolve().parent.parent


# ------------------------------------------------------------------ Open-Meteo's formulas
# From open-meteo/open-meteo, Sources/App/Helper/Meteorology.swift.


def relative_humidity(t: float, td: float) -> float:
    """Percent, from temperature and dew point in °C."""
    b, c = 17.625, 243.04
    return max(min(100 * math.exp(b * td / (c + td)) / math.exp(b * t / (c + t)), 100), 0)


def apparent_temperature(t: float, rh: float, wind10: float, radiation: float) -> float:
    """°C. wind10 in m/s at 10 m, radiation in W/m² (mean over the preceding hour)."""
    wind2 = wind10 * 0.75
    e = rh / 100 * 6.105 * math.exp(17.27 * t / (237.7 + t))
    q = max(0.0, 0.1 * (radiation - 550))
    return t + 0.348 * e - 0.70 * wind2 + 0.70 * (q / (wind2 + 10)) - 4.25


# ------------------------------------------------------------------ hours → days


def read_hours(raw: bytes) -> list:
    """Hourly rows from a downloaded CSV (plain or zipped): dicts of UTC time and SI values."""
    if raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            name = next(n for n in z.namelist() if n.endswith(".csv"))
            raw = z.read(name)
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8")))
    fields = reader.fieldnames or []
    tcol = next((c for c in TIME_COLUMNS if c in fields), None)
    cols = {k: next((c for c in names if c in fields), None) for k, names in COLUMNS.items()}
    if not tcol or not cols["t2m"]:
        raise ValueError(f"Unexpected CSV columns: {fields}")
    hours = []
    for row in reader:
        when = datetime.fromisoformat(row[tcol].replace("Z", "").replace("T", " ")).replace(tzinfo=timezone.utc)
        h = {"time": when}
        for k, c in cols.items():
            v = row.get(c) if c else None
            h[k] = float(v) if v not in (None, "") else None
        hours.append(h)
    return hours


def daily_values(hours: list, utc_offset: int, t_offset: float = 0.0) -> dict:
    """{date: {precip, tmax, tmin, rh, atmax, atmin}} for complete local days (24 hours).
    t_offset is the place's height correction in °C (see the top of this file)."""
    # Rain for hour H is stamped H + 1 in the download.
    later = {h["time"] - timedelta(hours=1): h for h in hours}
    by_day = defaultdict(list)
    for h in hours:
        if h["t2m"] is None:
            continue
        nxt = later.get(h["time"], {})
        h = {**h, **{k: nxt.get(k) for k in ACCUMULATED}}
        local = h["time"] + timedelta(seconds=utc_offset)
        by_day[local.date().isoformat()].append(h)
    out = {}
    for day, hs in by_day.items():
        if len(hs) != 24:
            continue  # the first and last day of the download, cut by the time zone shift
        t = [h["t2m"] - 273.15 for h in hs]
        # Humidity comes from the uncorrected temperature (it matches Open-Meteo's that way).
        ta = [x + t_offset for x in t]
        vals = {"tmax": round(max(ta), 1), "tmin": round(min(ta), 1), "precip": None, "rh": None, "atmax": None, "atmin": None}
        if all(h["tp"] is not None for h in hs):
            vals["precip"] = round(max(0.0, sum(h["tp"] for h in hs) * 1000), 1)
        if all(h["d2m"] is not None for h in hs):
            rh = [relative_humidity(ti, h["d2m"] - 273.15) for ti, h in zip(t, hs)]
            vals["rh"] = round(sum(rh) / len(rh))
            if all(h["u10"] is not None and h["v10"] is not None and h["ssrd"] is not None for h in hs):
                at = [
                    apparent_temperature(ti, r, math.hypot(h["u10"], h["v10"]), max(0.0, h["ssrd"]) / 3600)
                    for ti, r, h in zip(ta, rh, hs)
                ]
                vals["atmax"] = round(max(at), 1)
                vals["atmin"] = round(min(at), 1)
        out[day] = vals
    return out


# ------------------------------------------------------------------ places and storage


def library_order(port: int) -> list:
    """The weather library's places in download order, if the app is running."""
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/api/library", timeout=60) as r:
            places = json.load(r)["places"]
    except Exception:
        return []
    return sorted((p for p in places if p.get("priority")), key=lambda p: p["priority"])


def places(db: sqlite3.Connection, port: int) -> list:
    rows = db.execute(
        "SELECT lat, lon, grid_lat, grid_lon, utc_offset FROM point_meta WHERE kind = 'era5' AND grid_lat IS NOT NULL"
    ).fetchall()
    found = [{"lat": r[0], "lon": r[1], "grid_lat": r[2], "grid_lon": r[3], "utc_offset": r[4] or 0, "name": None, "rank": math.inf} for r in rows]
    # Name and rank them from the library: its places are within 10 km of a stored one.
    for i, lp in enumerate(library_order(port)):
        best = min(found, key=lambda p: (p["lat"] - lp["lat"]) ** 2 + (p["lon"] - lp["lon"]) ** 2, default=None)
        if best and abs(best["lat"] - lp["lat"]) < 0.1 and abs(best["lon"] - lp["lon"]) < 0.1 and best["rank"] == math.inf:
            best["name"], best["rank"] = lp["name"], i
    return sorted(found, key=lambda p: (p["rank"], p["lat"], p["lon"]))


def stored_days(db: sqlite3.Connection, p: dict, start: str, end: str) -> int:
    return db.execute(
        "SELECT COUNT(*) FROM era5_daily WHERE lat = ? AND lon = ? AND date BETWEEN ? AND ?", (p["lat"], p["lon"], start, end)
    ).fetchone()[0]


def complete_days(db: sqlite3.Connection, p: dict, start: str, end: str) -> int:
    """Days with every value Copernicus provides (snowfall aside)."""
    filled = " AND ".join(f"{c} IS NOT NULL" for c in DAILY_COLS)
    return db.execute(
        f"SELECT COUNT(*) FROM era5_daily WHERE lat = ? AND lon = ? AND date BETWEEN ? AND ? AND {filled}",
        (p["lat"], p["lon"], start, end),
    ).fetchone()[0]


def height_correction(db: sqlite3.Connection, p: dict, days: dict):
    """Median Open-Meteo minus Copernicus temperature (°C) on days both have, or None if too few."""
    rows = db.execute(
        "SELECT date, tmax, tmin FROM era5_daily WHERE lat = ? AND lon = ? AND source IS NOT 'cds' AND tmax IS NOT NULL",
        (p["lat"], p["lon"]),
    ).fetchall()
    diffs = []
    for d, tmax, tmin in rows:
        if d in days:
            diffs += [tmax - days[d]["tmax"], tmin - days[d]["tmin"]]
    return round(statistics.median(diffs), 2) if len(diffs) >= 2 * MIN_OVERLAP else None


def store(db: sqlite3.Connection, p: dict, days: dict) -> int:
    """Add Copernicus days, and fill blanks on stored days. No stored value is changed."""
    cols = ", ".join(DAILY_COLS)
    fill = ", ".join(f"{c} = COALESCE(era5_daily.{c}, excluded.{c})" for c in DAILY_COLS)
    before = db.total_changes
    db.executemany(
        f"INSERT INTO era5_daily (lat, lon, date, {cols}, source) VALUES (?, ?, ?, {', '.join('?' * len(DAILY_COLS))}, 'cds') "
        f"ON CONFLICT (lat, lon, date) DO UPDATE SET {fill}",
        [(p["lat"], p["lon"], d, *(v[c] for c in DAILY_COLS)) for d, v in sorted(days.items())],
    )
    db.commit()
    return db.total_changes - before


def download(client, p: dict, start: str, end: str) -> bytes:
    # A day either side, so local days at the ends are complete whatever the time zone.
    first = (date.fromisoformat(start) - timedelta(days=1)).isoformat()
    last = (date.fromisoformat(end) + timedelta(days=1)).isoformat()
    request = {
        "variable": VARIABLES,
        "location": {"longitude": p["grid_lon"], "latitude": p["grid_lat"]},
        "date": [f"{first}/{last}"],
        "data_format": "csv",
    }
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "series"
        client.retrieve(DATASET, request).download(str(target))
        return target.read_bytes()


# ------------------------------------------------------------------ validation


def compare(db: sqlite3.Connection, p: dict, days: dict) -> dict:
    """Per column: (days compared, mean absolute difference, largest difference) vs Open-Meteo."""
    rows = db.execute(
        f"SELECT date, {', '.join(DAILY_COLS)} FROM era5_daily WHERE lat = ? AND lon = ? AND source IS NOT 'cds'",
        (p["lat"], p["lon"]),
    ).fetchall()
    diffs = defaultdict(list)
    for r in rows:
        mine = days.get(r[0])
        if not mine:
            continue
        for c, om in zip(DAILY_COLS, r[1:]):
            if om is not None and mine[c] is not None:
                diffs[c].append(abs(mine[c] - om))
    return {c: (len(d), sum(d) / len(d), max(d)) for c, d in diffs.items() if d}


def main() -> None:
    today = date.today()
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--db", default=str(ROOT / "data" / "weather.db"))
    ap.add_argument("--start", default=f"{today.year - 10}-01-01", help="first day (default: 1 January, 10 years ago)")
    ap.add_argument("--end", default=(today - timedelta(days=SETTLE_DAYS)).isoformat(), help="last day (default: 10 days ago)")
    ap.add_argument("--limit", type=int, help="import at most this many places")
    ap.add_argument("--port", type=int, default=5173, help="where the app runs, for the library order")
    ap.add_argument("--validate", type=int, nargs="?", const=3, metavar="N",
                    help="download N places (default 3) that Open-Meteo already stored, compare, write nothing")
    args = ap.parse_args()

    try:
        import cdsapi
    except ImportError:
        sys.exit("Needs the Copernicus client: pip3 install cdsapi (and an API key in ~/.cdsapirc, see the top of this script).")
    db = sqlite3.connect(args.db, timeout=60)
    if "source" not in [r[1] for r in db.execute("PRAGMA table_info(era5_daily)")]:
        sys.exit("This database predates Copernicus imports: start the app once (npm run dev) to update it.")
    client = cdsapi.Client(quiet=True, progress=False)
    todo = places(db, args.port)

    if args.validate:
        # Places with the most Open-Meteo days in the range, so there is plenty to compare.
        start, end = args.start, args.end
        todo = sorted(todo, key=lambda p: -stored_days(db, p, start, end))[: args.validate]
        for p in todo:
            label = p["name"] or f"{p['lat']}, {p['lon']}"
            print(f"{label}: downloading {start} to {end}…", flush=True)
            hours = read_hours(download(client, p, start, end))
            offset = height_correction(db, p, daily_values(hours, p["utc_offset"]))
            days = daily_values(hours, p["utc_offset"], offset or 0.0)
            print(f"  height correction {offset if offset is not None else 'unknown (too few Open-Meteo days)'} °C")
            print(f"  {'value':<7}{'days':>6}{'mean diff':>11}{'max diff':>10}")
            for c, (n, mean, worst) in compare(db, p, days).items():
                print(f"  {c:<7}{n:>6}{mean:>11.2f}{worst:>10.1f}")
        return

    span = (date.fromisoformat(args.end) - date.fromisoformat(args.start)).days + 1
    done = 0
    for p in todo:
        if args.limit is not None and done >= args.limit:
            break
        label = p["name"] or f"{p['lat']}, {p['lon']}"
        if complete_days(db, p, args.start, args.end) >= span:
            continue
        done += 1
        try:
            hours = read_hours(download(client, p, args.start, args.end))
        except Exception as e:  # one place failing shouldn't stop the rest
            print(f"{label}: failed ({e})", flush=True)
            continue
        offset = height_correction(db, p, daily_values(hours, p["utc_offset"]))
        if offset is None:
            print(f"{label}: skipped (fewer than {MIN_OVERLAP} Open-Meteo days to measure its height correction)", flush=True)
            continue
        days = daily_values(hours, p["utc_offset"], offset)
        days = {d: v for d, v in days.items() if args.start <= d <= args.end}
        print(f"{label}: {store(db, p, days)} days written (height correction {offset:+.2f} °C)", flush=True)


if __name__ == "__main__":
    main()
