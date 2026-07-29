/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetCollection = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-error");
  return {
    ApiError: actual.ApiError,
    successResponse: (data: unknown) => Response.json({ success: true, data }),
    withAuth: async (
      request: NextRequest,
      handler: (req: NextRequest, user: { email: string }, session: { sub: string }) => Promise<Response>,
    ) => handler(request, { email: "owner@example.com" }, { sub: "owner-sub" }),
    withErrorHandler:
      <T,>(handler: (request: NextRequest) => Promise<T>) =>
      async (request: NextRequest) => handler(request),
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

describe("GET /api/users/search", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("queries only users with a stable Keycloak subject", async () => {
    const toArray = jest.fn().mockResolvedValue([
      {
        email: "shridhsh@cisco.com",
        name: "Sridhar Shah",
        avatar_url: "avatar.png",
        keycloak_sub: "keycloak-user-1",
      },
    ]);
    const limit = jest.fn().mockReturnValue({ toArray });
    const find = jest.fn().mockReturnValue({ limit });
    mockGetCollection.mockResolvedValue({ find });

    const { GET } = await import("../route");
    const response = await GET(new NextRequest("http://localhost/api/users/search?q=Shri"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(find).toHaveBeenCalledWith({
      $and: [
        {
          $or: [
            { email: { $regex: "Shri", $options: "i" } },
            { name: { $regex: "Shri", $options: "i" } },
          ],
        },
        {
          $or: [
            { keycloak_sub: { $type: "string", $regex: "\\S" } },
            { "metadata.keycloak_sub": { $type: "string", $regex: "\\S" } },
          ],
        },
      ],
    });
    expect(limit).toHaveBeenCalledWith(10);
    expect(body.data).toEqual([
      {
        email: "shridhsh@cisco.com",
        name: "Sridhar Shah",
        avatar_url: "avatar.png",
      },
    ]);
  });

  it("escapes regex metacharacters in directory searches", async () => {
    const find = jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
    });
    mockGetCollection.mockResolvedValue({ find });

    const { GET } = await import("../route");
    await GET(new NextRequest("http://localhost/api/users/search?q=shri.*"));

    expect(find.mock.calls[0][0].$and[0].$or[0].email.$regex).toBe("shri\\.\\*");
  });
});
