import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))
from report_dates import range_end, range_start


class ReportDateBoundaryTests(unittest.TestCase):
    def test_karachi_local_day_maps_to_correct_utc_boundaries(self):
        # 2026-11-07 20:00 UTC is 2026-11-08 01:00 in Karachi.
        now = datetime(2026, 11, 7, 20, 0, tzinfo=timezone.utc)
        offset = -300  # JavaScript getTimezoneOffset() for UTC+5
        start = range_start("today", offset, now)
        end = range_end("today", offset, now)
        self.assertEqual(start, datetime(2026, 11, 7, 19, 0, tzinfo=timezone.utc))
        self.assertEqual(end, datetime(2026, 11, 8, 19, 0, tzinfo=timezone.utc))
        self.assertEqual((end - start).total_seconds(), 86400)

    def test_karachi_week_uses_monday_local_midnight(self):
        now = datetime(2026, 11, 7, 20, 0, tzinfo=timezone.utc)  # Saturday local
        offset = -300
        start = range_start("week", offset, now)
        end = range_end("week", offset, now)
        self.assertEqual(start, datetime(2026, 11, 1, 19, 0, tzinfo=timezone.utc))
        self.assertEqual(end, datetime(2026, 11, 8, 19, 0, tzinfo=timezone.utc))

    def test_named_month_boundaries_use_local_timezone(self):
        offset = -300
        start = range_start("month:2026-11", offset)
        end = range_end("month:2026-11", offset)
        self.assertEqual(start, datetime(2026, 10, 31, 19, 0, tzinfo=timezone.utc))
        self.assertEqual(end, datetime(2026, 11, 30, 19, 0, tzinfo=timezone.utc))


if __name__ == "__main__":
    unittest.main()
