---
sidebar_position: 3
---

# Configure LLM Providers in a Docker Compose setup

CAIPE leverages the [`cnoe-io/cnoe-agent-utils`](https://github.com/cnoe-io/cnoe-agent-utils) utility library to configure the `LLMFactory` class, enabling dynamic switching between LLM providers.

> Refer to the [.env.example](https://github.com/caipe-io/ai-platform-engineering/blob/main/.env.example) file for sample environment variable configurations.

## 🧑‍💻 LLM Provider Usage

To test integration with different LLM providers, set the required environment variables as shown for each provider below.

---

### 🤖 Anthropic

```bash
export LLM_PROVIDER=anthropic-claude

export ANTHROPIC_API_KEY=<your_anthropic_api_key>
export ANTHROPIC_MODEL_NAME=<model_name>
```

---

### ☁️ AWS Bedrock (Anthropic Claude)

```bash
export LLM_PROVIDER=aws-bedrock

export AWS_PROFILE=<your_aws_profile>
export AWS_REGION=<your_aws_region>
export AWS_BEDROCK_MODEL_ID="us.anthropic.claude-3-7-sonnet-20250219-v1:0"
export AWS_BEDROCK_PROVIDER="anthropic"
```

---

### ☁️ Azure OpenAI

```bash
export LLM_PROVIDER=azure-openai

export AZURE_OPENAI_API_KEY=<your_azure_openai_api_key>
export AZURE_OPENAI_API_VERSION=<api_version>
export AZURE_OPENAI_DEPLOYMENT=<deployment_name>  # e.g., gpt-4o
export AZURE_OPENAI_ENDPOINT=<your_azure_openai_endpoint>
```

---

### 🤖 OpenAI

```bash
export LLM_PROVIDER=openai

export OPENAI_API_KEY=<your_openai_api_key>
export OPENAI_ENDPOINT=https://api.openai.com/v1
export OPENAI_MODEL_NAME=gpt-4.1
```

---

### 🤖 Google Gemini

```bash
export LLM_PROVIDER=google-gemini

export GOOGLE_API_KEY=<your_google_api_key>
```


---

### ☁️ GCP Vertex AI

```bash
export LLM_PROVIDER=gcp-vertexai

export GOOGLE_APPLICATION_CREDENTIALS=~/.config/gcp.json
export VERTEXAI_MODEL_NAME="gemini-2.0-flash-001"
```

---
