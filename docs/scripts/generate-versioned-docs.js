#!/usr/bin/env node
/**
 * Generate Docusaurus versioned docs at build time from git release tags.
 *
 * Instead of committing `versioned_docs/` snapshots into the repo, the published
 * versions are listed in `docs/published-versions.json` and materialised here, on
 * demand, by snapshotting each tag's `docs/` tree with the current Docusaurus
 * toolchain. The generated `versioned_docs/`, `versioned_sidebars/`,
 * `versions.json` and `versions-config.json` are git-ignored.
 *
 * Mechanism (per published version X.Y.Z):
 *   1. `git worktree add` a detached checkout at tag X.Y.Z.
 *   2. Reuse the current `docs/node_modules` (symlink) so the snapshot is produced
 *      with the toolchain that will actually build the site.
 *   3. If the tag already carries `versioned_docs/version-X.Y.Z`, reuse it;
 *      otherwise run `docusaurus docs:version X.Y.Z` inside the worktree.
 *   4. Copy `version-X.Y.Z/` + `version-X.Y.Z-sidebars.json` into the main tree.
 *
 * Usage (run from repo root or docs/, after `npm install` in docs/):
 *   node docs/scripts/generate-versioned-docs.js
 *
 * assisted-by Claude:claude-opus-4-8
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const DOCS_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(DOCS_DIR, '..');
const PUBLISHED_JSON = path.join(DOCS_DIR, 'published-versions.json');
const VERSIONED_DOCS_DIR = path.join(DOCS_DIR, 'versioned_docs');
const VERSIONED_SIDEBARS_DIR = path.join(DOCS_DIR, 'versioned_sidebars');
const VERSIONS_JSON = path.join(DOCS_DIR, 'versions.json');
const VERSIONS_CONFIG_JSON = path.join(DOCS_DIR, 'versions-config.json');
const NODE_MODULES = path.join(DOCS_DIR, 'node_modules');

// Docs content lives at repo `docs/docs/`; links are authored relative to that.
const GITHUB_BASE = 'https://github.com/caipe-io/ai-platform-engineering';
const DOC_CONTENT_ROOT = '/docs/docs';

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function runOut(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
}

// ---------------------------------------------------------------------------
// Link sanitiser
//
// Frozen historical docs sometimes link to repo *source* files via relative
// paths that escape the docs tree (e.g. `](../../../../ui/src/lib/x.ts)`).
// Those never resolve to a docs route, so Docusaurus reports them as broken.
// Since the content is immutable (it comes from a tag), we rewrite any link that
// resolves outside `docs/docs/` into an absolute GitHub URL pinned to that
// version's tag. Intra-docs links are left untouched. Root-absolute links into
// the docs site need a version prefix when the snapshot is not the latest one.
// ---------------------------------------------------------------------------

function rewriteVersionedDocsTarget(target, tag, isVersionedRoute) {
  if (!isVersionedRoute || !target.startsWith('/docs/')) return null;

  const targetPath = target.slice('/docs/'.length);
  if (!targetPath || targetPath.startsWith(`${tag}/`)) return null;
  return `/docs/${tag}/${targetPath}`;
}

function rewriteEscapingTarget(target, fileDirRepoRel, tag) {
  if (!target) return null;
  // Skip absolute URLs, anchors, root-absolute, protocol-relative and mail/tel.
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(target)) return null;

  const hashIndex = target.indexOf('#');
  const rawPath = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? '' : target.slice(hashIndex);
  if (!rawPath) return null; // pure anchor

  const resolved = path.posix.normalize(path.posix.join('/', fileDirRepoRel, rawPath));
  if (resolved === DOC_CONTENT_ROOT || resolved.startsWith(DOC_CONTENT_ROOT + '/')) {
    return null; // stays inside the docs content tree → valid intra-docs link
  }

  const repoPath = resolved.replace(/^\/+/, '');
  if (!repoPath) return null;
  const lastSegment = repoPath.split('/').pop();
  const kind = lastSegment.includes('.') ? 'blob' : 'tree';
  return `${GITHUB_BASE}/${kind}/${tag}/${repoPath}${anchor}`;
}

function sanitizeFileLinks(absFile, fileDirRepoRel, tag, isVersionedRoute) {
  const original = fs.readFileSync(absFile, 'utf8');
  let changed = false;

  // Inline links: ](target) and ](target "title")
  const inlineRe = /\]\(\s*([^)\s]+?)(\s+"[^"]*"|\s+'[^']*')?\s*\)/g;
  let updated = original.replace(inlineRe, (match, target, title) => {
    const versionedTarget = rewriteVersionedDocsTarget(target, tag, isVersionedRoute);
    if (versionedTarget) {
      changed = true;
      return `](${versionedTarget}${title || ''})`;
    }

    const next = rewriteEscapingTarget(target, fileDirRepoRel, tag);
    if (!next) return match;
    changed = true;
    return `](${next}${title || ''})`;
  });

  // Reference-style definitions: [label]: target
  const refRe = /^(\s*\[[^\]]+\]:\s*)(\S+)(.*)$/gm;
  updated = updated.replace(refRe, (match, prefix, target, rest) => {
    const versionedTarget = rewriteVersionedDocsTarget(target, tag, isVersionedRoute);
    if (versionedTarget) {
      changed = true;
      return `${prefix}${versionedTarget}${rest}`;
    }

    const next = rewriteEscapingTarget(target, fileDirRepoRel, tag);
    if (!next) return match;
    changed = true;
    return `${prefix}${next}${rest}`;
  });

  if (changed) fs.writeFileSync(absFile, updated);
  return changed;
}

function sanitizeVersionLinks(versionDir, tag, isVersionedRoute) {
  let count = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (/\.mdx?$/.test(entry.name)) {
        const relWithinVersion = path.relative(versionDir, abs);
        const fileDirRepoRel = path.posix.join(
          'docs/docs',
          path.dirname(relWithinVersion).split(path.sep).join('/')
        );
        if (sanitizeFileLinks(abs, fileDirRepoRel, tag, isVersionedRoute)) count += 1;
        if (sanitizeMdxBreakingPatterns(abs)) count += 1;
      }
    }
  };
  walk(versionDir);
  return count;
}

// ---------------------------------------------------------------------------
// MDX sanitizer
//
// Frozen tag snapshots can contain markdown that compiled fine as plain MD but
// breaks under MDX (e.g. nested backticks leaking `{objectType}` expressions).
// Patch known offenders in-place after the version tree is copied.
// ---------------------------------------------------------------------------

const MDX_MODULE_API_P2_BLOCK = `- Paginate FGA tuples for the resource object:

\`\`\`ts
readOpenFgaTuples({
  tuple: { object: objectType + ':' + objectId },
})
\`\`\`

- Collect slugs via \`extractTeamSlugsFromTuples\`.`;

const MDX_MODULE_API_P3_BLOCK = `3. Call \`reconcileShareableResource\` with the descriptor fields (example below).
4. Never persist to Mongo.

\`\`\`ts
reconcileShareableResource({
  objectType: descriptor.objectType,
  objectId,
  creatorSubject: ownerSubject,
  ownerSubject,
  ownerTeamSlug,
  previousOwnerTeamSlug,
  nextSharedTeamSlugs,
  previousSharedTeamSlugs,
  memberRelations: descriptor.memberRelations,
  sharedWithOrg,
  previousSharedWithOrg,
})
\`\`\``;

function sanitizeMdxBreakingPatterns(absFile) {
  if (!absFile.endsWith('specs/2026-06-04-fga-projected-team-shares/contracts/module-api.md')) {
    return false;
  }

  let content = fs.readFileSync(absFile, 'utf8');
  const original = content;

  // 0.5.9: nested backticks in a list item leak \`{objectType}\` into MDX.
  content = content.replace(
    /- Paginate `readOpenFgaTuples\(\{ tuple: \{ object: `\$\{objectType\}:\$\{objectId\}` \} \}\)`\.\r?\n- Collect slugs via `extractTeamSlugsFromTuples`\./,
    MDX_MODULE_API_P2_BLOCK
  );

  // 0.5.10+: indented fenced block inside a list item is not always treated as code.
  content = content.replace(
    /- Paginate FGA tuples for the resource object:\r?\n\r?\n  ```ts\r?\n  readOpenFgaTuples\(\{ tuple: \{ object: `\$\{objectType\}:\$\{objectId\}` \} \}\)\r?\n  ```\r?\n\r?\n- Collect slugs via `extractTeamSlugsFromTuples`\./,
    MDX_MODULE_API_P2_BLOCK
  );

  // 0.5.9: long inline reconcile call with \`{ objectType,\` shorthand.
  content = content.replace(
    /3\. Call `reconcileShareableResource\(\{ objectType, objectId, creatorSubject: ownerSubject, ownerSubject, ownerTeamSlug, previousOwnerTeamSlug, nextSharedTeamSlugs, previousSharedTeamSlugs, memberRelations: descriptor\.memberRelations, sharedWithOrg, previousSharedWithOrg \}\)`\.\r?\n4\. Never persist to Mongo\./,
    MDX_MODULE_API_P3_BLOCK
  );

  // 0.5.10+: indented reconcile example inside numbered list.
  content = content.replace(
    /3\. Call `reconcileShareableResource` with the descriptor fields:\r?\n\r?\n   ```ts\r?\n   reconcileShareableResource\(\{\r?\n     objectType,\r?\n     objectId,\r?\n     creatorSubject: ownerSubject,\r?\n     ownerSubject,\r?\n     ownerTeamSlug,\r?\n     previousOwnerTeamSlug,\r?\n     nextSharedTeamSlugs,\r?\n     previousSharedTeamSlugs,\r?\n     memberRelations: descriptor\.memberRelations,\r?\n     sharedWithOrg,\r?\n     previousSharedWithOrg,\r?\n   \}\)\r?\n   ```\r?\n4\. Never persist to Mongo\./,
    MDX_MODULE_API_P3_BLOCK
  );

  if (content === original) return false;
  fs.writeFileSync(absFile, content);
  return true;
}

function compareVersionsDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return 0;
}

// ---------------------------------------------------------------------------

if (!fs.existsSync(PUBLISHED_JSON)) {
  console.error(`ERROR: ${path.relative(REPO_ROOT, PUBLISHED_JSON)} not found.`);
  process.exit(1);
}

if (!fs.existsSync(NODE_MODULES)) {
  console.error('ERROR: docs/node_modules not found. Run `npm install` in docs/ first.');
  process.exit(1);
}

let versions = JSON.parse(fs.readFileSync(PUBLISHED_JSON, 'utf8'));
versions = [...new Set(versions)].sort(compareVersionsDesc);
const latestPublishedVersion = versions[0];

if (versions.length === 0) {
  console.log('No published versions listed; nothing to generate. Building current docs only.');
}

// Start from a clean slate so stale generated versions never leak into a build.
fs.rmSync(VERSIONED_DOCS_DIR, { recursive: true, force: true });
fs.rmSync(VERSIONED_SIDEBARS_DIR, { recursive: true, force: true });
fs.mkdirSync(VERSIONED_DOCS_DIR, { recursive: true });
fs.mkdirSync(VERSIONED_SIDEBARS_DIR, { recursive: true });

const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caipe-docs-versions-'));

try {
  for (const version of versions) {
    const tag = version;

    try {
      runOut(`git -C "${REPO_ROOT}" rev-parse --verify "refs/tags/${tag}^{commit}"`);
    } catch {
      console.error(`ERROR: git tag "${tag}" not found. Fetch tags (fetch-depth: 0) or fix published-versions.json.`);
      process.exit(1);
    }

    console.log(`\n==> Snapshotting version ${tag} from tag ...`);
    const worktree = path.join(worktreeRoot, `v-${tag}`);
    run(`git -C "${REPO_ROOT}" worktree add --quiet --detach "${worktree}" "refs/tags/${tag}"`);

    try {
      const wtDocs = path.join(worktree, 'docs');
      if (!fs.existsSync(wtDocs)) {
        throw new Error(`tag ${tag} has no docs/ directory`);
      }

      const wtVersionedDir = path.join(wtDocs, 'versioned_docs', `version-${tag}`);
      const wtSidebarFile = path.join(wtDocs, 'versioned_sidebars', `version-${tag}-sidebars.json`);

      // The tag may already ship a snapshot of itself (older mechanism). Only run
      // docs:version when it does not, to avoid "version already exists" errors.
      if (!fs.existsSync(wtVersionedDir)) {
        const wtNodeModules = path.join(wtDocs, 'node_modules');
        if (!fs.existsSync(wtNodeModules)) {
          fs.symlinkSync(NODE_MODULES, wtNodeModules, 'junction');
        }
        run(`npm run docusaurus -- docs:version ${tag}`, { cwd: wtDocs });
      }

      if (!fs.existsSync(wtVersionedDir)) {
        throw new Error(`expected ${wtVersionedDir} after snapshot, but it is missing`);
      }

      const destVersionDir = path.join(VERSIONED_DOCS_DIR, `version-${tag}`);
      fs.cpSync(wtVersionedDir, destVersionDir, { recursive: true });
      if (fs.existsSync(wtSidebarFile)) {
        fs.cpSync(wtSidebarFile, path.join(VERSIONED_SIDEBARS_DIR, `version-${tag}-sidebars.json`));
      }
      const fixed = sanitizeVersionLinks(destVersionDir, tag, tag !== latestPublishedVersion);
      console.log(`    captured version-${tag}${fixed ? ` (rewrote source links in ${fixed} file(s))` : ''}`);
    } finally {
      run(`git -C "${REPO_ROOT}" worktree remove --force "${worktree}"`);
    }
  }
} finally {
  fs.rmSync(worktreeRoot, { recursive: true, force: true });
}

// versions.json: newest first.
fs.writeFileSync(VERSIONS_JSON, JSON.stringify(versions, null, 2) + '\n');

// versions-config.json: latest at root path, others under their version path.
const latest = versions[0];
const versionsBlock = {
  current: { label: 'main 🚧', path: 'next', badge: true },
};
if (latest) {
  versionsBlock[latest] = { label: `${latest} (Latest)`, path: '', badge: false };
  for (const v of versions.slice(1)) {
    versionsBlock[v] = { label: v, path: v, badge: false };
  }
}

fs.writeFileSync(
  VERSIONS_CONFIG_JSON,
  JSON.stringify({ lastVersion: latest || 'current', versions: versionsBlock }, null, 2) + '\n'
);

console.log(`\nDone. Generated ${versions.length} version(s): ${versions.join(', ') || '(none)'}`);
