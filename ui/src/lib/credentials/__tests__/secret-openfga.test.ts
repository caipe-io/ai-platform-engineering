import { buildSecretRefOwnerTuples, buildSecretRefShareTuples } from "@/lib/credentials/secret-openfga";

describe("secret_ref OpenFGA tuple builders", () => {
  it("builds owner tuples for user-owned secrets", () => {
    expect(
      buildSecretRefOwnerTuples({
        secretId: "secret-1",
        owner: { type: "user", id: "alice-sub" },
        ownerSubject: "alice-sub",
      }),
    ).toEqual([
      { user: "user:alice-sub", relation: "metadata_reader", object: "secret_ref:secret-1" },
      { user: "user:alice-sub", relation: "user", object: "secret_ref:secret-1" },
      { user: "user:alice-sub", relation: "manager", object: "secret_ref:secret-1" },
      { user: "user:alice-sub", relation: "auditor", object: "secret_ref:secret-1" },
    ]);
  });

  it("builds owner tuples for organization-owned secrets", () => {
    expect(
      buildSecretRefOwnerTuples({
        secretId: "secret-1",
        owner: { type: "organization", id: "example-org" },
        ownerSubject: "alice-sub",
      }),
    ).toEqual([
      {
        user: "organization:example-org#member",
        relation: "metadata_reader",
        object: "secret_ref:secret-1",
      },
      {
        user: "organization:example-org#member",
        relation: "user",
        object: "secret_ref:secret-1",
      },
      {
        user: "organization:example-org#admin",
        relation: "manager",
        object: "secret_ref:secret-1",
      },
      {
        user: "organization:example-org#admin",
        relation: "auditor",
        object: "secret_ref:secret-1",
      },
    ]);
  });

  it("builds share tuples for team use and metadata access", () => {
    expect(buildSecretRefShareTuples("secret-1", "platform-team")).toEqual([
      { user: "team:platform-team#member", relation: "metadata_reader", object: "secret_ref:secret-1" },
      { user: "team:platform-team#member", relation: "user", object: "secret_ref:secret-1" },
    ]);
  });
});
