# Feature Specification: App-Declared Message Actions in the Host Assistant

**Feature Branch**: `2026-11-15-host-message-actions`
**Created**: 2026-11-15
**Status**: Draft
**Input**: User description: "read document `host-message-actions-feature.md`"

## Problem

- Installed apps can use the host-owned assistant popup for streaming, history and activity.
- An app cannot add its own control to a finished answer in that popup.
- Apps that need a per-answer action must replace the popup with their own, and lose those host benefits.
- Example need: an evaluation-review app wants reviewers to flag an answer, optionally with a corrected answer, so it can be queued for evaluation.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Act on a finished answer with one click (Priority: P1)

A user sees a finished assistant answer from an app's agent and clicks an app-provided action on it. The app receives the answer reference and records the result. The user sees a success confirmation.

**Why this priority**: This is the core value. It lets apps act on answers without giving up the host assistant.

**Independent Test**: Install an app that declares one action with no dialog. Finish an answer. Click the action. Confirm the app received the call and the user saw a success message.

**Acceptance Scenarios**:

1. **Given** an enabled no-dialog action and a finished assistant answer from the app's agent, **When** the user clicks the action, **Then** the control shows a pending state, the app is called, and a success confirmation appears.
2. **Given** the app returns an error, **When** the user clicks the action, **Then** the app's error text is shown and the control becomes usable again.
3. **Given** an answer is still streaming, **When** the user views it, **Then** no app action is shown on it.
4. **Given** a user message, **When** the user views it, **Then** no app action is shown.

---

### User Story 2 - Review and edit text before submitting (Priority: P1)

A user clicks an action that declares a dialog. A dialog opens with a text field, optionally prefilled with the answer text. The user edits the text and submits. The app receives the edited text.

**Why this priority**: The motivating use case needs a corrected answer from the user. It is the second half of the minimum useful feature.

**Independent Test**: Declare an action with a dialog whose field prefills from the answer. Open it, edit the text, submit. Confirm the app received the edited text.

**Acceptance Scenarios**:

1. **Given** an action whose field prefills from the message, **When** the dialog opens, **Then** the field contains the answer text and is editable.
2. **Given** an action whose field starts empty, **When** the dialog opens, **Then** the field is empty.
3. **Given** a required field, **When** the user submits it empty, **Then** submission is blocked with a clear message.
4. **Given** text longer than the declared limit, **When** the user tries to submit, **Then** submission is blocked and the user is told the limit.
5. **Given** the dialog is open, **When** the user uses only the keyboard or a screen reader, **Then** they can complete or cancel it.

---

### User Story 3 - App decides who sees each action (Priority: P2)

An app shows an action only to the users it applies to, such as reviewers. Other users never see it.

**Why this priority**: Without per-user visibility, every user of the app's agent would see every action. This is needed for a safe rollout but not for the basic flow.

**Independent Test**: Sign in as two users. The app enables the action for one only. Confirm only that user sees it.

**Acceptance Scenarios**:

1. **Given** an app has declared an action but not enabled it for the current user, **When** the user views a finished answer, **Then** the action is hidden.
2. **Given** the app enables the action for the current user, **When** the user views a finished answer, **Then** the action is shown.
3. **Given** the user signs out or switches account, **When** the new session starts, **Then** earlier enablement does not carry over.
4. **Given** the app enables an action id it never declared, **When** the host processes it, **Then** the id is ignored.
5. **Given** a user is hidden from an action, **When** they call its endpoint directly, **Then** the app, not the host, is responsible for refusing them.

---

### User Story 4 - App developer declares actions and detects support (Priority: P2)

An app developer declares up to four actions in the app manifest. Before declaring, they can detect whether the host supports the feature. Apps built on native packages and apps embedded as iframes can both use it.

**Why this priority**: It is how apps adopt the feature. The end-user stories depend on it, but it can be proven with one test app first.

**Independent Test**: Declare a valid action and confirm the host accepts it. Declare an invalid one and confirm the host rejects it with a clear reason.

**Acceptance Scenarios**:

1. **Given** a valid declaration, **When** the app is installed, **Then** the host accepts it.
2. **Given** a declaration with an unknown field, duplicate ids, more than four actions, a bad path, or an oversize label or limit, **When** the app is installed, **Then** the host rejects it with a reason.
3. **Given** a host that supports the feature, **When** a native or iframe app checks for support, **Then** it learns that message actions are available.
4. **Given** an older host that lacks the feature, **When** an app declares message actions, **Then** the host rejects the manifest. The documentation tells developers to require a host release that includes the feature.

---

### User Story 5 - Host protects the app and the user (Priority: P1)

The host only lets the right user trigger an action on the right answer. It forwards only what the app declared.

**Why this priority**: The feature sends user-supplied text to external app endpoints on the user's behalf. Safety is part of the minimum bar.

**Independent Test**: Send requests as an unauthenticated caller, a service account, a non-owner, and with a wrong or forged target. Confirm each is refused and no app call is made.

**Acceptance Scenarios**:

1. **Given** an unauthenticated caller, **When** they trigger an action, **Then** the request is refused.
2. **Given** a service account, **When** it triggers an action, **Then** the request is refused.
3. **Given** a user without write access to the conversation or without use of the agent, **When** they trigger an action, **Then** the request is refused.
4. **Given** a request names an action the app did not declare, **When** it is processed, **Then** it is refused.
5. **Given** a request supplies its own destination, **When** it is processed, **Then** the destination is ignored and the declared one is used.
6. **Given** the target message is not a finished assistant message in that conversation, or the agent does not belong to the app, **When** the request is processed, **Then** it is refused.
7. **Given** a successful or failed action, **When** it completes, **Then** an audit record exists with the app and action but not the user's text.

---

### Edge Cases

- App endpoint is slow or unreachable: the user sees an error within the time limit and can retry.
- App endpoint redirects or returns a non-JSON response: the host treats it as a failure and does not follow the redirect.
- The user double-clicks or resubmits while a call is pending: only one call is made.
- Answer text exceeds the field limit: the prefill is kept whole, submission is blocked, and the user is told to shorten it.
- A conversation is viewed in a chat client other than the web UI: no actions are shown.
- The app never sends a visibility configuration: all of its actions stay hidden.
- The same answer is acted on more than once: the host allows it. The app decides whether repeats are idempotent.

## Requirements *(mandatory)*

### Functional Requirements

**Declaration**
- **FR-001**: An app MUST be able to declare zero to four message actions in its manifest. Each has an id, label, icon, endpoint, and optionally a dialog.
- **FR-002**: Labels MUST be 24 characters or fewer. Icons MUST come from a host-defined list.
- **FR-003**: A dialog MUST be able to set a title, description, submit label, and one text field. The field sets its label, whether it prefills from the answer or starts empty, whether it is optional, and a maximum length of 60,000 characters or fewer.
- **FR-004**: The host MUST reject manifests with unknown keys, duplicate action ids, invalid ids, more than four actions, invalid endpoint paths, or values over a limit.
- **FR-005**: Declarations MUST be data only. The host MUST NOT load app code to render an action.

**Capability and enablement**
- **FR-006**: The host MUST advertise message-action support so native and iframe apps can detect it.
- **FR-007**: Actions MUST be hidden until the app enables them for the current user.
- **FR-008**: Enablement MUST reset when the app view unmounts or the account changes.
- **FR-009**: The host MUST ignore enablement for undeclared action ids.
- **FR-010**: Visibility MUST be treated as cosmetic only. It MUST NOT grant access.

**Display and interaction**
- **FR-011**: The host MUST show enabled actions only on finished assistant messages in conversations whose agent belongs to the declaring app.
- **FR-012**: The host MUST NOT show actions on streaming messages, user messages, other apps' agents, or non-web chat clients.
- **FR-013**: An action with a dialog MUST open an editable dialog. An action without one MUST call the app immediately.
- **FR-014**: The host MUST show pending, success and error states. The error state MUST show the app's error text when one is given.
- **FR-015**: While a call is pending, the host MUST prevent duplicate submissions.
- **FR-016**: Actions and dialogs MUST work with keyboard and screen reader.

**Server-side handling**
- **FR-017**: The host MUST authenticate an interactive user and refuse service accounts.
- **FR-018**: The host MUST check that the user has write access to the conversation and may use the agent.
- **FR-019**: The host MUST resolve the destination from the installed app's manifest by action id. It MUST NOT accept a destination from the client.
- **FR-020**: The host MUST verify the target is a finished assistant message in that conversation. It MUST pass the app the stored turn reference for that message.
- **FR-021**: The host MUST call the app as the user, using the same identity mode as the app's assistant stream. No app credential may reach the browser.
- **FR-022**: The host MUST send the app the conversation, message, turn and action ids, plus the user's text when given.
- **FR-023**: The host MUST enforce a maximum request size, a timeout of about 30 seconds, JSON-only exchange, and no redirects.
- **FR-024**: The host MUST require a JSON response and return the app's error text and code on non-success.
- **FR-025**: The host MUST write an audit event with the app id and action id. It MUST NOT include the user's text.

**Documentation**
- **FR-026**: Developer documentation MUST include a manifest example and the request and response contract.
- **FR-027**: Published developer tooling and its version MUST reflect the new capability.

### Key Entities

- **Message Action**: App-declared control. It has an id, label, icon, endpoint and optional dialog. It belongs to one installed app and is limited to four per app.
- **Action Dialog**: Optional prompt with a title, description, submit label and one text field.
- **Action Enablement**: Per-user, per-session flag that controls whether an action is visible.
- **Action Request**: User-triggered call. It carries conversation, message, turn and action ids and optional text.
- **Action Result**: App response, either success or an error with text and code.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can submit an action on a finished answer in 3 clicks or fewer without a dialog, and in under 30 seconds with a dialog.
- **SC-002**: 100% of requests from unauthenticated callers, service accounts, non-owners, undeclared actions and non-assistant messages are refused, with no call to the app.
- **SC-003**: 0 actions appear on streaming messages, user messages, other apps' agents or non-web chat clients in testing.
- **SC-004**: Users not enabled for an action see 0 controls for it. Enabled users see it on 100% of finished assistant answers from the app's agent.
- **SC-005**: 100% of invalid manifests in the test set are rejected with a reason. Valid ones are accepted.
- **SC-006**: Audit records exist for 100% of action calls and contain 0 user-supplied text.
- **SC-007**: A user sees an error or success result within 35 seconds of submitting, even if the app is unresponsive.
- **SC-008**: An existing app that does not declare message actions behaves exactly as before.
- **SC-009**: An app developer can add an action by following the documentation alone, without reading host code.

## Assumptions

- Only apps using the host-owned assistant popup can use this feature.
- The app is responsible for access control on its own endpoint. The host's visibility flag is not authorization.
- User text is untrusted and forwarded without alteration beyond size limits.
- The change is additive. Hosts without it reject manifests that use it.
- Enablement lives only in the session, not in stored data.
- The app decides how repeated actions on one answer are handled.
- The icon list is host-owned and small.

## Out of Scope

- Arbitrary app UI inside the panel.
- Visibility rules based on message content.
- Bulk actions.
- Chat clients other than the web UI, including Webex.
