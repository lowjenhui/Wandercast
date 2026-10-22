"""Tests for scripts/validate-cams.py: python3 scripts/test_validate_cams.py"""

import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location("cams", Path(__file__).with_name("validate-cams.py"))
cams = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cams)


def samples(start_utc: str, n: int, pm25=20.0, aod=0.4, dust=0.02, om=0.25, bc=0.03):
    t0 = datetime.fromisoformat(start_utc).replace(tzinfo=timezone.utc)
    return [{"time": t0 + timedelta(hours=3 * i), "pm25": pm25, "pm10": pm25 * 1.3, "aod": aod, "dust": dust, "om": om, "bc": bc} for i in range(n)]


class Scales(unittest.TestCase):
    def test_epa_2016_breakpoints(self):
        for c, want in [(0, 0), (12.0, 50), (12.05, 50), (12.1, 51), (35.4, 100), (35.5, 101), (55.4, 150), (55.5, 151), (150.4, 200), (250.4, 300), (600, 500)]:
            self.assertEqual(cams.aqi_pm25(c), want, c)

    def test_psi_runs_lower_than_aqi_in_the_moderate_range(self):
        self.assertEqual(cams.psi_pm25(55.0), 100)
        self.assertEqual(cams.psi_pm25(55.1), 101)
        self.assertEqual(cams.aqi_pm25(40), 112)
        self.assertEqual(cams.psi_pm25(40), 83)

    def test_bands(self):
        self.assertEqual(cams.band(50), "Good")
        self.assertEqual(cams.band(101), "Unhealthy for sensitive groups")
        self.assertEqual(cams.band(420), "Hazardous")


class Cause(unittest.TestCase):
    def test_cause(self):
        self.assertEqual(cams.cause_of(1.0, 0.6, 0.2, 0.02), "dust")
        self.assertEqual(cams.cause_of(1.0, 0.05, 0.5, 0.05), "smoke")
        self.assertEqual(cams.cause_of(1.0, 0.1, 0.2, 0.05), "smog")
        self.assertEqual(cams.cause_of(0.0, 0, 0, 0), "smog")


class Days(unittest.TestCase):
    def test_local_days_need_all_eight_samples(self):
        # UTC+8: local 1 Sep runs 31 Aug 16:00 to 1 Sep 16:00 UTC, i.e. samples 18:00 … 15:00.
        days = cams.daily_values(samples("2019-08-31T00:00", 24), 8)
        self.assertEqual(list(days), ["2019-09-01", "2019-09-02"])  # 31 Aug and 3 Sep are partial
        self.assertEqual(days["2019-09-01"]["aqi"], 68)
        self.assertEqual(days["2019-09-01"]["cause"], "smoke")

    def test_fractional_offset(self):
        days = cams.daily_values(samples("2021-03-01T00:00", 24), 5.75)
        self.assertEqual(list(days), ["2021-03-02", "2021-03-03"])  # local days start at 18:15 UTC

    def test_daily_mean(self):
        s = samples("2019-09-01T00:00", 8)
        for i, x in enumerate(s):
            x["pm25"] = 10.0 + 10 * i  # mean 45
        days = cams.daily_values(s, 0)
        self.assertEqual(days["2019-09-01"]["pm25"], 45.0)
        self.assertEqual(days["2019-09-01"]["aqi"], cams.aqi_pm25(45))

    def test_summary(self):
        days = {f"2019-09-{d:02}": {"aqi": a, "psi": a, "cause": c} for d, (a, c) in enumerate([(40, "smog"), (90, "smog"), (120, "smoke"), (160, "smoke")], 1)}
        s = cams.summary(days)
        self.assertEqual((s["days"], s["worst"], s["bad_share"], s["cause"]), (4, 160, 0.5, "smoke"))
        self.assertEqual(s["typical"], 105)


class Reference(unittest.TestCase):
    CSV = "date, pm25, pm10, o3\n2019/9/1, 80, 30, 10\n2019/9/2, 152, 60, 12\n2019/9/3, , 40, 9\n2019/9/4, 95, 33, 8\n"

    def test_read_aqicn(self):
        self.assertEqual(cams.read_aqicn(self.CSV), {"2019-09-01": 80, "2019-09-02": 152, "2019-09-04": 95})

    def test_rejects_other_csv(self):
        with self.assertRaises(ValueError):
            cams.read_aqicn("time,value\n1,2\n")

    def test_compare(self):
        days = {"2019-09-01": {"aqi": 70}, "2019-09-02": {"aqi": 130}, "2019-09-04": {"aqi": 110}}
        c = cams.compare(days, cams.read_aqicn(self.CSV))
        self.assertEqual((c["days"], c["hits"], c["misses"], c["false"]), (3, 1, 0, 1))
        self.assertEqual(c["bias"], round(((70 - 80) + (130 - 152) + (110 - 95)) / 3, 1))
        self.assertIsNotNone(c["r"])
        self.assertEqual(cams.compare(days, {})["days"], 0)

    def test_pearson(self):
        self.assertAlmostEqual(cams.pearson([1, 2, 3], [2, 4, 6]), 1.0)
        self.assertIsNone(cams.pearson([1, 1, 1], [1, 2, 3]))


class Time(unittest.TestCase):
    def test_units(self):
        scale, epoch = cams.parse_time_units("seconds since 1970-01-01")
        self.assertEqual((scale, epoch.year), (1, 1970))
        scale, epoch = cams.parse_time_units("hours since 1900-01-01 00:00:00.0")
        self.assertEqual((scale, epoch.year), (3600, 1900))


class Cases(unittest.TestCase):
    def test_cases_are_well_formed(self):
        ids = [c[0] for c in cams.CASES]
        self.assertEqual(len(ids), len(set(ids)))
        for cid, _, lat, lon, offset, month, _ in cams.CASES:
            self.assertTrue(cid.endswith(month), cid)
            self.assertLessEqual(month, "2025-12")  # EAC4 ends with last year
            self.assertTrue(-90 <= lat <= 90 and -180 <= lon <= 180)


if __name__ == "__main__":
    unittest.main()
