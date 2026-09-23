import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      "node_modules/",
      ".next/",
      "out/",
      "dist/",
      "build/",
      "coverage/",
      "playwright-report/",
      "test-results/",
      "*.min.js",
    ],
  },
  ...nextVitals,
  ...nextTypescript,
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "@next/next/no-img-element": "error",
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/set-state-in-effect": "error",
    },
  },
  // Engines are private to CAS. The existing RBAC relationship helper is the
  // only outside consumer allowed to use the shared transport during migration.
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["src/lib/authz/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/authz/engines/*", "**/lib/authz/engines/*"],
              message:
                "Import CAS through its public API (@/lib/authz), not the engine adapter directly.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/lib/rbac/openfga.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [{
            group: [
              "@/lib/authz/engines/*",
              "**/lib/authz/engines/*",
              "!@/lib/authz/engines/openfga-client",
            ],
            message: "The RBAC helper may use the shared transport, not the CAS policy engine.",
          }],
        },
      ],
    },
  },
];

export default eslintConfig;
