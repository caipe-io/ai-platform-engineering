# Insights cache benchmark

Recorded October 15, 2026. This local synthetic benchmark checks shared admin
cache behavior under concurrent requests; it does not predict production latency.

## Setup

- One Next.js development server using Turbopack, Node 24.11.1.
- Local MongoDB 7 and Redis 7.2 containers.
- 100,000 conversations, 1,000,000 assistant messages, 100,000 feedback rows.
- 25 distinct synthetic admin sessions; authorization bypass enabled locally.
  Production authorization-service latency is excluded.
- Four endpoints per user: Statistics overview, feedback summary, Top Users,
  and the first Feedback page. All use the relative `30d` range.
- Cold phase requests `refresh=true`; warm phase repeats each endpoint ten times.
  The first cold run includes development compilation overhead.

## Results

| Users | Phase | Requests | Errors | p50 (ms) | p95 (ms) | p99 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Cold | 4 | 0 | 526 | 3,673 | 3,673 |
| 1 | Warm | 40 | 0 | 9 | 20 | 22 |
| 10 | Cold | 40 | 0 | 348 | 3,581 | 3,582 |
| 10 | Warm | 400 | 0 | 93 | 113 | 217 |
| 25 | Cold | 100 | 0 | 640 | 3,818 | 3,819 |
| 25 | Warm | 1,000 | 0 | 155 | 300 | 1,119 |

- All warm responses reported `x-caipe-cache: hit`.
- At 25 users, 94 of 100 cold responses shared a concurrent computation.
- The initial message leaderboard query exceeded the 15-second database deadline.
  Grouping messages by conversation and owner before the identity join reduced
  join work while preserving message weights. A separate HTTP check confirmed
  25 ranked users and 40,000 messages per user in this dataset.
- This run covers one UI process. Cross-process lease, restart, and Redis failure
  behavior belongs to the shared cache integration checks.

## Reproduce

Use disposable local MongoDB and Redis instances. Start the UI against the
benchmark database with a matching `NEXTAUTH_SECRET`, local development admin
access, and the cache Redis URL. Keep authorization bypass confined to local work.

```bash
cd ui
INSIGHTS_BENCHMARK_MONGODB_URI=mongodb://127.0.0.1:27017 \
  node scripts/benchmark-insights-cache.mjs --seed
NEXTAUTH_SECRET=local-benchmark-secret node scripts/benchmark-insights-cache.mjs
```

Seeding requires a loopback MongoDB URI and a database ending in `_benchmark`.
It replaces the three synthetic collections in that database. The load script
also requires a loopback UI URL (default `http://127.0.0.1:3107`) and writes raw
results to `/private/tmp/caipe-insights-cache-benchmark.json`.
