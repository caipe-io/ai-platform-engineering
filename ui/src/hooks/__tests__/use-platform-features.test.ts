import { act, renderHook, waitFor } from "@testing-library/react";
import { usePlatformFeatures } from "../use-platform-features";

jest.mock("@/lib/config", () => ({ getConfig: () => true }));

it("keeps refreshed features when the older mount request finishes last", async () => {
  let finishOld!: (value: Response) => void;
  global.fetch = jest.fn()
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { features: { workflows: { deployed: true, enabled: false } } } }) });
  const { result } = renderHook(() => usePlatformFeatures());
  act(() => window.dispatchEvent(new Event("caipe:platform-features-updated")));
  await waitFor(() => expect(result.current.workflows.enabled).toBe(false));
  await act(async () => finishOld({ ok: true, json: async () => ({ data: { features: { workflows: { deployed: true, enabled: true } } } }) } as Response));
  expect(result.current.workflows.enabled).toBe(false);
});
