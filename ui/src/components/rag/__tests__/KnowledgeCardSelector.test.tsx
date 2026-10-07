/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  KnowledgeCardHand,
  type KnowledgeCardItem,
} from "../KnowledgeCardSelector";

const ITEMS: KnowledgeCardItem[] = Array.from({ length: 30 }, (_, index) => ({
  id: `source-${index + 1}`,
  name: `Example datasource ${index + 1}`,
  kind: "datasource",
  datasourceKind: "web",
  subtitle: "Collection datasource",
}));

describe("KnowledgeCardHand", () => {
  it("bounds a large hand and lets users find any selected datasource", async () => {
    const { container } = render(
      <KnowledgeCardHand items={ITEMS} onRemove={jest.fn()} />,
    );

    expect(screen.getByLabelText("Find selected knowledge")).toBeVisible();
    expect(screen.getByText("30 selected")).toBeVisible();
    expect(
      container.querySelectorAll('[data-testid^="knowledge-card-datasource-"]'),
    ).toHaveLength(24);
    expect(container.querySelector(".overflow-x-auto")).toBeNull();

    fireEvent.change(screen.getByLabelText("Find selected knowledge"), {
      target: { value: "datasource 30" },
    });

    expect(screen.getByText("1 of 30")).toBeVisible();
    expect(
      screen.getByTestId("knowledge-card-datasource-source-30"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        container.querySelectorAll(
          '[data-testid^="knowledge-card-datasource-"]',
        ),
      ).toHaveLength(1),
    );
  });
});
