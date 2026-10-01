/** @jest-environment node */

import { NextRequest } from "next/server";

import type { PublicationDriftItem, PublicationRequestDocument } from "@/types/publication-approval";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockAcquirePublicationRequestForApproval = jest.fn();
const mockApplyPublicationRequestAdapter = jest.fn();
const mockCompletePublicationApproval = jest.fn();
const mockFailPublicationApproval = jest.fn();
const mockReleasePublicationApprovalForDrift = jest.fn();
const mockSupersedeApplyingPublicationRequest = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown, status = 200) =>
      Response.json({ success: true, data }, { status }),
    withErrorHandler:
      <T>(handler: (request: NextRequest, context: T) => Promise<Response>) =>
      async (request: NextRequest, context: T) => {
        try {
          return await handler(request, context);
        } catch (error) {
          if (error instanceof actual.ApiError) {
            return Response.json(
              { success: false, error: error.message, code: error.code },
              { status: error.statusCode },
            );
          }
          throw error;
        }
      },
  };
});

jest.mock("@/lib/publication-approval-adapters.server", () => ({
  applyPublicationRequestAdapter: (...args: unknown[]) =>
    mockApplyPublicationRequestAdapter(...args),
}));

jest.mock("@/lib/publication-approval.server", () => ({
  acquirePublicationRequestForApproval: (...args: unknown[]) =>
    mockAcquirePublicationRequestForApproval(...args),
  completePublicationApproval: (...args: unknown[]) =>
    mockCompletePublicationApproval(...args),
  failPublicationApproval: (...args: unknown[]) =>
    mockFailPublicationApproval(...args),
  publicationActorFromSession: () => ({
    subject: "approver-subject",
    email: "approver@example.com",
    name: "Approving User",
  }),
  releasePublicationApprovalForDrift: (...args: unknown[]) =>
    mockReleasePublicationApprovalForDrift(...args),
  supersedeApplyingPublicationRequest: (...args: unknown[]) =>
    mockSupersedeApplyingPublicationRequest(...args),
}));

import { PublicationDriftError } from "@/lib/api-error";
import { ApiError } from "@/lib/api-middleware";
import { POST as approve } from "@/app/api/publication-requests/[id]/approve/route";

function nextRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/publication-requests/request-primary/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function request(overrides: Partial<PublicationRequestDocument> = {}): PublicationRequestDocument {
  return {
    _id: "request-primary",
    adapter_version: 1,
    resource: { kind: "slack_channel", id: "workspace/channel", label: "Slack: #primary" },
    authorization_policy_id: "publication.slack_channel.abc.request-primary",
    resource_revision: "revision-primary",
    requested_state: {},
    effective_state: {},
    risk_facts: { organization_wide: false, target_team_slugs: ["target-team"], reasons: [] },
    requester: { subject: "requester-subject" },
    requester_team_slugs: ["requester-team"],
    approver_team_slugs: ["approver-team"],
    status: "applying",
    history: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const params = Promise.resolve({ id: "request-primary" });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthFromBearerOrSession.mockResolvedValue({
    session: { sub: "approver-subject", user: { email: "approver@example.com" } },
  });
  mockAcquirePublicationRequestForApproval.mockResolvedValue(request());
});

it("approves and forwards the adapter-reported drift to completion", async () => {
  const acknowledged: PublicationDriftItem[] = [
    { field: "member_count", label: "Members", before: 24, after: 25, overridable: true },
  ];
  mockApplyPublicationRequestAdapter.mockResolvedValue(acknowledged);
  mockCompletePublicationApproval.mockResolvedValue(request({ status: "approved" }));

  const response = await approve(
    nextRequest({ note: "looks fine", acknowledged_drift_fingerprint: "fp-1" }),
    { params },
  );
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.data.request.status).toBe("approved");
  expect(mockApplyPublicationRequestAdapter).toHaveBeenCalledWith(
    expect.objectContaining({ _id: "request-primary" }),
    expect.objectContaining({ sub: "approver-subject" }),
    { acknowledgedFingerprint: "fp-1" },
  );
  expect(mockCompletePublicationApproval).toHaveBeenCalledWith(
    "request-primary",
    expect.objectContaining({ subject: "approver-subject" }),
    "looks fine",
    acknowledged,
  );
  expect(mockReleasePublicationApprovalForDrift).not.toHaveBeenCalled();
  expect(mockSupersedeApplyingPublicationRequest).not.toHaveBeenCalled();
});

it("releases the request to pending and asks for confirmation on soft drift", async () => {
  const drift: PublicationDriftItem[] = [
    { field: "member_count", label: "Members", before: 24, after: 25, overridable: true },
  ];
  mockApplyPublicationRequestAdapter.mockRejectedValue(
    new PublicationDriftError("Slack channel membership changed.", drift, "fp-2"),
  );
  mockReleasePublicationApprovalForDrift.mockResolvedValue(request({ status: "pending" }));

  const response = await approve(nextRequest({}), { params });
  const body = await response.json();

  expect(response.status).toBe(409);
  expect(body.data).toEqual(
    expect.objectContaining({
      drift_confirmation_required: true,
      drift,
      drift_fingerprint: "fp-2",
    }),
  );
  expect(body.data.request.status).toBe("pending");
  expect(mockReleasePublicationApprovalForDrift).toHaveBeenCalledWith(
    "request-primary",
    expect.objectContaining({ subject: "approver-subject" }),
    drift,
  );
  expect(mockCompletePublicationApproval).not.toHaveBeenCalled();
  expect(mockFailPublicationApproval).not.toHaveBeenCalled();
});

it("supersedes the request on a hard conflict and surfaces its drift", async () => {
  const drift: PublicationDriftItem[] = [
    { field: "channel_id", label: "Channel", before: "channel-old", after: "channel-new", overridable: false },
  ];
  const hardConflict = new ApiError(
    "Slack channel membership or audience changed after approval was requested.",
    409,
    "PUBLICATION_REVISION_CONFLICT",
  );
  Object.assign(hardConflict, { drift });
  mockApplyPublicationRequestAdapter.mockRejectedValue(hardConflict);
  mockSupersedeApplyingPublicationRequest.mockResolvedValue(request({ status: "superseded" }));

  const response = await approve(nextRequest({}), { params });
  const body = await response.json();

  expect(response.status).toBe(409);
  expect(body.data.conflict).toBe(true);
  expect(body.data.drift).toEqual(drift);
  expect(body.data.request.status).toBe("superseded");
  expect(mockSupersedeApplyingPublicationRequest).toHaveBeenCalledWith(
    "request-primary",
    expect.objectContaining({ subject: "approver-subject" }),
    hardConflict.message,
    drift,
  );
  expect(mockReleasePublicationApprovalForDrift).not.toHaveBeenCalled();
});

it("marks the apply failed and rethrows for any other error", async () => {
  mockApplyPublicationRequestAdapter.mockRejectedValue(new Error("provider unavailable"));

  await expect(approve(nextRequest({}), { params })).rejects.toThrow("provider unavailable");

  expect(mockFailPublicationApproval).toHaveBeenCalledWith(
    "request-primary",
    expect.objectContaining({ subject: "approver-subject" }),
    expect.any(Error),
  );
  expect(mockReleasePublicationApprovalForDrift).not.toHaveBeenCalled();
  expect(mockSupersedeApplyingPublicationRequest).not.toHaveBeenCalled();
});

it("rejects an oversized acknowledged_drift_fingerprint", async () => {
  const response = await approve(
    nextRequest({ acknowledged_drift_fingerprint: "x".repeat(129) }),
    { params },
  );
  expect(response.status).toBe(400);
  expect(mockAcquirePublicationRequestForApproval).not.toHaveBeenCalled();
});
