# Feature Specification: Skill Scanner Validation Errors

**Feature Branch**: `prebuild/fix/skill-scanner-load-error`
**Created**: 2026-05-13
**Status**: Draft
**Input**: User description: "fix https://github.com/caipe-io/ai-platform-engineering/issues/1391"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Receive Actionable Validation Feedback (Priority: P1)

As a skill author or catalog operator, I need malformed skill submissions to return a clear validation failure that identifies what is wrong, so I can correct the skill definition without investigating server logs or guessing why the scan failed.

**Why this priority**: This is the reported failure mode. Without actionable validation feedback, user-correctable configuration issues look like platform outages and block skill onboarding.

**Independent Test**: Submit a skill definition that is missing a required field and verify the scan response identifies the submission as invalid and includes the missing field message.

**Acceptance Scenarios**:

1. **Given** a skill definition is missing the required `name` field, **When** a user requests a skill scan, **Then** the response is categorized as a validation failure and includes a message equivalent to "SKILL.md missing required field: name".
2. **Given** a skill definition has a user-correctable formatting or manifest validation problem, **When** a user requests a skill scan, **Then** the response provides an actionable validation message rather than a generic internal failure.
3. **Given** a malformed skill definition fails validation, **When** the failure is returned to a caller, **Then** the caller can distinguish the problem from an unexpected server fault.

---

### User Story 2 - Preserve Genuine Server Fault Handling (Priority: P2)

As an operator, I need unexpected scan failures to remain distinguishable from user-correctable validation issues, so incident triage and alerting can focus on real platform faults.

**Why this priority**: The fix must not hide genuine service failures as user input errors.

**Independent Test**: Trigger a non-validation scan failure and verify it remains reported as an internal failure while malformed skill definitions are reported as validation failures.

**Acceptance Scenarios**:

1. **Given** a scan fails for an unexpected internal reason, **When** the failure is returned, **Then** the response remains categorized as an internal failure.
2. **Given** a scan fails because the submitted skill definition is invalid, **When** the failure is returned, **Then** the response is categorized as a validation failure.

---

### User Story 3 - Keep Valid Skill Scans Unchanged (Priority: P3)

As a skill author, I need valid skill scans to continue succeeding with the same usable result, so the error-handling improvement does not disrupt the normal scan workflow.

**Why this priority**: The bugfix should be narrowly scoped and preserve existing successful behavior.

**Independent Test**: Submit a valid skill definition and verify the scan succeeds with the expected result.

**Acceptance Scenarios**:

1. **Given** a valid skill definition, **When** a user requests a skill scan, **Then** the scan completes successfully and returns the normal scan result.
2. **Given** a previously supported valid skill definition, **When** it is scanned after this change, **Then** it is not rejected by the new validation-error handling.

### Edge Cases

- A skill definition is missing more than one required field; the response should include the first actionable validation message available from the scan process.
- A skill definition file is present but malformed enough that required metadata cannot be read; the response should still be categorized as a validation failure if the failure is user-correctable.
- A validation message contains filesystem or environment details; the user-facing response should remain actionable while avoiding unnecessary sensitive implementation details.
- Concurrent malformed scan requests should each receive validation feedback without affecting valid scan requests.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST classify known skill definition loading and validation failures as caller-correctable validation failures.
- **FR-002**: The system MUST return the original actionable validation message for known skill definition validation failures, including missing required field names when available.
- **FR-003**: The system MUST NOT return a generic internal scan error for known skill definition validation failures.
- **FR-004**: The system MUST preserve the existing internal-failure response category for unexpected scan failures that are not caused by invalid skill definitions.
- **FR-005**: The system MUST preserve successful scan behavior for valid skill definitions.
- **FR-006**: The system MUST ensure the validation response allows automated callers to distinguish validation failures from internal service faults.
- **FR-007**: The system MUST avoid exposing unnecessary filesystem paths, stack traces, credentials, tokens, or other sensitive runtime details in user-facing validation responses.

### Key Entities

- **Skill Submission**: A user-provided skill directory or skill definition being scanned; includes metadata and instruction content required for validation.
- **Validation Failure**: A caller-correctable problem with the skill submission, such as missing required metadata or malformed skill definition content.
- **Scan Result**: The outcome returned to the caller after a scan request, either a successful result, a validation failure, or an internal failure.

### Assumptions

- Missing required skill metadata, malformed skill definition content, and skill loading errors caused by the submitted skill are considered user-correctable validation failures.
- Unexpected runtime faults, unavailable dependencies, and platform defects remain internal failures.
- The validation message can be safely surfaced after excluding stack traces and sensitive runtime details.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of scan requests with a skill definition missing the required `name` field return an actionable validation failure instead of a generic internal failure.
- **SC-002**: 100% of known user-correctable skill loading and validation failures are distinguishable from internal service faults by automated callers.
- **SC-003**: 0 successful scans for valid skill definitions regress because of the validation-error handling change.
- **SC-004**: A skill author can identify the missing or malformed skill metadata from the scan response in under 1 minute without consulting service logs.
