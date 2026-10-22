"""Build public/rainfall-normals.{bin,json} from NOAA PSL's GPCP v2.3 monthly long-term means.

Source (≈680 KB, netCDF-4):
  https://downloads.psl.noaa.gov/Datasets/gpcp/precip.mon.ltm.1991-2020.nc

Usage (needs numpy + h5py, e.g. in a throwaway virtualenv):
  python3 scripts/build-rainfall.py path/to/precip.mon.ltm.1991-2020.nc

Output: 12 × 72 × 144 little-endian uint16 values, mean rainfall in mm per month
(month-major, then latitude north → south, then longitude 1.25 → 358.75 °E), plus a small
JSON file describing the grid and the source.
"""

import json
import sys
from pathlib import Path

import h5py
import numpy as np

DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def main(src: str) -> None:
    out = Path(__file__).resolve().parent.parent / "public"
    with h5py.File(src, "r") as f:
        lat = f["lat"][:].astype(float)
        lon = f["lon"][:].astype(float)
        p = f["precip"][:].astype(float)  # (12, lat, lon) mm/day
        missing = float(f["precip"].attrs["missing_value"][0])
        period = f["time"].attrs["climo_period"].decode()
        title = f.attrs["title"].decode()
    if lat[0] < lat[-1]:  # ensure north → south
        lat = lat[::-1]
        p = p[:, ::-1, :]
    p[p <= missing / 2] = 0
    mm = np.rint(p * np.array(DAYS)[:, None, None]).clip(0, 65535).astype("<u2")
    (out / "rainfall-normals.bin").write_bytes(mm.tobytes())
    meta = {
        "source": {
            "name": f"{title} — monthly long-term mean {period}",
            "url": "https://psl.noaa.gov/data/gridded/data.gpcp.html",
            "citation": "Adler et al. (2003), J. Hydrometeor. 4, 1147–1167; data provided by NOAA PSL, Boulder, Colorado, USA.",
        },
        "units": "mm/month",
        "lat0": float(lat[0]),
        "dlat": float(lat[1] - lat[0]),
        "nlat": int(len(lat)),
        "lon0": float(lon[0]),
        "dlon": float(lon[1] - lon[0]),
        "nlon": int(len(lon)),
        "months": 12,
        "max": int(mm.max()),
    }
    (out / "rainfall-normals.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {mm.nbytes} bytes; max {meta['max']} mm/month; grid {meta['nlat']}×{meta['nlon']}")


if __name__ == "__main__":
    main(sys.argv[1])
