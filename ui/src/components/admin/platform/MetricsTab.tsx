"use client";

import { Button } from "@/components/ui/button";
import { useUrlFilterParams } from "@/hooks/use-url-filter-params";
import { useSearchParams } from "next/navigation";
import {
  type UseBatchPrometheusReturn,
  useBatchPrometheus,
} from "@/hooks/use-prometheus";
import { useAuthorizationMetrics } from "@/hooks/use-authorization-metrics";
import { cn } from "@/lib/utils";
import {
  Activity,
  BrainCircuit,
  Clock3,
  Coins,
  Cpu,
  RefreshCw,
  Server,
  ShieldCheck,
  Timer,
  Wrench,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DateRange,
  DateRangeFilter,
  DateRangePreset,
} from "../shared/DateRangeFilter";
import { AuthorizationMetricsSection } from "./AuthorizationMetricsSection";
import {
  AgentHealthTable,
  BarMetricChart,
  DonutChart,
  type MetricQueryState,
  MetricStatCard,
  smartBytesFormat,
  smartCountFormat,
  smartDurationFormat,
  TimeseriesChart,
  TokenUsageChart,
} from "./PrometheusCharts";
import {
  buildDependencyQueries,
  buildOverviewQueries,
  buildRuntimeQueries,
  resolveMetricsRange,
} from "./metrics-query-plan";

function metricState(batch: UseBatchPrometheusReturn, id: string): MetricQueryState {
  const result = batch.results?.[id];
  return {
    configured: batch.configured,
    data: result?.status === "success" ? result.data?.result ?? null : null,
    error: batch.queryErrors[id] || batch.error,
    loading: batch.loading,
  };
}

const METRICS_RANGE_PRESETS: readonly DateRangePreset[] = [
  "1h",
  "12h",
  "24h",
  "7d",
  "30d",
  "90d",
  "custom",
];

function metricsRangeFromParams(searchParams: { get(name: string): string | null }): {
  customRange?: DateRange;
  preset: DateRangePreset;
} {
  const rawPreset = searchParams.get("metricsRange");
  const preset = rawPreset && (METRICS_RANGE_PRESETS as readonly string[]).includes(rawPreset)
    ? rawPreset as DateRangePreset
    : "24h";
  if (preset !== "custom") return { preset };

  const from = searchParams.get("metricsFrom");
  const to = searchParams.get("metricsTo");
  if (
    !from ||
    !to ||
    !Number.isFinite(Date.parse(from)) ||
    !Number.isFinite(Date.parse(to)) ||
    Date.parse(from) > Date.parse(to)
  ) {
    return { preset: "24h" };
  }
  return { customRange: { from, to }, preset };
}

const percentFormat = (value: number): string => `${value.toFixed(2)}%`;
const coresFormat = (value: number): string => `${value.toFixed(value < 0.1 ? 3 : 2)} cores`;
const reliabilityTone = (value: number): "positive" | "warning" | "negative" => (
  value >= 99 ? "positive" : value >= 95 ? "warning" : "negative"
);
const availabilityTone = (value: number): "positive" | "warning" | "negative" => (
  value >= 99.9 ? "positive" : value >= 99 ? "warning" : "negative"
);

function toolWithAgent(metric: Record<string, string>): string {
  const tool = metric.tool_name || "unknown";
  return metric.agent_name ? `${tool} (${metric.agent_name})` : tool;
}

function compactModelId(modelId: string): string {
  return modelId
    .replace(/^(global|us|eu)\./, "")
    .replace(/^(anthropic|openai)\./, "");
}

function modelLabel(metric: Record<string, string>): string {
  return compactModelId(metric.model_id || "unknown");
}

export function MetricsTab() {
  const searchParams = useSearchParams();
  const updateUrlFilters = useUrlFilterParams();
  const urlRange = metricsRangeFromParams(searchParams);
  const urlRangeKey = `${urlRange.preset}\u0000${urlRange.customRange?.from ?? ""}\u0000${urlRange.customRange?.to ?? ""}`;
  const [rangePreset, setRangePreset] = useState<DateRangePreset>(urlRange.preset);
  const [customRange, setCustomRange] = useState<DateRange | undefined>(urlRange.customRange);
  const [previousUrlRangeKey, setPreviousUrlRangeKey] = useState(urlRangeKey);
  const [snapshotAt, setSnapshotAt] = useState(() => Math.floor(Date.now() / 1000));

  if (urlRangeKey !== previousUrlRangeKey) {
    setPreviousUrlRangeKey(urlRangeKey);
    setRangePreset(urlRange.preset);
    setCustomRange(urlRange.customRange);
  }

  const range = useMemo(
    () => resolveMetricsRange(rangePreset, customRange, snapshotAt),
    [customRange, rangePreset, snapshotAt],
  );
  const overviewQueries = useMemo(() => buildOverviewQueries(range), [range]);
  const runtimeQueries = useMemo(() => buildRuntimeQueries(range), [range]);
  const dependencyQueries = useMemo(() => buildDependencyQueries(range), [range]);

  const overview = useBatchPrometheus(overviewQueries);
  const runtime = useBatchPrometheus(runtimeQueries);
  const dependencies = useBatchPrometheus(dependencyQueries);
  const authorization = useAuthorizationMetrics(range, { refreshInterval: 0 });
  const refreshing = overview.loading
    || runtime.loading
    || dependencies.loading
    || authorization.loading;
  const updateTimes = [
    overview.lastUpdatedAt ?? 0,
    runtime.lastUpdatedAt ?? 0,
    dependencies.lastUpdatedAt ?? 0,
    authorization.lastUpdatedAt ?? 0,
  ];
  const lastUpdatedAt = updateTimes.every((timestamp) => timestamp > 0)
    ? Math.min(...updateTimes)
    : 0;
  const overviewRefetch = overview.refetch;
  const runtimeRefetch = runtime.refetch;
  const dependenciesRefetch = dependencies.refetch;
  const authorizationRefetch = authorization.refetch;

  const refetchAll = useCallback(async (): Promise<void> => {
    await Promise.all([
      overviewRefetch(),
      runtimeRefetch(),
      dependenciesRefetch(),
      authorizationRefetch(),
    ]);
  }, [authorizationRefetch, dependenciesRefetch, overviewRefetch, runtimeRefetch]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (range.fixed) {
        void refetchAll();
        return;
      }
      setSnapshotAt(Math.floor(Date.now() / 1000));
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [range.fixed, refetchAll]);

  const formatTimestamp = useCallback((timestamp: number): string => {
    const date = new Date(timestamp * 1000);
    if (range.seconds <= 24 * 60 * 60) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (range.seconds <= 7 * 24 * 60 * 60) {
      return date.toLocaleString([], { day: "numeric", hour: "numeric", month: "short" });
    }
    return date.toLocaleDateString([], { day: "numeric", month: "short" });
  }, [range.seconds]);

  const refreshAll = useCallback(async (): Promise<void> => {
    const nextSnapshot = Math.floor(Date.now() / 1000);
    if (!range.fixed && nextSnapshot !== snapshotAt) {
      setSnapshotAt(nextSnapshot);
      return;
    }
    await refetchAll();
  }, [range.fixed, refetchAll, snapshotAt]);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 rounded-lg border bg-muted/20 p-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          {lastUpdatedAt > 0 && (
            <p className="text-sm text-muted-foreground">
              Last synced {new Date(lastUpdatedAt).toLocaleTimeString()}
            </p>
          )}
          <p className="text-xs text-muted-foreground">All sections refresh together every 30 seconds.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <DateRangeFilter
            value={rangePreset}
            customRange={customRange}
            onChange={(preset, selectedRange) => {
              setRangePreset(preset);
              setCustomRange(preset === "custom" ? selectedRange : undefined);
              setSnapshotAt(Math.floor(Date.now() / 1000));
              updateUrlFilters({
                metricsRange: preset === "24h" ? null : preset,
                metricsFrom: preset === "custom" ? selectedRange.from : null,
                metricsTo: preset === "custom" ? selectedRange.to : null,
              });
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={refreshing}
            onClick={() => void refreshAll()}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            {refreshing ? "Refreshing" : "Refresh"}
          </Button>
        </div>
      </div>

      <section className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Executive Health</h3>
          <p className="text-sm text-muted-foreground">
            Availability, reliability, latency, traffic, efficiency, and saturation for the selected period.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricStatCard
            title="Runtime Availability"
            state={metricState(overview, "runtime_availability")}
            icon={<Server className="h-4 w-4 text-muted-foreground" />}
            format={percentFormat}
            tone={availabilityTone}
            subtitle="At least one Dynamic Agents target scrapeable"
          />
          <MetricStatCard
            title="Recorded Turns"
            state={metricState(overview, "turn_volume")}
            icon={<Activity className="h-4 w-4 text-muted-foreground" />}
            format={smartCountFormat}
            subtitle="All terminal outcomes in range"
          />
          <MetricStatCard
            title="Turn Reliability"
            state={metricState(overview, "turn_reliability")}
            icon={<ShieldCheck className="h-4 w-4 text-muted-foreground" />}
            format={percentFormat}
            tone={reliabilityTone}
            subtitle="Success vs runtime errors; expected pauses excluded"
          />
          <MetricStatCard
            title="Successful Turn p95"
            state={metricState(overview, "turn_p95")}
            icon={<Clock3 className="h-4 w-4 text-muted-foreground" />}
            format={smartDurationFormat}
            subtitle="End-to-end latency"
          />
          <MetricStatCard
            title="First Response p95"
            state={metricState(overview, "first_response_p95")}
            icon={<Timer className="h-4 w-4 text-muted-foreground" />}
            format={smartDurationFormat}
            subtitle="Time to first user-visible text"
          />
          <MetricStatCard
            title="Peak Concurrency"
            state={metricState(overview, "peak_concurrency")}
            icon={<Cpu className="h-4 w-4 text-muted-foreground" />}
            format={(value) => Math.round(value).toLocaleString()}
            subtitle="Maximum simultaneous HTTP requests"
          />
          <MetricStatCard
            title="Tokens / Turn"
            state={metricState(overview, "tokens_per_turn")}
            icon={<Coins className="h-4 w-4 text-muted-foreground" />}
            format={smartCountFormat}
            subtitle="Provider-reported input plus output tokens"
          />
          <MetricStatCard
            title="HTTP Reliability"
            state={metricState(overview, "http_reliability")}
            icon={<Zap className="h-4 w-4 text-muted-foreground" />}
            format={percentFormat}
            tone={reliabilityTone}
            subtitle="2xx vs server errors; 4xx excluded"
          />
          <MetricStatCard
            title="LLM Reliability"
            state={metricState(overview, "llm_reliability")}
            icon={<BrainCircuit className="h-4 w-4 text-muted-foreground" />}
            format={percentFormat}
            tone={reliabilityTone}
            subtitle="Successful model calls"
          />
          <MetricStatCard
            title="Tool Reliability"
            state={metricState(overview, "tool_reliability")}
            icon={<Wrench className="h-4 w-4 text-muted-foreground" />}
            format={percentFormat}
            tone={reliabilityTone}
            subtitle="Successful tool calls"
          />
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Turn Outcomes</h3>
          <p className="text-sm text-muted-foreground">
            Expected interruptions and user cancellations remain visible but do not count as platform failures.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <TimeseriesChart
            title="Turns Over Time by Agent"
            description={`Turns completed in each rolling ${smartDurationFormat(range.rateWindowSeconds)} window`}
            state={metricState(runtime, "turn_count_by_agent")}
            labelKey="agent_name"
            formatValue={smartCountFormat}
            formatTime={formatTimestamp}
          />
          <TimeseriesChart
            title="Turn Reliability Trend"
            description="Successful completed turns vs runtime errors"
            state={metricState(runtime, "turn_reliability_trend")}
            formatValue={percentFormat}
            formatTime={formatTimestamp}
            type="line"
          />
          <TimeseriesChart
            title="Successful Turn p95 by Agent"
            description="End-to-end latency; interruptions and cancellations excluded"
            state={metricState(runtime, "turn_p95_by_agent")}
            labelKey="agent_name"
            formatValue={smartDurationFormat}
            formatTime={formatTimestamp}
            type="line"
          />
          <TimeseriesChart
            title="First Response p95 by Agent"
            description="Time until the first user-visible text"
            state={metricState(runtime, "first_response_p95_by_agent")}
            labelKey="agent_name"
            formatValue={smartDurationFormat}
            formatTime={formatTimestamp}
            type="line"
          />
          <DonutChart
            title="Turn Outcome Distribution"
            description={`Recorded outcomes over ${range.label}`}
            state={metricState(runtime, "turn_outcomes")}
            labelKey="status"
          />
          <AgentHealthTable
            title="Agent Health Comparison"
            description={`Volume, reliability, and successful-turn latency over ${range.label}`}
            volumeState={metricState(runtime, "agent_turn_volume")}
            reliabilityState={metricState(runtime, "agent_turn_reliability")}
            latencyState={metricState(runtime, "agent_turn_p95")}
          />
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Request Path & Saturation</h3>
          <p className="text-sm text-muted-foreground">
            Server errors, request latency, active work, and resources summed across replicas.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <TimeseriesChart
            title="HTTP Server-error Rate"
            description="5xx and unhandled errors; client 4xx responses excluded"
            state={metricState(runtime, "http_error_rate")}
            formatValue={percentFormat}
            formatTime={formatTimestamp}
            type="line"
          />
          <TimeseriesChart
            title="Successful HTTP Request p95"
            description="Dynamic Agents request latency"
            state={metricState(runtime, "http_p95")}
            formatValue={smartDurationFormat}
            formatTime={formatTimestamp}
            type="line"
          />
          <TimeseriesChart
            title="Active HTTP Requests"
            description="Requests currently executing at each sample"
            state={metricState(runtime, "active_requests")}
            formatValue={smartCountFormat}
            formatTime={formatTimestamp}
            type="line"
          />
          <TimeseriesChart
            title="Active Agent Streams"
            description="Turns currently executing in agent runtimes"
            state={metricState(runtime, "active_streams")}
            formatValue={smartCountFormat}
            formatTime={formatTimestamp}
            type="line"
          />
          <TimeseriesChart
            title="Total CPU Across Replicas"
            description="Sum across Dynamic Agents pods; 1.0 equals one fully used CPU core"
            state={metricState(runtime, "process_cpu")}
            formatValue={coresFormat}
            formatTime={formatTimestamp}
            type="line"
          />
          <TimeseriesChart
            title="Total Memory Across Replicas"
            description="Sum of resident memory across all Dynamic Agents pods"
            state={metricState(runtime, "process_memory")}
            formatValue={smartBytesFormat}
            formatTime={formatTimestamp}
            type="line"
          />
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">LLM Dependency</h3>
          <p className="text-sm text-muted-foreground">
            Model-call reliability, successful latency, call volume, and token efficiency.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <TimeseriesChart
            title="LLM Error Rate by Model"
            description="Failed model calls grouped only by model"
            state={metricState(dependencies, "llm_error_rate_by_model")}
            labelTransform={modelLabel}
            formatValue={percentFormat}
            formatTime={formatTimestamp}
            type="line"
          />
          <TimeseriesChart
            title="Successful LLM p95"
            description="Model-call latency grouped only by model"
            state={metricState(dependencies, "llm_p95_by_model")}
            labelTransform={modelLabel}
            formatValue={smartDurationFormat}
            formatTime={formatTimestamp}
            type="line"
          />
          <BarMetricChart
            title="Model Usage"
            description={`LLM call volume by model over ${range.label}`}
            state={metricState(dependencies, "llm_calls_by_model")}
            labelTransform={modelLabel}
            layout="horizontal"
            formatValue={smartCountFormat}
            categoryWidth={220}
          />
          <DonutChart
            title="LLM Call Outcomes"
            description={`Success and error outcomes over ${range.label}`}
            state={metricState(dependencies, "llm_status")}
            labelKey="status"
          />
          <div className="xl:col-span-2">
            <TokenUsageChart
              title="Token Usage by Model"
              description={`Provider-reported input and output tokens over ${range.label}`}
              inputState={metricState(dependencies, "llm_input_tokens_by_model")}
              outputState={metricState(dependencies, "llm_output_tokens_by_model")}
              labelTransform={compactModelId}
              emptyMessage="No provider-reported token samples yet. Token telemetry starts with calls made after the Dynamic Agents update."
            />
          </div>
        </div>
      </section>

      <AuthorizationMetricsSection
        rangeLabel={range.label}
        state={authorization}
      />

      <section className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Tool Dependency</h3>
          <p className="text-sm text-muted-foreground">
            Failure concentration and successful execution latency across agent tools.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <TimeseriesChart
            title="Tool Error Rate"
            description="Failed calls by tool and owning agent"
            state={metricState(dependencies, "tool_error_rate_by_tool")}
            labelTransform={toolWithAgent}
            formatValue={percentFormat}
            formatTime={formatTimestamp}
            type="line"
          />
          <TimeseriesChart
            title="Successful Tool p95"
            description="Execution latency by tool and owning agent"
            state={metricState(dependencies, "tool_p95_by_tool")}
            labelTransform={toolWithAgent}
            formatValue={smartDurationFormat}
            formatTime={formatTimestamp}
            type="line"
          />
          <BarMetricChart
            title="Top Failing Tools"
            description={`Error count over ${range.label}`}
            state={metricState(dependencies, "top_failing_tools")}
            labelTransform={toolWithAgent}
            labelKey="tool_name"
            layout="horizontal"
            formatValue={smartCountFormat}
            emptyMessage="No tool failures in this range"
          />
          <DonutChart
            title="Tool Call Outcomes"
            description={`Success and error outcomes over ${range.label}`}
            state={metricState(dependencies, "tool_status")}
            labelKey="status"
          />
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Input Files</h3>
          <p className="text-sm text-muted-foreground">
            Attached files dropped from the user turn, by reason. A rise in <code>not_accepted_by_model</code> points to a model or capability regression rather than user behavior.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <TimeseriesChart
            title="Dropped Input Files Over Time"
            description={`Files dropped in each rolling ${smartDurationFormat(range.rateWindowSeconds)} window, by reason`}
            state={metricState(dependencies, "dropped_input_files_trend")}
            labelKey="reason"
            formatValue={smartCountFormat}
            formatTime={formatTimestamp}
            type="line"
          />
          <DonutChart
            title="Dropped Input Files by Reason"
            description={`Why attached files were dropped over ${range.label}`}
            state={metricState(dependencies, "dropped_input_files_by_reason")}
            labelKey="reason"
          />
        </div>
      </section>
    </div>
  );
}
