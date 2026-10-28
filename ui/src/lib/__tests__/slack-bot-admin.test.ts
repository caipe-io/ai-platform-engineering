import { _resetSlackBotAdminTokenCacheForTests, callSlackBotAdmin } from "../slack-bot-admin";

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  _resetSlackBotAdminTokenCacheForTests();
  process.env.OIDC_ISSUER = "http://keycloak:7080/realms/caipe";
  process.env.OIDC_CLIENT_ID = "caipe-ui";
  process.env.OIDC_CLIENT_SECRET = "__TEST_ONLY_PLACEHOLDER__";
  process.env.SLACK_BOT_ADMIN_URL = "http://slack-bot:3001";
  process.env.SLACK_BOT_ADMIN_AUDIENCE = "caipe-slack-bot-admin";
});

afterEach(() => {
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.SLACK_BOT_ADMIN_URL;
  delete process.env.SLACK_BOT_ADMIN_AUDIENCE;
  delete process.env.SLACK_BOT_ADMIN_TOKEN_URL;
  delete process.env.SLACK_BOT_ADMIN_DEV_AUTH_ENABLED;
  delete process.env.SLACK_BOT_ADMIN_DEV_TOKEN;
});

it("calls Slack bot admin API with a Keycloak client-credentials bearer token", async () => {
  fetchMock
    .mockResolvedValueOnce(response({ access_token: "service-token", expires_in: 300 }))
    .mockResolvedValueOnce(response({ route_mode: "db_prefer" }));

  const result = await callSlackBotAdmin<{ route_mode: string }>("/admin/slack/routes/status");

  expect(result.route_mode).toBe("db_prefer");
  expect(fetchMock).toHaveBeenCalledWith(
    "http://keycloak:7080/realms/caipe/protocol/openid-connect/token",
    expect.objectContaining({
      method: "POST",
      body: expect.any(URLSearchParams),
    })
  );
  expect(String(fetchMock.mock.calls[0][1].body)).toContain("grant_type=client_credentials");
  expect(String(fetchMock.mock.calls[0][1].body)).toContain("client_id=caipe-ui");
  expect(String(fetchMock.mock.calls[0][1].body)).toContain("audience=caipe-slack-bot-admin");
  expect(fetchMock).toHaveBeenCalledWith(
    "http://slack-bot:3001/admin/slack/routes/status",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer service-token" }),
    })
  );
});

it("calls Slack bot admin API with a local dev bearer token when enabled", async () => {
  process.env.SLACK_BOT_ADMIN_DEV_AUTH_ENABLED = "true";
  process.env.SLACK_BOT_ADMIN_DEV_TOKEN = "local-dev-token";
  fetchMock.mockResolvedValueOnce(response({ route_mode: "db_prefer" }));

  const result = await callSlackBotAdmin<{ route_mode: string }>("/admin/slack/routes/status");

  expect(result.route_mode).toBe("db_prefer");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(
    "http://slack-bot:3001/admin/slack/routes/status",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer local-dev-token" }),
    })
  );
});

function response(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => payload,
  } as Response;
}

it("forwards only fixed directory parameters to the bot and uses a service token", async () => {
  const { callSlackBotDirectory } = await import("../slack-bot-admin");
  fetchMock
    .mockResolvedValueOnce(response({ access_token: "service-token", expires_in: 300 }))
    .mockResolvedValueOnce(response({ users: [] }));
  await callSlackBotDirectory("users", new URLSearchParams("q=example&limit=10&url=https://example.com&token=secret"));
  expect(fetchMock.mock.calls[1][0]).toBe("http://slack-bot:3001/admin/slack/directory/users?q=example&limit=10");
  expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer service-token");
});

it("preserves a bot directory busy response and retry interval", async () => {
  process.env.SLACK_BOT_ADMIN_DEV_AUTH_ENABLED = "true";
  process.env.SLACK_BOT_ADMIN_DEV_TOKEN = "local-dev-token";
  fetchMock.mockResolvedValueOnce({
    ...response({ error: "Directory refresh in progress" }, false, 503),
    headers: new Headers({ "Retry-After": "2" }),
  });
  await expect(callSlackBotAdmin("/admin/slack/directory/users"))
    .rejects.toMatchObject({ statusCode: 503, retryAfterSeconds: 2 });
});
