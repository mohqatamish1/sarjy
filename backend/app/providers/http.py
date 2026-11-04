"""Small, bounded retry policy shared by external HTTP integrations."""

import logging
import math
import random
import time
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

import httpx

logger = logging.getLogger(__name__)
TRANSIENT = {429, 500, 502, 503, 504}


def retry_delay(value: str | None, attempt: int) -> float:
    if value:
        try:
            seconds = float(value)
            return max(0, seconds) if math.isfinite(seconds) else float("inf")
        except ValueError:
            try:
                return max(0, (parsedate_to_datetime(value) - datetime.now(UTC)).total_seconds())
            except (ValueError, TypeError, OverflowError):
                pass
    return 0.3 * 2**attempt + random.uniform(0, 0.2)


def request_with_retry(client, method, url, *, budget=20.0, attempts=3, **kwargs):
    deadline = time.monotonic() + budget
    for attempt in range(attempts):
        remaining = deadline - time.monotonic()
        try:
            response = client.request(
                method,
                url,
                timeout=httpx.Timeout(max(0.1, min(12, remaining)), connect=5),
                **kwargs,
            )
        except (httpx.ConnectError, httpx.ConnectTimeout):
            # Connection failures happen before the inference request is accepted.
            if attempt == attempts - 1:
                raise
            delay = retry_delay(None, attempt)
            if deadline - time.monotonic() <= delay + 0.1:
                raise
        else:
            if response.status_code not in TRANSIENT or attempt == attempts - 1:
                return response
            delay = retry_delay(response.headers.get("retry-after"), attempt)
            # Never shorten Retry-After. Return an actionable failure if it exceeds our budget.
            if deadline - time.monotonic() <= delay + 0.1:
                return response
            logger.warning(
                "External request retry: status=%s attempt=%s", response.status_code, attempt + 1
            )
            response.close()
        time.sleep(delay)
    raise RuntimeError("Retry policy exhausted")
