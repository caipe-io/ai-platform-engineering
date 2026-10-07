import type { DateRange, DateRangePreset } from "../shared/DateRangeFilter";
import type { BatchQuery } from "@/hooks/use-prometheus";

const DYNAMIC_AGENTS_JOB = 'job=~".*dynamic-agents.*"';

export interface MetricsRange {
  end?: string;
  fixed: boolean;
  label: string;
  rateWindowSeconds: number;
  seconds: number;
  start?: string;
  stepSeconds: number;
}

const PRESET_SECONDS: Record<Exclude<DateRangePreset, "custom">, number> = {
  "1h": 60 * 60,
  "12h": 12 * 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
  "90d": 90 * 24 * 60 * 60,
};

const PRESET_LABELS: Record<Exclude<DateRangePreset, "custom">, string> = {
  "1h": "1 hour",
  "12h": "12 hours",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
};

export function resolveMetricsRange(
  preset: DateRangePreset,
  customRange?: DateRange,
  nowSeconds = Math.floor(Date.now() / 1000),
): MetricsRange {
  let seconds: number;
  let start: string | undefined;
  let end: string | undefined;
  let fixed = false;
  let label: string;

  if (preset === "custom" && customRange) {
    const startSeconds = Math.floor(new Date(customRange.from).getTime() / 1000);
    const endSeconds = Math.floor(new Date(customRange.to).getTime() / 1000);
    if (Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds) {
      start = String(startSeconds);
      end = String(endSeconds);
      fixed = true;
      seconds = endSeconds - startSeconds;
      label = `${new Date(customRange.from).toLocaleDateString()} – ${new Date(customRange.to).toLocaleDateString()}`;
    } else {
      seconds = PRESET_SECONDS["1h"];
      label = PRESET_LABELS["1h"];
    }
  } else {
    const relativePreset = preset === "custom" ? "1h" : preset;
    seconds = PRESET_SECONDS[relativePreset];
    label = PRESET_LABELS[relativePreset];
  }

  if (!fixed) {
    end = String(nowSeconds);
    start = String(nowSeconds - seconds);
  }

  const stepSeconds = Math.max(15, Math.ceil(seconds / 240));
  const rateWindowSeconds = Math.min(seconds, Math.max(300, stepSeconds * 4));
  return { end, fixed, label, rateWindowSeconds, seconds, start, stepSeconds };
}

function instantQuery(id: string, query: string, range: MetricsRange): BatchQuery {
  return {
    id,
    query,
    ...(range.end ? { time: range.end } : {}),
  };
}

function rangeQuery(id: string, query: string, range: MetricsRange): BatchQuery {
  const requestedEnd = Number(range.end);
  const alignedEnd = range.fixed
    ? requestedEnd
    : Math.floor(requestedEnd / range.stepSeconds) * range.stepSeconds;
  const start = range.fixed ? Number(range.start) : alignedEnd - range.seconds;
  return {
    end: String(alignedEnd),
    id,
    query,
    start: String(start),
    type: "range",
    step: `${range.stepSeconds}s`,
  };
}

export function buildOverviewQueries(range: MetricsRange): BatchQuery[] {
  const window = `${range.seconds}s`;
  const step = `${range.stepSeconds}s`;
  const availabilityStep = `${Math.min(300, Math.max(15, range.stepSeconds))}s`;
  const recordedTurns = `sum(increase(da_turns_total[${window}]))`;
  const completedTurns = `sum(increase(da_turns_total{status=~"success|error"}[${window}]))`;
  const successfulTurns = `(sum(increase(da_turns_total{status="success"}[${window}])) or vector(0))`;
  const reliabilityRatio = `(${successfulTurns}) / (${completedTurns})`;

  return [
    instantQuery(
      "runtime_availability",
      `avg_over_time(((max(up{job=~".*dynamic-agents.*"}) or vector(0)))[${window}:${availabilityStep}]) * 100`,
      range,
    ),
    instantQuery("turn_volume", `sum(increase(da_turns_total[${window}]))`, range),
    instantQuery("turn_reliability", `${reliabilityRatio} * 100`, range),
    instantQuery(
      "turn_p95",
      `histogram_quantile(0.95, sum(increase(da_turn_duration_seconds_bucket{status="success"}[${window}])) by (le))`,
      range,
    ),
    instantQuery(
      "first_response_p95",
      `histogram_quantile(0.95, sum(increase(da_turn_time_to_first_response_seconds_bucket[${window}])) by (le))`,
      range,
    ),
    instantQuery(
      "peak_concurrency",
      `max_over_time((sum(da_active_requests))[${window}:${step}])`,
      range,
    ),
    instantQuery(
      "tokens_per_turn",
      `(sum(increase(da_llm_input_tokens_total[${window}])) + sum(increase(da_llm_output_tokens_total[${window}]))) / (${recordedTurns})`,
      range,
    ),
    instantQuery(
      "http_reliability",
      `(sum(increase(da_request_duration_seconds_count{status="2xx"}[${window}])) or vector(0)) / sum(increase(da_request_duration_seconds_count{status=~"2xx|5xx|error"}[${window}])) * 100`,
      range,
    ),
    instantQuery(
      "llm_reliability",
      `(sum(increase(da_llm_calls_total{status="success"}[${window}])) or vector(0)) / sum(increase(da_llm_calls_total[${window}])) * 100`,
      range,
    ),
    instantQuery(
      "tool_reliability",
      `(sum(increase(da_tool_calls_total{status="success"}[${window}])) or vector(0)) / sum(increase(da_tool_calls_total[${window}])) * 100`,
      range,
    ),
  ];
}

export function buildRuntimeQueries(range: MetricsRange): BatchQuery[] {
  const window = `${range.seconds}s`;
  const rateWindow = `${range.rateWindowSeconds}s`;
  const successfulRate = `(sum(rate(da_turns_total{status="success"}[${rateWindow}])) or vector(0))`;
  const completedRate = `sum(rate(da_turns_total{status=~"success|error"}[${rateWindow}]))`;

  return [
    rangeQuery(
      "turn_count_by_agent",
      `round(sum by (agent_name) (increase(da_turns_total[${rateWindow}])))`,
      range,
    ),
    rangeQuery("turn_reliability_trend", `(${successfulRate}) / (${completedRate}) * 100`, range),
    rangeQuery(
      "turn_p95_by_agent",
      `histogram_quantile(0.95, sum(rate(da_turn_duration_seconds_bucket{status="success"}[${rateWindow}])) by (le, agent_name))`,
      range,
    ),
    rangeQuery(
      "first_response_p95_by_agent",
      `histogram_quantile(0.95, sum(rate(da_turn_time_to_first_response_seconds_bucket[${rateWindow}])) by (le, agent_name))`,
      range,
    ),
    instantQuery(
      "turn_outcomes",
      `sum by (status) (increase(da_turns_total[${window}]))`,
      range,
    ),
    instantQuery(
      "agent_turn_volume",
      `sum by (agent_name) (increase(da_turns_total[${window}]))`,
      range,
    ),
    instantQuery(
      "agent_turn_reliability",
      `(sum by (agent_name) (increase(da_turns_total{status="success"}[${window}])) or (0 * sum by (agent_name) (increase(da_turns_total{status=~"success|error"}[${window}])))) / sum by (agent_name) (increase(da_turns_total{status=~"success|error"}[${window}])) * 100`,
      range,
    ),
    instantQuery(
      "agent_turn_p95",
      `histogram_quantile(0.95, sum by (le, agent_name) (increase(da_turn_duration_seconds_bucket{status="success"}[${window}])))`,
      range,
    ),
    rangeQuery(
      "http_error_rate",
      `(1 - (sum(rate(da_request_duration_seconds_count{status="2xx"}[${rateWindow}])) or vector(0)) / sum(rate(da_request_duration_seconds_count{status=~"2xx|5xx|error"}[${rateWindow}]))) * 100`,
      range,
    ),
    rangeQuery(
      "http_p95",
      `histogram_quantile(0.95, sum(rate(da_request_duration_seconds_bucket{status="2xx"}[${rateWindow}])) by (le))`,
      range,
    ),
    rangeQuery("active_requests", "sum(da_active_requests)", range),
    rangeQuery("active_streams", "sum(da_active_streams)", range),
    rangeQuery(
      "process_cpu",
      `sum(rate(process_cpu_seconds_total{${DYNAMIC_AGENTS_JOB}}[${rateWindow}]))`,
      range,
    ),
    rangeQuery(
      "process_memory",
      `sum(process_resident_memory_bytes{${DYNAMIC_AGENTS_JOB}})`,
      range,
    ),
  ];
}

export function buildDependencyQueries(range: MetricsRange): BatchQuery[] {
  const window = `${range.seconds}s`;
  const rateWindow = `${range.rateWindowSeconds}s`;
  return [
    rangeQuery(
      "llm_error_rate_by_model",
      `(1 - (sum by (model_id) (rate(da_llm_calls_total{status="success"}[${rateWindow}])) or (0 * sum by (model_id) (rate(da_llm_calls_total[${rateWindow}])))) / sum by (model_id) (rate(da_llm_calls_total[${rateWindow}]))) * 100`,
      range,
    ),
    rangeQuery(
      "llm_p95_by_model",
      `histogram_quantile(0.95, sum(rate(da_llm_call_duration_seconds_bucket{status="success"}[${rateWindow}])) by (le, model_id))`,
      range,
    ),
    instantQuery(
      "llm_calls_by_model",
      `sum by (model_id) (increase(da_llm_calls_total[${window}]))`,
      range,
    ),
    instantQuery(
      "llm_status",
      `sum by (status) (increase(da_llm_calls_total[${window}]))`,
      range,
    ),
    instantQuery(
      "llm_input_tokens_by_model",
      `sum by (model_id) (increase(da_llm_input_tokens_total[${window}]))`,
      range,
    ),
    instantQuery(
      "llm_output_tokens_by_model",
      `sum by (model_id) (increase(da_llm_output_tokens_total[${window}]))`,
      range,
    ),
    rangeQuery(
      "tool_error_rate_by_tool",
      `(1 - (sum by (tool_name, agent_name) (rate(da_tool_calls_total{status="success"}[${rateWindow}])) or (0 * sum by (tool_name, agent_name) (rate(da_tool_calls_total[${rateWindow}])))) / sum by (tool_name, agent_name) (rate(da_tool_calls_total[${rateWindow}]))) * 100`,
      range,
    ),
    rangeQuery(
      "tool_p95_by_tool",
      `histogram_quantile(0.95, sum(rate(da_tool_call_duration_seconds_bucket{status="success"}[${rateWindow}])) by (le, tool_name, agent_name))`,
      range,
    ),
    instantQuery(
      "top_failing_tools",
      `topk(10, sum by (tool_name, agent_name) (increase(da_tool_calls_total{status="error"}[${window}])))`,
      range,
    ),
    instantQuery(
      "tool_status",
      `sum by (status) (increase(da_tool_calls_total[${window}]))`,
      range,
    ),
    instantQuery(
      "dropped_input_files_by_reason",
      `sum by (reason) (increase(da_dropped_input_files_total[${window}]))`,
      range,
    ),
    rangeQuery(
      "dropped_input_files_trend",
      `sum by (reason) (increase(da_dropped_input_files_total[${rateWindow}]))`,
      range,
    ),
  ];
}
