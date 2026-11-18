/** @jest-environment node */
let user: Record<string, unknown> | null;
let writes: Record<string, unknown>[];
const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  process.env = { ...originalEnv, KEYCLOAK_URL: "https://identity.example.test", KEYCLOAK_REALM: "example", KEYCLOAK_ADMIN_CLIENT_ID: "example-client", KEYCLOAK_ADMIN_CLIENT_SECRET: "test-secret" };
  user = { id: "test-subject", email: "test-user@example.test", firstName: "", lastName: "" };
  writes = [];
  global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/protocol/openid-connect/token")) return Response.json({ access_token: "test-token", expires_in: 300 });
    expect(url).toBe("https://identity.example.test/admin/realms/example/users/test-subject");
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }
    return user ? Response.json(user) : new Response(null, { status: 404 });
  }) as typeof fetch;
});
afterAll(() => { global.fetch = originalFetch; process.env = originalEnv; });

it.each([
  { given_name: "Test", family_name: "Person" },
  { firstname: "Test", lastname: "Person" },
  { caipe_idp_given_name: "Test", caipe_idp_family_name: "Person" },
  { caipe_idp_firstname: "Test", caipe_idp_lastname: "Person" },
])("repairs an email-only existing account from structured claims %j", async (claims) => {
  const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
  expect(await backfillMissingUserNamesFromClaims("test-subject", claims)).toBe("Test Person");
  expect(writes).toEqual([{ firstName: "Test", lastName: "Person" }]);
});

it("preserves an existing name and fills only the missing part", async () => {
  user = { ...user, firstName: "Preferred", lastName: "  " };
  const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
  expect(await backfillMissingUserNamesFromClaims("test-subject", { given_name: "Other", family_name: "Person" })).toBe("Preferred Person");
  expect(writes).toEqual([{ lastName: "Person" }]);
});

it("does not overwrite a complete profile", async () => {
  user = { ...user, firstName: "Preferred", lastName: "Person" };
  const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
  expect(await backfillMissingUserNamesFromClaims("test-subject", { given_name: "Other", family_name: "Name" })).toBeUndefined();
  expect(writes).toEqual([]);
});

it.each([
  { name: "Test Person", email: "test-user@example.test", preferred_username: "test-user" },
  { given_name: ["Test"], family_name: { value: "Person" } },
  { given_name: "test-user@example.test", family_name: "<>&" },
  { given_name: "a".repeat(256), family_name: " " },
])("does not infer names or use malformed claims %j", async (claims) => {
  const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
  await backfillMissingUserNamesFromClaims("test-subject", claims);
  expect(global.fetch).not.toHaveBeenCalled();
});

it("sanitizes valid structured names and falls back from empty upstream claims", async () => {
  const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
  await backfillMissingUserNamesFromClaims("test-subject", { caipe_idp_given_name: " ", given_name: "Test (Example)", family_name: "  Person  " });
  expect(writes).toEqual([{ firstName: "Test Example", lastName: "Person" }]);
});

it("never recreates a deleted subject or resolves a replacement by email", async () => {
  user = null;
  const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
  expect(await backfillMissingUserNamesFromClaims("test-subject", { given_name: "Test" })).toBeUndefined();
  expect(writes).toEqual([]);
});

it("requires a subject and surfaces a write failure to its caller", async () => {
  const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
  await backfillMissingUserNamesFromClaims(" ", { given_name: "Test" });
  expect(global.fetch).not.toHaveBeenCalled();
  (global.fetch as jest.Mock).mockImplementation(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ access_token: "test-token", expires_in: 300 });
    if (init?.method === "PUT") return new Response("unavailable", { status: 503 });
    return Response.json(user);
  });
  await expect(backfillMissingUserNamesFromClaims("test-subject", { given_name: "Test" })).rejects.toThrow();
});

function controlledDeadline(): jest.SpyInstance {
  jest.useFakeTimers();
  return jest.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Profile repair timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
}

function stalledFetch(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function stalledBody(signal: AbortSignal, status = 200): Response {
  return new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  }), { status });
}

it.each(["token-fetch", "token-body", "lookup-fetch", "lookup-body", "update-fetch", "update-error-body"])(
  "cancels stalled %s within one overall repair deadline", async (stage) => {
    const deadline = controlledDeadline();
    const signals: AbortSignal[] = [];
    try {
      (global.fetch as jest.Mock).mockImplementation(async (input: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        if (input.endsWith("/protocol/openid-connect/token")) {
          if (stage === "token-fetch") return stalledFetch(signal);
          if (stage === "token-body") return stalledBody(signal);
          return Response.json({ access_token: "test-token", expires_in: 300 });
        }
        if (init.method === "GET") {
          if (stage === "lookup-fetch") return stalledFetch(signal);
          if (stage === "lookup-body") return stalledBody(signal);
          return Response.json(user);
        }
        if (stage === "update-fetch") return stalledFetch(signal);
        return stalledBody(signal, 503);
      });
      const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
      const pending = backfillMissingUserNamesFromClaims("test-subject", { given_name: "Test" });
      const rejected = expect(pending).rejects.toThrow("Profile repair timed out");
      await jest.advanceTimersByTimeAsync(2_999);
      expect(signals.length).toBeGreaterThan(0);
      expect(signals[0].aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await rejected;
      expect(deadline).toHaveBeenCalledTimes(1);
      expect(deadline).toHaveBeenCalledWith(3_000);
      expect(signals.every((signal) => signal === signals[0] && signal.aborted)).toBe(true);
      // An aborted credential request must not fall through to the dev password grant.
      expect(signals.length).toBe(stage.startsWith("token") ? 1 : stage.startsWith("lookup") ? 2 : 3);
    } finally {
      deadline.mockRestore();
      jest.useRealTimers();
    }
  },
);

it("does not wait for or cancel a shared token refresh owned by another caller", async () => {
  const deadline = controlledDeadline();
  let completeShared!: (response: Response) => void;
  let sharedCompleted = false;
  try {
    (global.fetch as jest.Mock).mockImplementation(async (_input: string, init: RequestInit) => {
      if (init.signal) return stalledFetch(init.signal);
      return new Promise<Response>((resolve) => { completeShared = resolve; });
    });
    const { getAdminToken, backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
    const shared = getAdminToken().then((value) => { sharedCompleted = true; return value; });
    const repair = backfillMissingUserNamesFromClaims("test-subject", { given_name: "Test" });
    const rejected = expect(repair).rejects.toThrow("Profile repair timed out");
    await jest.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(sharedCompleted).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    completeShared(Response.json({ access_token: "shared-token", expires_in: 300 }));
    expect(await shared).toBe("shared-token");
    expect(await getAdminToken()).toBe("shared-token");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  } finally {
    deadline.mockRestore();
    jest.useRealTimers();
  }
});
