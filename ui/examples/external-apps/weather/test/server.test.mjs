// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { createWeatherServer } from "../server.mjs";
import { bearer, mintTestToken, TEST_SECRET } from "./helpers.mjs";

const dashboard = {
  attribution: {
    name: "Open-Meteo",
    url: "https://open-meteo.com/",
    license: "CC BY 4.0",
    transformed: true,
  },
  location: { name: "Example City", region: "Example Region", country: "Example Country" },
  observedAt: "2026-09-04T10:00",
  current: {
    temperatureC: 20,
    apparentC: 19,
    humidityPercent: 52,
    windKmh: 12,
    weatherCode: 2,
    condition: "Partly cloudy",
  },
  daily: [],
  airQuality: { available: true, usAqi: 34, category: "Good", pm25: 5.5, ozone: 48 },
};

test("leaves health unauthenticated but authenticates every other route", async () => {
  await withServer(async (origin) => {
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, appId: "weather" });

    const healthHead = await fetch(`${origin}/healthz`, { method: "HEAD" });
    assert.equal(healthHead.status, 200);
    assert.equal(await healthHead.text(), "");

    const healthPost = await fetch(`${origin}/healthz`, { method: "POST" });
    assert.equal(healthPost.status, 401);

    for (const path of ["/", "/assets/app.css", "/api/weather", "/not-a-route"]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 401, path);
      assert.match(response.headers.get("www-authenticate") || "", /agentic-app:weather/);
    }
  });
});

test("serves a base-path-safe page, assets, and read API with weather:read", async () => {
  const cities = [];
  await withServer(
    async (origin) => {
      const headers = {
        ...bearer(mintTestToken()),
        "x-forwarded-prefix": "/apps/weather",
      };
      const page = await fetch(`${origin}/`, { headers });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /href="\/apps\/weather\/assets\/app\.css"/);
      assert.match(html, /src="\/apps\/weather\/assets\/app\.js"/);
      assert.match(html, /Weather data by Open-Meteo\.com/);
      assert.match(html, /https:\/\/creativecommons\.org\/licenses\/by\/4\.0\//);

      const script = await fetch(`${origin}/apps/weather/assets/app.js`, { headers });
      assert.equal(script.status, 200);
      assert.match(script.headers.get("content-type") || "", /text\/javascript/);
      assert.match(await script.text(), /\/api\/weather/);

      const weather = await fetch(`${origin}/api/weather?city=Example%20City`, { headers });
      assert.equal(weather.status, 200);
      assert.deepEqual(await weather.json(), dashboard);
      assert.deepEqual(cities, ["Example City"]);

      const head = await fetch(`${origin}/assets/app.css`, { method: "HEAD", headers });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
    },
    async (city) => {
      cities.push(city);
      return dashboard;
    },
  );
});

test("enforces read and exact write scopes independently", async () => {
  await withServer(async (origin) => {
    const readHeaders = bearer(mintTestToken({ scopes: ["weather:read"] }));
    const writeHeaders = {
      ...bearer(mintTestToken({ scopes: ["weather:write"] })),
      "content-type": "application/json",
    };

    const deniedWrite = await fetch(`${origin}/api/preferences`, {
      method: "POST",
      headers: { ...readHeaders, "content-type": "application/json" },
      body: JSON.stringify({ units: "us" }),
    });
    assert.equal(deniedWrite.status, 403);
    assert.deepEqual(await deniedWrite.json(), {
      error: "insufficient_scope",
      requiredScope: "weather:write",
    });

    const saved = await fetch(`${origin}/api/preferences`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ units: "us" }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { units: "us" });

    const deniedRead = await fetch(`${origin}/api/preferences`, {
      headers: bearer(mintTestToken({ scopes: ["weather:write"] })),
    });
    assert.equal(deniedRead.status, 403);

    const loaded = await fetch(`${origin}/api/preferences`, { headers: readHeaders });
    assert.equal(loaded.status, 200);
    assert.deepEqual(await loaded.json(), { units: "us" });

    const undeclaredPost = await fetch(`${origin}/api/weather`, {
      method: "POST",
      headers: writeHeaders,
      body: "{}",
    });
    assert.equal(undeclaredPost.status, 404);
  });
});

test("rejects an unexpected forwarded prefix after authenticating", async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/`, {
      headers: {
        ...bearer(mintTestToken()),
        "x-forwarded-prefix": "/apps/another-app",
      },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_forwarded_prefix" });
  });
});

async function withServer(assertion, weatherProvider = async () => dashboard) {
  const server = createWeatherServer({ secret: TEST_SECRET, weatherProvider });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await assertion(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
