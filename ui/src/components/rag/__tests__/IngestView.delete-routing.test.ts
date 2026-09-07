/**
 * @jest-environment node
 *
 * Deleting an already-ingested data source that also has a self-service
 * `rag_ingestion_sources` config row must go through the Mongo/OpenFGA-aware
 * `DELETE /api/rag/sources/[sourceId]` route BEFORE purging the ingested
 * data via the raw RAG-server proxy — otherwise the primary Delete button
 * bypasses that route entirely and strands the source's `ingestion_source`/
 * `knowledge_base`/`data_source` OpenFGA grants after the data is gone.
 * Mirrors the source-inspection style of `IngestView.reingest-error.test.ts`
 * since this 3000+ line component has no full render-test harness.
 */

import { readFileSync } from "fs";
import path from "path";

describe("IngestView delete routing", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/components/rag/IngestView.tsx"),
    "utf8",
  );

  it("deletes the source config row before purging the RAG-server datasource", () => {
    const handlerMatch = source.match(
      /const handleDeleteDataSource = async[\s\S]*?(?=\n {2}const handleReloadDataSource)/,
    );
    expect(handlerMatch).not.toBeNull();
    const handler = handlerMatch![0];

    const configDeleteIndex = handler.indexOf("/api/rag/sources/");
    const rawDeleteIndex = handler.indexOf("deleteDataSource(datasourceId)");
    expect(configDeleteIndex).toBeGreaterThan(-1);
    expect(rawDeleteIndex).toBeGreaterThan(-1);
    expect(configDeleteIndex).toBeLessThan(rawDeleteIndex);
    expect(handler).toMatch(/method:\s*["']DELETE["']/);
  });

  it("refreshes ingestion source configs after a successful delete", () => {
    const handlerMatch = source.match(
      /const handleDeleteDataSource = async[\s\S]*?(?=\n {2}const handleReloadDataSource)/,
    );
    expect(handlerMatch![0]).toContain("fetchIngestionSourceConfigs()");
  });

  it("does not let Search administration imply source management", () => {
    expect(source).toContain(
      "hasSourceManagementPolicy || !sourcePolicyStateKnown",
    );
    expect(source).toContain("? rowPermissions.can_manage_source");
    expect(source).toContain(": rowPermissions.can_manage_query");
    // Source managers may also administer the independent Search
    // sharing policy. The OR belongs only to that sharing control; mutation
    // of the source itself continues to use canManageDatasource above.
    expect(source).toContain("const canManageQueryAccess = rowPermissions");
    expect(source).toMatch(
      /rowPermissions\.can_manage_query\s*\|\|\s*rowPermissions\.can_manage_source/,
    );
    expect(source).toContain("{canManageDatasource && (");
    expect(source).toMatch(
      /const canOpenDatasourceManager\s*=\s*canManageQueryAccess\s*\|\|\s*canManageSourceConfig/,
    );
    expect(source).toContain('title="Manage Datasource"');
    expect(source).toMatch(
      /if\s*\(\s*cachedConfig\s*&&\s*canManageConfig\s*\)/,
    );
    expect(source).toMatch(
      /datasource\.has_source_config\s*&&\s*datasource\._permissions\?\.can_manage_source/,
    );
    expect(source).toMatch(
      /if\s*\(\s*!shouldLoadConfig\s*\)\s*{\s*setSharingDatasource\(datasource\)/,
    );
    expect(source).toMatch(
      /if\s*\(\s*!body\.data\?\._permissions\.can_manage\s*\)\s*{\s*setSharingDatasource\(datasource\)/,
    );
  });
});
