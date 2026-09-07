---
sidebar_position: 5
---

# Selection controls

Choose a control from the data contract. Screen location is not a reason to
create another picker.

## Decision table

| Data contract | Canonical control | Use it when |
|---|---|---|
| Small static enum or value set | `Select` | The list is short, already available, and search adds no value. It is native-backed for browser type-ahead, mobile pickers, forms, and keyboard behavior. |
| Searchable local entity | A thin adapter over `SearchablePicker` | Options have stable IDs and labels and can become difficult to scan. Feature screens consume adapters such as `AgentPicker` or `TeamPicker`. |
| Async or paginated entity | Domain loader + thin `SearchablePicker` adapter | The API owns search, pagination, deduplication, or authorization filtering. The adapter passes loading, error, empty, and load-more state to the base control. |
| Multi-select value set | `MultiSelect` | Values are plain strings and the parent owns the complete option list. |
| Multi-select team set | `TeamMultiPicker` | Team slugs are persisted and names are presentation data. |
| Permission or access subject | `AccessSubjectPicker` or `AccessSubjectMultiPicker` | User/team kinds, implicit access, remote user search, or per-kind limits affect selection. |
| Free text or a specialized command surface | A focused domain control | Users create values, invoke commands, browse a hierarchy, or need interaction that is not a list selection. Document why the shared contracts do not fit. |

Do not add feature flags to a shared picker for domain labels, endpoints,
permissions, or persistence shapes. Keep those concerns in the adapter.

## Shared contract

### Accessibility and focus

- Give every trigger an accessible name through a visible `<label>` or
  `ariaLabel`.
- Searchable single-select triggers expose `combobox`, `aria-expanded`,
  `aria-controls`, invalid, described-by, required, and disabled state.
- Opening a searchable picker focuses its search field.
- Arrow keys skip disabled options. `Home` and `End` move to the bounds.
  `Enter` selects. `Escape` closes and returns focus to the trigger.
- Options expose `listbox` / `option`, `aria-selected`, and disabled state.
- A required selection has no clear action. Optional controls use a real
  sibling button for clear actions; do not nest an interactive element in a
  trigger button.
- Multi-select options remain keyboard-reachable and expose
  `aria-multiselectable`.

### Data and asynchronous state

- The base control renders options; it does not fetch them.
- The domain loader owns authorization filters, server search, pagination,
  page deduplication, cancellation, and response validation.
- Preserve the current selection when another page loads or an entity is no
  longer returned. Adapters decide how a stale value is labeled.
- Use explicit loading, error, retry, empty, loading-more, and disabled states.
  An empty response is not an error.
- `onLoadMore` requests one page. The parent prevents concurrent requests and
  updates `hasMore` from the API response.

The Dynamic Agents loader in `ui/src/lib/dynamic-agent-list.ts` and
`AgentPicker` are the reference paginated adapter pattern. `TeamPicker` keeps
team slug, record-ID compatibility, and labels outside the generic base.

## Test contract

Shared interaction behavior belongs beside the shared component:

- `components/ui/__tests__/select.test.tsx` owns native select behavior.
- `components/ui/__tests__/searchable-picker.test.tsx` owns search, keyboard,
  focus, accessibility, status, and pagination affordances.
- `components/ui/popover.test.tsx` owns shared open/close, trigger, and portal
  mechanics.
- `components/ui/__tests__/team-picker.test.tsx` owns team identity mapping,
  multi-selection grouping, stale values, and domain limits.
- `e2e/rbac/selection-controls.spec.ts` owns browser-only dialog portal,
  focus, and scrolling integration.
- Domain-adapter tests cover only ID mapping, labels, stale values, and
  domain-specific limits.
- Feature unit and Playwright tests cover feature outcomes: the request sent,
  value persisted, authorization applied, or workflow completed.

Do not repeat shared search, arrow-key, focus, clear, option-rendering, or
page-loading assertions in every feature screen. Use a picker as part of a
feature test only when making the selection is required to reach the feature
outcome.

## Inventory

The `origin/main` snapshot at `6139fb6e4` contained 62 direct native-select
instances across 37 production files. All 62 now route through a canonical
shared primitive or a thin domain adapter. Production feature code no longer
renders a literal `<select>`; `ui/src/components/ui/select.tsx` owns that
element.

| Migrated contract | Examples |
|---|---|
| Small static or schema-bounded values | Sharing permissions, audit filters, source and crawl modes, schedules, statuses, severity, page size, webhook providers, credential fields, and workflow error handling use `Select`. |
| Searchable entities and growing filters | Repositories, identity providers, secrets, collections, resources, workflow filters, skill categories and tags, namespaces, tools, and RAG metadata keys use `SearchablePicker` directly or through an adapter. |
| Repeated domain entities | Models use `ModelPicker`; Webex connector identities use `ConnectorIdentityPicker`; RAG filter keys use `MetadataFilterKeyPicker`; agents, teams, providers, and Slack service accounts keep their existing adapters. |

The migration also removes one-off search state, popover composition, option
rendering, and empty-state behavior from the migrated Skills Gallery, Webex,
model, resource, collection, secret, repository, and filter controls.

### Searchable and custom controls

| Group | Inventory |
|---|---|
| Shared bases | `Select`, `SearchablePicker`, `MultiSelect`, and `Popover`. |
| Thin entity adapters | `AgentPicker`, `TeamPicker`, `ModelPicker`, `ProviderSelect`, `ConnectorIdentityPicker`, `MetadataFilterKeyPicker`, and the Slack `ServiceAccountSelect`. |
| Domain multi-select | `TeamMultiPicker` preserves team slugs, stale subjects, compact chips, and per-screen selection limits. |
| Permission adapter | `AccessSubjectPicker` and `AccessSubjectMultiPicker`. |
| Specialized async controls | ReBAC principal search, application navigation search, Slack emoji search, chat share-subject search, and the team-member control that accepts either a directory result or new free text. Keep their domain loading behavior local. |
| Action and navigation menus | Workflow execution, widget customization, notifications, navigation flyouts, and file-tree actions invoke commands rather than persist a selected value, so they remain focused menu/popover components. |
| Structured multi-pickers | Dynamic-agent tools, skills, middleware, data sources, subagents, and workflow tools. These select structured configuration rather than one entity value and remain domain components. |

The targeted team and agent migrations already present on `main` remain the
pattern:

- Agent catalogs use the paginated loader and `AgentPicker`.
- Datasource ownership and search access use `TeamPicker` /
  `TeamMultiPicker`; short permission enums stay native-backed.
- ReBAC principal search remains specialized because it combines multiple
  subject kinds and accepts canonical subject references.

## Review checklist

- Identify the data contract in the decision table.
- Reuse an existing adapter before importing a base control.
- Keep API, authorization, pagination, and labels outside the base.
- Cover shared interaction once in `components/ui/__tests__`.
- Test only the consuming feature outcome outside the shared suite.
- Explain any new custom selection surface in the pull request.
