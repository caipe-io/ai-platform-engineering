#!/usr/bin/env bash
# Prepare the current DevNet pod for the learner's CAIPE UI exercises.
# Include this file in the DevNet image or download it before running the lab.
set -euo pipefail

WORK_DIR="$HOME/src"
VERSION=1.3.0-rc.12
INSTALLER_REF=5bcfc13184c3c3a3201bafbbe0d4c3212cac7a7d
# Temporary backend-only build of the LLM_STREAMING fix (PR #3035, ad41ea687).
# Replace this pin with the released image after the fix is tagged.
DYNAMIC_AGENTS_IMAGE_TAG='1.2.0-fix-llm-streaming-control-1@sha256:08b160e09e37589adff732364b4ba0f74b6f8b855cc4d41cbc8578f4137c3c46'
MODEL="${CAIPE_LAB_MODEL:-gpt-4o}"
mkdir -p "$WORK_DIR"
LOG_FILE="$WORK_DIR/caipe-setup.log"
: > "$LOG_FILE"
CURRENT_STAGE='Starting preparation'
progress() {
  CURRENT_STAGE="$*"
  printf '\n%s\n' "$CURRENT_STAGE" | tee -a "$LOG_FILE"
}
run_logged() (
  # Keep the command in the foreground so it can read a bundled manifest.
  # Always stop its progress timer, including when the command fails.
  local heartbeat_pid=''
  trap 'if [[ -n "$heartbeat_pid" ]]; then kill "$heartbeat_pid" 2>/dev/null || true; wait "$heartbeat_pid" 2>/dev/null || true; fi' EXIT
  (
    while sleep 30; do
      printf '  Still working: %s\n' "$CURRENT_STAGE"
    done
  ) &
  heartbeat_pid=$!
  "$@" >> "$LOG_FILE" 2>&1
)
report_failure() {
  local status=$?
  printf '\nPreparation failed during: %s\nRecent log output:\n' "$CURRENT_STAGE" >&2
  tail -n 8 "$LOG_FILE" >&2
  printf '\nFull log: %s\nResolve the error, then rerun bash ~/src/prepare-caipe.sh.\n' "$LOG_FILE" >&2
  exit "$status"
}
trap report_failure ERR

progress "Preparing CAIPE. Allow up to 15 minutes; detailed progress is recorded in $LOG_FILE"
progress '[1/7] Waiting for the cluster and checking command-line tools...'
: "${OPENAI_API_KEY:?The DevNet LLM key is missing. Restart the development environment.}"
: "${OPENAI_BASE_URL:?The DevNet LLM endpoint is missing. Restart the development environment.}"
: "${DEVENV_APP_8081_URL:?The DevNet CAIPE application URL is missing.}"
: "${DEVENV_APP_8080_URL:?The DevNet sign-in URL is missing.}"
wait_for_cluster() {
  local deadline=$((SECONDS + 300))
  while (( SECONDS < deadline )); do
    if command -v kubectl >/dev/null && kubectl wait --for=condition=Ready nodes --all --timeout=5s; then
      kubectl get nodes
      return 0
    fi
    sleep 5
  done
  echo "The kind cluster did not become Ready within five minutes. Wait for cluster startup before rerunning preparation." >&2
  return 1
}
run_logged wait_for_cluster

export PATH="$HOME/.local/bin:$PATH"
if ! command -v jq >/dev/null; then
  progress 'Installing jq in your home directory...'
  mkdir -p "$HOME/.local/bin"
  JQ_ARCH=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
  run_logged curl -fsSL "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-$JQ_ARCH" -o "$HOME/.local/bin/jq"
  chmod +x "$HOME/.local/bin/jq"
fi
grep -qsF 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.bashrc" ||
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"

progress "[2/7] Checking access to the lab model ($MODEL)..."
curl -fsS "$OPENAI_BASE_URL/models" -H "Authorization: Bearer $OPENAI_API_KEY" |
  jq -r '.data[].id' > "$WORK_DIR/caipe-models.txt"
if ! grep -Fxq "$MODEL" "$WORK_DIR/caipe-models.txt"; then
  echo "The lab model $MODEL is unavailable. Available models are listed in $WORK_DIR/caipe-models.txt." >&2
  exit 1
fi
printf '%s\n' "$MODEL" > "$WORK_DIR/caipe-model.txt"

cd "$WORK_DIR"
progress '[3/7] Downloading the CAIPE installer...'
run_logged curl -fsSL "https://raw.githubusercontent.com/caipe-io/ai-platform-engineering/$INSTALLER_REF/setup-caipe.sh" -o setup-caipe.sh
sed -i 's#^OPENAI_ENDPOINT=.*#OPENAI_ENDPOINT="${OPENAI_ENDPOINT:-$OPENAI_BASE_URL}"#' setup-caipe.sh
sed -i 's#^OPENAI_MODEL_NAME=.*#OPENAI_MODEL_NAME="${OPENAI_MODEL_NAME:-gpt-4o}"#' setup-caipe.sh
# Keep these values in Helm so a rerun preserves the proxy compatibility fix.
sed -i '/--set "dynamic-agents.llmSecret=llm-secret"/a\
      --set-string "dynamic-agents.config.LLM_STREAMING=false"\
      --set-string "dynamic-agents.image.tag=${CAIPE_LAB_DYNAMIC_AGENTS_IMAGE_TAG}"' setup-caipe.sh
progress '[4/7] Installing CAIPE and initializing the workspace...'
run_logged env CAIPE_CHART_VERSION="$VERSION" LLM_PROVIDER=openai OPENAI_MODEL_NAME="$MODEL" \
  CAIPE_LAB_DYNAMIC_AGENTS_IMAGE_TAG="$DYNAMIC_AGENTS_IMAGE_TAG" \
  bash ./setup-caipe.sh --non-interactive --no-metallb --domain=caipe.localtest.me \
  --ui-url="$DEVENV_APP_8081_URL" --idp-url="$DEVENV_APP_8080_URL" \
  --expose=nodeport --apply-migrations --repair-pending-install </dev/null

progress '[5/7] Enabling agent chat and waiting for services...'
run_logged kubectl patch configmap caipe-caipe-ui-config -n caipe --type merge \
  -p '{"data":{"DYNAMIC_AGENTS_ENABLED":"true"}}'
run_logged kubectl rollout restart deployment caipe-caipe-ui -n caipe
run_logged kubectl rollout status deployment caipe-caipe-ui -n caipe --timeout=300s
run_logged kubectl wait --for=condition=Available deployment --all -n caipe --timeout=600s

progress '[6/7] Starting the sample weather service...'
run_logged kubectl apply -f - <<'WEATHER_MCP'
# Open-Meteo weather MCP server for the CAIPE getting-started lab.
apiVersion: v1
kind: ConfigMap
metadata:
  name: weather-mcp-src
  namespace: caipe
data:
  server.py: |
    """Minimal weather MCP server backed by Open-Meteo (no API key required).

    Exposes two tools over MCP streamable HTTP at http://<host>:8000/mcp:
      - get_current_weather(city)
      - get_forecast(city, days)
    """

    import httpx
    from mcp.server.fastmcp import FastMCP

    GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
    FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

    # WMO weather interpretation codes -> short description.
    WMO_CODES = {
        0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
        45: "fog", 48: "depositing rime fog",
        51: "light drizzle", 53: "moderate drizzle", 55: "dense drizzle",
        61: "slight rain", 63: "moderate rain", 65: "heavy rain",
        66: "light freezing rain", 67: "heavy freezing rain",
        71: "slight snow", 73: "moderate snow", 75: "heavy snow", 77: "snow grains",
        80: "slight rain showers", 81: "moderate rain showers", 82: "violent rain showers",
        85: "slight snow showers", 86: "heavy snow showers",
        95: "thunderstorm", 96: "thunderstorm with slight hail", 99: "thunderstorm with heavy hail",
    }

    mcp = FastMCP("open-meteo-weather", host="0.0.0.0", port=8000, stateless_http=True)


    async def _geocode(client: httpx.AsyncClient, city: str) -> dict:
        resp = await client.get(GEOCODE_URL, params={"name": city, "count": 1})
        resp.raise_for_status()
        results = resp.json().get("results") or []
        if not results:
            raise ValueError(f"No location found for '{city}'")
        place = results[0]
        return {
            "name": place["name"],
            "country": place.get("country", ""),
            "latitude": place["latitude"],
            "longitude": place["longitude"],
            "timezone": place.get("timezone", "auto"),
        }


    @mcp.tool()
    async def get_current_weather(city: str) -> dict:
        """Get the current weather (temperature, wind, conditions) for a city by name."""
        async with httpx.AsyncClient(timeout=15) as client:
            place = await _geocode(client, city)
            resp = await client.get(FORECAST_URL, params={
                "latitude": place["latitude"],
                "longitude": place["longitude"],
                "timezone": place["timezone"],
                "current": "temperature_2m,apparent_temperature,relative_humidity_2m,"
                           "precipitation,weather_code,wind_speed_10m",
            })
            resp.raise_for_status()
            current = resp.json()["current"]
        return {
            "location": place,
            "time": current["time"],
            "temperature_c": current["temperature_2m"],
            "feels_like_c": current["apparent_temperature"],
            "humidity_pct": current["relative_humidity_2m"],
            "precipitation_mm": current["precipitation"],
            "wind_speed_kmh": current["wind_speed_10m"],
            "conditions": WMO_CODES.get(current["weather_code"], f"code {current['weather_code']}"),
        }


    @mcp.tool()
    async def get_forecast(city: str, days: int = 3) -> dict:
        """Get a daily forecast (min/max temperature, precipitation, conditions) for a city, 1-7 days."""
        days = max(1, min(days, 7))
        async with httpx.AsyncClient(timeout=15) as client:
            place = await _geocode(client, city)
            resp = await client.get(FORECAST_URL, params={
                "latitude": place["latitude"],
                "longitude": place["longitude"],
                "timezone": place["timezone"],
                "forecast_days": days,
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code",
            })
            resp.raise_for_status()
            daily = resp.json()["daily"]
        return {
            "location": place,
            "days": [
                {
                    "date": daily["time"][i],
                    "min_c": daily["temperature_2m_min"][i],
                    "max_c": daily["temperature_2m_max"][i],
                    "precipitation_mm": daily["precipitation_sum"][i],
                    "conditions": WMO_CODES.get(daily["weather_code"][i], f"code {daily['weather_code'][i]}"),
                }
                for i in range(len(daily["time"]))
            ],
        }


    if __name__ == "__main__":
        mcp.run(transport="streamable-http")
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: weather-mcp
  namespace: caipe
  labels:
    app: weather-mcp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: weather-mcp
  template:
    metadata:
      labels:
        app: weather-mcp
    spec:
      containers:
        - name: weather-mcp
          image: python:3.12-slim
          command: ["sh", "-c"]
          args:
            - pip install --quiet --no-cache-dir mcp==1.30.0 httpx==0.28.1 && exec python /app/server.py
          ports:
            - name: http
              containerPort: 8000
          readinessProbe:
            tcpSocket:
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            requests:
              cpu: 50m
              memory: 96Mi
            limits:
              memory: 256Mi
          volumeMounts:
            - name: src
              mountPath: /app
      volumes:
        - name: src
          configMap:
            name: weather-mcp-src
---
apiVersion: v1
kind: Service
metadata:
  name: weather-mcp
  namespace: caipe
spec:
  selector:
    app: weather-mcp
  ports:
    - name: http
      port: 8000
      targetPort: http
WEATHER_MCP
run_logged kubectl rollout status deployment weather-mcp -n caipe --timeout=300s

progress '[7/7] Waiting for the CAIPE application to respond...'
UI_READY=false
for attempt in $(seq 60); do
  if curl -s -o /dev/null -w '%{http_code}' http://localhost:8081/ | grep -qE '^(200|307)$'; then
    UI_READY=true
    break
  fi
  if (( attempt % 5 == 0 )); then
    progress "Still waiting for the CAIPE application ($attempt of 60 checks)..."
  fi
  sleep 3
done
if [[ "$UI_READY" != true ]]; then
  echo "CAIPE has not become reachable. Review $LOG_FILE before continuing." >&2
  exit 1
fi
printf '\nCAIPE is ready.\nURL: %s\nModel: %s\n' "$DEVENV_APP_8081_URL" "$MODEL" | tee -a "$LOG_FILE"
