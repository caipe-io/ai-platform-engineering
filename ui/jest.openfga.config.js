/* eslint-disable @typescript-eslint/no-require-imports */
const baseConfig = require("./jest.config.js");

module.exports = async () => ({
  ...await baseConfig(),
  // The ordinary UI setup mocks fetch. This suite needs real HTTP to a local PDP.
  setupFilesAfterEnv: [],
  testMatch: ["<rootDir>/src/lib/rbac/__tests__/agent-use-model.integration.test.ts"],
  modulePathIgnorePatterns: ["<rootDir>/.next/"],
});
