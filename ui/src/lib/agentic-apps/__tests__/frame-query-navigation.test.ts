import { connectFrameQueryNavigation } from "../frame-query-navigation";

const publicPath = "/apps/example-app";

describe("iframe query navigation", () => {
  let iframe: HTMLIFrameElement;
  let dispose: () => void;
  let post: jest.SpyInstance;
  const message = (data: Record<string, unknown>, overrides: MessageEventInit = {}) => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin, source: iframe.contentWindow,
      data: { appId: "example-app", version: "1.0", ...data }, ...overrides,
    }));
  };
  const connect = () => message({ type: "caipe.agenticApp.bridge.connect.v1" });
  const navigate = (href: string, history?: string) => message({ type: "caipe.agenticApp.navigate.v1", href, history });
  beforeEach(() => {
    window.history.replaceState(null, "", publicPath);
    iframe = document.createElement("iframe"); document.body.append(iframe);
    post = jest.spyOn(iframe.contentWindow!, "postMessage");
    ({ dispose } = connectFrameQueryNavigation({ host: window, appId: "example-app", publicPath, frame: () => iframe, onConnect: jest.fn() }));
  });
  afterEach(() => { dispose(); iframe.remove(); jest.restoreAllMocks(); });

  it("pushes committed views, replaces edits, and ignores duplicate navigation", () => {
    connect();
    const push = jest.spyOn(window.history, "pushState");
    const replace = jest.spyOn(window.history, "replaceState");
    navigate(publicPath + "?tab=instances");
    navigate(publicPath + "?tab=instances");
    expect(push).toHaveBeenCalledTimes(1);
    navigate(publicPath + "?tab=instances&search=worker", "replace");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?tab=instances&search=worker");
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: "caipe.agenticApp.navigation.v1", href: publicPath + window.location.search }), window.location.origin);
  });

  it("publishes Back/Forward state without adding another history entry", () => {
    connect();
    window.history.replaceState(null, "", publicPath + "?tab=search&search=example");
    const push = jest.spyOn(window.history, "pushState");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(push).not.toHaveBeenCalled();
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ href: publicPath + "?tab=search&search=example" }), window.location.origin);
  });

  it("requires a handshake from its own same-origin iframe", () => {
    navigate(publicPath + "?before=connect");
    connect();
    for (const overrides of [{ origin: "https://example.invalid" }, { source: window }, { data: { appId: "other", version: "1.0", type: "caipe.agenticApp.navigate.v1", href: publicPath + "?wrong=app" } }]) {
      message({ type: "caipe.agenticApp.navigate.v1", href: publicPath + "?wrong=source" }, overrides);
    }
    expect(window.location.search).toBe("");
  });

  it.each(["//example.invalid/apps/example-app", "https://example.invalid", "/apps/other?tab=search", "/api/secrets", "/apps/example-app/../other", "/apps/example-app\\?x=1", "/apps/example-app?x=bad\nvalue"])("rejects navigation outside the owned query route: %s", (href) => {
    connect(); navigate(href); expect(window.location.pathname + window.location.search).toBe(publicPath);
  });

  it("does not change the parent route or expose listeners after disposal", () => {
    connect(); navigate(publicPath + "?tab=instances", "invalid");
    window.history.replaceState(null, "", "/apps/other");
    navigate(publicPath + "?tab=search");
    expect(window.location.pathname).toBe("/apps/other");
    dispose(); post.mockClear(); window.dispatchEvent(new PopStateEvent("popstate"));
    expect(post).not.toHaveBeenCalled();
  });
});
