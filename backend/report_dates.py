"""Local-calendar reporting boundaries converted to UTC.

The client passes JavaScript Date.getTimezoneOffset() (UTC minus local time).
"""
from datetime import datetime, timedelta, timezone
from typing import Optional


def range_start(
    range_: str,
    tz_offset_minutes: int = 0,
    now_utc: Optional[datetime] = None,
) -> Optional[datetime]:
    now = now_utc or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    else:
        now = now.astimezone(timezone.utc)
    local_now = now - timedelta(minutes=tz_offset_minutes)

    if range_ in ("today", "day"):
        local_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
        return local_start + timedelta(minutes=tz_offset_minutes)
    if range_ == "week":
        local_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
        local_start -= timedelta(days=local_start.weekday())
        return local_start + timedelta(minutes=tz_offset_minutes)
    if range_ == "month":
        local_start = local_now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return local_start + timedelta(minutes=tz_offset_minutes)
    if range_ == "year":
        local_start = local_now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
        return local_start + timedelta(minutes=tz_offset_minutes)
    if range_.startswith("month:"):
        local_month = datetime.strptime(range_.split(":", 1)[1], "%Y-%m").replace(tzinfo=timezone.utc)
        return local_month + timedelta(minutes=tz_offset_minutes)
    if range_.startswith("year:"):
        year = int(range_.split(":", 1)[1])
        return datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=tz_offset_minutes)
    return None


def range_end(
    range_: str,
    tz_offset_minutes: int = 0,
    now_utc: Optional[datetime] = None,
) -> Optional[datetime]:
    now = now_utc or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    else:
        now = now.astimezone(timezone.utc)
    local_now = now - timedelta(minutes=tz_offset_minutes)
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)

    if range_ in ("today", "day"):
        return local_midnight + timedelta(days=1, minutes=tz_offset_minutes)
    if range_ == "week":
        local_start = local_midnight - timedelta(days=local_midnight.weekday())
        return local_start + timedelta(days=7, minutes=tz_offset_minutes)
    if range_ == "month":
        if local_midnight.month == 12:
            next_month = datetime(local_midnight.year + 1, 1, 1, tzinfo=timezone.utc)
        else:
            next_month = datetime(local_midnight.year, local_midnight.month + 1, 1, tzinfo=timezone.utc)
        return next_month + timedelta(minutes=tz_offset_minutes)
    if range_ == "year":
        return datetime(local_midnight.year + 1, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=tz_offset_minutes)
    if range_.startswith("month:"):
        local_month = datetime.strptime(range_.split(":", 1)[1], "%Y-%m").replace(tzinfo=timezone.utc)
        if local_month.month == 12:
            next_month = datetime(local_month.year + 1, 1, 1, tzinfo=timezone.utc)
        else:
            next_month = datetime(local_month.year, local_month.month + 1, 1, tzinfo=timezone.utc)
        return next_month + timedelta(minutes=tz_offset_minutes)
    if range_.startswith("year:"):
        year = int(range_.split(":", 1)[1])
        return datetime(year + 1, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=tz_offset_minutes)
    return None
