---
title: Model provider connections
description: Save and test a model provider connection, then share model access with your team.
---

# Model provider connections

In CAIPE 1.4.0, administrators can save named provider connections, register model IDs, and test access with the same provider configuration used by agent chat.

## Connect and test a provider

1. Open **Model Providers** from the model configuration workspace or **Configure provider access** in the [Setup Wizard](../getting-started/first-agent.md).
2. Choose a provider and enter its connection parameters. Select a permitted saved secret, enter a new value to store encrypted, or use deployment credentials where the provider supports them.
3. Enter one or more provider model IDs. Use **Test Connection** to run a short completion before saving. You can also test a saved connection or a specific model.
4. Select **Save Connection**, then choose the registered model in [Agent Builder](./agent-builder.md). Verify the agent with a real chat and any tools you intend to use.

## Manage access

- Registering a new endpoint and key pairing requires platform configuration access and permission to manage the selected secrets.
- Team members need **read** access to the model and **use** access to each saved credential it references. A provider connection stores references to secrets.
- Rotate or revoke saved credentials in **Credentials → Saved Secrets**. Revoked access blocks future calls. If a provider key itself must be revoked, revoke it at the provider.
- For deployment-managed models, retain their configured environment credentials. See [provider authentication options](../getting-started/first-agent.md#provider-credentials) for the supported connection fields.

## Solution architecture

![The Models workspace saves model and connection records through the CAIPE backend. The backend and agent runtime resolve authorized credentials before making provider requests.](/diagrams/model-providers.svg)

[Download editable Excalidraw](/diagrams/model-providers.excalidraw)
