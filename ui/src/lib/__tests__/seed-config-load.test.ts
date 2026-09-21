/** @jest-environment node */

import fs from "fs";
import os from "os";
import path from "path";

import { loadSeedConfig } from "../seed-config";

const EMPTY_SEED_CONFIG = {
  models: [],
  agents: [],
  mcp_servers: [],
  workflow_configs: [],
  rag_sources: [],
};

function withConfigFile(
  contents: string,
  assertion: (configPath: string) => void,
): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "seed-config-"));
  const configPath = path.join(directory, "example.yaml");

  try {
    fs.writeFileSync(configPath, contents);
    assertion(configPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("loadSeedConfig", () => {
  it("treats an empty YAML document as an empty seed configuration", () => {
    withConfigFile("", (configPath) => {
      expect(loadSeedConfig(configPath)).toEqual(EMPTY_SEED_CONFIG);
    });
  });

  it("loads YAML and expands environment variable defaults", () => {
    withConfigFile(
      [
        "models:",
        "  - model_id: example-model",
        "    name: Example Model",
        "    provider: example",
        "agents:",
        "  - id: example-agent",
        "    token: ${EXAMPLE_SEED_TOKEN:-example-token}",
      ].join("\n"),
      (configPath) => {
        expect(loadSeedConfig(configPath)).toEqual({
          ...EMPTY_SEED_CONFIG,
          models: [
            {
              model_id: "example-model",
              name: "Example Model",
              provider: "example",
            },
          ],
          agents: [{ id: "example-agent", token: "example-token" }],
        });
      },
    );
  });
});
