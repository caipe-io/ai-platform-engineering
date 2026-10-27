/* eslint-disable @typescript-eslint/no-require-imports */
const base = require("./jest.config.js");
module.exports = async () => ({
  ...await base(), setupFilesAfterEnv: [],
  modulePathIgnorePatterns: ["<rootDir>/.next/"],
  testMatch: ["<rootDir>/src/lib/authz/__tests__/gateway-native.integration.test.ts"],
});
