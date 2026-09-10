/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

import { ApiError } from "@/lib/api-middleware";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockMergeUserAttributes = jest.fn();
const mockFindRealmUserIdByAttribute = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
  };
});

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  mergeUserAttributes: (...args: unknown[]) => mockMergeUserAttributes(...args),
  findRealmUserIdByAttribute: (...args: unknown[]) => mockFindRealmUserIdByAttribute(...args),
}));

const WEBEX_TOKEN_URL = "https://webexapis.com/v1/access_token";
const WEBEX_PEOPLE_URL = "https://webexapis.com/v1/people/me";

function setConfigured(): void {
  process.env.WEBEX_LINK_CLIENT_ID = "link-client-id";
  process.env.WEBEX_LINK_CLIENT_SECRET = "link-client-secret";
  process.env.WEBEX_LINK_REDIRECT_URI = "http://localhost:3000/api/auth/webex-link/callback";
  process.env.WEBEX_LINK_ALLOWED_ORG_ID = "org-1";
}

function clearConfigured(): void {
  delete process.env.WEBEX_LINK_CLIENT_ID;
  delete process.env.WEBEX_LINK_CLIENT_SECRET;
  delete process.env.WEBEX_LINK_REDIRECT_URI;
  delete process.env.WEBEX_LINK_ALLOWED_ORG_ID;
}

beforeEach(() => {
  jest.clearAllMocks();
  clearConfigured();
  mockGetAuthFromBearerOrSession.mockResolvedValue({ session: { sub: "kc-user-1" } });
  mockMergeUserAttributes.mockResolvedValue(undefined);
  mockFindRealmUserIdByAttribute.mockResolvedValue(null);
});

describe("GET /api/auth/webex-link/start", () => {
  it("returns 404 when identity linking is not configured", async () => {
    const { GET } = await import("../webex-link/start/route");
    const response = await GET(new NextRequest("http://localhost:3000/api/auth/webex-link/start"));
    expect(response.status).toBe(404);
  });

  it("returns 401 when there is no authenticated subject", async () => {
    setConfigured();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ session: {} });
    const { GET } = await import("../webex-link/start/route");
    const response = await GET(new NextRequest("http://localhost:3000/api/auth/webex-link/start"));
    expect(response.status).toBe(401);
  });

  it("redirects to the Webex authorize URL and sets a signed state cookie", async () => {
    setConfigured();
    const { GET } = await import("../webex-link/start/route");
    const response = await GET(new NextRequest("http://localhost:3000/api/auth/webex-link/start"));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://webexapis.com/v1/authorize");
    expect(location.searchParams.get("client_id")).toBe("link-client-id");
    expect(location.searchParams.get("scope")).toBe("spark:people_read");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(response.headers.get("set-cookie")).toContain("caipe_oauth_state_webex-link=");
  });

  it("redirects an unauthenticated browser navigation to sign-in with a callbackUrl, not a bare JSON 401", async () => {
    setConfigured();
    mockGetAuthFromBearerOrSession.mockRejectedValue(
      new ApiError("You are not signed in. Please sign in to continue.", 401, "NOT_SIGNED_IN", "not_signed_in", "sign_in"),
    );
    const { GET } = await import("../webex-link/start/route");
    const response = await GET(
      new NextRequest("http://localhost:3000/api/auth/webex-link/start?webex_user=abc123"),
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("callbackUrl")).toBe(
      "/api/auth/webex-link/start?webex_user=abc123",
    );
    expect(await response.text()).toBe("");
  });

  it("redirects to the public origin (NEXTAUTH_URL) for the sign-in page, not the pod-internal request origin", async () => {
    setConfigured();
    process.env.NEXTAUTH_URL = "https://forge.dev.svc.splunk8s.io";
    mockGetAuthFromBearerOrSession.mockRejectedValue(
      new ApiError("You are not signed in. Please sign in to continue.", 401, "NOT_SIGNED_IN", "not_signed_in", "sign_in"),
    );
    const { GET } = await import("../webex-link/start/route");
    const response = await GET(new NextRequest("http://0.0.0.0:3000/api/auth/webex-link/start"));
    delete process.env.NEXTAUTH_URL;

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://forge.dev.svc.splunk8s.io");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("callbackUrl")).toBe("/api/auth/webex-link/start");
  });
});

describe("GET /api/auth/webex-link/callback", () => {
  async function startAndGetCookie(): Promise<string> {
    const { GET } = await import("../webex-link/start/route");
    const response = await GET(new NextRequest("http://localhost:3000/api/auth/webex-link/start"));
    const cookieHeader = response.headers.get("set-cookie") ?? "";
    return cookieHeader.split(";")[0];
  }

  function mockFetchSequence(options: {
    tokenOk?: boolean;
    accessToken?: string;
    personId?: string;
    personOrgId?: string;
    personEmails?: string[];
    meOk?: boolean;
  }): jest.Mock {
    const {
      tokenOk = true,
      accessToken = "webex-access-token",
      personId = "person-1",
      personOrgId = "org-1",
      personEmails,
      meOk = true,
    } = options;
    return jest.fn(async (url: string) => {
      if (url === WEBEX_TOKEN_URL) {
        return {
          ok: tokenOk,
          status: tokenOk ? 200 : 400,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify({ access_token: accessToken }),
        };
      }
      if (url === WEBEX_PEOPLE_URL) {
        return {
          ok: meOk,
          status: meOk ? 200 : 401,
          json: async () => ({ id: personId, orgId: personOrgId, emails: personEmails }),
        };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
  }

  it("returns 404 when identity linking is not configured", async () => {
    const { GET } = await import("../webex-link/callback/route");
    const response = await GET(
      new NextRequest("http://localhost:3000/api/auth/webex-link/callback?code=c&state=s"),
    );
    expect(response.status).toBe(404);
  });

  it("returns 401 when there is no authenticated subject", async () => {
    setConfigured();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ session: {} });
    const { GET } = await import("../webex-link/callback/route");
    const response = await GET(
      new NextRequest("http://localhost:3000/api/auth/webex-link/callback?code=c&state=s"),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a state/owner mismatch without writing any attribute", async () => {
    setConfigured();
    const cookie = await startAndGetCookie();
    const { GET } = await import("../webex-link/callback/route");
    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/auth/webex-link/callback?code=code-1&state=wrong-state",
        { headers: { cookie } },
      ),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("webex_link")).toBe("error");
    expect(location.searchParams.get("reason")).toBe("INVALID_OAUTH_STATE");
    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
  });

  it("rejects an orgId mismatch without writing any attribute", async () => {
    setConfigured();
    const cookie = await startAndGetCookie();
    const { oauthStateCookieName, parseOAuthStateCookie } = await import("@/lib/credentials/oauth-state");
    const cookieValue = cookie.split(`${oauthStateCookieName("webex-link")}=`)[1];
    const parsed = parseOAuthStateCookie(cookieValue);

    global.fetch = mockFetchSequence({ personOrgId: "some-other-org" });

    const { GET } = await import("../webex-link/callback/route");
    const response = await GET(
      new NextRequest(
        `http://localhost:3000/api/auth/webex-link/callback?code=code-1&state=${parsed.state}`,
        { headers: { cookie } },
      ),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("webex_link")).toBe("error");
    expect(location.searchParams.get("reason")).toBe("WEBEX_ORG_MISMATCH");
    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
  });

  it("rejects a Webex id already linked to a different user", async () => {
    setConfigured();
    const cookie = await startAndGetCookie();
    const { oauthStateCookieName, parseOAuthStateCookie } = await import("@/lib/credentials/oauth-state");
    const cookieValue = cookie.split(`${oauthStateCookieName("webex-link")}=`)[1];
    const parsed = parseOAuthStateCookie(cookieValue);

    global.fetch = mockFetchSequence({ personOrgId: "org-1" });
    mockFindRealmUserIdByAttribute.mockResolvedValue("kc-user-2");

    const { GET } = await import("../webex-link/callback/route");
    const response = await GET(
      new NextRequest(
        `http://localhost:3000/api/auth/webex-link/callback?code=code-1&state=${parsed.state}`,
        { headers: { cookie } },
      ),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("webex_link")).toBe("error");
    expect(location.searchParams.get("reason")).toBe("WEBEX_ID_ALREADY_LINKED");
    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
  });

  it("links the Webex identity on a successful happy-path grant", async () => {
    setConfigured();
    const cookie = await startAndGetCookie();
    const { oauthStateCookieName, parseOAuthStateCookie } = await import("@/lib/credentials/oauth-state");
    const cookieValue = cookie.split(`${oauthStateCookieName("webex-link")}=`)[1];
    const parsed = parseOAuthStateCookie(cookieValue);

    global.fetch = mockFetchSequence({ personId: "person-42", personOrgId: "org-1" });

    const { GET } = await import("../webex-link/callback/route");
    const response = await GET(
      new NextRequest(
        `http://localhost:3000/api/auth/webex-link/callback?code=code-1&state=${parsed.state}`,
        { headers: { cookie } },
      ),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/settings/account-and-access");
    expect(location.searchParams.get("webex_link")).toBe("success");
    expect(mockMergeUserAttributes).toHaveBeenCalledWith("kc-user-1", {
      webex_user_id: ["person-42"],
      webex_user_email: undefined,
    });
    expect(response.headers.get("set-cookie")).toContain("caipe_oauth_state_webex-link=;");
  });

  it("redirects to the public origin (NEXTAUTH_URL), not the pod-internal request origin", async () => {
    setConfigured();
    process.env.NEXTAUTH_URL = "https://forge.dev.svc.splunk8s.io";
    const cookie = await startAndGetCookie();
    const { oauthStateCookieName, parseOAuthStateCookie } = await import("@/lib/credentials/oauth-state");
    const cookieValue = cookie.split(`${oauthStateCookieName("webex-link")}=`)[1];
    const parsed = parseOAuthStateCookie(cookieValue);

    global.fetch = mockFetchSequence({ personId: "person-42", personOrgId: "org-1" });

    const { GET } = await import("../webex-link/callback/route");
    const response = await GET(
      new NextRequest(
        `http://0.0.0.0:3000/api/auth/webex-link/callback?code=code-1&state=${parsed.state}`,
        { headers: { cookie } },
      ),
    );
    delete process.env.NEXTAUTH_URL;

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://forge.dev.svc.splunk8s.io");
    expect(location.pathname).toBe("/settings/account-and-access");
    expect(location.searchParams.get("webex_link")).toBe("success");
  });

  it("rolls back and rejects when a concurrent grant wins the race after the initial check", async () => {
    setConfigured();
    const cookie = await startAndGetCookie();
    const { oauthStateCookieName, parseOAuthStateCookie } = await import("@/lib/credentials/oauth-state");
    const cookieValue = cookie.split(`${oauthStateCookieName("webex-link")}=`)[1];
    const parsed = parseOAuthStateCookie(cookieValue);

    global.fetch = mockFetchSequence({ personId: "person-42", personOrgId: "org-1" });
    mockFindRealmUserIdByAttribute
      .mockResolvedValueOnce(null) // pre-write check: no existing owner
      .mockResolvedValueOnce("kc-user-2"); // post-write check: a concurrent grant won the race

    const { GET } = await import("../webex-link/callback/route");
    const response = await GET(
      new NextRequest(
        `http://localhost:3000/api/auth/webex-link/callback?code=code-1&state=${parsed.state}`,
        { headers: { cookie } },
      ),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("webex_link")).toBe("error");
    expect(location.searchParams.get("reason")).toBe("WEBEX_ID_ALREADY_LINKED");
    expect(mockMergeUserAttributes).toHaveBeenCalledWith("kc-user-1", {
      webex_user_id: ["person-42"],
      webex_user_email: undefined,
    });
    expect(mockMergeUserAttributes).toHaveBeenCalledWith("kc-user-1", {
      webex_user_id: undefined,
      webex_user_email: undefined,
    });
  });

  it("captures the Webex account's email alongside the person id", async () => {
    setConfigured();
    const cookie = await startAndGetCookie();
    const { oauthStateCookieName, parseOAuthStateCookie } = await import("@/lib/credentials/oauth-state");
    const cookieValue = cookie.split(`${oauthStateCookieName("webex-link")}=`)[1];
    const parsed = parseOAuthStateCookie(cookieValue);

    global.fetch = mockFetchSequence({
      personId: "person-42",
      personOrgId: "org-1",
      personEmails: ["person@example.com"],
    });

    const { GET } = await import("../webex-link/callback/route");
    await GET(
      new NextRequest(
        `http://localhost:3000/api/auth/webex-link/callback?code=code-1&state=${parsed.state}`,
        { headers: { cookie } },
      ),
    );

    expect(mockMergeUserAttributes).toHaveBeenCalledWith("kc-user-1", {
      webex_user_id: ["person-42"],
      webex_user_email: ["person@example.com"],
    });
  });
});

describe("DELETE /api/auth/webex-link/unlink", () => {
  it("returns 404 when identity linking is not configured", async () => {
    const { DELETE } = await import("../webex-link/unlink/route");
    const response = await DELETE(new NextRequest("http://localhost:3000/api/auth/webex-link/unlink"));
    expect(response.status).toBe(404);
    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no authenticated subject", async () => {
    setConfigured();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ session: {} });
    const { DELETE } = await import("../webex-link/unlink/route");
    const response = await DELETE(new NextRequest("http://localhost:3000/api/auth/webex-link/unlink"));
    expect(response.status).toBe(401);
    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
  });

  it("clears both the Webex id and email attributes for the calling user", async () => {
    setConfigured();
    const { DELETE } = await import("../webex-link/unlink/route");
    const response = await DELETE(new NextRequest("http://localhost:3000/api/auth/webex-link/unlink"));

    expect(response.status).toBe(200);
    expect(mockMergeUserAttributes).toHaveBeenCalledWith("kc-user-1", {
      webex_user_id: undefined,
      webex_user_email: undefined,
    });
  });
});
