# Creating an MCP Server

This guide will walk you through creating a Model Context Protocol (MCP) server that provides tools for your agents.

## Overview

An MCP server in CAIPE:

- Exposes **tools** that agents can call
- Communicates via **HTTP** or **stdio**
- Uses **FastMCP** framework for rapid development
- Supports **authentication** and **authorization**
- Includes **type validation** with Pydantic
- Can be **auto-generated** from OpenAPI specs

## What is MCP?

[Model Context Protocol](https://modelcontextprotocol.io/) is an open standard for connecting LLMs to external data sources and tools. Think of it as a universal adapter that allows agents to interact with any API or service.

### MCP vs Direct API Integration

| Aspect | MCP Server | Direct API |
|--------|------------|-----------|
| **Reusability** | Multiple agents can use the same server | Each agent implements its own integration |
| **Maintenance** | Update once, affects all agents | Update each agent individually |
| **Type Safety** | Pydantic models with validation | Manual validation in each agent |
| **Discovery** | Tools auto-discovered by agents | Manual tool definition |
| **Security** | Centralized auth and rate limiting | Distributed security logic |

## Prerequisites

Before creating an MCP server, you should:

- Understand the target API you're integrating with
- Have API documentation (OpenAPI/Swagger preferred)
- Have API credentials for testing
- Know whether you need HTTP or stdio transport

## Option 1: Auto-Generate from OpenAPI (Recommended)

The fastest way to create an MCP server is to generate it from an OpenAPI specification.

### Using openapi-mcp-codegen

```bash
# Install the code generator
uvx git+https://github.com/cnoe-io/openapi-mcp-codegen.git

# Generate MCP server from OpenAPI spec
openapi-mcp-codegen generate \
  --spec https://api.example.com/openapi.json \
  --output ai_platform_engineering/mcp/example \
  --server-name mcp-example \
  --package-name mcp_example

# Navigate to generated server
cd ai_platform_engineering/mcp/example

# Install dependencies
uv sync

# Test the server
uv run mcp-example
```

### What Gets Generated

```
mcp/
├── mcp_example/
│   ├── __init__.py
│   ├── __main__.py
│   ├── server.py              # FastMCP server
│   ├── api/
│   │   └── client.py         # HTTP client
│   ├── models/
│   │   ├── base.py           # Base Pydantic models
│   │   ├── User.py           # Generated models
│   │   └── ...
│   └── tools/
│       ├── get_user.py       # Generated tools
│       ├── create_user.py
│       └── ...
├── pyproject.toml
├── README.md
└── Makefile
```

### Customize Generated Code

After generation, you can customize:

1. **Add authentication logic** in `api/client.py`
2. **Enhance tool descriptions** in `tools/*.py`
3. **Add validation** in models
4. **Configure rate limiting**
5. **Add caching**

## Option 2: Build from Scratch

For APIs without OpenAPI specs or custom integrations, build manually using FastMCP.

### Step 1: Create Project Structure

```bash
# Create MCP server directory
mkdir -p ai_platform_engineering/mcp/example
cd ai_platform_engineering/mcp/example

# Create package structure
mkdir -p mcp_example/{api,models,tools}
touch mcp_example/__init__.py
touch mcp_example/__main__.py
touch mcp_example/server.py
touch mcp_example/api/__init__.py
touch mcp_example/api/client.py
touch mcp_example/models/__init__.py
touch mcp_example/models/base.py
touch mcp_example/tools/__init__.py
```

### Step 2: Create pyproject.toml

```toml
[project]
name = "mcp-example"
version = "0.1.0"
description = "MCP server for Example API"
requires-python = ">=3.11"
dependencies = [
    "fastmcp>=2.13.3",
    "mcp>=1.21.0",
    "pydantic>=2.12.5",
    "httpx>=0.28.1",
    "python-dotenv>=1.2.1",
    "typing-extensions>=4.15.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.24.0",
    "ruff>=0.9.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.ruff]
line-length = 100
target-version = "py311"
```

### Step 3: Create API Client

`mcp_example/api/client.py`:

```python
"""HTTP client for Example API."""

import os
from typing import Any
import httpx
from pydantic import BaseModel


class ExampleAPIClient:
    """Client for interacting with Example API."""

    def __init__(self) -> None:
        """Initialize the Example API client."""
        self.base_url = os.getenv(
            "EXAMPLE_API_URL",
            "https://api.example.com"
        )
        self.api_key = os.getenv("EXAMPLE_API_KEY")

        if not self.api_key:
            raise ValueError("EXAMPLE_API_KEY environment variable is required")

        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    async def get(
        self,
        path: str,
        params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Make GET request to Example API.

        Args:
            path: API endpoint path
            params: Query parameters

        Returns:
            Response data as dictionary

        Raises:
            httpx.HTTPStatusError: If request fails
        """
        response = await self.client.get(path, params=params)
        response.raise_for_status()
        return response.json()

    async def post(
        self,
        path: str,
        data: dict[str, Any] | BaseModel
    ) -> dict[str, Any]:
        """Make POST request to Example API.

        Args:
            path: API endpoint path
            data: Request payload

        Returns:
            Response data as dictionary

        Raises:
            httpx.HTTPStatusError: If request fails
        """
        if isinstance(data, BaseModel):
            data = data.model_dump(exclude_none=True)

        response = await self.client.post(path, json=data)
        response.raise_for_status()
        return response.json()

    async def put(
        self,
        path: str,
        data: dict[str, Any] | BaseModel
    ) -> dict[str, Any]:
        """Make PUT request to Example API."""
        if isinstance(data, BaseModel):
            data = data.model_dump(exclude_none=True)

        response = await self.client.put(path, json=data)
        response.raise_for_status()
        return response.json()

    async def delete(self, path: str) -> dict[str, Any]:
        """Make DELETE request to Example API."""
        response = await self.client.delete(path)
        response.raise_for_status()
        return response.json()

    async def close(self) -> None:
        """Close the HTTP client."""
        await self.client.aclose()


# Global client instance
_client: ExampleAPIClient | None = None


def get_client() -> ExampleAPIClient:
    """Get or create the Example API client."""
    global _client
    if _client is None:
        _client = ExampleAPIClient()
    return _client
```

### Step 4: Define Models

`mcp_example/models/base.py`:

```python
"""Base models for Example API."""

from pydantic import BaseModel, Field


class ExampleResource(BaseModel):
    """Represents a resource in Example API."""

    id: str = Field(..., description="Unique identifier")
    name: str = Field(..., description="Resource name")
    description: str | None = Field(None, description="Resource description")
    created_at: str | None = Field(None, description="Creation timestamp")
    updated_at: str | None = Field(None, description="Last update timestamp")


class CreateResourceRequest(BaseModel):
    """Request model for creating a resource."""

    name: str = Field(..., description="Resource name")
    description: str | None = Field(None, description="Resource description")


class UpdateResourceRequest(BaseModel):
    """Request model for updating a resource."""

    name: str | None = Field(None, description="New resource name")
    description: str | None = Field(None, description="New description")
```

### Step 5: Create MCP Tools

`mcp_example/tools/list_resources.py`:

```python
"""Tool for listing Example API resources."""

from typing import Annotated
from fastmcp import Context
from ..api.client import get_client
from ..models.base import ExampleResource


async def list_resources(
    ctx: Context,
    limit: Annotated[
        int,
        "Maximum number of resources to return"
    ] = 20,
    offset: Annotated[
        int,
        "Offset for pagination"
    ] = 0,
) -> list[ExampleResource]:
    """List all available resources from Example API.

    This tool fetches resources with pagination support.
    Use limit and offset parameters to paginate through large result sets.

    Args:
        ctx: MCP context
        limit: Maximum resources to return (default: 20, max: 100)
        offset: Starting position for pagination (default: 0)

    Returns:
        List of ExampleResource objects

    Example:
        >>> resources = await list_resources(limit=10, offset=0)
        >>> for resource in resources:
        ...     print(f"{resource.name}: {resource.description}")
    """
    client = get_client()

    # Validate limits
    if limit < 1 or limit > 100:
        raise ValueError("Limit must be between 1 and 100")

    if offset < 0:
        raise ValueError("Offset must be non-negative")

    # Fetch resources
    response = await client.get(
        "/api/v1/resources",
        params={"limit": limit, "offset": offset}
    )

    # Parse and return
    return [ExampleResource(**item) for item in response.get("items", [])]
```

`mcp_example/tools/get_resource.py`:

```python
"""Tool for getting a specific resource."""

from typing import Annotated
from fastmcp import Context
from ..api.client import get_client
from ..models.base import ExampleResource


async def get_resource(
    ctx: Context,
    resource_id: Annotated[str, "ID of the resource to retrieve"]
) -> ExampleResource:
    """Get a specific resource by ID.

    Args:
        ctx: MCP context
        resource_id: Unique identifier of the resource

    Returns:
        ExampleResource object

    Raises:
        httpx.HTTPStatusError: If resource not found (404)
    """
    client = get_client()

    response = await client.get(f"/api/v1/resources/{resource_id}")

    return ExampleResource(**response)
```

`mcp_example/tools/create_resource.py`:

```python
"""Tool for creating a new resource."""

from typing import Annotated
from fastmcp import Context
from ..api.client import get_client
from ..models.base import ExampleResource, CreateResourceRequest


async def create_resource(
    ctx: Context,
    name: Annotated[str, "Name for the new resource"],
    description: Annotated[str | None, "Description of the resource"] = None,
) -> ExampleResource:
    """Create a new resource in Example API.

    Args:
        ctx: MCP context
        name: Resource name (required)
        description: Resource description (optional)

    Returns:
        Newly created ExampleResource

    Example:
        >>> resource = await create_resource(
        ...     name="My Resource",
        ...     description="A test resource"
        ... )
        >>> print(f"Created resource with ID: {resource.id}")
    """
    client = get_client()

    # Validate input
    if not name or len(name) < 3:
        raise ValueError("Resource name must be at least 3 characters")

    # Create request
    request = CreateResourceRequest(
        name=name,
        description=description
    )

    # Call API
    response = await client.post("/api/v1/resources", data=request)

    return ExampleResource(**response)
```

### Step 6: Create MCP Server

`mcp_example/server.py`:

```python
"""FastMCP server for Example API."""

import logging
from fastmcp import FastMCP

# Import tools
from .tools.list_resources import list_resources
from .tools.get_resource import get_resource
from .tools.create_resource import create_resource

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

# Create MCP server
mcp = FastMCP(
    name="mcp-example",
    version="0.1.0",
    description="MCP server for Example API"
)

# Register tools
mcp.tool()(list_resources)
mcp.tool()(get_resource)
mcp.tool()(create_resource)


def run_server() -> None:
    """Run the MCP server."""
    mcp.run()
```

### Step 7: Create Entry Point

`mcp_example/__main__.py`:

```python
"""Entry point for MCP Example server."""

from .server import run_server

if __name__ == "__main__":
    run_server()
```

### Step 8: Create Makefile

```makefile
.PHONY: help install test lint run clean

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	uv sync --all-groups

test: ## Run tests
	uv run pytest

lint: ## Run linter
	uv run ruff check .

lint-fix: ## Fix linting issues
	uv run ruff check --fix .
	uv run ruff format .

run: ## Run MCP server
	uv run python -m mcp_example

clean: ## Clean build artifacts
	rm -rf .venv __pycache__ .pytest_cache .ruff_cache
	find . -type d -name "__pycache__" -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete
```

## Step 9: Add to Docker Compose

Update `docker-compose.dev.yaml`:

```yaml
services:
  mcp-example:
    build:
      context: .
      dockerfile: build/mcp/Dockerfile
      args:
        MCP_NAME: example
    container_name: mcp-example
    environment:
      - EXAMPLE_API_URL=${EXAMPLE_API_URL:-https://api.example.com}
      - EXAMPLE_API_KEY=${EXAMPLE_API_KEY}
      - LOG_LEVEL=INFO
    ports:
      - "8080:8080"
    volumes:
      - ./ai_platform_engineering/mcp/example:/app/mcp
    networks:
      - ai-platform-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3

networks:
  ai-platform-network:
    driver: bridge
```

## Step 10: Test Your MCP Server

### Test Locally

```bash
# Install dependencies
make install

# Run the server
make run
```

### Test with MCP Inspector

```bash
# Install MCP Inspector
npx @modelcontextprotocol/inspector

# Connect to your server
# URL: http://localhost:8080
```

### Test Tools

```python
# test_mcp.py
import asyncio
from mcp_example.tools.list_resources import list_resources
from mcp_example.tools.create_resource import create_resource
from fastmcp import Context


async def main():
    ctx = Context()

    # Test list_resources
    print("Listing resources...")
    resources = await list_resources(ctx, limit=5)
    for resource in resources:
        print(f"- {resource.name}: {resource.description}")

    # Test create_resource
    print("\nCreating resource...")
    new_resource = await create_resource(
        ctx,
        name="Test Resource",
        description="Created via MCP"
    )
    print(f"Created: {new_resource.id}")


if __name__ == "__main__":
    asyncio.run(main())
```

## Best Practices

### Tool Design

1. **Clear Descriptions**: Write detailed docstrings for each tool
2. **Type Hints**: Use Annotated for parameter documentation
3. **Validation**: Validate inputs before calling the API
4. **Error Handling**: Return helpful error messages
5. **Pagination**: Support pagination for list operations

### Example of Good Tool Design

```python
async def search_resources(
    ctx: Context,
    query: Annotated[str, "Search query string"],
    category: Annotated[
        str | None,
        "Filter by category (optional)"
    ] = None,
    limit: Annotated[
        int,
        "Maximum results (1-100)"
    ] = 20,
    sort_by: Annotated[
        str,
        "Sort field: 'name', 'created_at', 'updated_at'"
    ] = "name",
) -> list[ExampleResource]:
    """Search for resources matching the query.

    This tool performs a full-text search across resource names and descriptions.
    Results can be filtered by category and sorted by various fields.

    Args:
        ctx: MCP context
        query: Search string (minimum 3 characters)
        category: Optional category filter
        limit: Maximum number of results (default: 20, max: 100)
        sort_by: Field to sort by (default: 'name')

    Returns:
        List of matching ExampleResource objects

    Example:
        >>> results = await search_resources(
        ...     query="test",
        ...     category="demo",
        ...     limit=10,
        ...     sort_by="created_at"
        ... )
    """
    # Validation
    if len(query) < 3:
        raise ValueError("Query must be at least 3 characters")

    if sort_by not in ["name", "created_at", "updated_at"]:
        raise ValueError(f"Invalid sort_by: {sort_by}")

    # Implementation...
```

### Authentication

Always handle authentication securely:

```python
class ExampleAPIClient:
    def __init__(self) -> None:
        # Support multiple auth methods
        api_key = os.getenv("EXAMPLE_API_KEY")
        bearer_token = os.getenv("EXAMPLE_BEARER_TOKEN")

        headers = {"Content-Type": "application/json"}

        if bearer_token:
            headers["Authorization"] = f"Bearer {bearer_token}"
        elif api_key:
            headers["X-API-Key"] = api_key
        else:
            raise ValueError("No authentication credentials provided")

        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=30.0,
        )
```

### Rate Limiting

Implement rate limiting to avoid API throttling:

```python
from asyncio import Semaphore

class ExampleAPIClient:
    def __init__(self) -> None:
        # Limit concurrent requests
        self.semaphore = Semaphore(10)  # Max 10 concurrent requests

    async def get(self, path: str, **kwargs) -> dict:
        async with self.semaphore:
            response = await self.client.get(path, **kwargs)
            response.raise_for_status()
            return response.json()
```

### Caching

Add caching for frequently accessed data:

```python
from functools import lru_cache
from datetime import datetime, timedelta

class ExampleAPIClient:
    def __init__(self) -> None:
        self.cache = {}
        self.cache_ttl = timedelta(minutes=5)

    async def get_with_cache(
        self,
        path: str,
        cache_key: str | None = None
    ) -> dict:
        key = cache_key or path

        # Check cache
        if key in self.cache:
            data, timestamp = self.cache[key]
            if datetime.now() - timestamp < self.cache_ttl:
                return data

        # Fetch and cache
        data = await self.get(path)
        self.cache[key] = (data, datetime.now())
        return data
```

## Advanced Topics

### Custom Context

Add custom context data to tools:

```python
from fastmcp import FastMCP, Context
from dataclasses import dataclass

@dataclass
class ExampleContext(Context):
    user_id: str
    tenant_id: str

mcp = FastMCP[ExampleContext](
    name="mcp-example",
    context_factory=lambda: ExampleContext(
        user_id=os.getenv("USER_ID"),
        tenant_id=os.getenv("TENANT_ID")
    )
)
```

### Streaming Responses

Support streaming for large responses:

```python
from typing import AsyncIterator

async def stream_logs(
    ctx: Context,
    resource_id: str
) -> AsyncIterator[str]:
    """Stream logs from a resource.

    Yields log lines as they become available.
    """
    client = get_client()

    async with client.stream("GET", f"/api/v1/resources/{resource_id}/logs") as response:
        async for line in response.aiter_lines():
            yield line
```

### Webhooks

Register webhooks for real-time updates:

```python
@mcp.resource("resource://{resource_id}/events")
async def resource_events(ctx: Context, resource_id: str):
    """Subscribe to resource events."""
    # Implementation for webhook subscription
    pass
```

## Testing

### Unit Tests

```python
# tests/test_tools.py
import pytest
from unittest.mock import AsyncMock, patch
from mcp_example.tools.list_resources import list_resources
from fastmcp import Context


@pytest.mark.asyncio
async def test_list_resources():
    """Test listing resources."""
    ctx = Context()

    with patch("mcp_example.api.client.get_client") as mock_get_client:
        mock_client = AsyncMock()
        mock_client.get.return_value = {
            "items": [
                {"id": "1", "name": "Resource 1", "description": "Test"}
            ]
        }
        mock_get_client.return_value = mock_client

        resources = await list_resources(ctx, limit=10)

        assert len(resources) == 1
        assert resources[0].name == "Resource 1"
```

### Integration Tests

```python
# tests/test_integration.py
import pytest
from mcp_example.api.client import ExampleAPIClient


@pytest.mark.integration
@pytest.mark.asyncio
async def test_real_api():
    """Test against real API (requires credentials)."""
    client = ExampleAPIClient()

    try:
        resources = await client.get("/api/v1/resources", params={"limit": 1})
        assert "items" in resources
    finally:
        await client.close()
```

## Deployment

### Docker

```dockerfile
# build/mcp/Dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY ai_platform_engineering/mcp/example/pyproject.toml ./
COPY ai_platform_engineering/mcp/example/mcp_example/ ./mcp_example/

RUN uv sync --frozen --no-dev

EXPOSE 8080

CMD ["uv", "run", "python", "-m", "mcp_example"]
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-example
spec:
  replicas: 3
  selector:
    matchLabels:
      app: mcp-example
  template:
    metadata:
      labels:
        app: mcp-example
    spec:
      containers:
      - name: mcp-example
        image: ghcr.io/yourorg/mcp-example:latest
        ports:
        - containerPort: 8080
        env:
        - name: EXAMPLE_API_KEY
          valueFrom:
            secretKeyRef:
              name: example-credentials
              key: api-key
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
```

## Troubleshooting

### Server won't start

- Check environment variables are set
- Verify API credentials are valid
- Check port 8080 is not in use
- Review logs for errors

### Tools not discovered

- Ensure tools are registered with `mcp.tool()`
- Check tool function signatures are correct
- Verify type hints are present
- Test tools independently

### API errors

- Check API credentials
- Verify base URL is correct
- Test API with curl/Postman first
- Check rate limits

## Next Steps

- **[Connect Agent to MCP](./creating-an-agent#step-4-implement-the-agent-logic)** - Use your MCP server in an agent
- **[Add Evaluations](../evaluations/index.md)** - Test MCP server quality
- **[Deploy to Production](../installation/index.md)** - Deploy with Kubernetes

## Resources

- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [FastMCP Documentation](https://github.com/jlowin/fastmcp)
- [OpenAPI MCP Codegen](https://github.com/cnoe-io/openapi-mcp-codegen)
- [Example MCP Servers](../agents/README.md)

---

**You've created your first MCP server!** 🎉

Your MCP server is now ready to be used by agents across the platform.
