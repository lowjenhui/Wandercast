"""Build public/rainfall-asia.{bin,json}: ERA5 monthly rainfall normals, 1991–2020, at 0.25°
for Asia and Australia (45 °S–55 °N, 60–155 °E, so all of Hokkaido, northeast China and
Australia's east coast are inside). The map switches to this grid from regional zoom so
coasts with opposite monsoons (Sri Lanka, peninsular Malaysia, Thailand, Vietnam, the
Philippines) show apart; the global GPCP grid (build-rainfall.py) stays for the world view.

Source: Copernicus Climate Data Store, "ERA5 monthly averaged data on single levels from 1940
to present" (reanalysis-era5-single-levels-monthly-means), total precipitation, monthly
averaged reanalysis. Needs the same ~/.cdsapirc key as import-era5-cds.py and the dataset's
licence accepted on its Download page.

Usage (needs numpy + h5py; cdsapi only for --download):
  python3 scripts/build-rainfall-era5.py --download era5-tp-asia.nc   # fetch (≈60 MB), then build
  python3 scripts/build-rainfall-era5.py era5-tp-asia.nc              # build from a saved file

Output: 12 × 401 × 381 little-endian uint16 values (≈3.7 MB), mean rainfall in mm per month (month-major,
then latitude north → south, then longitude west → east), plus a JSON file describing the grid.
"""

import argparse
import calendar
import json
from pathlib import Path

import numpy as np

DATASET = "reanalysis-era5-single-levels-monthly-means"
YEARS = range(1991, 2021)
AREA = [55, 60, -45, 155]  # N, W, S, E


def download(target: Path) -> None:
    import cdsapi

    request = {
        "product_type": ["monthly_averaged_reanalysis"],
        "variable": ["total_precipitation"],
        "year": [str(y) for y in YEARS],
        "month": [f"{m:02d}" for m in range(1, 13)],
        "time": ["00:00"],
        "area": AREA,
        "data_format": "netcdf",
        "download_format": "unarchived",
    }
    cdsapi.Client(quiet=True, progress=False).retrieve(DATASET, request).download(str(target))


def read(src: Path):
    import h5py

    with h5py.File(src, "r") as f:
        lat = f["latitude"][:].astype(float)
        lon = f["longitude"][:].astype(float)
        tv = "valid_time" if "valid_time" in f else "time"
        t = f[tv][:].astype("int64")  # seconds since 1970-01-01
        v = f["tp"]
        tp = v[:].astype(float)
        scale = float(v.attrs.get("scale_factor", 1.0))
        offset = float(v.attrs.get("add_offset", 0.0))
        fill = v.attrs.get("_FillValue")
        if fill is not None:
            tp[tp == float(np.asarray(fill).ravel()[0])] = np.nan
        tp = tp * scale + offset
    if tp.ndim == 4:  # (time, expver, lat, lon) in some older files
        tp = np.nanmax(tp, axis=1)
    return lat, lon, t, tp


def normals(t, tp) -> np.ndarray:
    """Mean mm per calendar month: ERA5 monthly means are metres per day."""
    dates = t.astype("datetime64[s]").astype(object)
    sums = np.zeros((12,) + tp.shape[1:])
    counts = np.zeros(12)
    for k, d in enumerate(dates):
        days = calendar.monthrange(d.year, d.month)[1]
        sums[d.month - 1] += np.nan_to_num(tp[k]) * 1000 * days
        counts[d.month - 1] += 1
    if counts.min() == 0:
        raise SystemExit("Some months have no data: check the download covers every month.")
    return sums / counts[:, None, None]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="ERA5 netCDF file (written first with --download)")
    ap.add_argument("--download", action="store_true", help="fetch the file from the CDS first")
    a = ap.parse_args()
    src = Path(a.src)
    if a.download:
        download(src)
    lat, lon, t, tp = read(src)
    mm = normals(t, tp)
    if lat[0] < lat[-1]:
        lat = lat[::-1]
        mm = mm[:, ::-1, :]
    grid = np.rint(mm).clip(0, 65535).astype("<u2")
    out = Path(__file__).resolve().parent.parent / "public"
    (out / "rainfall-asia.bin").write_bytes(grid.tobytes())
    years = sorted({d.year for d in t.astype("datetime64[s]").astype(object)})
    meta = {
        "source": {
            "name": f"ERA5 monthly averaged reanalysis, total precipitation — mean {years[0]}–{years[-1]}",
            "url": "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels-monthly-means",
            "citation": "Hersbach et al. (2023): ERA5 monthly averaged data on single levels from 1940 to present. Copernicus Climate Change Service (C3S) Climate Data Store, DOI 10.24381/cds.f17050d7.",
        },
        "units": "mm/month",
        "lat0": float(lat[0]),
        "dlat": float(lat[1] - lat[0]),
        "nlat": int(len(lat)),
        "lon0": float(lon[0]),
        "dlon": float(lon[1] - lon[0]),
        "nlon": int(len(lon)),
        "months": 12,
        "max": int(grid.max()),
    }
    (out / "rainfall-asia.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {grid.nbytes} bytes; max {meta['max']} mm/month; grid {meta['nlat']}×{meta['nlon']}")


if __name__ == "__main__":
    main()
