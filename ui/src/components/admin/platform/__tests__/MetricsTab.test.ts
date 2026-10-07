import {
  buildDependencyQueries,
  buildOverviewQueries,
  buildRuntimeQueries,
  resolveMetricsRange,
} from "../metrics-query-plan";

describe("MetricsTab PromQL planning", () => {
  it("uses adaptive sampling and rate windows for long presets", () => {
    const range = resolveMetricsRange("90d", undefined, 1_800_000_000);

    expect(range.seconds).toBe(90 * 24 * 60 * 60);
    expect(range.stepSeconds).toBeGreaterThan(60 * 60);
    expect(range.rateWindowSeconds).toBeGreaterThan(5 * 60);

    const turnCount = buildRuntimeQueries(range).find((query) => query.id === "turn_count_by_agent");
    expect(turnCount?.query).toContain(`increase(da_turns_total[${range.rateWindowSeconds}s])`);
    expect(turnCount?.start).toBeDefined();
    expect(turnCount?.end).toBeDefined();
  });

  it("preserves absolute custom bounds for range and instant queries", () => {
    const range = resolveMetricsRange("custom", {
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-06-03T00:00:00.000Z",
    });
    const overview = buildOverviewQueries(range);
    const runtime = buildRuntimeQueries(range);

    expect(range.start).toBe(String(Date.parse("2026-06-01T00:00:00.000Z") / 1000));
    expect(range.end).toBe(String(Date.parse("2026-06-03T00:00:00.000Z") / 1000));
    expect(overview.every((query) => query.time === range.end)).toBe(true);
    expect(runtime.filter((query) => query.type === "range").every((query) => (
      query.start === range.start
      && query.end === range.end
      && query.rangeSeconds === undefined
    ))).toBe(true);
  });

  it("anchors every Prometheus section to one rolling snapshot", () => {
    const snapshot = 1_800_000_000;
    const range = resolveMetricsRange("7d", undefined, snapshot);
    const queryGroups = [
      buildOverviewQueries(range),
      buildRuntimeQueries(range),
      buildDependencyQueries(range),
    ];

    expect(range.start).toBe(String(snapshot - (7 * 24 * 60 * 60)));
    expect(range.end).toBe(String(snapshot));
    expect(queryGroups.flat().filter((query) => query.type !== "range").every((query) => (
      query.time === String(snapshot)
    ))).toBe(true);

    const rangeQueries = queryGroups.flat().filter((query) => query.type === "range");
    expect(new Set(rangeQueries.map((query) => query.start)).size).toBe(1);
    expect(new Set(rangeQueries.map((query) => query.end)).size).toBe(1);
    expect(new Set(rangeQueries.map((query) => query.step)).size).toBe(1);
    expect(Number(rangeQueries[0].end) % range.stepSeconds).toBe(0);
  });

  it("uses selected-window increases instead of lifetime counters", () => {
    const range = resolveMetricsRange("24h", undefined, 1_800_000_000);
    const overview = buildOverviewQueries(range);
    const runtime = buildRuntimeQueries(range);

    expect(overview.find((query) => query.id === "turn_volume")?.query).toContain("increase(da_turns_total[86400s])");
    expect(runtime.find((query) => query.id === "turn_outcomes")?.query).toContain("increase(da_turns_total[86400s])");
    expect(runtime.find((query) => query.id === "agent_turn_volume")?.query).toContain("increase(da_turns_total[86400s])");
  });

  it("keeps expected pauses out of the reliability denominator", () => {
    const reliability = buildOverviewQueries(resolveMetricsRange("7d", undefined, 1_800_000_000))
      .find((query) => query.id === "turn_reliability")?.query;

    expect(reliability).toContain('status="success"');
    expect(reliability).toContain('status=~"success|error"');
    expect(reliability).not.toContain("interrupted");
    expect(reliability).not.toContain("cancelled");
  });

  it("groups every LLM dependency query by model, never by agent", () => {
    const queries = buildDependencyQueries(resolveMetricsRange("30d", undefined, 1_800_000_000));

    expect(queries.find((query) => query.id === "llm_calls_by_model")?.query).toContain("by (model_id)");
    expect(queries.find((query) => query.id === "llm_input_tokens_by_model")?.query).toContain("by (model_id)");
    expect(queries.find((query) => query.id === "llm_p95_by_model")?.query).toContain("le, model_id");
    expect(queries.find((query) => query.id === "llm_error_rate_by_model")?.query).toContain("by (model_id)");
    expect(queries.filter((query) => query.id.startsWith("llm_")).every((query) => (
      !query.query.includes("agent_name")
    ))).toBe(true);
  });

  it("uses a service-level availability signal instead of averaging ephemeral pods", () => {
    const availability = buildOverviewQueries(resolveMetricsRange("7d", undefined, 1_800_000_000))
      .find((query) => query.id === "runtime_availability")?.query;

    expect(availability).toContain('max(up{job=~".*dynamic-agents.*"})');
    expect(availability).not.toContain("avg(avg_over_time(up");
  });

  it("removes cache utilization and error-budget queries", () => {
    const range = resolveMetricsRange("24h", undefined, 1_800_000_000);
    const queryIds = [
      ...buildOverviewQueries(range),
      ...buildRuntimeQueries(range),
    ].map((query) => query.id);

    expect(queryIds).not.toContain("turn_error_budget_burn");
    expect(queryIds).not.toContain("peak_cache_utilization");
    expect(queryIds).not.toContain("cache_utilization");
  });

  it("plans dropped-input-file panels grouped by reason", () => {
    const range = resolveMetricsRange("24h", undefined, 1_800_000_000);
    const queries = buildDependencyQueries(range);

    const byReason = queries.find((query) => query.id === "dropped_input_files_by_reason");
    expect(byReason?.query).toContain("increase(da_dropped_input_files_total[86400s])");
    expect(byReason?.query).toContain("by (reason)");
    expect(byReason?.time).toBe(String(range.end));

    const trend = queries.find((query) => query.id === "dropped_input_files_trend");
    expect(trend?.type).toBe("range");
    expect(trend?.query).toContain(`increase(da_dropped_input_files_total[${range.rateWindowSeconds}s])`);
    expect(trend?.query).toContain("by (reason)");
  });

  it("keeps every async section under the batch endpoint limit", () => {
    const range = resolveMetricsRange("24h", undefined, 1_800_000_000);

    expect(buildOverviewQueries(range).length).toBeLessThanOrEqual(20);
    expect(buildRuntimeQueries(range).length).toBeLessThanOrEqual(20);
    expect(buildDependencyQueries(range).length).toBeLessThanOrEqual(20);
  });
});
