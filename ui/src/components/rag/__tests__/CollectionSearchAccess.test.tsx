import { render, screen } from "@testing-library/react";

import {
  CollectionSearchAccessNotice,
  collectionDerivedSearchAccess,
} from "../CollectionSearchAccess";

describe("collection-derived Search access", () => {
  const collections = [
    {
      id: "platform-rag",
      name: "Platform RAG",
      is_platform: true,
      reader_team_slugs: ["everyone"],
    },
    {
      id: "engineering",
      name: "Engineering",
      is_platform: false,
      reader_team_slugs: ["everyone", "engineering"],
    },
  ];

  it("groups inherited audiences and identifies their collections", () => {
    const access = collectionDerivedSearchAccess(collections);

    expect(access.selections).toEqual([
      { kind: "team", id: "everyone" },
      { kind: "team", id: "engineering" },
    ]);
    expect(access.labelFor({ kind: "team", id: "everyone" })).toBe(
      "From Platform RAG, Engineering",
    );
  });

  it("explains that collection access is managed on the collection", () => {
    render(<CollectionSearchAccessNotice collections={collections} />);

    expect(screen.getByText("Search from collections")).toBeInTheDocument();
    expect(screen.getByText("Platform RAG · Everyone")).toBeInTheDocument();
    expect(screen.getByText("Engineering · Everyone, engineering")).toBeInTheDocument();
  });
});
