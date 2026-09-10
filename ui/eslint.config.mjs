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
  // CAS silo boundary: the OpenFGA transport adapters are private. The CAS
  // core (lib/authz/**) and the legacy RBAC layer (lib/rbac/**) must never
  // import each other's OpenFGA transport — each owns its own. App code must
  // consume CAS only through its public entrypoint (@/lib/authz), never the
  // engine directly.
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
];

export default eslintConfig;
