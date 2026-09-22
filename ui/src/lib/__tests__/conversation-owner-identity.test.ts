import {
  reconcileConversationAnalyticsIdentity,
  reconcileConversationOwnerIdentity,
} from "@/lib/conversation-owner-identity";

describe("reconcileConversationOwnerIdentity", () => {
  it("binds email and connector aliases without overwriting an existing subject", async () => {
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 3 });

    const modified = await reconcileConversationOwnerIdentity(
      { updateMany } as never,
      "person-subject",
      ["Person@Example.COM", "U123EXAMPLE"],
    );

    expect(modified).toBe(3);
    expect(updateMany).toHaveBeenCalledWith(
      {
        $and: [
          {
            $or: [
              {
                owner_id: {
                  $regex: "^Person@Example\\.COM$",
                  $options: "i",
                },
              },
              { owner_id: "U123EXAMPLE" },
            ],
          },
          {
            $or: [
              { owner_subject: { $exists: false } },
              { owner_subject: null },
              { owner_subject: "" },
              { owner_subject: "person-subject" },
            ],
          },
        ],
      },
      {
        $set: {
          owner_subject: "person-subject",
          owner_canonical_subject: "person-subject",
          owner_identity_version: 2,
        },
      },
    );
  });

  it("can reconcile analytics without granting ownership", async () => {
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 2 });

    const modified = await reconcileConversationAnalyticsIdentity(
      { updateMany } as never,
      "person-subject",
      ["person@example.com"],
    );

    expect(modified).toBe(2);
    expect(updateMany).toHaveBeenCalledWith(
      expect.any(Object),
      {
        $set: {
          owner_canonical_subject: "person-subject",
          owner_identity_version: 2,
        },
      },
    );
    expect(updateMany.mock.calls[0][1].$set).not.toHaveProperty("owner_subject");
  });

  it("does not write without a subject or owner alias", async () => {
    const updateMany = jest.fn();

    await expect(
      reconcileConversationOwnerIdentity({ updateMany } as never, "", ["person@example.com"]),
    ).resolves.toBe(0);
    await expect(
      reconcileConversationOwnerIdentity({ updateMany } as never, "person-subject", ["  "]),
    ).resolves.toBe(0);

    expect(updateMany).not.toHaveBeenCalled();
  });
});
