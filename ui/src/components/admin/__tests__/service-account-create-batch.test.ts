/**
 * Unit tests for createServiceAccountBatched (extracted from
 * CreateServiceAccountDialog.submit in ServiceAccountsTab.tsx). Covers the
 * create-time scopes cap: the create endpoint only accepts up to
 * `createBatchSize` scopes per request, so a selection beyond that must be
 * split into a first batch (sent with the create call) and a remainder
 * attached afterward via the bulk `/scopes/bulk` endpoint (in chunks of
 * `bulkBatchSize`), mirroring how the edit/unlinked-SA "add scopes" flow
 * already avoids one-request-per-scope round trips.
 */

import { createServiceAccountBatched } from "../ServiceAccountsTab";

function jsonResponse(body: unknown, ok: boolean, status: number): Response {
  return { ok, status, json: async () => body } as Response;
}

const CREDENTIAL = { client_id: "c1", client_secret: "s1", token_url: "t1" };

function createSuccessResponse() {
  return jsonResponse(
    {
      success: true,
      data: { id: "sa-sub-1", name: "bot", credential: CREDENTIAL },
    },
    true,
    201,
  );
}

describe("createServiceAccountBatched", () => {
  it("sends all scopes in one create call when at/under the batch size", async () => {
    const scopes = [{ type: "tool" as const, ref: "server_1" }];
    const fetchMock = jest.fn().mockResolvedValueOnce(createSuccessResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await createServiceAccountBatched({
      name: "bot",
      owningTeamId: "team-sre",
      scopes,
      createBatchSize: 500,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/service-accounts");
    expect(JSON.parse(init.body).scopes).toEqual(scopes);
    expect(result).toEqual({
      success: true,
      credential: CREDENTIAL,
      name: "bot",
      warning: undefined,
    });
  });

  it("sends only the first `createBatchSize` scopes in the create call, then attaches the rest via one bulk call", async () => {
    const scopes = Array.from({ length: 5 }, (_, i) => ({
      type: "tool" as const,
      ref: `server_${i}`,
    }));
    const fetchMock = jest.fn();
    fetchMock.mockResolvedValueOnce(createSuccessResponse());
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { added_count: 3 } }, true, 200),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await createServiceAccountBatched({
      name: "bot",
      owningTeamId: "team-sre",
      scopes,
      createBatchSize: 2,
    });

    // 1 create call + 1 bulk call for the remaining 3 scopes.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(createUrl).toBe("/api/admin/service-accounts");
    expect(JSON.parse(createInit.body).scopes).toEqual(scopes.slice(0, 2));

    const [bulkUrl, bulkInit] = fetchMock.mock.calls[1];
    expect(bulkUrl).toBe("/api/admin/service-accounts/sa-sub-1/scopes/bulk");
    expect(bulkInit.method).toBe("POST");
    expect(JSON.parse(bulkInit.body)).toEqual({ scopes: scopes.slice(2) });

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("chunks the remainder into multiple bulk calls when it exceeds bulkBatchSize", async () => {
    const scopes = Array.from({ length: 5 }, (_, i) => ({
      type: "tool" as const,
      ref: `server_${i}`,
    }));
    const fetchMock = jest.fn();
    fetchMock.mockResolvedValueOnce(createSuccessResponse());
    // remaining = 4 scopes (index 1..4), bulkBatchSize=2 -> two bulk calls of 2 each.
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { added_count: 2 } }, true, 200),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await createServiceAccountBatched({
      name: "bot",
      owningTeamId: "team-sre",
      scopes,
      createBatchSize: 1,
      bulkBatchSize: 2,
    });

    // 1 create call + 2 bulk calls (chunks of 2 covering the 4 remaining scopes).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const remaining = scopes.slice(1);
    const [, firstBulkInit] = fetchMock.mock.calls[1];
    const [, secondBulkInit] = fetchMock.mock.calls[2];
    expect(JSON.parse(firstBulkInit.body)).toEqual({
      scopes: remaining.slice(0, 2),
    });
    expect(JSON.parse(secondBulkInit.body)).toEqual({
      scopes: remaining.slice(2, 4),
    });
    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("returns a warning naming the failed count when a follow-up bulk chunk fails", async () => {
    const scopes = Array.from({ length: 4 }, (_, i) => ({
      type: "tool" as const,
      ref: `server_${i}`,
    }));
    const fetchMock = jest.fn();
    fetchMock.mockResolvedValueOnce(createSuccessResponse());
    // createBatchSize=1 -> 3 remaining, bulkBatchSize=1 -> 3 individual bulk calls; the middle one fails.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { added_count: 1 } }, true, 200),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: false, error: "nope" }, false, 403),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { added_count: 1 } }, true, 200),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await createServiceAccountBatched({
      name: "bot",
      owningTeamId: "team-sre",
      scopes,
      createBatchSize: 1,
      bulkBatchSize: 1,
    });

    expect(result.success).toBe(true);
    expect(result.warning).toBe(
      "1 of 3 additional scope(s) beyond the first 1 could not be attached. Add them from Manage → Scopes.",
    );
  });

  it("surfaces the create error and rejected scope refs without making any follow-up calls", async () => {
    const scopes = Array.from({ length: 3 }, (_, i) => ({
      type: "tool" as const,
      ref: `server_${i}`,
    }));
    const fetchMock = jest.fn().mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error: "You cannot grant scopes you do not hold",
          data: { rejected_scopes: [{ type: "tool", ref: "server_0" }] },
        },
        false,
        403,
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await createServiceAccountBatched({
      name: "bot",
      owningTeamId: "team-sre",
      scopes,
      createBatchSize: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toBe("You cannot grant scopes you do not hold");
    expect(result.rejectedScopeRefs).toEqual(["server_0"]);
  });
});
