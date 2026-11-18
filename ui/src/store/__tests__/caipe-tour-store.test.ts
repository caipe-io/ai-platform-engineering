import { useCaipeTourStore } from "../caipe-tour-store";
import { DEFAULT_PRODUCT_TOUR_STATE } from "@/lib/product-tour";

beforeEach(() => useCaipeTourStore.getState().reset());

it("does not let an old refresh undo a newly saved opt-out", async () => {
  let finish!: (value: Response) => void;
  global.fetch = jest.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
  const pending = useCaipeTourStore.getState().refresh();
  useCaipeTourStore.getState().receive({ state: DEFAULT_PRODUCT_TOUR_STATE, eligible: true, auto_start: false, tours_enabled: false });
  finish({ ok: true, json: async () => ({ success: true, data: { state: {}, tours_enabled: true } }) } as Response);
  await pending;
  expect(useCaipeTourStore.getState().enabled).toBe(false);
});

it("does not restore the previous account's preferences after reset", async () => {
  let finish!: (value: Response) => void;
  global.fetch = jest.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
  const pending = useCaipeTourStore.getState().refresh();
  useCaipeTourStore.getState().reset();
  finish({ ok: true, json: async () => ({ success: true, data: { state: {}, tours_enabled: false } }) } as Response);
  await pending;
  expect(useCaipeTourStore.getState().loaded).toBe(false);
});

it("does not let a stale refresh undo a runtime toggle", async () => {
  let finish!: (value: Response) => void;
  global.fetch = jest.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
  const pending = useCaipeTourStore.getState().refresh();
  useCaipeTourStore.getState().setPlatformEnabled(false);
  finish({ ok: true, json: async () => ({ success: true, data: { state: {}, platform_enabled: true } }) } as Response);
  await pending;
  expect(useCaipeTourStore.getState().platformEnabled).toBe(false);
});
