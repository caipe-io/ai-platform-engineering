import { _resetWebexBotAdminTokenCacheForTests, callWebexBotAdmin } from "../webex-bot-admin";

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  _resetWebexBotAdminTokenCacheForTests();
  process.env.OIDC_ISSUER = "http://keycloak:7080/realms/caipe";
  process.env.OIDC_CLIENT_ID = "caipe-ui";
  process.env.OIDC_CLIENT_SECRET = "__TEST_ONLY_PLACEHOLDER__";
});

afterEach(() => {
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.WEBEX_BOT_ADMIN_URL;
  delete process.env.WEBEX_BOT_ADMIN_TOKEN_URL;
  delete process.env.WEBEX_BOT_ADMIN_AUDIENCE;
});

it("defaults to the webex-bot compose service hostname when WEBEX_BOT_ADMIN_URL is unset", async () => {
  fetchMock
    .mockResolvedValueOnce(response({ access_token: "service-token", expires_in: 300 }))
    .mockResolvedValueOnce(response({ route_mode: "db_prefer" }));

  const result = await callWebexBotAdmin<{ route_mode: string }>("/admin/webex/routes/status");

  expect(result.route_mode).toBe("db_prefer");
  expect(fetchMock).toHaveBeenCalledWith(
    new URL("http://webex-bot:3002/admin/webex/routes/status"),
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer service-token" }),
    })
  );
});

it("uses WEBEX_BOT_ADMIN_URL when explicitly configured", async () => {
  process.env.WEBEX_BOT_ADMIN_URL = "http://custom-webex-bot-host:9999/";
  fetchMock
    .mockResolvedValueOnce(response({ access_token: "service-token", expires_in: 300 }))
    .mockResolvedValueOnce(response({ route_mode: "db_prefer" }));

  await callWebexBotAdmin("/admin/webex/routes/status");

  expect(fetchMock).toHaveBeenCalledWith(
    new URL("http://custom-webex-bot-host:9999/admin/webex/routes/status"),
    expect.anything()
  );
});

it("calls Webex bot admin API with a Keycloak client-credentials bearer token", async () => {
  fetchMock
    .mockResolvedValueOnce(response({ access_token: "service-token", expires_in: 300 }))
    .mockResolvedValueOnce(response({ route_mode: "db_prefer" }));

  const result = await callWebexBotAdmin<{ route_mode: string }>("/admin/webex/routes/status");

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
  expect(String(fetchMock.mock.calls[0][1].body)).toContain("audience=caipe-webex-bot-admin");
});

it("rejects admin paths outside the allowlist", async () => {
  await expect(callWebexBotAdmin("/admin/../etc/passwd")).rejects.toMatchObject({
    statusCode: 400,
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("rejects with 503 when no client secret is configured", async () => {
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.WEBEX_BOT_ADMIN_CLIENT_SECRET;

  await expect(callWebexBotAdmin("/admin/webex/routes/status")).rejects.toMatchObject({
    statusCode: 503,
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("rejects with 502 when the token endpoint responds with a non-OK status", async () => {
  fetchMock.mockResolvedValueOnce(response({}, false, 500));

  await expect(callWebexBotAdmin("/admin/webex/routes/status")).rejects.toMatchObject({
    statusCode: 502,
  });
});

it("rejects with 502 when the token response is missing access_token", async () => {
  fetchMock.mockResolvedValueOnce(response({ expires_in: 300 }));

  await expect(callWebexBotAdmin("/admin/webex/routes/status")).rejects.toMatchObject({
    statusCode: 502,
  });
});

it("propagates the downstream admin response status and error message", async () => {
  fetchMock
    .mockResolvedValueOnce(response({ access_token: "service-token", expires_in: 300 }))
    .mockResolvedValueOnce(response({ error: "boom" }, false, 404));

  await expect(callWebexBotAdmin("/admin/webex/routes/status")).rejects.toMatchObject({
    statusCode: 404,
    message: expect.stringContaining("boom"),
  });
});

it("reuses a cached unexpired token instead of fetching a new one", async () => {
  fetchMock
    .mockResolvedValueOnce(response({ access_token: "service-token", expires_in: 300 }))
    .mockResolvedValueOnce(response({ route_mode: "db_prefer" }))
    .mockResolvedValueOnce(response({ route_mode: "db_prefer" }));

  await callWebexBotAdmin("/admin/webex/routes/status");
  await callWebexBotAdmin("/admin/webex/routes/status");

  expect(fetchMock).toHaveBeenCalledTimes(3);
});

function response(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => payload,
  } as Response;
}
