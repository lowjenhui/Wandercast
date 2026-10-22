"""Check CAMS reanalysis PM2.5 against known pollution episodes before the air-quality import.

Source: the Copernicus Atmosphere Data Store's "CAMS global reanalysis (EAC4)"
(cams-global-reanalysis-eac4), 3-hourly on a 0.75° grid, 2003 to the end of last year. This
script downloads a small box around each test place for one month, turns it into daily values
the way the air-quality layer will, and prints them. Nothing is written to the app's database.

Daily values, per place, in its local time (8 three-hourly samples per day):
  pm25   mean PM2.5, µg/m³ (the US EPA AQI for PM2.5 is based on the 24-hour mean)
  aqi    US EPA 2016 AQI for that PM2.5 (the scale AQICN uses); 101+ is a "bad-air day"
  psi    Singapore PSI sub-index for the same PM2.5, shown as a hint only
  cause  smoke, smog or dust, from which aerosol makes up most of the day's optical depth:
         dust ≥ 50% → dust; organic matter + black carbon ≥ 50% → smoke; otherwise smog

Optional reference: AQICN's historical data for a city (aqicn.org/historical, "Download data",
a CSV of daily AQI per pollutant). Pass --reference singapore=path/to/singapore.csv and the
days are compared: typical AQI, the bias, and whether CAMS finds the same bad-air days. AQICN's
values come from city stations and CAMS covers areas about 80 km across, so CAMS should run a
little low in city centres; what matters is that it catches the episodes.

Setup (once):
  1. Sign in at https://ads.atmosphere.copernicus.eu with your ECMWF account and accept the
     CC-BY licence on the EAC4 dataset's Download page.
  2. Put the Atmosphere Data Store key in ~/.adsapirc (it is a different address from
     ~/.cdsapirc, which the ERA5 import uses):
       url: https://ads.atmosphere.copernicus.eu/api
       key: <your key>
  3. pip3 install cdsapi h5py

Usage:
  python3 scripts/validate-cams.py                      # every test case (about 16 small requests)
  python3 scripts/validate-cams.py --only singapore     # cases whose id starts with "singapore"
  python3 scripts/validate-cams.py --reference singapore=~/Downloads/singapore-air-quality.csv
                                                        # city = the case id without its month, e.g. kuala-lumpur
  python3 scripts/validate-cams.py --days               # also print every day
  python3 scripts/validate-cams.py --source forecast    # the CAMS forecast archive instead (2015 on)

Downloads are kept in data/cams-validate/, so a rerun costs nothing.
Tests: python3 scripts/test_validate_cams.py
"""

import argparse
import csv
import io
import math
import re
import statistics
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DATASET = "cams-global-reanalysis-eac4"
# --source forecast: the archive of CAMS's daily forecasts (2015 on), read every 3 hours from the
# 00 and 12 UTC runs. It has nitrate and ammonium aerosol, which the reanalysis lacks, but the
# forecast system is upgraded about once a year, so years aren't strictly comparable.
FORECAST_DATASET = "cams-global-atmospheric-composition-forecasts"
VARIABLES = [
    "particulate_matter_2.5um",
    "particulate_matter_10um",
    "total_aerosol_optical_depth_550nm",
    "dust_aerosol_optical_depth_550nm",
    "organic_matter_aerosol_optical_depth_550nm",
    "black_carbon_aerosol_optical_depth_550nm",
]
TIMES = ["00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00"]
# NetCDF variable names (short, as in GRIB) for the request variables.
SHORT = {"pm25": "pm2p5", "pm10": "pm10", "aod": "aod550", "dust": "duaod550", "om": "omaod550", "bc": "bcaod550"}
ROOT = Path(__file__).resolve().parent.parent
BAD_AQI = 101

# Test cases: place, grid point to read, local UTC offset (hours) and month, with what to expect.
# Episodes are well documented; the controls should come out mostly good or moderate.
CASES = [
    ("singapore-2019-09", "Singapore", 1.35, 103.82, 8, "2019-09", "haze: bad-air days in the second half of the month"),
    ("singapore-2023-10", "Singapore", 1.35, 103.82, 8, "2023-10", "El Niño haze, milder than 2019: a few bad-air days"),
    ("singapore-2022-09", "Singapore", 1.35, 103.82, 8, "2022-09", "control (La Niña year): no haze"),
    ("kuala-lumpur-2019-09", "Kuala Lumpur", 3.14, 101.69, 8, "2019-09", "haze: many bad-air days, worse than Singapore"),
    ("palembang-2019-09", "Palembang", -2.98, 104.76, 7, "2019-09", "next to the fires: very unhealthy to hazardous days"),
    ("chiang-mai-2023-03", "Chiang Mai", 18.79, 98.98, 7, "2023-03", "burning season, a bad year: most days bad"),
    ("chiang-mai-2022-03", "Chiang Mai", 18.79, 98.98, 7, "2022-03", "burning season, a milder (wet) year"),
    ("bangkok-2020-01", "Bangkok", 13.75, 100.5, 7, "2020-01", "dry-season smog: spells of bad-air days"),
    ("hanoi-2019-12", "Hanoi", 21.03, 105.85, 7, "2019-12", "winter smog: frequent bad-air days"),
    ("delhi-2024-11", "Delhi", 28.61, 77.21, 5.5, "2024-11", "winter smog with stubble smoke: nearly every day bad, some hazardous"),
    ("kathmandu-2021-03", "Kathmandu", 27.72, 85.32, 5.75, "2021-03", "forest-fire smoke: a severe spring"),
    ("beijing-2016-12", "Beijing", 39.9, 116.4, 8, "2016-12", "heating smog before the clean-up: several severe episodes"),
    ("beijing-2024-12", "Beijing", 39.9, 116.4, 8, "2024-12", "same month eight years on: far fewer bad-air days"),
    ("seoul-2021-03", "Seoul", 37.57, 126.98, 9, "2021-03", "fine dust plus the late-March yellow dust storm (dust cause)"),
    ("sydney-2019-12", "Sydney", -33.87, 151.21, 11, "2019-12", "Black Summer bushfire smoke: many bad-air days"),
    ("denpasar-2019-09", "Denpasar", -8.65, 115.22, 8, "2019-09", "control: mostly good despite the haze further north"),
]

# ------------------------------------------------------------------ AQI scales

# US EPA 2016 PM2.5 (24-hour) breakpoints, as AQICN uses: (C low, C high, I low, I high).
EPA_PM25 = [
    (0.0, 12.0, 0, 50),
    (12.1, 35.4, 51, 100),
    (35.5, 55.4, 101, 150),
    (55.5, 150.4, 151, 200),
    (150.5, 250.4, 201, 300),
    (250.5, 350.4, 301, 400),
    (350.5, 500.4, 401, 500),
]
# Singapore PSI PM2.5 (24-hour) sub-index (NEA).
PSI_PM25 = [
    (0.0, 12.0, 0, 50),
    (12.1, 55.0, 51, 100),
    (55.1, 150.0, 101, 200),
    (150.1, 250.0, 201, 300),
    (250.1, 350.0, 301, 400),
    (350.1, 500.0, 401, 500),
]
BANDS = [(50, "Good"), (100, "Moderate"), (150, "Unhealthy for sensitive groups"), (200, "Unhealthy"), (300, "Very unhealthy"), (10**9, "Hazardous")]


def _index(c: float, table: list) -> int:
    c = math.floor(c * 10) / 10  # EPA truncates PM2.5 to 0.1 µg/m³
    for c_lo, c_hi, i_lo, i_hi in table:
        if c <= c_hi:
            c = max(c, c_lo)
            return round((i_hi - i_lo) / (c_hi - c_lo) * (c - c_lo) + i_lo)
    return 500


def aqi_pm25(c: float) -> int:
    return _index(c, EPA_PM25)


def psi_pm25(c: float) -> int:
    return _index(c, PSI_PM25)


def band(aqi: float) -> str:
    return next(name for top, name in BANDS if aqi <= top)


# ------------------------------------------------------------------ download and read


def ads_client():
    try:
        import cdsapi
    except ImportError:
        sys.exit("Needs the Copernicus client: pip3 install cdsapi h5py (and a key in ~/.adsapirc, see the top of this script).")
    rc = Path.home() / ".adsapirc"
    if not rc.exists():
        sys.exit("No ~/.adsapirc: add the Atmosphere Data Store url and key (see the top of this script).")
    conf = dict(line.split(":", 1) for line in rc.read_text().splitlines() if ":" in line)
    return cdsapi.Client(url=conf["url"].strip(), key=conf["key"].strip(), quiet=True, progress=False)


def download(client, lat: float, lon: float, month: str, target: Path, source: str = "reanalysis") -> bytes:
    """One month (plus a day either side, for the time zone shift) of a small box around the place."""
    first = date.fromisoformat(f"{month}-01")
    nxt = (first + timedelta(days=32)).replace(day=1)
    request = {
        "variable": VARIABLES,
        "date": [f"{(first - timedelta(days=1)).isoformat()}/{nxt.isoformat()}"],
        "time": TIMES,
        "area": [lat + 0.8, lon - 0.8, lat - 0.8, lon + 0.8],  # N, W, S, E
        "data_format": "netcdf_zip",
    }
    if source == "forecast":
        request.update({"type": ["forecast"], "time": ["00:00", "12:00"], "leadtime_hour": ["0", "3", "6", "9"]})
    target.parent.mkdir(parents=True, exist_ok=True)
    client.retrieve(FORECAST_DATASET if source == "forecast" else DATASET, request).download(str(target))
    return target.read_bytes()


def netcdf_files(raw: bytes) -> list:
    """The NetCDF files in a download (zipped or not), as bytes."""
    if raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            return [z.read(n) for n in z.namelist() if n.endswith(".nc")]
    return [raw]


def parse_time_units(units: str):
    """(seconds per unit, epoch) from e.g. 'seconds since 1970-01-01' or 'hours since 1900-01-01 00:00:00.0'."""
    m = re.match(r"(\w+) since (\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?", units.strip())
    if not m:
        raise ValueError(f"Unexpected time units: {units}")
    scale = {"seconds": 1, "minutes": 60, "hours": 3600, "days": 86400}[m.group(1)]
    epoch = datetime.fromisoformat(f"{m.group(2)} {(m.group(3) or '00:00:00')[:8]}").replace(tzinfo=timezone.utc)
    return scale, epoch


def _datetimes(ds) -> list:
    units = ds.attrs["units"]
    scale, epoch = parse_time_units(units.decode() if isinstance(units, bytes) else str(units))
    return [epoch + timedelta(seconds=float(t) * scale) for t in ds[:].reshape(-1)]


def sample_times(f, v) -> list:
    """UTC time of each sample of variable v, flattened in the order of v[..., i, j].

    Reanalysis files have one time axis (valid_time). Forecast files have a run time and a lead
    time (forecast_reference_time × forecast_period), with valid_time sometimes stored as 2-D."""
    lead = v.shape[:-2]
    for name in ("valid_time", "time"):
        if name in f and f[name].shape == lead:
            return _datetimes(f[name])
    dims = [d[0].name.split("/")[-1] if len(d) else None for d in list(v.dims)[:-2]]
    axes = []
    for name in dims:
        ds = f[name]
        units = ds.attrs["units"]
        units = units.decode() if isinstance(units, bytes) else str(units)
        if " since " in units:
            axes.append(_datetimes(ds))
        else:  # a lead time, e.g. 'hours'
            scale = {"seconds": 1, "minutes": 60, "hours": 3600, "days": 86400}[units.split()[0]]
            axes.append([timedelta(seconds=float(x) * scale) for x in ds[:]])
    out = [None]
    for axis in axes:  # run time + lead time, in C order like the data
        out = [a if t is None else t + a for t in out for a in axis]
    return out


def read_point(files: list, lat: float, lon: float) -> list:
    """Samples at the grid point nearest (lat, lon): dicts of UTC time and pm25 (µg/m³), pm10, aod, dust, om, bc."""
    import h5py

    by_time = defaultdict(dict)
    for raw in files:
        with h5py.File(io.BytesIO(raw), "r") as f:
            lats, lons = f["latitude"][:], f["longitude"][:]
            i = min(range(len(lats)), key=lambda k: abs(lats[k] - lat))
            j = min(range(len(lons)), key=lambda k: abs(((lons[k] - lon + 180) % 360) - 180))
            for key, short in SHORT.items():
                if short not in f:
                    continue
                v = f[short]
                times = sample_times(f, v)
                data = v[..., i, j].reshape(-1).astype(float)
                factor = float(v.attrs.get("scale_factor", 1.0))
                offset = float(v.attrs.get("add_offset", 0.0))
                fill = v.attrs.get("_FillValue")
                fill = None if fill is None else float(fill.reshape(-1)[0] if hasattr(fill, "reshape") else fill)
                for t, x in zip(times, data):
                    if math.isnan(x) or (fill is not None and x == fill):
                        continue
                    x = float(x) * factor + offset
                    by_time[t][key] = x * 1e9 if key in ("pm25", "pm10") else x  # kg/m³ → µg/m³
    return [{"time": t, **v} for t, v in sorted(by_time.items())]


# ------------------------------------------------------------------ samples → days


def cause_of(aod: float, dust: float, om: float, bc: float) -> str:
    if not aod or aod <= 0:
        return "smog"
    if dust / aod >= 0.5:
        return "dust"
    if (om + bc) / aod >= 0.5:
        return "smoke"
    return "smog"


def daily_values(samples: list, utc_offset_hours: float) -> dict:
    """{local date: {pm25, pm10, aqi, psi, cause}} for local days with all 8 samples."""
    by_day = defaultdict(list)
    for s in samples:
        if s.get("pm25") is None:
            continue
        local = s["time"] + timedelta(hours=utc_offset_hours)
        by_day[local.date().isoformat()].append(s)
    out = {}
    for day, ss in sorted(by_day.items()):
        if len(ss) != len(TIMES):
            continue
        pm25 = sum(s["pm25"] for s in ss) / len(ss)
        mean = lambda k: sum(s.get(k) or 0.0 for s in ss) / len(ss)
        out[day] = {
            "pm25": round(pm25, 1),
            "pm10": round(mean("pm10"), 1),
            "aqi": aqi_pm25(pm25),
            "psi": psi_pm25(pm25),
            "cause": cause_of(mean("aod"), mean("dust"), mean("om"), mean("bc")),
        }
    return out


def summary(days: dict) -> dict:
    aqis = [d["aqi"] for d in days.values()]
    bad = [d for d in days.values() if d["aqi"] >= BAD_AQI]
    causes = Counter(d["cause"] for d in (bad or days.values()))
    return {
        "days": len(aqis),
        "typical": round(statistics.median(aqis)) if aqis else None,
        "worst": max(aqis) if aqis else None,
        "bad_share": len(bad) / len(aqis) if aqis else 0.0,
        "cause": causes.most_common(1)[0][0] if causes else None,
        "psi_typical": round(statistics.median(d["psi"] for d in days.values())) if days else None,
    }


# ------------------------------------------------------------------ AQICN reference


def read_aqicn(text: str) -> dict:
    """{date: PM2.5 AQI} from an AQICN historical CSV ('date, pm25, pm10, …', dates like 2019/9/1)."""
    reader = csv.reader(io.StringIO(text))
    header = [h.strip().lower() for h in next(reader)]
    if "date" not in header or "pm25" not in header:
        raise ValueError(f"Not an AQICN historical CSV (columns: {header})")
    di, pi = header.index("date"), header.index("pm25")
    out = {}
    for row in reader:
        if len(row) <= max(di, pi) or not row[pi].strip():
            continue
        y, m, d = (int(x) for x in re.split(r"[/-]", row[di].strip()))
        out[date(y, m, d).isoformat()] = int(float(row[pi]))
    return out


def pearson(xs: list, ys: list):
    """Correlation, or None when either side doesn't vary (statistics.correlation needs Python 3.10)."""
    mx, my = statistics.mean(xs), statistics.mean(ys)
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if not sx or not sy:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)


def compare(days: dict, ref: dict) -> dict:
    """CAMS vs AQICN on the days both have."""
    common = sorted(set(days) & set(ref))
    if not common:
        return {"days": 0}
    cams = [days[d]["aqi"] for d in common]
    obs = [ref[d] for d in common]
    hits = sum(1 for c, o in zip(cams, obs) if c >= BAD_AQI and o >= BAD_AQI)
    misses = sum(1 for c, o in zip(cams, obs) if c < BAD_AQI <= o)
    false = sum(1 for c, o in zip(cams, obs) if o < BAD_AQI <= c)
    r = pearson(cams, obs) if len(common) > 2 else None
    return {
        "days": len(common),
        "cams_typical": round(statistics.median(cams)),
        "aqicn_typical": round(statistics.median(obs)),
        "bias": round(statistics.mean(c - o for c, o in zip(cams, obs)), 1),
        "r": None if r is None else round(r, 2),
        "hits": hits,
        "misses": misses,
        "false": false,
    }


# ------------------------------------------------------------------ main


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--only", help="run the cases whose id starts with this")
    ap.add_argument("--reference", action="append", default=[], metavar="CITY=CSV",
                    help="AQICN historical CSV for a city, e.g. singapore=~/Downloads/singapore.csv (repeatable)")
    ap.add_argument("--days", action="store_true", help="print every day")
    ap.add_argument("--source", choices=["reanalysis", "forecast"], default="reanalysis",
                    help="CAMS reanalysis EAC4 (default) or the archive of CAMS forecasts (2015 on)")
    ap.add_argument("--cache", default=str(ROOT / "data" / "cams-validate"))
    args = ap.parse_args()

    refs = {}
    for item in args.reference:
        city, _, path = item.partition("=")
        refs[city.strip().lower()] = read_aqicn(Path(path).expanduser().read_text(encoding="utf-8-sig"))
    cases = [c for c in CASES if not args.only or c[0].startswith(args.only)]
    if not cases:
        sys.exit(f"No case id starts with {args.only!r}.")
    client = None
    for cid, name, lat, lon, offset, month, expect in cases:
        if args.source == "forecast" and month < "2015-01":
            continue
        target = Path(args.cache) / f"{'fc-' if args.source == 'forecast' else ''}{cid}.zip"
        if target.exists():
            raw = target.read_bytes()
        else:
            client = client or ads_client()
            print(f"{cid}: downloading…", flush=True)
            try:
                raw = download(client, lat, lon, month, target, args.source)
            except Exception as e:  # one case failing shouldn't stop the rest
                print(f"{cid}: failed ({e})", flush=True)
                continue
        days = {d: v for d, v in daily_values(read_point(netcdf_files(raw), lat, lon), offset).items() if d.startswith(month)}
        s = summary(days)
        print(f"\n{name}, {month}  (expect: {expect})")
        if not s["days"]:
            print("  no complete days")
            continue
        print(f"  typical AQI {s['typical']} ({band(s['typical'])}), PSI ≈ {s['psi_typical']} · worst {s['worst']} ({band(s['worst'])})")
        print(f"  bad-air days {s['bad_share']:.0%} of {s['days']} · main cause {s['cause']}")
        ref = refs.get(cid.rsplit("-", 2)[0])
        if ref is not None:
            c = compare(days, ref)
            if c["days"]:
                print(f"  vs AQICN ({c['days']} days): typical {c['cams_typical']} vs {c['aqicn_typical']}, bias {c['bias']:+}, r {c['r']}")
                print(f"  bad-air days: both {c['hits']}, missed by CAMS {c['misses']}, CAMS only {c['false']}")
            else:
                print("  vs AQICN: no days in common (check the CSV covers this month)")
        if args.days:
            for d, v in days.items():
                obs = f"  AQICN {ref[d]}" if ref and d in ref else ""
                print(f"    {d}  PM2.5 {v['pm25']:6.1f}  AQI {v['aqi']:3}  PSI {v['psi']:3}  {v['cause']}{obs}")


if __name__ == "__main__":
    main()
