import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { MongoClient } from "mongodb";
import { encode } from "next-auth/jwt";

const database = process.env.INSIGHTS_BENCHMARK_DATABASE || "caipe_insights_benchmark";
const mongoUri = process.env.INSIGHTS_BENCHMARK_MONGODB_URI;
const baseUrl = process.env.INSIGHTS_BENCHMARK_URL || "http://127.0.0.1:3107";
const output = process.env.INSIGHTS_BENCHMARK_REPORT || "/private/tmp/caipe-insights-cache-benchmark.json";
const seed = process.argv.includes("--seed");

if (seed) {
  if (!mongoUri || !["localhost", "127.0.0.1"].includes(new URL(mongoUri).hostname) || !database.endsWith("_benchmark")) {
    throw new Error("Seeding requires a loopback MongoDB URI and a database name ending in _benchmark");
  }
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db(database);
    const now = Date.now();
    const date = (index) => new Date(now - (index % 2_500_000) * 1000);
    const email = (index) => `test-user-${index % 25}@example.test`;
    const specifications = [
      ["conversations", Number(process.env.INSIGHTS_BENCHMARK_CONVERSATIONS || 100_000), (index) => ({
        _id: `example-conversation-${index}`, owner_id: email(index), source: "web", client_type: "webui",
        title: "Example conversation", created_at: date(index), updated_at: date(index),
      })],
      ["messages", Number(process.env.INSIGHTS_BENCHMARK_MESSAGES || 1_000_000), (index) => ({
        _id: `example-message-${index}`, conversation_id: `example-conversation-${index % 100_000}`,
        owner_id: email(index), role: "assistant", created_at: date(index),
        metadata: { source: "web", agent_name: "example", latency_ms: 200 + index % 800 },
      })],
      ["feedback", Number(process.env.INSIGHTS_BENCHMARK_FEEDBACK || 100_000), (index) => ({
        _id: `example-feedback-${index}`, conversation_id: `example-conversation-${index % 100_000}`,
        source: "web", rating: index % 5 ? "positive" : "negative", value: index % 5 ? "thumbs_up" : "thumbs_down",
        user_email: email(index), comment: "Example feedback", created_at: date(index),
      })],
    ];
    for (const [name, count, record] of specifications) {
      if (!Number.isInteger(count) || count < 1) throw new Error("Dataset sizes must be positive integers");
      const collection = db.collection(name);
      await collection.deleteMany({});
      for (let start = 0; start < count; start += 5000) {
        await collection.insertMany(Array.from({ length: Math.min(5000, count - start) }, (_, offset) => record(start + offset)));
      }
      console.log(`${name}: ${await collection.countDocuments({})} synthetic records`);
    }
  } finally {
    await client.close();
  }
  process.exit(0);
}

if (!process.env.NEXTAUTH_SECRET) throw new Error("NEXTAUTH_SECRET must match the local UI server");
if (!["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname)) throw new Error("Benchmark target must be loopback");
const endpoints = [
  "/api/admin/stats?section=overview&range=30d",
  "/api/admin/stats?section=feedback&range=30d",
  "/api/admin/stats?section=top_users&range=30d",
  "/api/admin/feedback?range=30d&page=1&limit=50",
];
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
const report = { recordedAt: new Date().toISOString(), runtime: "local UI; record server mode and authorization configuration with results", database, endpoints, runs: [] };

for (const users of [1, 10, 25]) {
  const cookies = await Promise.all(Array.from({ length: users }, async (_, index) => encode({
    secret: process.env.NEXTAUTH_SECRET,
    maxAge: 3600,
    token: {
      sub: `benchmark-user-${index}`, name: "Test User", email: `test-user-${index}@example.test`,
      accessToken: "local-benchmark-access-token", expiresAt: Math.floor(Date.now() / 1000) + 3600,
      isAuthorized: true, role: "admin", org: "caipe",
    },
  })));

  for (const phase of ["cold", "warm"]) {
    const samples = [];
    const failures = [];
    const states = {};
    const started = performance.now();
    await Promise.all(cookies.map(async (cookie) => {
      const rounds = phase === "cold" ? 1 : 10;
      for (let round = 0; round < rounds; round++) {
        await Promise.all(endpoints.map(async (endpoint) => {
          const requestStarted = performance.now();
          const response = await fetch(`${baseUrl}${endpoint}${phase === "cold" ? "&refresh=true" : ""}`, {
            headers: { Cookie: `next-auth.session-token=${cookie}` }, signal: AbortSignal.timeout(30_000),
          });
          const payload = await response.json();
          samples.push(performance.now() - requestStarted);
          const state = response.headers.get("x-caipe-cache") || "none";
          states[state] = (states[state] || 0) + 1;
          if (!response.ok || payload.success !== true) failures.push({ endpoint, status: response.status, error: payload.error });
        }));
      }
    }));
    const run = {
      users, phase, requests: samples.length, failures: failures.length,
      p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), p99Ms: percentile(samples, 0.99),
      maxMs: Math.max(...samples), requestsPerSecond: samples.length / ((performance.now() - started) / 1000), states,
      ...(failures.length ? { errors: failures.slice(0, 10) } : {}),
    };
    report.runs.push(run);
    console.log(JSON.stringify(run));
  }
}
await mkdir(new URL(".", `file://${output}`).pathname, { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
if (report.runs.some((run) => run.failures)) process.exitCode = 1;
