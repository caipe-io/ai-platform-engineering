#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="scripts/generate-helm-chart-docs.sh"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OCI_REGISTRY="oci://ghcr.io/caipe-io/charts/ai-platform-engineering"
PARENT_CHARTS=("ai-platform-engineering" "rag-stack")
CHARTS_ROOT="${REPO_ROOT}/charts"
DOCS_HELM_ROOT="${REPO_ROOT}/docs/docs/installation/helm-charts"

GENERATED_FILES=()
ERRORS=()

# ---------------------------------------------------------------------------
# Utility: colours (disabled when not a tty)
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; NC=''
fi
info()  { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*" >&2; }
error() { echo -e "${RED}✗${NC} $*" >&2; }

trim_trailing_blank_lines() {
  local file="$1"
  local temporary_file="${file}.tmp"
  awk '
    { lines[NR] = $0 }
    $0 !~ /^[[:space:]]*$/ { last_content_line = NR }
    END {
      for (line_number = 1; line_number <= last_content_line; line_number++) {
        print lines[line_number]
      }
    }
  ' "$file" > "$temporary_file"
  mv "$temporary_file" "$file"
}

# ---------------------------------------------------------------------------
# T005: Strip pre-release suffixes from a version string
# ---------------------------------------------------------------------------
strip_prerelease_version() {
  local ver="${1:-}"
  echo "$ver" | sed -E 's/-(dev|rc|hotfix|alpha|beta|pre)\.[^ "]*//g'
}

# ---------------------------------------------------------------------------
# T004: Resolve the published chart version
#   Priority: CHART_VERSION env > OCI registry > local appVersion
# ---------------------------------------------------------------------------
resolve_version() {
  if [[ -n "${CHART_VERSION:-}" ]]; then
    PUBLISHED_VERSION="$(strip_prerelease_version "${CHART_VERSION}")"
    info "Using CHART_VERSION override: ${PUBLISHED_VERSION}"
    return
  fi

  local registry_version=""
  if command -v helm >/dev/null 2>&1; then
    if command -v timeout >/dev/null 2>&1; then
      registry_version=$(
        timeout 10 helm show chart "${OCI_REGISTRY}" 2>/dev/null \
          | yq '.version // ""' 2>/dev/null
      ) || true
    elif command -v gtimeout >/dev/null 2>&1; then
      registry_version=$(
        gtimeout 10 helm show chart "${OCI_REGISTRY}" 2>/dev/null \
          | yq '.version // ""' 2>/dev/null
      ) || true
    else
      registry_version=$(
        helm show chart "${OCI_REGISTRY}" 2>/dev/null \
          | yq '.version // ""' 2>/dev/null
      ) || true
    fi
  fi

  if [[ -n "$registry_version" ]]; then
    PUBLISHED_VERSION="$(strip_prerelease_version "$registry_version")"
    info "Resolved version from OCI registry: ${PUBLISHED_VERSION}"
  else
    local local_app_version
    local_app_version=$(yq '.appVersion // .version // "0.0.0"' \
      "${CHARTS_ROOT}/ai-platform-engineering/Chart.yaml" 2>/dev/null) || true
    PUBLISHED_VERSION="$(strip_prerelease_version "${local_app_version:-0.0.0}")"
    warn "OCI registry unreachable — falling back to local appVersion: ${PUBLISHED_VERSION}"
  fi
}

# ---------------------------------------------------------------------------
# T006: Discover all chart directories
# ---------------------------------------------------------------------------
discover_charts() {
  local charts=()
  for parent in "${PARENT_CHARTS[@]}"; do
    local parent_dir="${CHARTS_ROOT}/${parent}"
    if [[ -f "${parent_dir}/Chart.yaml" ]]; then
      charts+=("${parent_dir}")
    fi
    if [[ -d "${parent_dir}/charts" ]]; then
      for sub_dir in "${parent_dir}/charts"/*/; do
        [[ -f "${sub_dir}Chart.yaml" ]] && charts+=("${sub_dir%/}")
      done
    fi
  done
  printf '%s\n' "${charts[@]}"
}

# ---------------------------------------------------------------------------
# T007: Parse Chart.yaml fields via yq
# ---------------------------------------------------------------------------
chart_field() {
  local chart_dir="$1" field="$2" default="${3:-}"
  local val
  val=$(yq "${field}" "${chart_dir}/Chart.yaml" 2>/dev/null) || true
  if [[ -z "$val" || "$val" == "null" ]]; then
    echo "$default"
  else
    echo "$val"
  fi
}

# ---------------------------------------------------------------------------
# Determine parent group name for a chart directory
# ---------------------------------------------------------------------------
parent_group_of() {
  local chart_dir="$1"
  for parent in "${PARENT_CHARTS[@]}"; do
    if [[ "$chart_dir" == "${CHARTS_ROOT}/${parent}" || \
          "$chart_dir" == "${CHARTS_ROOT}/${parent}/"* ]]; then
      echo "$parent"
      return
    fi
  done
  echo "unknown"
}

is_parent_chart() {
  local chart_dir="$1"
  for parent in "${PARENT_CHARTS[@]}"; do
    [[ "$chart_dir" == "${CHARTS_ROOT}/${parent}" ]] && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
# T014: Run helm-docs to regenerate values tables
# ---------------------------------------------------------------------------
run_helm_docs() {
  if ! command -v helm-docs >/dev/null 2>&1; then
    warn "helm-docs not installed — skipping values table regeneration"
    return
  fi
  info "Running helm-docs to regenerate values tables..."
  helm-docs --chart-search-root "${CHARTS_ROOT}/" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# Extract the values table from an existing README.md produced by helm-docs
# ---------------------------------------------------------------------------
extract_values_table() {
  local chart_dir="$1"
  local readme="${chart_dir}/README.md"

  if [[ ! -f "$readme" ]]; then
    echo ""
    return
  fi

  local in_table=false
  local table_lines=""
  while IFS= read -r line; do
    if [[ "$line" =~ ^\|[[:space:]]*Key ]]; then
      in_table=true
    fi
    if $in_table; then
      if [[ "$line" =~ ^\| ]]; then
        table_lines+="${line}"$'\n'
      elif [[ -n "$table_lines" ]]; then
        break
      fi
    fi
  done < "$readme"

  echo "$table_lines"
}

# ---------------------------------------------------------------------------
# T018: Generate dependencies section for parent charts
# ---------------------------------------------------------------------------
generate_dependencies_section() {
  local chart_dir="$1"

  local dep_count
  dep_count=$(yq '.dependencies | length // 0' "${chart_dir}/Chart.yaml" 2>/dev/null) || dep_count=0

  if [[ "$dep_count" -eq 0 || "$dep_count" == "null" ]]; then
    return
  fi

  cat <<'HEADER'

## Dependencies

| Name | Version | Condition / Tags |
|------|---------|------------------|
HEADER

  local i=0
  while [[ $i -lt $dep_count ]]; do
    local dep_name dep_version dep_condition dep_tags dep_alias dep_repo
    dep_name=$(yq ".dependencies[$i].name // \"\"" "${chart_dir}/Chart.yaml" 2>/dev/null)
    dep_version=$(yq ".dependencies[$i].version // \"\"" "${chart_dir}/Chart.yaml" 2>/dev/null)
    dep_alias=$(yq ".dependencies[$i].alias // \"\"" "${chart_dir}/Chart.yaml" 2>/dev/null)
    dep_condition=$(yq ".dependencies[$i].condition // \"\"" "${chart_dir}/Chart.yaml" 2>/dev/null)
    dep_tags=$(yq ".dependencies[$i].tags // [] | join(\", \")" "${chart_dir}/Chart.yaml" 2>/dev/null)
    dep_repo=$(yq ".dependencies[$i].repository // \"\"" "${chart_dir}/Chart.yaml" 2>/dev/null)

    local display_name="${dep_name}"
    if [[ -n "$dep_alias" && "$dep_alias" != "null" && "$dep_alias" != "$dep_name" ]]; then
      display_name="${dep_alias} (${dep_name})"
    fi

    local clean_version
    clean_version="$(strip_prerelease_version "$dep_version")"

    local cond_display=""
    if [[ -n "$dep_condition" && "$dep_condition" != "null" ]]; then
      cond_display="\`${dep_condition}\`"
    fi
    if [[ -n "$dep_tags" && "$dep_tags" != "null" ]]; then
      if [[ -n "$cond_display" ]]; then
        cond_display="${cond_display}, tags: ${dep_tags}"
      else
        cond_display="tags: ${dep_tags}"
      fi
    fi

    echo "| ${display_name} | \`${clean_version}\` | ${cond_display} |"
    i=$((i + 1))
  done
}

# ---------------------------------------------------------------------------
# T013: MDX-safe escaping
# ---------------------------------------------------------------------------
mdx_escape() {
  sed -E \
    -e 's|<(https?://[^>]+)>|[\1](\1)|g' \
    -e 's|<([a-zA-Z][a-zA-Z0-9_.:-]*(/[a-zA-Z0-9_.:-]*)*)>|`\1`|g' \
    | awk '
      /^```/ {
        print
        in_fence = !in_fence
        next
      }
      in_fence {
        print
        next
      }
      {
        segment_count = split($0, segments, "`")
        output = ""
        for (segment_number = 1; segment_number <= segment_count; segment_number++) {
          if (segment_number % 2 == 1) {
            gsub(/\{/, "\\{", segments[segment_number])
            gsub(/\}/, "\\}", segments[segment_number])
          }
          output = output segments[segment_number]
          if (segment_number < segment_count) {
            output = output "`"
          }
        }
        print output
      }
    '
}

# ---------------------------------------------------------------------------
# T008 / T009 / T010 / T011: Generate enriched source README
# ---------------------------------------------------------------------------
generate_source_readme() {
  local chart_dir="$1"
  local name description

  name=$(chart_field "$chart_dir" '.name' 'chart')
  description=$(chart_field "$chart_dir" '.description' 'A Helm chart for Kubernetes')

  local values_table
  values_table=$(extract_values_table "$chart_dir")

  local deps_section=""
  if is_parent_chart "$chart_dir"; then
    deps_section=$(generate_dependencies_section "$chart_dir")
  fi

  local parent_group
  parent_group=$(parent_group_of "$chart_dir")

  local oci_url="oci://ghcr.io/caipe-io/charts/${name}"
  if is_parent_chart "$chart_dir"; then
    oci_url="oci://ghcr.io/caipe-io/charts/${name}"
  fi

  cat > "${chart_dir}/README.md" <<EOF
<!-- AUTO-GENERATED by ${SCRIPT_NAME} — DO NOT EDIT -->
<!-- Source: ${chart_dir#"${REPO_ROOT}/"}/Chart.yaml, ${chart_dir#"${REPO_ROOT}/"}/values.yaml -->
<!-- Regenerate: make docs-helm-charts -->

# ${name}

${description}

| | |
|---|---|
| **Version** | \`${PUBLISHED_VERSION}\` |
| **Type** | $(chart_field "$chart_dir" '.type' 'application') |

## Quick Start

\`\`\`bash
# Add and install the chart
helm install ${name} ${oci_url} --version ${PUBLISHED_VERSION}

# Upgrade an existing release
helm upgrade ${name} ${oci_url} --version ${PUBLISHED_VERSION}
\`\`\`

## Customizing Values

Override default values using \`--set\` flags or a custom values file:

\`\`\`bash
# Override individual values
helm install ${name} ${oci_url} --version ${PUBLISHED_VERSION} \\
  --set replicaCount=2

# Use a custom values file
helm install ${name} ${oci_url} --version ${PUBLISHED_VERSION} \\
  -f custom-values.yaml

# Show all configurable values
helm show values ${oci_url} --version ${PUBLISHED_VERSION}
\`\`\`

## Reading the Values Table

| Column | Meaning |
|--------|---------|
| **Key** | Dot-separated path into \`values.yaml\` (e.g. \`image.repository\`) |
| **Type** | Go/Helm data type (\`string\`, \`int\`, \`bool\`, \`object\`, \`list\`) |
| **Default** | Value used when not overridden |
| **Description** | What the parameter controls |

## Values

${values_table:-"_No configurable values._"}
${deps_section}
EOF

  trim_trailing_blank_lines "${chart_dir}/README.md"

  GENERATED_FILES+=("${chart_dir}/README.md")
  info "Generated source README: ${chart_dir#"${REPO_ROOT}/"}/README.md"
}

# ---------------------------------------------------------------------------
# T012 / T016 / T017: Generate Docusaurus page
# ---------------------------------------------------------------------------
generate_docusaurus_page() {
  local chart_dir="$1"
  local name description parent_group

  name=$(chart_field "$chart_dir" '.name' 'chart')
  description=$(chart_field "$chart_dir" '.description' 'A Helm chart for Kubernetes')
  parent_group=$(parent_group_of "$chart_dir")

  local doc_dir="${DOCS_HELM_ROOT}/${parent_group}"
  mkdir -p "$doc_dir"

  local doc_file doc_id
  if is_parent_chart "$chart_dir"; then
    doc_file="${doc_dir}/index.md"
    doc_id="${name}-chart"
  else
    doc_file="${doc_dir}/${name}.md"
    doc_id="${name}-chart"
  fi

  local values_table
  values_table=$(extract_values_table "$chart_dir")

  local deps_section=""
  if is_parent_chart "$chart_dir"; then
    deps_section=$(generate_dependencies_section "$chart_dir")
  fi

  local oci_url="oci://ghcr.io/caipe-io/charts/${name}"

  {
    cat <<EOF
---
id: ${doc_id}
sidebar_label: ${name}
---

:::caution Auto-generated
This page is auto-generated from the Helm chart source. Do not edit directly.
Regenerate with \`make docs-helm-charts\`.
:::

# ${name}

${description}

| | |
|---|---|
| **Version** | \`${PUBLISHED_VERSION}\` |
| **Type** | $(chart_field "$chart_dir" '.type' 'application') |

## Quick Start

\`\`\`bash
# Add and install the chart
helm install ${name} ${oci_url} --version ${PUBLISHED_VERSION}

# Upgrade an existing release
helm upgrade ${name} ${oci_url} --version ${PUBLISHED_VERSION}
\`\`\`

## Customizing Values

Override default values using \`--set\` flags or a custom values file:

\`\`\`bash
# Override individual values
helm install ${name} ${oci_url} --version ${PUBLISHED_VERSION} \\
  --set replicaCount=2

# Use a custom values file
helm install ${name} ${oci_url} --version ${PUBLISHED_VERSION} \\
  -f custom-values.yaml

# Show all configurable values
helm show values ${oci_url} --version ${PUBLISHED_VERSION}
\`\`\`

## Reading the Values Table

| Column | Meaning |
|--------|---------|
| **Key** | Dot-separated path into \`values.yaml\` (e.g. \`image.repository\`) |
| **Type** | Go/Helm data type (\`string\`, \`int\`, \`bool\`, \`object\`, \`list\`) |
| **Default** | Value used when not overridden |
| **Description** | What the parameter controls |

## Values

${values_table:-"_No configurable values._"}
${deps_section}
EOF
  } | mdx_escape > "$doc_file"

  trim_trailing_blank_lines "$doc_file"

  GENERATED_FILES+=("$doc_file")
  info "Generated Docusaurus page: ${doc_file#"${REPO_ROOT}/"}"
}

# ---------------------------------------------------------------------------
# T022: Validate no RC versions in generated output
# ---------------------------------------------------------------------------
validate_no_rc_versions() {
  info "Validating no RC/pre-release versions in generated files..."
  local rc_found=false
  for f in "${GENERATED_FILES[@]}"; do
    if grep -qE '-(dev|rc|hotfix|alpha|beta|pre)\.' "$f" 2>/dev/null; then
      error "RC version pattern found in: ${f#"${REPO_ROOT}/"}"
      grep -nE '-(dev|rc|hotfix|alpha|beta|pre)\.' "$f" | head -5 >&2
      rc_found=true
    fi
  done
  if $rc_found; then
    error "FAIL: RC version patterns detected in generated output"
    return 1
  fi
  info "PASS: No RC version patterns in generated output"
}

# ---------------------------------------------------------------------------
# T015: Main
# ---------------------------------------------------------------------------
main() {
  echo "=== Helm Chart Documentation Generator ==="
  echo ""

  # Check prerequisites
  if ! command -v yq >/dev/null 2>&1; then
    error "yq is required but not installed. Install with: brew install yq"
    exit 1
  fi

  # Step 1: Resolve published version
  resolve_version

  # Step 2: Run helm-docs for values tables
  run_helm_docs

  # Step 3: Discover all charts
  local charts=()
  while IFS= read -r chart_dir; do
    charts+=("$chart_dir")
  done < <(discover_charts)
  info "Discovered ${#charts[@]} charts"

  # Step 4: Generate docs for each chart
  for chart_dir in "${charts[@]}"; do
    generate_source_readme "$chart_dir"
    generate_docusaurus_page "$chart_dir"
  done

  # Step 5: Validate output
  echo ""
  validate_no_rc_versions

  # Summary
  echo ""
  echo "=== Summary ==="
  echo "Charts processed: ${#charts[@]}"
  echo "Files generated:  ${#GENERATED_FILES[@]}"
  echo "Published version: ${PUBLISHED_VERSION}"
  echo ""
  info "Done. Run 'make docs-build' to validate Docusaurus output."
}

main "$@"
