import { fireEvent,render,screen } from "@testing-library/react";

import { MetricsTab } from "../MetricsTab";

const replaceMock = jest.fn();
const mockUseBatchPrometheus = jest.fn();
const mockUseAuthorizationMetrics = jest.fn();
let currentSearchParams = new URLSearchParams();

jest.mock("next/navigation", () => ({
  usePathname: () => "/admin/operations/metrics",
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => currentSearchParams,
}));

jest.mock("@/hooks/use-prometheus", () => ({
  useBatchPrometheus: (...args: unknown[]) => mockUseBatchPrometheus(...args),
}));

jest.mock("@/hooks/use-authorization-metrics", () => ({
  useAuthorizationMetrics: (...args: unknown[]) => mockUseAuthorizationMetrics(...args),
}));

jest.mock("../PrometheusCharts", () => ({
  AgentHealthTable: () => null,
  BarMetricChart: () => null,
  DonutChart: () => null,
  MetricStatCard: () => null,
  TimeseriesChart: () => null,
  TokenUsageChart: () => null,
  smartBytesFormat: jest.fn(),
  smartCountFormat: jest.fn(),
  smartDurationFormat: jest.fn(),
  smartRateFormat: jest.fn(),
}));

const batchState = {
  configured: true,
  error: null,
  lastUpdatedAt: null,
  loading: false,
  queryErrors: {},
  refetch: jest.fn().mockResolvedValue(undefined),
  results: {},
};

const authorizationState = {
  data: null,
  error: null,
  lastUpdatedAt: null,
  loading: false,
  refetch: jest.fn().mockResolvedValue(undefined),
};

describe("MetricsTab filter deep links", () => {
  beforeEach(() => {
    currentSearchParams = new URLSearchParams();
    replaceMock.mockReset();
    mockUseBatchPrometheus.mockReset().mockReturnValue(batchState);
    mockUseAuthorizationMetrics.mockReset().mockReturnValue(authorizationState);
  });

  it("restores a preset for operations and authorization metrics", () => {
    currentSearchParams = new URLSearchParams("metricsRange=7d");
    render(<MetricsTab />);

    expect(mockUseAuthorizationMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ seconds: 7 * 24 * 60 * 60 }),
      { refreshInterval: 0 },
    );

    fireEvent.click(screen.getByRole("button", { name: "24h" }));
    expect(replaceMock).toHaveBeenLastCalledWith(
      "/admin/operations/metrics",
      { scroll: false },
    );
  });

  it("restores custom endpoints and rewrites them for a relative range", () => {
    currentSearchParams = new URLSearchParams({
      metricsRange: "custom",
      metricsFrom: "2026-07-01T00:00:00.000Z",
      metricsTo: "2026-07-02T12:00:00.000Z",
    });
    render(<MetricsTab />);

    expect(mockUseAuthorizationMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        start: String(Date.parse("2026-07-01T00:00:00.000Z") / 1000),
        end: String(Date.parse("2026-07-02T12:00:00.000Z") / 1000),
      }),
      { refreshInterval: 0 },
    );

    fireEvent.click(screen.getByRole("button", { name: "1h" }));
    expect(replaceMock).toHaveBeenLastCalledWith(
      "/admin/operations/metrics?metricsRange=1h",
      { scroll: false },
    );
  });
});
