#!/usr/bin/env node
import { readFileSync } from "node:fs";

import {
  validateAgenticAppManifest,
  validateAgenticAppOwnership,
} from "../agentic-app-manifest.mjs";

const path = process.argv[2];
if (!path) throw new Error("Usage: caipe-app-check <manifest.json>");
const manifest = validateAgenticAppManifest(
  JSON.parse(readFileSync(path, "utf8")),
);
validateAgenticAppOwnership([manifest]);
process.stdout.write(
  `${manifest.id}@${manifest.version} conforms to AgenticAppManifest ${manifest.apiVersion}; permission requests are declarations only\n`,
);
