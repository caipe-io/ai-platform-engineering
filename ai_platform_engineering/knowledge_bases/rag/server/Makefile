# Common Makefile for CNOE Agent Projects
# --------------------------------------------------
# This Makefile provides common targets for building, testing, and running CNOE agents.
# Usage:
#   make <target>
# --------------------------------------------------

# Variables
AGENT_NAME ?= rag
AGENT_DIR_NAME = kb-$(shell echo $(AGENT_NAME))
AGENT_PKG_NAME ?= kb_$(shell echo $(AGENT_NAME))

.PHONY: \
  build setup-venv activate-venv install run help clean clean-pyc clean-venv clean-build-artifacts \
  install-uv verify-a2a-sdk evals \
  run-a2a run-curl-client \
  test test-unit test-coverage test-memory test-scale test-all \
  build-docker-a2a build-docker-a2a-tag build-docker-a2a-push build-docker-a2a-tag-and-push \
  run-docker-a2a \
  check-env lint ruff-fix \
  help add-copyright-license-headers

## ========== Setup & Clean ==========

setup-venv:        ## Use main project's virtual environment or create local one
	@echo "Setting up virtual environment..."
	@REPO_ROOT=$$(git rev-parse --show-toplevel 2>/dev/null || echo "../../../.."); \
	if [ -d "$$REPO_ROOT/.venv" ]; then \
		echo "Using main project virtual environment from $$REPO_ROOT/.venv"; \
		echo "To activate manually, run: source $$REPO_ROOT/.venv/bin/activate"; \
	elif [ -d ".venv" ]; then \
		echo "Virtual environment already exists."; \
		echo "To activate manually, run: source .venv/bin/activate"; \
	else \
		echo "Creating local virtual environment..."; \
		uv venv .venv; \
		echo "Virtual environment created. To activate manually, run: source .venv/bin/activate"; \
	fi

clean-pyc:         ## Remove Python bytecode and __pycache__
	@find . -type d -name "__pycache__" -exec rm -rf {} + || echo "No __pycache__ directories found."

clean-venv:        ## Note: Using main project's virtual environment
	@echo "Using main project's virtual environment. No local .venv to remove."

clean-build-artifacts: ## Remove dist/, build/, egg-info/
	@rm -rf dist $(AGENT_PKG_NAME).egg-info || echo "No build artifacts found."

clean:             ## Clean all build artifacts and cache
	@$(MAKE) clean-pyc
	@$(MAKE) clean-venv
	@$(MAKE) clean-build-artifacts
	@find . -type d -name ".pytest_cache" -exec rm -rf {} + || echo "No .pytest_cache directories found."

## ========== Environment Helpers ==========

check-env:         ## Check if .env file exists
	@if [ ! -f ".env" ]; then \
		echo "Error: .env file not found."; exit 1; \
	fi

# Dynamically find venv at runtime (prefer repo root, fallback to local)
REPO_ROOT ?= $(shell git rev-parse --show-toplevel 2>/dev/null || echo "../../../..")
# Define venv-activate as a single-line shell command that resolves the path at runtime
venv-activate = VENV_PATH=""; if [ -d "$(REPO_ROOT)/.venv" ]; then VENV_PATH="$(REPO_ROOT)/.venv"; elif [ -d ".venv" ]; then VENV_PATH=".venv"; else echo "Error: No virtual environment found. Run 'make setup-venv' first." >&2; exit 1; fi; . $$VENV_PATH/bin/activate
load-env = set -a && . .env && set +a
venv-run = $(venv-activate) && $(load-env)

## ========== Install ==========

install: setup-venv ## Install Python dependencies using UV
	@echo "Installing dependencies..."
	@$(venv-activate) && uv sync --no-dev
	@echo "Dependencies installed successfully."

install-uv:        ## Install uv package manager
	@$(venv-run) pip install uv

## ========== Build & Lint ==========

build: setup-venv  ## Build the package using UV
	@$(venv-activate) && uv build

lint: setup-venv   ## Lint code with ruff (ignoring F401)
	@$(venv-activate) && uv sync && ruff check --ignore F401 $(AGENT_PKG_NAME) tests

ruff-fix: setup-venv ## Auto-fix lint issues with ruff
	@$(venv-activate) && ruff check $(AGENT_PKG_NAME) tests --fix

## ========== Run ==========

run-a2a: setup-venv ## Run A2A agent
	@$(MAKE) check-env
	@$(venv-run) python -m $(AGENT_PKG_NAME).protocol_bindings.a2a_server

## ========== Docker ==========

build-docker-a2a:            ## Build A2A Docker image
	docker build -t $(AGENT_DIR_NAME):a2a-latest -f docker/Dockerfile.a2a .

build-docker-a2a-tag:        ## Tag A2A Docker image
	docker tag $(AGENT_DIR_NAME):a2a-latest ghcr.io/caipe-io/$(AGENT_DIR_NAME):a2a-latest

build-docker-a2a-push:       ## Push A2A Docker image
	docker push ghcr.io/caipe-io/$(AGENT_DIR_NAME):a2a-latest

build-docker-a2a-tag-and-push: ## Tag and push A2A Docker image
	@$(MAKE) build-docker-a2a build-docker-a2a-tag build-docker-a2a-push

run-docker-a2a: ## Run the A2A agent in Docker
	@A2A_AGENT_PORT=$$(grep A2A_AGENT_PORT .env | cut -d '=' -f2); \
	LOCAL_A2A_AGENT_IMAGE=$${A2A_AGENT_IMAGE:-ghcr.io/caipe-io/$(AGENT_DIR_NAME):a2a-latest}; \
	LOCAL_A2A_AGENT_PORT=$${A2A_AGENT_PORT:-8000}; \
	echo "==================================================================="; \
	echo "                      A2A AGENT DOCKER RUN                         "; \
	echo "==================================================================="; \
	echo "Using Agent Image: $$LOCAL_A2A_AGENT_IMAGE"; \
	echo "Using Agent Port: $$LOCAL_A2A_AGENT_PORT"; \
	echo "==================================================================="; \
	docker run -p $$LOCAL_A2A_AGENT_PORT:8000 -it \
		-e AZURE_OPENAI_API_KEY=$$AZURE_OPENAI_API_KEY \
		-e OPENAI_API_VERSION=$$OPENAI_API_VERSION \
		-e AZURE_OPENAI_API_VERSION=$$AZURE_OPENAI_API_VERSION \
		-e AZURE_OPENAI_ENDPOINT=$$AZURE_OPENAI_ENDPOINT \
		-e AZURE_OPENAI_DEPLOYMENT_NAME=$$AZURE_OPENAI_DEPLOYMENT_NAME \
		$$LOCAL_A2A_AGENT_IMAGE

## ========== Tests ==========

test-unit: setup-venv build ## Run unit tests using pytest and coverage
	@$(venv-activate) && uv sync --dev
	@$(venv-activate) && uv pip install -e ../common
	@$(venv-activate) && uv pip install -e .
	@$(venv-activate) && uv pip install pytest-asyncio pytest-cov
	@$(venv-activate) && pytest tests/ -v --tb=short --disable-warnings --maxfail=1 --cov=server --cov-report=term --cov-report=xml

test: test-all ## Run all tests (unit, scale, memory, coverage) - DEFAULT TARGET

test-coverage: setup-venv ## Run tests with detailed coverage report
	@$(venv-activate) && uv sync --dev
	@$(venv-activate) && uv pip install -e ../common
	@$(venv-activate) && uv pip install -e .
	@$(venv-activate) && uv pip install pytest-asyncio pytest-cov
	@echo "Running tests with detailed coverage analysis..."
	@$(venv-activate) && pytest tests/ -v --tb=short --disable-warnings \
		--cov=server --cov-report=term --cov-report=html --cov-report=xml \
		--cov-branch

test-memory: setup-venv ## Run tests with memory profiling
	@$(venv-activate) && uv sync --dev
	@$(venv-activate) && uv pip install -e ../common
	@$(venv-activate) && uv pip install -e .
	@$(venv-activate) && uv pip install pytest-asyncio pytest-cov memory-profiler psutil
	@echo "Running tests with memory profiling..."
	@$(venv-activate) && pytest tests/ -v --tb=short --disable-warnings \
		--cov=server --cov-report=term --cov-report=xml \
		--durations=10 --maxfail=1

test-scale: setup-venv ## Run scale tests with memory monitoring
	@$(venv-activate) && uv sync --dev
	@$(venv-activate) && uv pip install -e ../common
	@$(venv-activate) && uv pip install -e .
	@$(venv-activate) && uv pip install pytest-asyncio pytest-cov psutil
	@echo "Running scale tests with memory monitoring..."
	@$(venv-activate) && pytest tests/test_scale_ingestion.py -v --tb=short \
		--durations=10 --maxfail=1 -s

test-all: setup-venv ## Run all tests with coverage, memory profiling, and scale tests
	@echo "Installing RAG server dependencies including local 'common' module..."
	@$(venv-activate) && uv sync --dev
	@$(venv-activate) && uv pip install -e ../common
	@$(venv-activate) && uv pip install -e .
	@$(venv-activate) && uv pip install pytest-asyncio pytest-cov memory-profiler psutil
	@echo "Running comprehensive test suite..."
	@echo "==================================================================="
	@echo "                      COMPREHENSIVE TEST SUITE                      "
	@echo "==================================================================="
	@echo "1. Running unit tests with coverage..."
	@$(venv-activate) && pytest tests/test_loader.py tests/test_rag_api.py tests/test_scrapers.py \
		-v --tb=short --disable-warnings --cov=server --cov-report=term --cov-report=xml
	@echo ""
	@echo "2. Running scale tests with memory monitoring..."
	@$(venv-activate) && pytest tests/test_scale_ingestion.py -v --tb=short --durations=10 -s
	@echo ""
	@echo "3. Generating final coverage report..."
	@$(venv-activate) && pytest tests/ -v --tb=short --disable-warnings \
		--cov=server --cov-report=term --cov-report=html --cov-report=xml \
		--cov-branch
	@echo "==================================================================="
	@echo "                      TEST SUITE COMPLETED                          "
	@echo "==================================================================="

## ========== Licensing & Help ==========

add-copyright-license-headers: ## Add license headers
	docker run --rm -v $(shell pwd)/$(AGENT_PKG_NAME):/workspace ghcr.io/google/addlicense:latest -c "CNOE" -l apache -s=only -v /workspace

help: ## Show this help message
	@echo "Available targets:"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-30s\033[0m %s\n", $$1, $$2}' | sort
