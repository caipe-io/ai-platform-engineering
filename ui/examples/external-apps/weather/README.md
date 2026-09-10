# Weather External App example

This directory is a self-contained reference runtime for the config-driven
External Apps framework. It demonstrates the browser base-path contract,
app-bound identity verification, read/write scope separation, and a small real
data integration without registering or deploying an app automatically.

It deliberately does **not** depend on CAIPE UI source, a JavaScript framework,
an MCP server, an assistant, OpenFGA, or organization-specific services. The
runtime uses only Node.js 24 built-ins.

## Contract demonstrated

The host exposes one canonical prefix, `/apps/weather`. Top-level navigation
loads the CAIPE shell; iframe, asset, and API requests beneath that prefix are
sent through the authenticated runtime gateway. The gateway removes the prefix
before forwarding and supplies `X-Forwarded-Prefix: /apps/weather`. The example
uses that exact trusted prefix when generating asset and API URLs. It also
accepts prefixed paths when run directly for local diagnostics.

Every route except the health probe verifies the gateway-minted HS256 Bearer
JWT. Verification requires:

- `iss` matching `AGENTIC_APP_TOKEN_ISSUER` (default `caipe-agentic-apps`);
- `aud` equal to `agentic-app:weather`;
- `app_id` equal to `weather`;
- a non-empty stable `sub`;
- a future numeric `exp`; and
- the scope required by the route in `scp`.

`AGENTIC_APP_TOKEN_SECRET` is mandatory and must contain at least 32 bytes after
trimming. It is a dedicated app-token secret, not the host session secret.
There is no authentication-disable environment variable.

| Runtime route | Methods | Required scope | Purpose |
| --- | --- | --- | --- |
| `/healthz` | `GET`, `HEAD` | none | Container/platform liveness |
| `/`, `/dashboard` | `GET`, `HEAD` | `weather:read` | HTML application |
| `/assets/app.css`, `/assets/app.js` | `GET`, `HEAD` | `weather:read` | Static application assets |
| `/api/weather` | `GET`, `HEAD` | `weather:read` | Server-side provider lookup |
| `/api/preferences` | `GET`, `HEAD` | `weather:read` | Read the subject’s in-memory unit preference |
| `/api/preferences` | `POST` | `weather:write` | Exact mutation-policy example |

No method-wide POST fallback is declared. Other POST paths therefore fail
closed at the host gateway; the runtime also returns `404` if reached directly.
Preferences are intentionally process-local example data, keyed by verified
`sub`; they are not a persistence design.

## Run tests

```bash
node --test test/*.test.mjs
```

Provider tests inject a complete fake `fetch` implementation. They make no
requests to Open-Meteo or any other external service. Server tests use only a
loopback listener and an injected provider.

## Build and run

From this directory:

```bash
export WEATHER_EXAMPLE_TOKEN_SECRET="$(openssl rand -hex 32)"
docker build -t caipe-weather-example .
docker run --rm --detach --name caipe-weather-example \
  -p 127.0.0.1:3020:3020 \
  -e AGENTIC_APP_TOKEN_SECRET="$WEATHER_EXAMPLE_TOKEN_SECRET" \
  caipe-weather-example
```

`GET http://localhost:3020/healthz` is available without a token. Application
routes are expected to be opened through a CAIPE deployment configured with
the adjacent [`agentic-apps.yaml`](./agentic-apps.yaml), rather than accessed
directly.

The host and runtime must receive the same `AGENTIC_APP_TOKEN_SECRET`; use
`$WEATHER_EXAMPLE_TOKEN_SECRET` when starting a local UI in the same terminal.
The adjacent catalog targets the published loopback port for that local setup.
For a multi-container or Kubernetes deployment, replace `http://127.0.0.1:3020`
with the runtime’s service origin. Mount the catalog and configure the host as
described in the main External Apps documentation.

Stop the detached example when finished:

```bash
docker rm --force caipe-weather-example
```

## Open-Meteo configuration and licensing

The server performs geocoding, forecast, and air-quality requests. Defaults are
the public Open-Meteo endpoints and are appropriate for local evaluation only:

| Variable | Default |
| --- | --- |
| `OPEN_METEO_GEOCODING_ORIGIN` | `https://geocoding-api.open-meteo.com` |
| `OPEN_METEO_FORECAST_ORIGIN` | `https://api.open-meteo.com` |
| `OPEN_METEO_AIR_QUALITY_ORIGIN` | `https://air-quality-api.open-meteo.com` |
| `OPEN_METEO_API_KEY` | unset |

Open-Meteo data is provided under CC BY 4.0 and requires attribution. The UI
includes the requested link and states that values are normalized. Open-Meteo’s
free hosted API is limited to non-commercial use and rate limits; commercial
deployments must use an appropriate subscription or a compliant self-hosted
provider and set the origin/key variables accordingly. Review the current
[Open-Meteo licence](https://open-meteo.com/en/licence) and
[terms](https://open-meteo.com/en/terms) before deployment.

The sample includes no Open-Meteo source code, icons, or other third-party
assets. Provider responses are transformed at runtime and are not committed to
the repository.

## Files

- `server.mjs` — HTTP routing, policy-to-scope enforcement, static delivery,
  and process-local preferences.
- `auth.mjs` — dependency-free HS256 app-token verification.
- `provider.mjs` — server-side Open-Meteo adapter and normalization.
- `public/` — base-path-safe HTML, CSS, and browser JavaScript; no external
  assets.
- `agentic-apps.yaml` — disabled-by-default deployment catalog example.
- `Dockerfile` — dependency-free Node.js 24 runtime image.
- `test/` — JWT, route, provider, and base-path coverage.
