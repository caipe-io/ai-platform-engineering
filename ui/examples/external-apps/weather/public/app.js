// SPDX-License-Identifier: Apache-2.0

const basePath = document.documentElement.dataset.basePath || "/apps/weather";
const form = document.getElementById("weather-form");
const cityInput = document.getElementById("city");
const unitsSelect = document.getElementById("units");
const status = document.getElementById("status");
const preferenceStatus = document.getElementById("preference-status");
const dashboard = document.getElementById("dashboard");
const currentMetrics = document.getElementById("current-metrics");
const forecastGrid = document.getElementById("forecast");
const airQuality = document.getElementById("air-quality");

let currentWeather = null;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadWeather(cityInput.value);
});

unitsSelect.addEventListener("change", async () => {
  preferenceStatus.textContent = "Saving…";
  try {
    await requestJson(`${basePath}/api/preferences`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ units: unitsSelect.value }),
    });
    preferenceStatus.textContent = "Saved";
    if (currentWeather) renderWeather(currentWeather);
  } catch (error) {
    preferenceStatus.textContent = error instanceof Error ? error.message : "Could not save";
  }
});

initialize();

async function initialize() {
  try {
    const preferences = await requestJson(`${basePath}/api/preferences`);
    unitsSelect.value = preferences.units === "us" ? "us" : "metric";
  } catch {
    unitsSelect.value = "metric";
  }
  await loadWeather(cityInput.value);
}

async function loadWeather(city) {
  const button = form.querySelector("button");
  button.disabled = true;
  setStatus("Loading weather…");
  try {
    const weather = await requestJson(
      `${basePath}/api/weather?city=${encodeURIComponent(String(city || "").trim())}`,
    );
    currentWeather = weather;
    renderWeather(weather);
    setStatus(`Updated ${new Date(weather.observedAt).toLocaleString()}`);
  } catch (error) {
    dashboard.hidden = true;
    setStatus(error instanceof Error ? error.message : "Could not load weather", true);
  } finally {
    button.disabled = false;
  }
}

function renderWeather(weather) {
  dashboard.hidden = false;
  const location = [weather.location?.name, weather.location?.region, weather.location?.country]
    .filter(Boolean)
    .join(", ");
  document.getElementById("location-heading").textContent = location || "Selected location";
  document.getElementById("observed-at").textContent = weather.current?.condition || "Conditions unavailable";

  currentMetrics.replaceChildren(
    metric("Temperature", temperature(weather.current?.temperatureC)),
    metric("Feels like", temperature(weather.current?.apparentC)),
    metric("Humidity", valueWithUnit(weather.current?.humidityPercent, "%")),
    metric("Wind", wind(weather.current?.windKmh)),
  );

  forecastGrid.replaceChildren(
    ...(Array.isArray(weather.daily) ? weather.daily : []).map((day) => {
      const card = element("article", "day-card");
      const date = element("span", "day-date", formatDate(day.date));
      const condition = element("strong", "", day.condition || "Conditions unavailable");
      const temperatures = element("span", "", `${temperature(day.highC)} / ${temperature(day.lowC)}`);
      const rain = element("span", "", `Rain ${valueWithUnit(day.rainChancePercent, "%")}`);
      card.append(date, condition, temperatures, rain);
      return card;
    }),
  );

  const air = weather.airQuality || {};
  const card = element("div", "air-card");
  if (air.available) {
    card.append(
      labeledValue("US AQI", air.usAqi),
      labeledValue("Category", air.category),
      labeledValue("PM2.5", valueWithUnit(air.pm25, " μg/m³")),
      labeledValue("Ozone", valueWithUnit(air.ozone, " μg/m³")),
    );
  } else {
    card.append(element("p", "muted", air.reason || "Air-quality data is unavailable."));
  }
  airQuality.replaceChildren(card);
}

function metric(label, value) {
  const card = element("div", "metric");
  card.append(
    element("span", "metric-label", label),
    element("span", "metric-value", value),
  );
  return card;
}

function labeledValue(label, value) {
  const node = document.createElement("p");
  node.append(element("span", "metric-label", `${label} `), document.createTextNode(String(value ?? "—")));
  return node;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function temperature(value) {
  const numeric = finiteNumber(value);
  if (numeric === null) return "—";
  if (unitsSelect.value === "us") return `${Math.round((numeric * 9) / 5 + 32)}°F`;
  return `${Math.round(numeric)}°C`;
}

function wind(value) {
  const numeric = finiteNumber(value);
  if (numeric === null) return "—";
  if (unitsSelect.value === "us") return `${Math.round(numeric * 0.621371)} mph`;
  return `${Math.round(numeric)} km/h`;
}

function valueWithUnit(value, suffix) {
  const numeric = finiteNumber(value);
  return numeric === null ? "—" : `${Math.round(numeric)}${suffix}`;
}

function finiteNumber(value) {
  const numeric = Number(value);
  return value === null || value === undefined || !Number.isFinite(numeric) ? null : numeric;
}

function formatDate(value) {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? String(value || "")
    : new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: { accept: "application/json", ...(options?.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Request failed with HTTP ${response.status}`);
  }
  return payload;
}
