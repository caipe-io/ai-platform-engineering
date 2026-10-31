# Notification framework

Small implementation units extend the existing inbox.

## Event and preference contracts

- A typed platform event catalog defines categories, severity and defaults.
- Resolution uses event override, category override, then catalog default.
- A `null` patch removes an override; unknown keys and non-boolean values are rejected.
- This unit starts no workers, publishes no events, and changes no delivery behavior.
