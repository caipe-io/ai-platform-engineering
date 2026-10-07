# Webloader Ingestor

The Webloader ingestor is a specialized ingestor that crawls and ingests web pages and documentation sites into the RAG system. It supports sitemap parsing, recursive crawling, JavaScript rendering, and concurrent URL processing.

## Overview

The Webloader operates differently from other ingestors:
- **Event-Driven**: Listens to Redis queue for ingestion requests from the RAG server
- **Concurrent Processing**: Handles multiple URL ingestion tasks simultaneously
- **Automatic Reloading**: Periodically re-ingests datasources to keep content fresh
- **Scrapy-Powered**: Uses Scrapy with Playwright for robust web scraping
- **Smart Parsers**: Includes specialized parsers for Docusaurus, MkDocs, Sphinx, ReadTheDocs, and VitePress sites

## Architecture

The Webloader must run **alongside the RAG server** with access to the **same Redis instance**. The flow is:

1. User sends URL ingestion request to RAG server
2. Server creates datasource and job, then pushes request to Redis queue
3. Webloader picks up request from Redis queue
4. Webloader processes URL and ingests content
5. Webloader updates job status via Redis

## Required Environment Variables

- `RAG_SERVER_URL` - URL of the RAG server (default: `http://localhost:9446`)
- `REDIS_URL` - Redis connection URL (default: `redis://localhost:6379`)

## Optional Environment Variables

- `WEBLOADER_MAX_INGESTION_TASKS` - Max concurrent ingestion tasks (default: `5`)
- `LOG_LEVEL` - Logging level (default: `INFO`)

## Scraping Configuration

Scraping behavior is configured per-request via `ScrapySettings`. Key options:

| Setting | Default | Description |
|---------|---------|-------------|
| `crawl_mode` | `single` | `single` (one page), `sitemap` (discover sitemap), `recursive` (follow links) |
| `max_depth` | `2` | Max link depth for recursive crawling (1-10) |
| `max_pages` | `2000` | Maximum pages to crawl |
| `render_javascript` | `false` | Enable Playwright for JavaScript-heavy sites |
| `wait_for_selector` | `null` | CSS selector to wait for (JS rendering only) |
| `page_load_timeout` | `30` | Page load timeout in seconds |
| `follow_external_links` | `false` | Follow links to external domains |
| `allowed_url_patterns` | `null` | Regex whitelist for URLs to include |
| `denied_url_patterns` | `null` | Regex blacklist for URLs to exclude |
| `download_delay` | `0.5` | Delay between requests (seconds) |
| `concurrent_requests` | `10` | Max concurrent requests per crawl |
| `respect_robots_txt` | `true` | Obey robots.txt rules |
| `user_agent` | `null` | Custom user agent string |

## Request-Level Options

In addition to `ScrapySettings`, the URL ingestion request supports:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `reload_interval` | required | Per-datasource auto-reload interval in seconds. Minimum: 60 seconds. |

**Example request with custom reload interval:**
```json
{
  "url": "https://example.com/docs",
  "description": "Example documentation",
  "reload_interval": 3600,
  "settings": {
    "crawl_mode": "sitemap",
    "max_pages": 500
  }
}
```

## Features

### 1. URL Ingestion
- Crawls web pages and extracts text content
- Chunks content for optimal retrieval
- Extracts metadata (title, description, etc.)
- Stores documents with source URL tracking

### 2. Crawl Modes
- **Single URL**: Scrape only the specified URL
- **Sitemap**: Discover and crawl sitemap.xml automatically
- **Recursive**: Follow links from the starting URL up to `max_depth`

### 3. JavaScript Rendering
- Enable `render_javascript: true` for JavaScript-heavy sites (SPAs)
- Uses Playwright for headless browser rendering
- Supports waiting for specific selectors before extraction

### 4. Specialized Parsers
- **Docusaurus**: Optimized for Docusaurus documentation sites
- **MkDocs**: Optimized for MkDocs documentation sites
- **Sphinx**: Supports various Sphinx themes (Alabaster, RTD, Furo, PyData)
- **ReadTheDocs**: Optimized for ReadTheDocs-hosted documentation
- **VitePress**: Optimized for VitePress sites
- **Generic**: Falls back to generic HTML parsing for other sites

### 5. Automatic Reloading
- Each datasource can have its own `reload_interval` (in seconds)
- If not specified, uses the global `WEBLOADER_RELOAD_INTERVAL` (default: 24 hours)
- Minimum reload interval is 60 seconds (enforced automatically)
- Only datasources that are due for reload are refreshed (based on `last_updated` timestamp)
- Manual reloads reset the timer for that datasource
- Can be triggered on-demand via Redis

### 6. Concurrent Processing
- Processes multiple URLs simultaneously
- Rate limiting to prevent overwhelming servers
- Task queue management with configurable limits

### 7. Streaming Ingestion & Job Cancellation

Documents are sent to the RAG server **as they are crawled**, rather than waiting for the entire crawl to complete. This enables:

- **Early data availability**: Documents become searchable while crawling continues
- **Job termination support**: If a job is cancelled mid-crawl, the crawler stops promptly
- **Partial results**: Already-ingested documents are preserved even if the crawl is interrupted

**Architecture:**

```
┌─────────────────┐     CRAWL_DOCUMENTS      ┌──────────────────┐
│   WorkerSpider  │ ──────────────────────▶ │   WorkerPool     │
│   (subprocess)  │                          │   (main process) │
│                 │ ◀────────────────────── │                  │
└─────────────────┘     CANCEL_CRAWL         └──────────────────┘
                                                     │
                                                     │ on_documents()
                                                     ▼
                                             ┌──────────────────┐
                                             │   ScrapyLoader   │
                                             │  → Send to RAG   │
                                             │  → Check status  │
                                             └──────────────────┘
```

**How it works:**
1. WorkerSpider batches documents (default: 50 per batch) and sends `CRAWL_DOCUMENTS` messages
2. WorkerPool receives batches and calls `on_documents` callback in ScrapyLoader
3. ScrapyLoader sends documents to RAG server immediately
4. If server rejects (job terminated), ScrapyLoader sends `CANCEL_CRAWL` to worker
5. Worker stops crawling and sends final result with partial stats

### 8. Redirect Handling

When crawling sites that redirect (e.g., `legacy.example.com` → `docs.example.com`), the crawler automatically updates its domain filtering to follow links on the **destination domain**, not the original URL. This ensures recursive crawling works correctly through redirects.

## Running with Docker Compose

The Webloader should be part of your main deployment and have access to the same Redis instance as the RAG server.

```bash
# The Webloader typically runs automatically with the main stack
docker compose up --build webloader
```

## Deployment Requirements

### Critical: Redis Access
The Webloader **MUST** have access to the same Redis instance as the RAG server. It uses Redis for:
- Receiving URL ingestion requests from the server
- Job status updates and progress tracking
- Coordinating with the RAG server

### Network Configuration
- Must be on the same network as the RAG server
- Must be able to reach Redis
- Needs outbound internet access to crawl URLs

## Commands

The Webloader responds to three types of commands via Redis:

1. **INGEST_URL**: Ingest a specific URL
2. **RELOAD_DATASOURCE**: Reload a specific datasource
3. **RELOAD_ALL**: Reload all datasources for this ingestor

These commands are sent by the RAG server API, not directly by users.

## Monitoring

Check logs for:
- URL ingestion progress
- Error messages for failed crawls
- Redis connection status
- Active task count

Example log output:
```
INFO: Starting Webloader Ingestor...
INFO: Starting Redis listener on redis://localhost:6379 queue: webloader_queue
INFO: Max concurrent ingestion tasks: 5
INFO: Received message from Redis: {...}
INFO: Processing URL ingestion request: https://example.com (active tasks: 1)
INFO: Completed URL ingestion for https://example.com
```

## Notes

- The Webloader is designed to be a singleton - run only one instance per RAG deployment
- URLs are processed asynchronously; use job APIs to track progress
- Failed URLs are logged and can be retried via reload commands
- The ingestor automatically manages task concurrency to prevent resource exhaustion
- Periodic reloads ensure documentation stays current without manual intervention
