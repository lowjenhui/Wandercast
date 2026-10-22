"""Tests for scripts/import-era5-cds.py: python3 scripts/test_import_era5_cds.py"""

import importlib.util
import io
import sqlite3
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("cds", Path(__file__).with_name("import-era5-cds.py"))
cds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cds)


def csv_bytes(start_hour_utc: str, hours: int, t_k=300.15, d_k=295.15, tp_m=0.0005, u=3.0, v=4.0, ssrd=3_600_000.0) -> bytes:
    from datetime import datetime, timedelta

    t0 = datetime.fromisoformat(start_hour_utc)
    lines = ["valid_time,latitude,longitude,t2m,d2m,tp,u10,v10,ssrd"]
    for i in range(hours):
        when = (t0 + timedelta(hours=i)).strftime("%Y-%m-%d %H:%M:%S")
        lines.append(f"{when},13.75,100.5,{t_k + (i % 24) / 10},{d_k},{tp_m},{u},{v},{ssrd}")
    return "\n".join(lines).encode()


class Formulas(unittest.TestCase):
    def test_relative_humidity(self):
        self.assertEqual(cds.relative_humidity(25, 25), 100)
        self.assertAlmostEqual(cds.relative_humidity(30, 20), 55.1, delta=0.2)

    def test_apparent_temperature(self):
        # No wind, no sunshine above 550 W/m²: t + 0.348 e − 4.25.
        e = 0.5 * 6.105 * 2.718281828 ** (17.27 * 30 / (237.7 + 30))
        self.assertAlmostEqual(cds.apparent_temperature(30, 50, 0, 0), 30 + 0.348 * e - 4.25, places=4)
        # Wind cools, strong sunshine warms.
        self.assertLess(cds.apparent_temperature(30, 50, 10, 0), cds.apparent_temperature(30, 50, 0, 0))
        self.assertGreater(cds.apparent_temperature(30, 50, 0, 900), cds.apparent_temperature(30, 50, 0, 0))


class Days(unittest.TestCase):
    def test_local_days_from_hours(self):
        # 72 UTC hours at UTC+7 cover local 1 Jan 07:00 to 4 Jan 06:00: the partial first and last
        # local days are dropped.
        hours = cds.read_hours(csv_bytes("2024-01-01 00:00:00", 72))
        days = cds.daily_values(hours, 7 * 3600)
        self.assertEqual(sorted(days), ["2024-01-02", "2024-01-03"])
        d = days["2024-01-02"]
        self.assertEqual(d["precip"], 12.0)  # 24 × 0.5 mm
        self.assertEqual(d["tmax"], 29.3)  # 300.15 K + 2.3
        self.assertEqual(d["tmin"], 27.0)
        self.assertIsNotNone(d["rh"])
        self.assertIsNotNone(d["atmax"])
        self.assertGreaterEqual(d["atmax"], d["atmin"])

    def test_zipped_csv_and_missing_wind(self):
        raw = csv_bytes("2024-01-01 00:00:00", 24).replace(b",3.0,4.0,", b",,,")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("data.csv", raw)
        days = cds.daily_values(cds.read_hours(buf.getvalue()), 0)
        self.assertEqual(list(days), ["2024-01-01"])
        self.assertIsNone(days["2024-01-01"]["atmax"])  # left for Open-Meteo
        self.assertIsNotNone(days["2024-01-01"]["rh"])


class Corrections(unittest.TestCase):
    def test_rain_moves_back_an_hour(self):
        # Rain stamped 00:00 UTC on 2 Jan fell in the last hour of 1 Jan.
        lines = csv_bytes("2024-01-01 00:00:00", 48, tp_m=0).decode().split("\n")
        lines[25] = lines[25].replace(",0,3.0,", ",0.01,3.0,")  # 2024-01-02 00:00
        days = cds.daily_values(cds.read_hours("\n".join(lines).encode()), 0)
        self.assertEqual(days["2024-01-01"]["precip"], 10.0)
        self.assertIsNone(days["2024-01-02"]["precip"])  # its last hour's rain isn't in the download
        self.assertIsNotNone(days["2024-01-02"]["atmax"])  # sunshine isn't moved

    def test_height_correction(self):
        hours = cds.read_hours(csv_bytes("2024-01-01 00:00:00", 24 * 40))
        raw = cds.daily_values(hours, 0)
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE era5_daily (lat REAL, lon REAL, date TEXT, tmax REAL, tmin REAL, source TEXT)")
        db.executemany("INSERT INTO era5_daily VALUES (1, 2, ?, ?, ?, NULL)", [(d, v["tmax"] + 1.7, v["tmin"] + 1.6) for d, v in raw.items()])
        p = {"lat": 1, "lon": 2}
        self.assertEqual(cds.height_correction(db, p, raw), 1.65)
        fixed = cds.daily_values(hours, 0, 1.65)
        self.assertAlmostEqual(fixed["2024-01-05"]["tmax"], raw["2024-01-05"]["tmax"] + 1.65, delta=0.06)
        self.assertEqual(fixed["2024-01-05"]["rh"], raw["2024-01-05"]["rh"])  # humidity uncorrected
        self.assertIsNone(cds.height_correction(db, p, dict(list(raw.items())[:10])))  # too few days


class Storage(unittest.TestCase):
    def test_never_changes_a_stored_value_and_only_fills_blanks(self):
        db = sqlite3.connect(":memory:")
        db.execute(
            "CREATE TABLE era5_daily (lat REAL, lon REAL, date TEXT, precip REAL, tmax REAL, tmin REAL, rh REAL, "
            "atmax REAL, atmin REAL, snow REAL, source TEXT, PRIMARY KEY (lat, lon, date))"
        )
        db.execute("INSERT INTO era5_daily VALUES (1, 2, '2024-01-01', 9, 9, 9, 9, 9, 9, 0, NULL)")  # Open-Meteo
        db.execute("INSERT INTO era5_daily VALUES (1, 2, '2023-12-31', 9, 9, 9, 9, NULL, NULL, NULL, NULL)")  # before feels-like
        p = {"lat": 1, "lon": 2}
        v = {"precip": 1, "tmax": 30, "tmin": 20, "rh": 70, "atmax": None, "atmin": None}
        self.assertEqual(cds.complete_days(db, p, "2023-12-31", "2024-01-02"), 1)
        cds.store(db, p, {"2023-12-31": {**v, "atmax": 35, "atmin": 25}, "2024-01-01": v, "2024-01-02": v})
        rows = db.execute("SELECT date, tmax, atmax, snow, source FROM era5_daily ORDER BY date").fetchall()
        self.assertEqual(rows, [("2023-12-31", 9, 35, None, None), ("2024-01-01", 9, 9, 0, None), ("2024-01-02", 30, None, None, "cds")])
        cds.store(db, p, {"2024-01-02": {**v, "tmax": 99, "atmax": 33}})
        self.assertEqual(db.execute("SELECT tmax, atmax FROM era5_daily WHERE date = '2024-01-02'").fetchone(), (30, 33))


if __name__ == "__main__":
    unittest.main()
