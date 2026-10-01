import { render, screen } from "@testing-library/react";

import { CollectionSearchAccessNotice } from "../CollectionSearchAccess";

describe("CollectionSearchAccessNotice", () => {
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

  it("lists membership without implying Search access", () => {
    render(<CollectionSearchAccessNotice collections={collections} />);

    expect(screen.getByText("Included in collections")).toBeInTheDocument();
    expect(screen.getByText("Platform RAG")).toBeInTheDocument();
    expect(screen.getByText("Engineering")).toBeInTheDocument();
    expect(screen.queryByText(/Everyone/)).not.toBeInTheDocument();
  });

  it("renders nothing when the datasource is not in any collection", () => {
    render(<CollectionSearchAccessNotice collections={[]} />);

    expect(screen.queryByText("Included in collections")).not.toBeInTheDocument();
  });
});
