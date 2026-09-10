// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { fetchWeatherDashboard, providerOrigins } from "../provider.mjs";

const locationPayload = {
  results: [
    {
      name: "Example City",
      admin1: "Example Region",
      country: "Example Country",
      latitude: 48.1,
      longitude: 11.5,
    },
  ],
};

const forecastPayload = {
  current: {
    time: "2026-09-04T10:00",
    temperature_2m: 20,
    apparent_temperature: 19,
    relative_humidity_2m: 52,
    weather_code: 2,
    wind_speed_10m: 12,
  },
  daily: {
    time: ["2026-09-04", "2026-09-05"],
    weather_code: [2, 61],
    temperature_2m_max: [24, 21],
    temperature_2m_min: [13, 12],
    precipitation_probability_max: [15, 70],
    wind_speed_10m_max: [20, 28],
  },
};

test("loads and normalizes geocoding, forecast, and air-quality data without network", async () => {
  const requests = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (url.hostname === "geocoding-api.open-meteo.com") return json(locationPayload);
    if (url.hostname === "api.open-meteo.com") return json(forecastPayload);
    if (url.hostname === "air-quality-api.open-meteo.com") {
      return json({ current: { us_aqi: 34, pm2_5: 5.5, ozone: 48 } });
    }
    throw new Error(`unexpected provider ${url.hostname}`);
  };

  const dashboard = await fetchWeatherDashboard("Example City", {
    fetchImpl,
    apiKey: "example-api-key",
  });

  assert.deepEqual(requests.map((url) => url.hostname).sort(), [
    "air-quality-api.open-meteo.com",
    "api.open-meteo.com",
    "geocoding-api.open-meteo.com",
  ]);
  assert.equal(requests.every((url) => url.searchParams.get("apikey") === "example-api-key"), true);
  assert.equal(requests[0].searchParams.get("name"), "Example City");
  assert.equal(dashboard.location.name, "Example City");
  assert.equal(dashboard.current.condition, "Partly cloudy");
  assert.equal(dashboard.daily[1].condition, "Rain");
  assert.equal(dashboard.airQuality.category, "Good");
  assert.deepEqual(dashboard.attribution, {
    name: "Open-Meteo",
    url: "https://open-meteo.com/",
    license: "CC BY 4.0",
    transformed: true,
  });
});

test("keeps the forecast usable when the air-quality request fails", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === "geocoding-api.open-meteo.com") return json(locationPayload);
    if (url.hostname === "api.open-meteo.com") return json(forecastPayload);
    return json({ error: "unavailable" }, 503);
  };

  const dashboard = await fetchWeatherDashboard("Example City", { fetchImpl });
  assert.equal(dashboard.current.temperatureC, 20);
  assert.equal(dashboard.airQuality.available, false);
  assert.match(dashboard.airQuality.reason, /HTTP 503/);
});

test("fails before forecast calls when geocoding has no match", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return json({ results: [] });
  };

  await assert.rejects(
    fetchWeatherDashboard("Unknown Place", { fetchImpl }),
    /no location matched/,
  );
  assert.equal(calls, 1);
});

test("validates configurable provider origins", () => {
  assert.deepEqual(
    providerOrigins({
      OPEN_METEO_GEOCODING_ORIGIN: "https://geo.example.test/path",
      OPEN_METEO_FORECAST_ORIGIN: "https://forecast.example.test",
      OPEN_METEO_AIR_QUALITY_ORIGIN: "http://air.internal.test",
    }),
    {
      geocoding: "https://geo.example.test",
      forecast: "https://forecast.example.test",
      airQuality: "http://air.internal.test",
    },
  );
  assert.throws(
    () => providerOrigins({ OPEN_METEO_FORECAST_ORIGIN: "file:///tmp/data" }),
    /invalid Open-Meteo origin/,
  );
});

test("never sends an API key to a plaintext provider origin", async () => {
  let calls = 0;
  await assert.rejects(
    fetchWeatherDashboard("Example City", {
      apiKey: "example-api-key",
      origins: {
        geocoding: "https://geo.example.test",
        forecast: "https://forecast.example.test",
        airQuality: "http://air.example.test",
      },
      fetchImpl: async () => {
        calls += 1;
        return json({});
      },
    }),
    /API keys require HTTPS for the airQuality origin/,
  );
  assert.equal(calls, 0);
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
