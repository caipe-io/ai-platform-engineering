# Aggregate application usage

- Enable with server environment `APP_USAGE_ENABLED=true`; disabled by default.
- Counts admitted authenticated `(app)` layout renders, not unique users,
  sessions, successful page loads, or every client-side navigation.
- Next.js `after()` schedules the write after the response; delivery is best
  effort. A terminated process or failed database write can undercount.
- `app_usage_daily` stores one atomic counter per UTC date, with no email,
  subject, session, URL, IP address, or user-agent fields.
- A MongoDB TTL index expires each counter 30 days after its UTC day starts.
  Collection is skipped if index initialization fails. TTL deletion is
  asynchronous; reads also exclude expired rows immediately.
- Admin Insights shows a separate fixed 30-day platform-wide card. Existing
  user/team/date/source filters do not apply to these aggregate counters.
- `GET /api/admin/stats/app-usage` uses the existing `stats` admin-surface
  authorization gate. The card is not mounted in identity simulation.
- Disabling collection also hides retained counts; existing counters still
  expire. No old per-user usage events are copied or migrated.

## Integration test

- The optional `src/lib/__tests__/app-usage.integration.test.ts` uses a
  random test database and accepts loopback-only MongoDB URIs.
- Run against a throwaway MongoDB fixture with
  `--setParameter ttlMonitorSleepSecs=1`, setting
  `APP_USAGE_TEST_MONGODB_URI` for that test invocation only.
- It verifies concurrent increments, stored fields, the TTL index, immediate
  query exclusion, and physical expiry. Remove the fixture afterward; never
  point this test at a shared or environment database.
