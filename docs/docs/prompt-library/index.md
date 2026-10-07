---
sidebar_position: 1
---

# CAIPE Prompt Library

A **prompt library** is a curated collection of carefully designed prompts intended for use in multi-agent systems. These prompts guide AI agents—such as "Platform Engineer" or "Incident Engineer" personas—by providing standardized questions and instructions that facilitate effective collaboration, incident response, platform operations, and knowledge sharing.

* Prompts are **meta-level**: They focus on coordination, decision-making, troubleshooting, and collaboration between agents.
* Prompts are **tested and validated**: Ensuring they are effective for real-world use in roles like incident management and platform engineering.
* A prompt library makes it easy for teams to **reuse**, **share**, and **maintain** high-quality instructions, leading to more reliable and efficient AI-driven workflows.

## Available Prompts

CAIPE (Community AI Platform Engineering) provides two main prompt configurations:

### 1. Basic CAIPE Prompt

**Configuration File**: `charts/ai-platform-engineering/data/prompt_config.yaml`

**Purpose**: Simple agent routing and coordination for straightforward multi-agent operations.

**Key Features**:
- **Smart Routing & Coordination**: Routes user requests to appropriate specialized agents (ArgoCD, AWS, Jira, GitHub, PagerDuty, Slack, Splunk, etc.)
- **Task Management**: Two-phase approach for complex requests:
  - Phase 1: Planning - Creates a task plan before execution
  - Phase 2: Execution - Calls agents and tracks progress with checkmarks
- **Response Efficiency**:
  - Preserves agent messages verbatim
  - Minimal wrapper around agent responses
  - Direct presentation of results
- **Simple Coordination**: Focuses on routing and presenting results without complex orchestration

**Use Cases**:
- Simple queries requiring single agent routing
- Multi-step tasks that need basic coordination
- Scenarios where straightforward agent delegation is sufficient

**Example Behavior**:
```
User: "Get the status of ArgoCD applications"
→ Routes directly to ArgoCD agent
→ Presents results cleanly

User: "Check cluster health and list open Jira tickets"
→ Creates task plan
→ Calls AWS and Jira agents
→ Presents combined results
```

### 2. CAIPE Deep Agent Prompt

**Configuration File**: `charts/ai-platform-engineering/data/prompt_config.deep_agent.yaml`

**Purpose**: Advanced orchestration with comprehensive workflow management, parallel execution, and specialized incident engineering capabilities.

**Key Features**:

#### Core Orchestration Features
- **TODO-Based Execution**: Mandatory execution plan creation using `write_todos` tool for all operational requests
- **Parallel Execution**: Maximizes parallelism by executing independent agents simultaneously
- **Agent Workspace**: In-memory coordination system to prevent garbled output when multiple agents run in parallel
- **User Email Context**: Smart handling of user email for first-person queries vs. third-person queries
- **Zero Hallucination**: Never answers from knowledge base - always calls sub-agents first

#### Advanced Workflow Management
- **Execution Modes**: Declares PARALLEL, SEQUENTIAL, or HYBRID execution modes
- **Date Handling**: Automatic date/time injection for relative date queries
- **Markdown Formatting**: Built-in `format_markdown` tool for response validation
- **Error Recovery**: Automatic retry logic when agents return errors with available options

#### User Input Handling
- **UserInputMetaData Format**: Structured JSON format for requesting user input
- **Sub-Agent Integration**: Automatically formats sub-agent input requests into structured forms
- **Field Types**: Supports text, textarea, number, select, and boolean input types

#### Incident Engineering Specialization
Built-in support for four specialized incident management agents:

1. **Incident Investigator**: Deep root cause analysis combining PagerDuty, Jira, Kubernetes/Komodor, RAG, and Confluence data
2. **Incident Documenter**: Creates comprehensive post-incident reports and follow-up actions
3. **MTTR Analyst**: Analyzes Mean Time To Recovery metrics and generates improvement reports
4. **Uptime Analyst**: Analyzes service availability metrics and SLO compliance

#### Data Flow Management
- **Explicit Data Extraction**: Extracts and passes actual values between agents (not references)
- **Source Attribution**: Preserves detailed information from sub-agents with provenance footers
- **Multi-Agent Correlation**: Identifies relationships between data from different agents

#### Special Workflows
- **OnCall Schedule & Task Analysis**: Sequential workflow for PagerDuty → Jira correlation
- **Pod Investigation & Failure Analysis**: Multi-agent workflow for Komodor → ArgoCD → AWS analysis
- **GitHub CI/CD Failure Analysis**: Detailed CI check analysis with actionable recommendations
- **Jira Query & Data Formatting**: Standardized table formatting with links and metadata

**Use Cases**:
- Complex multi-agent workflows requiring parallel execution
- Incident management and root cause analysis
- Large-scale platform health reports
- Operations requiring structured user input
- Scenarios needing detailed execution planning and tracking

**Example Behavior**:
```
User: "Show me GitHub PRs and Jira tickets"
→ Creates TODO plan with PARALLEL mode
→ Calls GitHub AND Jira agents SIMULTANEOUSLY
→ Uses workspace to store results separately
→ Combines into unified table with attribution

User: "Investigate the API outage root cause"
→ Creates TODO plan
→ Routes to Incident Investigator specialist
→ Coordinates PagerDuty, Jira, Kubernetes, RAG agents
→ Synthesizes root cause analysis with evidence links
```

## Configuration

Both prompt configurations are located in:
- **Basic**: `charts/ai-platform-engineering/data/prompt_config.yaml`
- **Deep Agent**: `charts/ai-platform-engineering/data/prompt_config.deep_agent.yaml`

These YAML files contain:
- System prompt templates
- Agent-specific prompts (ArgoCD, AWS, Jira, GitHub, etc.)
- Agent skill examples
- Specialized workflow instructions

## Choosing the Right Prompt

**Use Basic CAIPE Prompt when**:
- You need simple agent routing
- Tasks are straightforward and don't require complex orchestration
- You want minimal overhead and faster responses
- Single-agent or simple multi-agent queries

**Use CAIPE Deep Agent Prompt when**:
- You need advanced workflow management
- Tasks require parallel execution of multiple agents
- You need incident engineering capabilities
- Complex multi-step operations with dependencies
- Operations requiring structured user input
- Large-scale platform health reports

## Integration

Both prompts integrate with the CAIPE multi-agent system and work with:
- **Specialized Agents**: ArgoCD, AWS, Jira, GitHub, PagerDuty, Slack, Splunk, Komodor, Confluence, Webex, Weather, Backstage
- **RAG Knowledge Base**: Documentation and process recall
- **Agent Workspace**: In-memory coordination for parallel execution (Deep Agent only)

The prompts are used by the Platform Engineer orchestrator to route queries and coordinate agent execution based on the selected configuration.
