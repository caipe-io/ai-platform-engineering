# Chat activity metrics

Admin Insights counts **recorded human chat prompts**, not profile visits or
conversation metadata edits. The same population drives Active Chat Users,
DAU/MAU, and activity charts.

- **Active Chat Users:** distinct prompt senders in the selected range.
- **DAU / MAU:** distinct senders in up to 24 hours / 30 days ending at the selected
  range end. Shorter selections narrow those windows; the UI says “Up to”.
- **Activity chart:** distinct senders per UTC bucket using message creation
  time. Both partial boundary buckets are included; repeated use of a chat
  remains visible on each day. Sub-day views use hour or five-minute buckets.
- Sender identity comes from `sender_email`; historical rows without it fall
  back to the retained conversation's owner. New web prompts use the authenticated
  sender. Authorized integration writers may supply a delegated sender.
- Scheduler, autonomous, direct API, flagged bot, and recognized service-account
  traffic are excluded. Message origins must be `web`, `slack`, or `webex`;
  parent conversation origin is checked too. API usage retains its separate section.
- Existing conversation visibility, channel, and agent rules apply. User/team
  filters select the prompt sender for activity and the conversation owner for
  conversation/output metrics.

## Coverage

Counts describe recorded messages, not reconstructed history. Missing source or
sender telemetry, deleted parent conversations, and integrations that only record
successful turns limit coverage. Legacy channel IDs are not automatically merged
with email identities. Historical client-provided senders cannot be independently
verified. Login timestamps remain available for separate visitor metrics.

## Regression tests

`admin-stats.test.ts` includes route tests plus opt-in MongoDB integration tests.
Set `ADMIN_STATS_TEST_MONGODB_URI=mongodb://127.0.0.1:<port>` to a disposable local
MongoDB and run the suite. It creates and drops a uniquely named test database;
remote endpoints and database names in the URI are rejected.
