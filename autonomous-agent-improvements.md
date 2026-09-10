Improve autonomous agent feature and address security concerns:

1. Webhook safety:

- Implement a per-task FIFO queue system so multiple deliveries for the same webhook task are never executed concurrently. Different webhook tasks may still execute concurrently.
- Reject webhook payloads larger than 1 MiB with HTTP `413`.
- Apply bounded per-task, per-owner, and global queue limits. Return HTTP `429` when queue capacity is exceeded to protect the service when it is bombarded with requests.
- These application-level controls complement ingress and WAF protection rather than replacing them.

2. Webhook secret:

- Store each webhook secret using envelope encryption, consistent with the existing credential-storage solution in the repository. The secret is encrypted with AES-256-GCM using a unique data-encryption key, and that key is wrapped using AWS KMS. Only the encrypted envelope is stored in MongoDB.
- If KMS is not configured or cannot be accessed, webhook task creation or secret updates fail. The secret is never stored as plaintext.
- For GitHub and Jira webhooks, CAIPE generates a secure secret when the webhook task is created, stores it securely, and shows it to the user once.
- For PagerDuty and Slack, the provider generates the signing secret and the user is required to paste it into CAIPE.
- Only GitHub, Jira, Slack, and PagerDuty are available when creating a webhook task in the UI. Generic HMAC is no longer user-selectable.

3. Webhook visibility:

- Webhook runs are not published as regular chat conversations because this could become very spammy.
- Instead, they appear under a collapsed `Webhook Runs` subsection inside `Autonomous Runs` in Chat History.
- Runs are grouped by webhook task, but every webhook delivery has its own isolated execution context.
- Users can select `Continue this run` to continue only the selected webhook run's context.

4. Cron / Interval tasks:

- Add a minimum interval of 30 minutes by default for cron and interval tasks. This is configurable during deployment using `MINIMUM_SCHEDULE_INTERVAL_SECONDS`.

5. Add new subsections in Chat History for `Autonomous Runs` and `Scheduled Runs` to provide a cleaner view. Both sections are collapsed by default.

6. Move the admin page to `Admin` > `Security & Policy` > `Autonomous Enablement`.

7. Remove unnecessary autonomous administration views:

- Remove the per-agent autonomous configuration view.
- Remove Task Oversight and its supporting API.
- Centralize autonomous team access management under `Autonomous Enablement`.

Current limitation:

- Autonomous Agents currently supports only one service replica. Webhook queues and per-task serialization state are stored in the pod's memory.
- Running multiple replicas would create independent queues, meaning the same webhook task could execute concurrently across different pods. Before replica support is implemented, webhook dispatch must be moved to shared infrastructure that provides durable queues and per-task serialization.
