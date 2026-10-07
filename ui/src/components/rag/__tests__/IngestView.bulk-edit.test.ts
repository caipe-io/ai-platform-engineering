/**
 * @jest-environment node
 *
 * Self-service bulk edit wiring on the Ingest page. Mirrors the
 * source-inspection style of `IngestView.reingest-error.test.ts` and
 * `IngestView.delete-routing.test.ts` since this 3000+ line component has no
 * full render-test harness.
 */

import { readFileSync } from "fs";
import path from "path";

const source = readFileSync(
  path.join(process.cwd(), "src/components/rag/IngestView.tsx"),
  "utf8",
);

describe("IngestView bulk edit", () => {
  it("only treats a source as bulk-manageable when it is not config-driven and the caller can manage it", () => {
    expect(source).toMatch(
      /source\._permissions\.can_manage\s*&&\s*!source\.config_driven/,
    );
  });

  it("gates the ingested-datasource row checkbox on manage permission AND config-driven state, matching manageableSourceIds", () => {
    const rowCheckboxMatch = source.match(
      /disabled=\{\s*!sourceConfig \|\|\s*!canManageSourceConfig \|\|\s*isConfigDriven\s*\}/,
    );
    expect(rowCheckboxMatch).not.toBeNull();
    expect(source).toMatch(
      /const canManageSourceConfig = Boolean\(\s*sourceConfig\?\._permissions\.can_manage,\s*\);/,
    );
    // config_driven and can_manage are independent (a config-driven record
    // is immutable regardless of who's asking) - the row checkbox must not
    // render enabled-but-inert for a manageable, config-driven source.
    expect(source).toMatch(/const isConfigDriven = Boolean\(/);
  });

  it("toggling selection is a no-op for a source the caller does not manage", () => {
    const toggleMatch = source.match(
      /const toggleBulkSelected = \(source: IngestionSourceConfigWithPermissions\) => \{[\s\S]*?\n {2}\};/,
    );
    expect(toggleMatch).not.toBeNull();
    expect(toggleMatch![0]).toContain(
      "if (!manageableSourceIds.has(source.source_id)) return;",
    );
  });

  it("select-by-collection only adds member ids the caller can manage, and never silently no-ops", () => {
    const selectByCollectionMatch = source.match(
      /const selectByCollection = async \(collectionId: string\) => \{[\s\S]*?\n {2}\};/,
    );
    expect(selectByCollectionMatch).not.toBeNull();
    const handler = selectByCollectionMatch![0];
    expect(handler).toContain(
      "const addable = memberIds.filter((id) => manageableSourceIds.has(id));",
    );
    expect(handler).toContain('toast(\n          "No datasources you manage are in that collection."');
  });

  it("exiting bulk selection mode clears the selection instead of leaving stale ids behind", () => {
    expect(source).toContain(
      "const exitBulkSelectionMode = () => {\n    setBulkSelectionMode(false);\n    setBulkSelectedSourceIds(new Set());\n  };",
    );
  });

  it("refreshes ingestion sources, datasources, and pending publication requests after a bulk edit is applied", () => {
    const onAppliedMatch = source.match(
      /onApplied=\{async \(\) => \{[\s\S]*?\}\}/,
    );
    expect(onAppliedMatch).not.toBeNull();
    const handler = onAppliedMatch![0];
    expect(handler).toContain("exitBulkSelectionMode()");
    expect(handler).toContain("fetchIngestionSourceConfigs()");
    expect(handler).toContain("fetchDataSources()");
    expect(handler).toContain("fetchPendingPublicationRequests()");
  });

  it("wires the row checkbox to the selected ingestion source config, not the raw datasource row", () => {
    expect(source).toMatch(
      /onChange=\{\(\) =>\s*sourceConfig && toggleBulkSelected\(sourceConfig\)\s*\}/,
    );
  });
});
