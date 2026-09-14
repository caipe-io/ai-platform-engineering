#!/usr/bin/env bash
# scripts/check-no-new-requireAdmin.sh
#
# Guard against new uses of the deprecated `requireAdmin` / `requireAdminView`
# helpers in `ui/src/app/api/**/route.ts`.
#
# No production route currently uses these helpers. For compatibility with a
# deliberately staged migration, a route whose matrix entry is explicitly
# tagged `migration_status: pending` is temporarily allow-listed.
#
# Anything else — i.e. a NEW call site in a NEW route file, or a re-introduced
# call in a previously-migrated route — fails the script with non-zero exit.
#
# Usage:
#   scripts/check-no-new-requireAdmin.sh                 # check, exit non-zero on drift
#   STRICT=1 scripts/check-no-new-requireAdmin.sh        # also fail if pending allowlist is empty
#
# Wired into `make test-rbac-lint`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MATRIX="${REPO_ROOT}/tests/rbac/rbac-matrix.yaml"

if [[ ! -f "${MATRIX}" ]]; then
  echo "[check-no-new-requireAdmin] matrix not found: ${MATRIX}" >&2
  exit 2
fi

cd "${REPO_ROOT}"

# 1) Pending allowlist — repo-relative route.ts paths that are allowed to keep
#    calling requireAdmin / requireAdminView until their migration task lands.
PENDING_TMP="$(mktemp)"
trap 'rm -f "${PENDING_TMP}" "${HITS_TMP:-}"' EXIT

python3 - <<'PYEOF' >"${PENDING_TMP}"
from pathlib import Path

# Keep this parser dependency-free: the CI cheap lane invokes system python3
# here before the uv environment is active for this shell script.
seen = set()
entry: dict[str, str] = {}


def flush() -> None:
    if entry.get("surface") != "ui_bff":
        return
    if entry.get("migration_status") != "pending":
        return
    path = entry.get("path", "").lstrip("/")
    if path:
        seen.add(f"ui/src/app/{path}/route.ts")


for raw_line in Path("tests/rbac/rbac-matrix.yaml").read_text(encoding="utf-8").splitlines():
    stripped = raw_line.strip()
    if stripped.startswith("- id:"):
        flush()
        entry = {}
        continue
    if ":" not in stripped:
        continue
    key, value = stripped.split(":", maxsplit=1)
    if key in {"surface", "path", "migration_status"}:
        entry[key] = value.strip().strip('"').strip("'")

flush()

for item in sorted(seen):
    print(item)
PYEOF

PENDING_COUNT=$(wc -l <"${PENDING_TMP}" | tr -d ' ')

# 2) All route.ts files that import OR call the SHARED requireAdmin /
#    requireAdminView helpers from `@/lib/api-middleware`. We skip files that
#    only define a *local* `function requireAdmin(...)` helper — those need to
#    be migrated, but they're a different audit surface and are reported by
#    `make test-rbac-lint` directly via the matrix linter.
HITS_TMP="$(mktemp)"
python3 - <<'PYEOF' >"${HITS_TMP}"
from pathlib import Path
import re

root = Path("ui/src/app/api")
if not root.exists():
    raise SystemExit(0)

imports_api_middleware = re.compile(r"from ['\"]@/lib/api-middleware['\"]")
references_require_admin = re.compile(r"\brequireAdmin(View)?\b")
defines_local_require_admin = re.compile(r"^(async\s+)?function\s+requireAdmin", re.MULTILINE)
imports_shared_require_admin = re.compile(r"requireAdmin\s*[,}]")

for path in sorted(root.rglob("route.ts")):
    text = path.read_text(encoding="utf-8")
    if not imports_api_middleware.search(text):
        continue
    if not references_require_admin.search(text):
        continue

    has_local_definition = defines_local_require_admin.search(text) is not None
    has_shared_import = imports_shared_require_admin.search(text) is not None
    if not has_local_definition or has_shared_import:
        print(path.as_posix())
PYEOF

if [[ ! -s "${HITS_TMP}" ]]; then
  echo "[check-no-new-requireAdmin] OK — no route.ts files reference requireAdmin / requireAdminView"
  exit 0
fi

# 3) Diff: any hit not in the pending allowlist is a violation.
VIOLATIONS_TMP="$(mktemp)"
trap 'rm -f "${PENDING_TMP}" "${HITS_TMP}" "${VIOLATIONS_TMP}"' EXIT

# `comm -23` requires sorted inputs; PENDING_TMP is already sorted, HITS_TMP we sorted above.
comm -23 "${HITS_TMP}" "${PENDING_TMP}" >"${VIOLATIONS_TMP}"

VIOL_COUNT=$(wc -l <"${VIOLATIONS_TMP}" | tr -d ' ')
HIT_COUNT=$(wc -l <"${HITS_TMP}" | tr -d ' ')

if [[ "${VIOL_COUNT}" -gt 0 ]]; then
  echo "[check-no-new-requireAdmin] FAIL — ${VIOL_COUNT} route file(s) call deprecated requireAdmin/requireAdminView"
  echo "                            outside the pending-migration allowlist:"
  while IFS= read -r v; do
    [[ -z "${v}" ]] && continue
    line="$(python3 - "${v}" <<'PYEOF'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
for lineno, text in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
    if re.search(r"\brequireAdmin(View)?\b", text):
        print(f"{lineno}:{text}")
        break
PYEOF
)"
    echo "    ${v}    ${line}"
  done <"${VIOLATIONS_TMP}"
  echo ""
  echo "Fix: migrate the route to requireRbacPermission with an explicit resource and scope"
  echo "     OR document an intentional staged migration with a temporary pending matrix entry"
  exit 1
fi

if [[ "${STRICT:-0}" == "1" && "${PENDING_COUNT}" -eq 0 && "${HIT_COUNT}" -gt 0 ]]; then
  echo "[check-no-new-requireAdmin] STRICT FAIL — pending allowlist is empty AND there are still requireAdmin call sites"
  exit 1
fi

echo "[check-no-new-requireAdmin] OK — ${HIT_COUNT} requireAdmin call site(s) found, all in pending allowlist (${PENDING_COUNT} entries)"
exit 0
