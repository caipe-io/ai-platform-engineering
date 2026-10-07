# Common Makefile for CNOE Agent Projects
# --------------------------------------------------
# This Makefile provides common targets for building, testing, and running CNOE agents.
# Usage:
#   make <target>
# --------------------------------------------------

# Variables
APP_NAME ?= ai-platform-engineering

# Cap BuildKit parallelism on cold-cache `docker compose ... up --build` runs.
# 22 images building simultaneously saturates Docker Desktop's NAT and stalls
# individual TCP streams long enough to trip uv's UV_HTTP_TIMEOUT (e.g. on the
# pyarrow / cffi wheels). Override per-shell via `COMPOSE_PARALLEL_LIMIT=N make ...`
# or unset to restore unlimited parallelism. Used by every target below that
# invokes `docker compose ... up --build`.
COMPOSE_PARALLEL_LIMIT ?= 4
DOCKER_COMPOSE_BUILD_ENV := DOCKER_BUILDKIT=1 COMPOSE_PARALLEL_LIMIT=$(COMPOSE_PARALLEL_LIMIT) BUILDKIT_MAX_PARALLELISM=$(COMPOSE_PARALLEL_LIMIT)

## -------------------------------------------------
.PHONY: \
	setup-venv start-venv clean-pyc clean-venv clean-build-artifacts clean \
	uv-prep \
	generate-agent-commands \
	lint lint-fix test \
	test-rag-unit test-rag-coverage test-rag-memory test-rag-scale validate lock-all help \
	caipe-ui caipe-ui-install caipe-ui-build caipe-ui-dev caipe-ui-tests caipe-ui-e2e-rbac \
	build-caipe-ui run-caipe-ui-docker caipe-ui-docker-compose \
	caipe-ui-hot caipe-ui-prod \
	docs docs-install docs-build docs-dev docs-start docs-serve \
	check-helm-docs helm-docs check-yq docs-helm-charts docs-helm-validate \
	scan-images scan-image \
	ui

.DEFAULT_GOAL := help

## ========== Setup & Clean ==========

setup-venv:        ## Create the Python virtual environment
	@echo "Setting up virtual environment..."
	@if [ ! -d ".venv" ]; then \
		python3 -m venv .venv && echo "Virtual environment created."; \
	else \
		echo "Virtual environment already exists."; \
	fi
	@echo "To activate manually, run: source .venv/bin/activate"
	@. .venv/bin/activate

start-venv: ## Activate the virtual environment (run: source .venv/bin/activate)
	@echo "To activate the virtual environment, run:"
	@echo "  source .venv/bin/activate"

clean-pyc:         ## Remove Python bytecode and __pycache__
	@find . -type d -name "__pycache__" -exec rm -rf {} + || echo "No __pycache__ directories found."

clean-venv:        ## Remove the virtual environment
	@rm -rf .venv && echo "Virtual environment removed." || echo "No virtual environment found."

clean-build-artifacts: ## Remove dist/, build/, egg-info/
	@rm -rf dist $(AGENT_PKG_NAME).egg-info || echo "No build artifacts found."

clean:             ## Clean all build artifacts and cache
	@$(MAKE) clean-pyc
	@$(MAKE) clean-venv
	@$(MAKE) clean-build-artifacts
	@find . -type d -name ".pytest_cache" -exec rm -rf {} + || echo "No .pytest_cache directories found."

## ========== Dependencies ==========

uv-prep: ## Lock and sync uv dependencies
	uv lock
	uv sync

## ========== CAIPE UI ==========

ui: caipe-ui ## Alias for caipe-ui

caipe-ui: caipe-ui-install caipe-ui-dev ## Build and run the CAIPE UI (install + dev server)

caipe-ui-install: ## Install CAIPE UI dependencies
	@echo "Installing CAIPE UI dependencies..."
	@cd ui && npm install

caipe-ui-build: caipe-ui-install ## Build CAIPE UI for production
	@echo "Building CAIPE UI for production..."
	@cd ui && npm run build

caipe-ui-dev: ## Run CAIPE UI in development mode
	@echo "Starting CAIPE UI development server..."
	@cd ui && npm run dev

caipe-ui-tests: ## Run CAIPE UI Jest tests
	@echo "Running CAIPE UI tests..."
	@cd ui && npm test

caipe-ui-e2e-rbac: ## Run mocked RBAC Playwright regression (dev server on :3000)
	@echo "Running mocked RBAC Playwright regression..."
	@cd ui && RUN_RBAC_REGRESSION=1 CAIPE_UI_BASE_URL=http://localhost:3000 WORKFLOWS_ENABLED=true \
		npx playwright test \
			e2e/rbac/workflow-agent-access.spec.ts \
			e2e/rbac/rbac-admin-regression.spec.ts \
			e2e/rbac/mcp-openfga-tuples.spec.ts \
			e2e/rbac/admin-settings-regression.spec.ts \
			--config=playwright.rbac.config.ts

migrate-canonical-team-membership: ## Backfill team_membership_sources from legacy teams.members[] and $$unset the field. Dry-run by default; APPLY=1 to apply.
	@# One-shot migration for spec 2026-05-26-canonical-team-membership.
	@# See docs/docs/specs/2026-05-26-canonical-team-membership/mongodb-migration.md
	@# for the operator runbook (dry-run, apply, verify, roll back).
	@APPLY_FLAG="$${APPLY:-false}"; \
	if [ "$$APPLY_FLAG" = "1" ] || [ "$$APPLY_FLAG" = "true" ]; then \
		APPLY=true npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/migrate-canonical-team-membership.ts; \
	else \
		echo "[dry-run] Set APPLY=1 to apply. Use MONGODB_URI / MONGODB_DATABASE to point at the target database."; \
		APPLY=false npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/migrate-canonical-team-membership.ts; \
	fi

migrate-canonical-team-membership-tests: ## Run unit tests for the canonical-team-membership migration planner.
	@npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/__tests__/migrate-canonical-team-membership.test.ts

# Docker targets for CAIPE UI
CAIPE_UI_IMAGE ?= caipe-ui
CAIPE_UI_TAG ?= local

build-caipe-ui: ## Build CAIPE UI Docker image locally
	@echo "Building CAIPE UI Docker image..."
	docker build -t $(CAIPE_UI_IMAGE):$(CAIPE_UI_TAG) \
		-f build/Dockerfile.caipe-ui \
		.

run-caipe-ui-docker: build-caipe-ui ## Run CAIPE UI container locally (requires NEXTAUTH_SECRET env var)
	@# R4: refuse to start the BFF with a known dev placeholder for
	@# NEXTAUTH_SECRET. NEXTAUTH_SECRET HS256-signs session cookies and the
	@# internal skills-API JWTs (see ui/src/lib/jwt-validation.ts) — a
	@# shared placeholder means tokens forged in one install are valid in
	@# every other install that copied this make target.
	@if [ -z "$$NEXTAUTH_SECRET" ]; then \
		echo ""; \
		echo "ERROR: NEXTAUTH_SECRET is not set." >&2; \
		echo "Generate one with: openssl rand -base64 48" >&2; \
		echo "Then export NEXTAUTH_SECRET=... and re-run make." >&2; \
		echo ""; \
		exit 1; \
	fi
	@case "$$NEXTAUTH_SECRET" in \
		caipe-dev-secret|"changeme"|"please-change-me"|"dev"|"test"|"secret") \
			echo ""; \
			echo "ERROR: NEXTAUTH_SECRET is a known dev placeholder ('$$NEXTAUTH_SECRET')." >&2; \
			echo "Generate a real one with: openssl rand -base64 48" >&2; \
			echo "" >&2; \
			exit 1 ;; \
	esac
	@echo "Running CAIPE UI container..."
	docker run --rm -it \
		-p 3000:3000 \
		-e DYNAMIC_AGENTS_URL=http://localhost:8100 \
		-e NEXTAUTH_SECRET="$$NEXTAUTH_SECRET" \
		-e NEXTAUTH_URL=http://localhost:3000 \
		--name caipe-ui-local \
		$(CAIPE_UI_IMAGE):$(CAIPE_UI_TAG)

caipe-ui-docker-compose: ## Run CAIPE UI with docker-compose
	@echo "Starting CAIPE UI with docker-compose..."
	$(DOCKER_COMPOSE_BUILD_ENV) docker compose -f docker-compose.dev.yaml --profile caipe-ui up --build

caipe-ui-hot: ## Run CAIPE UI in Docker with hot reload (next dev + bind-mounted ./ui/src)
	@echo "Starting CAIPE UI in hot-reload mode (next dev)..."
	@echo "  - Edits in ui/src trigger sub-second rebuild via next dev"
	@echo "  - public/ asset changes still need: make caipe-ui-hot (rebuilds image)"
	@# Bring down the prod-parity sibling first — both bind host port 3000 and
	@# Keycloak's caipe-ui client only allow-lists localhost:3000/* as a redirect
	@# URI (see deploy/keycloak/realm-config.json), so the two services are
	@# mutually exclusive at runtime.
	@docker compose -f docker-compose.dev.yaml --profile caipe-ui-prod rm -sf caipe-ui-prod 2>/dev/null || true
	$(DOCKER_COMPOSE_BUILD_ENV) \
	docker compose -f docker-compose.dev.yaml --profile caipe-ui up -d --build caipe-ui
	@echo ""
	@echo "Hot-reload UI ready: http://localhost:3000"
	@echo "Stream logs:        docker logs -f caipe-ui"
	@echo "Switch back to prod-parity:  make caipe-ui-prod"

caipe-ui-prod: ## Run CAIPE UI in Docker in prod-parity mode (next build + next start, no hot reload)
	@echo "Starting CAIPE UI in prod-parity mode (next build + next start)..."
	@echo "  - Source edits will NOT auto-reload — rerun this target to rebuild"
	@echo "  - Matches the runner stage that ships in the published image"
	@# Bring down the hot/dev sibling first (port 3000 collision — see comment
	@# in caipe-ui-hot above and the header block in docker-compose.dev.yaml).
	@docker compose -f docker-compose.dev.yaml --profile caipe-ui rm -sf caipe-ui 2>/dev/null || true
	$(DOCKER_COMPOSE_BUILD_ENV) \
	docker compose -f docker-compose.dev.yaml --profile caipe-ui-prod up -d --build caipe-ui-prod
	@echo ""
	@echo "Prod-parity UI ready: http://localhost:3000"
	@echo "Stream logs:          docker logs -f caipe-ui-prod"
	@echo "Switch back to hot reload:  make caipe-ui-hot"

## ========== Documentation (Docusaurus) ==========

docs: docs-install docs-start ## Install dependencies and start documentation development server

docs-install: ## Install documentation site dependencies
	@echo "Installing documentation dependencies..."
	@cd docs && npm install

docs-build: docs-install ## Build documentation static site
	@echo "Building documentation site..."
	@cd docs && npm run build

docs-dev: ## Start documentation development server with auto-reload
	@echo "Starting documentation development server..."
	@echo "Site will be available at http://localhost:3001"
	@cd docs && npm run start -- --port 3001

docs-start: docs-dev ## Alias for docs-dev (start documentation development server)

docs-serve: docs-build ## Serve documentation static site
	@echo "Serving documentation static site..."
	@cd docs && npm run serve

## ========== Spec-Kit Agent Commands ==========

SPECKIT_SRC := .specify/templates/commands
CURSOR_DST  := .cursor/commands
CLAUDE_DST  := .claude/commands

generate-agent-commands: ## Generate .cursor and .claude command files from .specify/templates/commands
	@echo "Generating agent command files from $(SPECKIT_SRC)..."
	@mkdir -p $(CURSOR_DST) $(CLAUDE_DST)
	@for src in $(SPECKIT_SRC)/*.md; do \
		name=$$(basename "$$src" .md); \
		cp "$$src" "$(CURSOR_DST)/speckit.$$name.md"; \
		cp "$$src" "$(CLAUDE_DST)/speckit.$$name.md"; \
	done
	@echo "✓ Generated commands in $(CURSOR_DST)/ and $(CLAUDE_DST)/"

## ========== Lint ==========

lint: setup-venv ## Lint the code using Ruff
	@echo "Linting the code..."
	@uv add ruff --dev
	@uv run python -m ruff check . --select E,F --ignore F403 --ignore E402 --line-length 320

lint-fix: setup-venv ## Automatically fix linting issues using Ruff
	@echo "Fixing linting issues..."
	@uv add ruff --dev
	@uv run python -m ruff check . --select E,F --ignore F403 --ignore E402 --line-length 320 --fix

## ========== Test ==========

test-core: setup-venv ## Run tests for the core/shared workspace (utils, dynamic_agents, etc.)
	@echo "Running core workspace tests..."
	@. .venv/bin/activate && uv add pytest-asyncio --group unittest
	@echo "Running general project tests..."
	@. .venv/bin/activate && PYTHONPATH=. uv run pytest --ignore=integration \
		--ignore=ai_platform_engineering/knowledge_bases/rag/tests \
		--ignore=ai_platform_engineering/mcp \
		--ignore=volumes --ignore=docker-compose

## ========== Individual MCP Tests ==========

test-mcp-argocd: ## Run ArgoCD MCP tests
	@echo "Running ArgoCD MCP tests..."
	@cd ai_platform_engineering/mcp/argocd && $(MAKE) test

test-mcp-backstage: ## Run Backstage MCP tests
	@echo "Running Backstage MCP tests..."
	@cd ai_platform_engineering/mcp/backstage && $(MAKE) test

test-mcp-confluence: ## Run Confluence MCP tests
	@echo "Running Confluence MCP tests..."
	@cd ai_platform_engineering/mcp/confluence && $(MAKE) test

test-mcp-jira: ## Run Jira MCP tests
	@echo "Running Jira MCP tests..."
	@cd ai_platform_engineering/mcp/jira && $(MAKE) test

test-mcp-komodor: ## Run Komodor MCP tests
	@echo "Running Komodor MCP tests..."
	@cd ai_platform_engineering/mcp/komodor && $(MAKE) test

test-mcp-litellm: ## Run LiteLLM MCP tests
	@echo "Running LiteLLM MCP tests..."
	@cd ai_platform_engineering/mcp/litellm && $(MAKE) test

test-mcp-pagerduty: ## Run PagerDuty MCP tests
	@echo "Running PagerDuty MCP tests..."
	@cd ai_platform_engineering/mcp/pagerduty && $(MAKE) test

test-mcp-slack: ## Slack MCP is external (korotovsky/slack-mcp-server) - no local tests
	@echo "Slack uses the external OSS korotovsky/slack-mcp-server. No local MCP tests."

test-mcp-splunk: ## Run Splunk MCP tests
	@echo "Running Splunk MCP tests..."
	@cd ai_platform_engineering/mcp/splunk && $(MAKE) test

test-agents: test-mcp-argocd test-mcp-jira ## Run tests for all agents (in their own environments)
	@echo ""
	@echo "Skipping RAG module tests (temporarily disabled)..."
	@echo "✓ RAG tests skipped"

test: test-core test-agents ## Run all tests (core + agents)

## ========== RAG Module Tests ==========

test-rag-unit: setup-venv ## Run RAG module unit tests
	@echo "Running RAG module unit tests..."
	@cd ai_platform_engineering/knowledge_bases/rag && make test-unit

test-rag-coverage: setup-venv ## Run RAG module tests with detailed coverage report
	@echo "Running RAG module tests with coverage analysis..."
	@cd ai_platform_engineering/knowledge_bases/rag && make test-coverage

test-rag-memory: setup-venv ## Run RAG module tests with memory profiling
	@echo "Running RAG module tests with memory profiling..."
	@cd ai_platform_engineering/knowledge_bases/rag && make test-memory

test-rag-scale: setup-venv ## Run RAG module scale tests with memory monitoring
	@echo "Running RAG module scale tests with memory monitoring..."
	@cd ai_platform_engineering/knowledge_bases/rag && make test-scale

# Temporarily disabled - test-all target not found in nested Makefile
# test-rag-all: setup-venv ## Run all RAG module tests (unit, scale, memory, coverage)
# 	@echo "Running comprehensive RAG module test suite..."
# 	@cd ai_platform_engineering/knowledge_bases/rag/server && make test-all

## ========== Integration Tests ==========

test-keycloak-reconcile:  ## End-to-end test of init-idp.sh caipe-platform client_secret reconcile (boots throwaway Keycloak)
	@echo "Running Keycloak platform-client reconcile integration test..."
	@KC_PORT=$${KC_PORT:-28080} ./tests/integration/test_keycloak_platform_client_reconcile.sh

test-keycloak-strict-secrets:  ## End-to-end test of strict client-secret mode (boots throwaway Keycloak; covers all 4 dev placeholders)
	@echo "Running Keycloak strict client-secret integration test..."
	@KC_PORT=$${KC_PORT:-19080} ./tests/integration/test_keycloak_strict_client_secrets.sh

test-keycloak-idp-hint:  ## End-to-end test of kc_idp_hint + identity-provider-redirector wiring
	@echo "Running Keycloak kc_idp_hint / IdP redirector integration test..."
	@KC_PORT=$${KC_PORT:-21080} ./tests/integration/test_keycloak_idp_hint_redirect.sh

test-keycloak-secrets-all: test-keycloak-reconcile test-keycloak-strict-secrets  ## Run all Keycloak client_secret integration tests

test-keycloak-sso-all: test-keycloak-reconcile test-keycloak-strict-secrets test-keycloak-idp-hint  ## Run every Keycloak SSO bootstrap integration test (client secrets + IdP redirector)

validate:
	@echo "Validating code..."
	@echo "========================================"
	@echo "Running linting to check code quality..."
	@echo "========================================"
	@$(MAKE) lint

	@echo "========================================"
	@echo "Running tests to ensure code correctness..."
	@echo "========================================"
	@$(MAKE) test
	@echo "Validation complete."

lock-all:
	@echo "🔁 Recursively locking all Python projects with uv..."
	@find . -name "pyproject.toml" | while read -r pyproject; do \
		dir=$$(dirname $$pyproject); \
		echo "📂 Entering $$dir"; \
		( \
			cd $$dir || exit 1; \
			echo "🔒 Running uv lock in $$dir"; \
			uv pip compile pyproject.toml --all-extras --prerelease; \
		); \
	done

## ========== Release & Versioning ==========
release: setup-venv  ## Bump version and create a release
	@uv tool install commitizen
	@git tag -d stable || echo "No stable tag found."
	@cz changelog
	@git add CHANGELOG.md
	@git commit -m "docs: update changelog"
	@cz bump --increment $${INCREMENT:-PATCH}
	@echo "Version bumped updated successfully."

## ========== Helm Docs ==========

check-helm-docs: ## Check that helm-docs is installed (prints install instructions if missing)
	@if ! which helm-docs > /dev/null 2>&1; then \
		echo ""; \
		echo "helm-docs is not installed. Install it with one of:"; \
		echo ""; \
		echo "  macOS / Linux (Homebrew):"; \
		echo "    brew install helm-docs"; \
		echo ""; \
		echo "  Any platform (Go):"; \
		echo "    go install github.com/norwoodj/helm-docs/cmd/helm-docs@latest"; \
		echo ""; \
		echo "  Binary download (Linux / macOS / Windows):"; \
		echo "    https://github.com/norwoodj/helm-docs/releases"; \
		echo ""; \
		exit 1; \
	fi

helm-docs: check-helm-docs ## Regenerate Helm chart README.md files from values.yaml comments
	@echo "Generating Helm chart documentation..."
	@helm-docs --chart-search-root charts/
	@echo "✓ Helm chart documentation updated"

## ========== Helm Chart Docs Generator ==========

check-yq: ## Check that yq is installed (prints install instructions if missing)
	@if ! which yq > /dev/null 2>&1; then \
		echo ""; \
		echo "yq is not installed. Install it with one of:"; \
		echo ""; \
		echo "  macOS / Linux (Homebrew):"; \
		echo "    brew install yq"; \
		echo ""; \
		echo "  Any platform (Go):"; \
		echo "    go install github.com/mikefarah/yq/v4@latest"; \
		echo ""; \
		echo "  Binary download:"; \
		echo "    https://github.com/mikefarah/yq/releases"; \
		echo ""; \
		exit 1; \
	fi

docs-helm-charts: check-yq check-helm-docs ## Generate Helm chart documentation (READMEs + Docusaurus pages)
	@echo "Generating Helm chart documentation..."
	@CHART_VERSION=$(CHART_VERSION) ./scripts/generate-helm-chart-docs.sh
	@echo "✓ Helm chart documentation generated"

docs-helm-validate: docs-helm-charts docs-build ## End-to-end validation: generate docs + Docusaurus build + RC check
	@echo "Checking for RC version patterns in generated docs..."
	@if grep -rE '-(dev|rc|hotfix|alpha|beta|pre)\.' docs/docs/installation/helm-charts/ 2>/dev/null; then \
		echo "FAIL: RC version patterns found in generated docs"; \
		exit 1; \
	fi
	@echo "✓ Helm chart docs validation passed"

.PHONY: triage-snapshot
triage-snapshot: ## Regenerate the open-issues triage dashboard into docs/static/triage/ (requires gh + git)
	@command -v gh >/dev/null 2>&1 || { echo "ERROR: gh CLI not found. Install: https://cli.github.com/"; exit 1; }
	@gh auth status --hostname github.com >/dev/null 2>&1 || { echo "ERROR: gh not authenticated for github.com. Run: gh auth login --hostname github.com"; exit 1; }
	@node scripts/triage/classify-open-issues.mjs --out docs/static/triage/open-issues.html
	@echo "✓ Wrote docs/static/triage/open-issues.html — served at /triage/open-issues.html (commit to publish)"

## ========== Security Scanning ==========

IMAGE_TAG ?= localtag

GRYPE_SEVERITY ?= high

scan-images: ## Scan all locally built images with grype (make scan-images GRYPE_SEVERITY=high)
	@command -v grype >/dev/null 2>&1 || { echo "grype not found. Install: brew install grype"; exit 1; }
	@echo "Scanning images with grype (severity >= $(GRYPE_SEVERITY))..."
	@failed=0; \
	for img in $$(docker images --format "{{.Repository}}:{{.Tag}}" | grep "cnoe-io.*$(IMAGE_TAG)"); do \
		echo ""; \
		echo "=== $$img ==="; \
		grype "$$img" --fail-on "$(GRYPE_SEVERITY)" --quiet 2>/dev/null || failed=1; \
	done; \
	if [ "$$failed" -eq 1 ]; then \
		echo ""; \
		echo "FAIL: one or more images have vulnerabilities >= $(GRYPE_SEVERITY)"; \
		exit 1; \
	else \
		echo ""; \
		echo "✓ All images passed grype scan"; \
	fi

scan-image: ## Scan a single image with grype (make scan-image IMG=ghcr.io/caipe-io/mcp-splunk:localtag)
	@command -v grype >/dev/null 2>&1 || { echo "grype not found. Install: brew install grype"; exit 1; }
	@[ -n "$(IMG)" ] || { echo "Usage: make scan-image IMG=<image:tag>"; exit 1; }
	@grype "$(IMG)" --fail-on "$(GRYPE_SEVERITY)"

## ========== RBAC tests ==========
# See docs/docs/specs/102-comprehensive-rbac-tests-and-completion/quickstart.md

# Profile selection. Override with E2E_PROFILES=...
# All profiles live in docker-compose.dev.yaml — no separate e2e compose file.
E2E_PROFILES   ?= rbac,caipe-ui,caipe-mongodb,dynamic-agents,rag,all-agents,slack-bot
E2E_COMPOSE    := -f docker-compose.dev.yaml
E2E_KC_URL     ?= http://localhost:7080
E2E_KC_REALM   ?= cnoe
E2E_KC_RESOURCE_SERVER_ID ?= caipe-resource-server
E2E_WAIT_SECS  ?= 120
RBAC_PYTEST_DIRS ?= tests/rbac/unit/py tests/rbac/fixtures
RBAC_E2E_DIRS    ?= tests/rbac/e2e

# E2E port band — host-side ports for the e2e lane. Container ports unchanged.
# caipe-ui MUST stay on 3000 because Keycloak's caipe-ui client only allow-lists
# http://localhost:3000/* as a redirect URI (see deploy/keycloak/realm-config.json).
# Mongo moves to the 28xxx band to avoid collisions with a host-side Mongo on 27017.
E2E_MONGODB_HOST_PORT    ?= 28017

# E2E env injected into docker-compose.dev.yaml via ${VAR:-default} substitution.
# These are no-ops for `make test-up` (dev) — they only activate the e2e behavior
# when the test-rbac-* targets export them.
E2E_COMPOSE_ENV := \
  E2E_RUN=true \
  MONGODB_HOST_PORT=$(E2E_MONGODB_HOST_PORT) \
  RBAC_FALLBACK_FILE=$(CURDIR)/deploy/keycloak/realm-config-extras.json \
  RBAC_FALLBACK_CONFIG_PATH=/etc/keycloak/realm-config-extras.json

.PHONY: test-rbac test-rbac-lint test-rbac-up test-rbac-down test-rbac-jest test-rbac-pytest test-rbac-e2e

test-rbac-lint: ## Lint the RBAC matrix + realm-config-extras (T009/T011/T012). No services required.
	@echo "[test-rbac-lint] running matrix linter (T009)…"
	@if [ "$(RBAC_LINT_STRICT)" = "1" ]; then \
	   PYTHONPATH=. uv run python scripts/validate-rbac-matrix.py; \
	 else \
	   PYTHONPATH=. uv run python scripts/validate-rbac-matrix.py || \
	     echo "[test-rbac-lint] matrix lint failed (expected during phase rollout — set RBAC_LINT_STRICT=1 to hard-fail)"; \
	 fi
	@echo "[test-rbac-lint] running realm-config + extras validator (T011/T012)…"
	@PYTHONPATH=. uv run python scripts/validate-realm-config.py
	@echo "[test-rbac-lint] running requireAdmin deprecation guard (T051)…"
	@if [ "$(RBAC_LINT_STRICT)" = "1" ]; then \
	   STRICT=1 bash scripts/check-no-new-requireAdmin.sh; \
	 else \
	   bash scripts/check-no-new-requireAdmin.sh || \
	     echo "[test-rbac-lint] requireAdmin guard reported drift — set RBAC_LINT_STRICT=1 to hard-fail"; \
	 fi
	@echo "[test-rbac-lint] running keycloak init-script symlink guard…"
	@bash scripts/check-keycloak-init-symlinks.sh
	@echo "[test-rbac-lint] running FGA create-path ownership linter (spec 2026-06-04 Layer 3)…"
	@PYTHONPATH=. uv run python scripts/validate-fga-create-paths.py

test-rbac-up: ## Boot the e2e stack (Keycloak + UI + dynamic-agents + agents + mongo) and seed personas via init-idp.sh.
	@echo "[test-rbac-up] starting stack with profiles: $(E2E_PROFILES)"
	@echo "[test-rbac-up] e2e ports: ui=3000 (IdP-pinned) mongo=$(E2E_MONGODB_HOST_PORT) keycloak=7080"
	@$(DOCKER_COMPOSE_BUILD_ENV) $(E2E_COMPOSE_ENV) COMPOSE_PROFILES='$(E2E_PROFILES)' \
	   docker compose $(E2E_COMPOSE) up -d --wait --wait-timeout $(E2E_WAIT_SECS)
	@echo "[test-rbac-up] waiting for Keycloak readiness on $(E2E_KC_URL)…"
	@for i in $$(seq 1 60); do \
	   if curl -fsS $(E2E_KC_URL)/realms/master/.well-known/openid-configuration >/dev/null 2>&1; then \
	     echo "[test-rbac-up] Keycloak is up"; break; \
	   fi; \
	   sleep 2; \
	   if [ $$i -eq 60 ]; then echo "[test-rbac-up] FAIL: Keycloak never became ready"; exit 1; fi; \
	 done
	@echo "[test-rbac-up] running init-idp.sh to seed realm + personas…"
	@KEYCLOAK_URL=$(E2E_KC_URL) KEYCLOAK_REALM=$(E2E_KC_REALM) bash deploy/keycloak/init-idp.sh
	@echo "[test-rbac-up] stack is ready. KEYCLOAK_URL=$(E2E_KC_URL) KEYCLOAK_REALM=$(E2E_KC_REALM)"

test-rbac-down: ## Tear down the e2e stack (volumes removed).
	@echo "[test-rbac-down] tearing down e2e stack…"
	@$(E2E_COMPOSE_ENV) COMPOSE_PROFILES='$(E2E_PROFILES)' \
	   docker compose $(E2E_COMPOSE) down -v --remove-orphans

.PHONY: rbac-reinit
rbac-reinit: ## Force-rerun keycloak-init + keycloak-init-token-exchange against a running stack.
	## Use after `docker compose restart keycloak` or any time you suspect the
	## IdP broker / token-exchange grants have drifted (e.g. after editing
	## init-idp.sh or BOOTSTRAP_ADMIN_EMAILS in .env without a full down/up).
	## Idempotent — safe to run repeatedly.
	@echo "[rbac-reinit] force-recreating keycloak-init…"
	@COMPOSE_PROFILES=rbac \
	   docker compose -f docker-compose.dev.yaml up -d --force-recreate --no-deps keycloak-init
	@echo "[rbac-reinit] force-recreating keycloak-init-token-exchange…"
	@COMPOSE_PROFILES=rbac \
	   docker compose -f docker-compose.dev.yaml up -d --force-recreate --no-deps keycloak-init-token-exchange
	@echo "[rbac-reinit] done. Tail logs with:"
	@echo "  docker compose -f docker-compose.dev.yaml logs -f keycloak-init keycloak-init-token-exchange"

# Minimal trimmed-down dev stack: 5 most-used agents + RBAC + UI + dynamic-agents + slack-bot.
# Useful for day-to-day Slack/UI iteration without booting the full all-agents/rag/graph_rag stack.
# Override agent set with: make e2e-test-minimal MINIMAL_AGENTS="aws,github,jira"
MINIMAL_AGENTS  ?= aws,github,argocd,jira,confluence
MINIMAL_PROFILES = $(MINIMAL_AGENTS),caipe-ui,dynamic-agents,slack-bot,caipe-mongodb,rbac

.PHONY: e2e-test-minimal e2e-test-minimal-down

e2e-test-minimal: ## Boot minimal trimmed dev stack (5 agents + UI + dynamic-agents + slack-bot + Keycloak). Hot-reload enabled.
	@echo "[e2e-test-minimal] starting trimmed stack with profiles: $(MINIMAL_PROFILES)"
	@echo "[e2e-test-minimal] hot-reload enabled (DEV_HOT_RELOAD=true) — Python edits auto-restart."
	@unset SLACK_INTEGRATION_AUTH_TOKEN_URL; \
	   $(DOCKER_COMPOSE_BUILD_ENV) \
	   DEV_HOT_RELOAD=true \
	   COMPOSE_PROFILES='$(MINIMAL_PROFILES)' \
	   docker compose -f docker-compose.dev.yaml up -d --wait --wait-timeout $(E2E_WAIT_SECS)
	@echo "[e2e-test-minimal] waiting for Keycloak readiness on http://localhost:7080…"
	@for i in $$(seq 1 60); do \
	   if curl -fsS http://localhost:7080/realms/master/.well-known/openid-configuration >/dev/null 2>&1; then \
	     echo "[e2e-test-minimal] Keycloak is up"; break; \
	   fi; \
	   sleep 2; \
	   if [ $$i -eq 60 ]; then echo "[e2e-test-minimal] FAIL: Keycloak never became ready"; exit 1; fi; \
	 done
	@echo "[e2e-test-minimal] stack ready:"
	@echo "  - UI:               http://localhost:3000"
	@echo "  - Dynamic Agents:   http://localhost:8100"
	@echo "  - Keycloak admin:   http://localhost:7080/admin (admin / admin)"
	@echo "  - Agent Gateway:    http://localhost:4000"
	@echo "  - Slack bot (HTTP): http://localhost:8030"
	@echo "  - Agents up: $(MINIMAL_AGENTS)"
	@echo ""
	@echo "Tail logs:    docker compose -f docker-compose.dev.yaml logs -f slack-bot dynamic-agents"
	@echo "Tear down:    make e2e-test-minimal-down"

e2e-test-minimal-down: ## Tear down the minimal trimmed dev stack (volumes preserved).
	@echo "[e2e-test-minimal-down] stopping trimmed stack…"
	@COMPOSE_PROFILES='$(MINIMAL_PROFILES)' \
	   docker compose -f docker-compose.dev.yaml down --remove-orphans

test-rbac-pytest: ## Run RBAC pytest helper-unit + matrix-driver tests. Pass --rbac-online via PYTEST_ARGS to enable live-Keycloak tests.
	@echo "[test-rbac-pytest] running RBAC pytest suite ($(RBAC_PYTEST_DIRS))…"
	@mkdir -p test-results
	@PYTHONPATH=. \
	   KEYCLOAK_URL=$(E2E_KC_URL) \
	   KEYCLOAK_REALM=$(E2E_KC_REALM) \
	   KEYCLOAK_RESOURCE_SERVER_ID=$(E2E_KC_RESOURCE_SERVER_ID) \
	   uv run --group unittest pytest $(RBAC_PYTEST_DIRS) -v \
	     --junitxml=test-results/rbac-pytest.xml \
	     $(PYTEST_ARGS)

test-rbac-jest: ## Run RBAC Jest matrix-driver tests (TS helper parity + UI BFF). Emits ui/test-results/junit.xml for T058 to consume.
	@if [ -d ui ] && [ -f ui/package.json ]; then \
	   echo "[test-rbac-jest] running ui/ jest suite filtered to rbac…"; \
	   mkdir -p ui/test-results; \
	   cd ui && JEST_JUNIT_OUTPUT_DIR=test-results JEST_JUNIT_OUTPUT_NAME=junit.xml \
	     npx jest \
	       'src/__tests__/rbac-matrix-driver.test.ts' \
	       'src/lib/rbac/__tests__/' \
	       'src/app/api/__tests__/rag-rbac.test.ts' \
	       --reporters=default --reporters=jest-junit \
	       --passWithNoTests; \
	 else \
	   echo "[test-rbac-jest] ui/ not found; skipping jest stage"; \
	 fi

test-rbac-e2e: ## Run RBAC Playwright e2e suite (tests/rbac/e2e/). Requires `make test-rbac-up` first.
	@if [ -d tests/rbac/e2e ] && [ -f tests/rbac/e2e/package.json ]; then \
	   echo "[test-rbac-e2e] running playwright RBAC e2e tests from tests/rbac/e2e/…"; \
	   if [ ! -d tests/rbac/e2e/node_modules ]; then \
	     echo "[test-rbac-e2e] installing tests/rbac/e2e/node_modules (one-time)…"; \
	     cd tests/rbac/e2e && npm install --no-audit --no-fund; cd $(CURDIR); \
	   fi; \
	   cd tests/rbac/e2e && npx playwright test --grep @rbac; \
	 else \
	   echo "[test-rbac-e2e] tests/rbac/e2e/ not found; skipping"; \
	 fi

test-rbac: ## Full comprehensive RBAC suite: lint + (optional online stack) + pytest + jest + e2e.
	@$(MAKE) test-rbac-lint
	@$(MAKE) test-rbac-pytest
	@$(MAKE) test-rbac-jest
	@if [ "$(RBAC_E2E)" = "1" ]; then \
	   echo "[test-rbac] RBAC_E2E=1 — bringing up stack and running playwright"; \
	   $(MAKE) test-rbac-up && $(MAKE) test-rbac-e2e || RC=$$?; \
	   $(MAKE) test-rbac-down; \
	   exit $${RC:-0}; \
	 else \
	   echo "[test-rbac] skipping e2e stage (set RBAC_E2E=1 to enable)"; \
	 fi

## ========== Help ==========

help: ## Show this help message
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' | sort
