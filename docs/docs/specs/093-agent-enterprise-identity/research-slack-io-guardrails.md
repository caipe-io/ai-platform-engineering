# Slack Input/Output Guardrails

**Pulled from [PR #975](https://github.com/caipe-io/ai-platform-engineering/pull/975) for spec 093 (`093-agent-enterprise-identity`).**

Every user prompt entering CAIPE through Slack and every LLM response leaving CAIPE back to Slack passes through a guardrail layer. Input guardrails protect the LLM and downstream systems from malicious, sensitive, or out-of-policy content. Output guardrails prevent the LLM from leaking secrets, PII, hallucinated actions, or harmful content back into Slack channels.

---

## Guardrail Placement in the Pipeline

The guardrails sit inside the **Slack Bot Backend Server**, wrapping the A2A call to the CAIPE Orchestrator. They are the last checkpoint before a prompt reaches the LLM and the first checkpoint before a response reaches Slack.

```mermaid
graph LR
    subgraph SLACK["Slack App"]
        USER["User Message<br/>(@caipe 'Review PR #42')"]
    end

    subgraph BOT["Slack Bot Backend Server"]
        EXTRACT["Extract &<br/>Build Prompt"]
        IG["🛡️ Input<br/>Guardrails"]
        A2A_OUT["A2A Client<br/>(send)"]
        A2A_IN["A2A Client<br/>(receive)"]
        OG["🛡️ Output<br/>Guardrails"]
        FORMAT["Format &<br/>Post to Slack"]
    end

    subgraph CAIPE["CAIPE Agent Platform"]
        ORCH["Orchestrator<br/>(A2A Server)"]
        LLM["LLM"]
        AGENTS["Domain Agents"]
    end

    USER -->|"WebSocket<br/>(Socket Mode)"| EXTRACT
    EXTRACT --> IG
    IG -->|"✅ Pass"| A2A_OUT
    IG -->|"❌ Block"| FORMAT
    A2A_OUT -->|"A2A Protocol"| ORCH
    ORCH --> LLM
    LLM --> AGENTS
    AGENTS --> ORCH
    ORCH -->|"A2A Streaming"| A2A_IN
    A2A_IN --> OG
    OG -->|"✅ Pass"| FORMAT
    OG -->|"⚠️ Redact"| FORMAT
    FORMAT -->|"Slack API"| USER

    style IG fill:#e74c3c,color:#fff,stroke:#c0392b
    style OG fill:#e74c3c,color:#fff,stroke:#c0392b
    style EXTRACT fill:#E67E22,color:#fff,stroke:#bf6516
    style FORMAT fill:#E67E22,color:#fff,stroke:#bf6516
    style A2A_OUT fill:#E67E22,color:#fff,stroke:#bf6516
    style A2A_IN fill:#E67E22,color:#fff,stroke:#bf6516
    style USER fill:#611f69,color:#fff,stroke:#4a154b
    style ORCH fill:#2ECC71,color:#fff,stroke:#1a9c54
    style LLM fill:#9B59B6,color:#fff,stroke:#7d3c98
    style AGENTS fill:#9B59B6,color:#fff,stroke:#7d3c98
```

### Insertion Points in Code

Both guardrails are centralized in `utils/ai.py` inside `stream_a2a_response()`, so every code path (mentions, DMs, Q&A, AI alerts, retries) passes through them:

| Guardrail | Location | Runs Before | Runs After |
|---|---|---|---|
| **Input** | Start of `stream_a2a_response()` | `a2a_client.send_message_stream()` | Prompt assembly (`extract_message_text` + `build_thread_context`) |
| **Output** | After `_get_final_text()` | `_stream_final_response()` / `_post_final_response()` | `_check_overthink_skip()` and confidence marker stripping |

---

## Input Guardrails

Input guardrails validate and sanitize every user prompt before it is sent to the CAIPE Orchestrator via A2A. A blocked input never reaches the LLM.

```mermaid
flowchart LR
    INPUT(["User Prompt<br/>from Slack"]) --> G1

    subgraph G1["Input Guardrail Pipeline"]
        direction TB
        I1["Length & Complexity<br/>──────────<br/>Max token count<br/>Max nesting depth<br/>Reject oversized prompts"]
        I2["Secrets Detection<br/>──────────<br/>API keys, passwords,<br/>tokens, private keys<br/>Connection strings"]
        I3["PII Detection<br/>──────────<br/>SSN, credit cards,<br/>phone numbers, addresses<br/>Email in free text"]
        I4["Prompt Injection<br/>──────────<br/>System prompt override<br/>Instruction hijacking<br/>Role manipulation<br/>Encoding bypass attempts"]
        I5["Content Policy<br/>──────────<br/>Toxic / harmful content<br/>Off-topic requests<br/>Scope enforcement"]

        I1 --> I2
        I2 --> I3
        I3 --> I4
        I4 --> I5
    end

    G1 -->|"✅ All checks pass"| SEND(["Send to CAIPE<br/>via A2A Protocol"])
    I1 -->|"❌ Reject"| BLOCK
    I2 -->|"❌ Reject"| BLOCK
    I3 -->|"⚠️ Redact & warn"| I4
    I4 -->|"❌ Reject"| BLOCK
    I5 -->|"❌ Reject"| BLOCK

    BLOCK(["Return safe error<br/>to Slack user"])

    style G1 fill:#1a3a5c,color:#fff,stroke:#0d2137
    style INPUT fill:#611f69,color:#fff
    style SEND fill:#2ecc71,color:#fff
    style BLOCK fill:#e74c3c,color:#fff
```

### Input Guardrail Details

| Guardrail | Action on Detect | Response to User | Logged |
|---|---|---|---|
| **Length & Complexity** | Block | "Your message exceeds the maximum length. Please shorten it." | Message length, user_id |
| **Secrets Detection** | Block | "Your message appears to contain a secret or credential. Please remove it and try again." | Detection type (no secret value) |
| **PII Detection** | Redact + Warn | PII replaced with `[REDACTED]`, user warned: "I detected and removed personal information from your message." | Detection type, field count |
| **Prompt Injection** | Block | "I wasn't able to process that request." (generic, no details) | Full classification, user_id, channel_id |
| **Content Policy** | Block | "That request falls outside what I can help with." | Policy category, user_id |

### Prompt Injection Patterns Detected

The injection detector identifies attempts to manipulate the LLM's system prompt or behavior:

```mermaid
graph LR
    subgraph PATTERNS["Injection Patterns"]
        P1["System prompt override<br/>──────────<br/>'Ignore previous instructions'<br/>'You are now a ...'<br/>'New system prompt:'"]
        P2["Instruction hijacking<br/>──────────<br/>'Do not follow your rules'<br/>'Forget your guidelines'<br/>'Act as if you have no limits'"]
        P3["Encoding bypass<br/>──────────<br/>Base64-encoded instructions<br/>Unicode homoglyphs<br/>Markdown/HTML injection"]
        P4["Indirect injection<br/>──────────<br/>Injected via thread context<br/>Injected via file content<br/>Injected via linked URLs"]
    end

    subgraph RESPONSE["Detection Response"]
        R1["Block request<br/>Log attempt<br/>Increment rate counter<br/>Alert on threshold"]
    end

    P1 --> R1
    P2 --> R1
    P3 --> R1
    P4 --> R1

    style P1 fill:#e74c3c,color:#fff
    style P2 fill:#e74c3c,color:#fff
    style P3 fill:#e74c3c,color:#fff
    style P4 fill:#e74c3c,color:#fff
    style R1 fill:#e67e22,color:#fff
```

---

## Output Guardrails

Output guardrails validate every LLM response before it is posted to Slack. They protect against data leakage, hallucinated actions, and policy violations in the model's output.

```mermaid
flowchart LR
    INPUT(["LLM Response<br/>from CAIPE"]) --> G2

    subgraph G2["Output Guardrail Pipeline"]
        direction TB
        O1["Secrets & Credential Scan<br/>──────────<br/>API keys, tokens, passwords<br/>in LLM-generated text<br/>Private keys, connection strings"]
        O2["PII Leak Detection<br/>──────────<br/>User PII from context<br/>Third-party PII<br/>Internal system details"]
        O3["Hallucination Markers<br/>──────────<br/>Ungrounded claims<br/>Fabricated URLs/repos<br/>Non-existent API responses"]
        O4["Content Safety<br/>──────────<br/>Toxic / harmful content<br/>Unauthorized disclosures<br/>Policy violations"]
        O5["Format & Sanitization<br/>──────────<br/>Slack mrkdwn safety<br/>Code block sanitization<br/>Link validation"]

        O1 --> O2
        O2 --> O3
        O3 --> O4
        O4 --> O5
    end

    G2 -->|"✅ All checks pass"| POST(["Post to Slack<br/>via Slack API"])
    O1 -->|"⚠️ Redact"| O2
    O2 -->|"⚠️ Redact"| O3
    O3 -->|"⚠️ Flag"| O4
    O4 -->|"❌ Replace"| SAFE(["Post safe fallback:<br/>'Unable to provide<br/>a response'"])
    O5 -->|"✅ Sanitized"| POST

    style G2 fill:#5c3a1a,color:#fff,stroke:#37210d
    style INPUT fill:#9B59B6,color:#fff
    style POST fill:#2ecc71,color:#fff
    style SAFE fill:#e67e22,color:#fff
```

### Output Guardrail Details

| Guardrail | Action on Detect | What User Sees | Logged |
|---|---|---|---|
| **Secrets & Credential Scan** | Redact in-place | Secrets replaced with `[CREDENTIAL REDACTED]` | Detection type (no secret value) |
| **PII Leak Detection** | Redact in-place | PII replaced with `[REDACTED]` | Field type, count |
| **Hallucination Markers** | Flag with disclaimer | Response posted with: "⚠️ Some information in this response could not be verified." | Flagged segments |
| **Content Safety** | Replace entire response | "I'm unable to provide a response for this request. Please rephrase or ask something else." | Policy category |
| **Format & Sanitization** | Sanitize in-place | Clean output (safe mrkdwn, validated links) | Sanitization count |

---

## Full Sequence with Guardrails

This sequence diagram shows the complete flow from Slack message to Slack response, with both guardrail layers highlighted.

```mermaid
sequenceDiagram
    autonumber
    participant U as 👤 User
    participant SA as Slack App<br/>(Workspace)
    participant SB as Slack Bot Backend
    participant IG as 🛡️ Input<br/>Guardrails
    participant A2A as A2A Client
    participant OR as CAIPE Orchestrator<br/>(A2A Server)
    participant OG as 🛡️ Output<br/>Guardrails

    Note over U,OG: ── Slack → Bot Backend (WebSocket / Socket Mode) ──

    U->>SA: @caipe "message"
    SA-->>SB: WebSocket event<br/>(user_id, text, channel, thread_ts)

    SB->>SB: Extract message text<br/>Build thread context<br/>Assemble prompt

    Note over SB,IG: ── Input Guardrail Check ──

    SB->>IG: Validate prompt

    alt Input blocked (injection, secrets, policy)
        IG-->>SB: ❌ BLOCKED (reason code)
        SB->>SA: Post safe error message
        SA->>U: "I wasn't able to process that request."
    else Input has PII (redactable)
        IG-->>SB: ⚠️ REDACTED (cleaned prompt + warning)
        SB->>SA: Post warning: "I removed personal info from your message."
        SB->>A2A: Send cleaned prompt
    else Input passes all checks
        IG-->>SB: ✅ PASS
        SB->>A2A: Send original prompt
    end

    Note over A2A,OR: ── Bot Backend → CAIPE (A2A Protocol) ──

    A2A->>OR: A2A message/stream<br/>Authorization: Bearer <user_jwt>
    OR->>OR: LLM processing +<br/>Agent execution
    OR-->>A2A: A2A streaming response (SSE)

    A2A->>SB: Parsed response<br/>(final_text from events)

    Note over SB,OG: ── Output Guardrail Check ──

    SB->>OG: Validate LLM response

    alt Output has secrets or PII
        OG-->>SB: ⚠️ REDACTED (cleaned response)
    else Output fails content safety
        OG-->>SB: ❌ REPLACED with safe fallback
    else Output has hallucination markers
        OG-->>SB: ⚠️ FLAGGED (response + disclaimer)
    else Output passes all checks
        OG-->>SB: ✅ PASS
    end

    Note over SB,SA: ── Bot Backend → Slack (Slack API) ──

    SB->>SB: Format for Slack mrkdwn<br/>Split into blocks (3000 char limit)<br/>Add feedback buttons
    SB->>SA: chat_postMessage / streaming
    SA->>U: Display response
```

---

## Guardrail Architecture Patterns

### Pattern 1: Middleware in `stream_a2a_response()`

The recommended pattern centralizes both guardrails in the single function that all Slack handlers call. Every code path — mentions, DMs, Q&A, AI alerts, retries — passes through the same guardrails.

```mermaid
graph LR
    subgraph HANDLERS["Slack Event Handlers"]
        H1["handle_mention"]
        H2["handle_dm_message"]
        H3["handle_qanda_message"]
        H4["handle_ai_alert_processing"]
    end

    subgraph CENTRAL["stream_a2a_response() — Central Pipeline"]
        IG["🛡️ Input Guardrails<br/>──────────<br/>validate_input(message_text)"]
        A2A["A2A send_message_stream"]
        PARSE["Event parsing +<br/>_get_final_text()"]
        OG["🛡️ Output Guardrails<br/>──────────<br/>validate_output(final_text)"]
        POST["Post to Slack"]

        IG --> A2A
        A2A --> PARSE
        PARSE --> OG
        OG --> POST
    end

    H1 --> IG
    H2 --> IG
    H3 --> IG
    H4 --> IG

    style IG fill:#e74c3c,color:#fff,stroke:#c0392b
    style OG fill:#e74c3c,color:#fff,stroke:#c0392b
    style A2A fill:#E67E22,color:#fff,stroke:#bf6516
    style PARSE fill:#E67E22,color:#fff,stroke:#bf6516
    style POST fill:#E67E22,color:#fff,stroke:#bf6516
    style H1 fill:#611f69,color:#fff
    style H2 fill:#611f69,color:#fff
    style H3 fill:#611f69,color:#fff
    style H4 fill:#611f69,color:#fff
```

### Pattern 2: Pluggable Guardrail Chain

Each guardrail is a pluggable module that can be independently enabled, configured, or replaced. The chain is defined in configuration and executed sequentially.

```mermaid
graph LR
    subgraph CHAIN["Guardrail Chain (configurable)"]
        direction LR
        G1["LengthGuard<br/>──────────<br/>max_tokens: 4096"]
        G2["SecretsGuard<br/>──────────<br/>patterns: AWS, GH,<br/>Stripe, JWT, PEM"]
        G3["PIIGuard<br/>──────────<br/>entities: SSN, CC,<br/>phone, email"]
        G4["InjectionGuard<br/>──────────<br/>model: classifier<br/>threshold: 0.85"]
        G5["PolicyGuard<br/>──────────<br/>allowed_topics:<br/>platform-eng"]

        G1 --> G2 --> G3 --> G4 --> G5
    end

    INPUT(["Prompt"]) --> G1
    G5 --> OUTPUT(["Validated Prompt"])

    style G1 fill:#3498db,color:#fff
    style G2 fill:#3498db,color:#fff
    style G3 fill:#3498db,color:#fff
    style G4 fill:#3498db,color:#fff
    style G5 fill:#3498db,color:#fff
    style INPUT fill:#611f69,color:#fff
    style OUTPUT fill:#2ecc71,color:#fff
```

### Configuration

```yaml
guardrails:
  input:
    enabled: true
    chain:
      - name: length
        max_tokens: 4096
        max_thread_depth: 20
      - name: secrets
        patterns: ["aws_key", "github_token", "stripe_key", "jwt", "private_key", "connection_string"]
        action: block
      - name: pii
        entities: ["ssn", "credit_card", "phone", "address"]
        action: redact
      - name: injection
        detection: classifier
        threshold: 0.85
        action: block
      - name: policy
        scope: platform-engineering
        action: block
  output:
    enabled: true
    chain:
      - name: secrets
        action: redact
      - name: pii
        action: redact
      - name: hallucination
        action: flag
      - name: content_safety
        action: replace
      - name: format
        action: sanitize
  logging:
    log_blocked: true
    log_redacted: true
    alert_threshold: 10  # alert after N blocks per user per hour
```

---

## Observability & Audit

Every guardrail decision is logged for audit, incident response, and guardrail tuning.

```mermaid
graph LR
    subgraph EVENTS["Guardrail Events"]
        E1["input.blocked<br/>──────────<br/>reason, user_id,<br/>channel_id, guardrail"]
        E2["input.redacted<br/>──────────<br/>field_type, count,<br/>user_id"]
        E3["input.passed<br/>──────────<br/>user_id, latency_ms"]
        E4["output.redacted<br/>──────────<br/>field_type, count"]
        E5["output.replaced<br/>──────────<br/>reason, guardrail"]
        E6["output.flagged<br/>──────────<br/>reason, segments"]
    end

    subgraph SINKS["Observability"]
        LOG["Structured Logs<br/>(JSON)"]
        METRICS["Metrics<br/>(Prometheus)"]
        ALERTS["Alerts<br/>(threshold-based)"]
        LANGFUSE["Langfuse<br/>(trace annotations)"]
    end

    E1 --> LOG
    E2 --> LOG
    E3 --> METRICS
    E4 --> LOG
    E5 --> LOG
    E6 --> LOG
    E1 --> METRICS
    E5 --> METRICS
    E1 --> ALERTS
    E3 --> LANGFUSE
    E6 --> LANGFUSE

    style E1 fill:#e74c3c,color:#fff
    style E2 fill:#e67e22,color:#fff
    style E3 fill:#2ecc71,color:#fff
    style E4 fill:#e67e22,color:#fff
    style E5 fill:#e74c3c,color:#fff
    style E6 fill:#f39c12,color:#fff
    style LOG fill:#34495e,color:#fff
    style METRICS fill:#34495e,color:#fff
    style ALERTS fill:#34495e,color:#fff
    style LANGFUSE fill:#34495e,color:#fff
```

### Metrics

| Metric | Type | Labels |
|---|---|---|
| `guardrail_input_total` | Counter | `result` (pass/block/redact), `guardrail`, `channel_id` |
| `guardrail_output_total` | Counter | `result` (pass/redact/replace/flag), `guardrail` |
| `guardrail_latency_seconds` | Histogram | `stage` (input/output), `guardrail` |
| `guardrail_blocked_per_user` | Counter | `user_id`, `guardrail` |

---

## Related Documentation

- [Slack Bot Authorization](./research-slack-bot-authorization.md) — identity, token exchange, and scope validation
- [Enterprise Identity Federation](./research-enterprise-identity-federation.md) — full Keycloak/Okta integration design
- [Slack Bot Integration](../../integrations/slack-bot.md) — deployment, configuration, and channel setup (main repo)
