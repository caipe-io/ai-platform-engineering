# Contract: SDK Capability and Configuration

## Capability

- `ASSISTANT_EXTENSIONS` gains `"messageActions.v1"`.
- Native: `HostAssistantCapability.extensions` includes it.
- Iframe: `capabilities.composerExtensions` includes it.
- Apps check for it before declaring or configuring actions.

## Configuration

```ts
configure({
  version: "1.0",
  visible: true,
  messageActions: { "flag-answer": { visible: true } },
});
```

- Native: `configure(configuration)`. Iframe: `configureAssistant(configuration)`.
- `validateAssistantConfiguration` checks each id's shape and accepts ids the app did not declare. The host ignores them, so one stale id does not drop the rest.
- A declared action with no entry stays hidden.
- With `requireConfiguration`, nothing shows before the first `configure` call.
- The host clears this state on unmount and account change. Apps call `configure` again.
- Iframe bridge throws if `"messageActions.v1"` is not in `composerExtensions` and `messageActions` is set.

## Versioning

- `CHECKER_VERSION` and `@caipe-io/app-sdk` version bump (additive).
- `CONTRACT_VERSION` unchanged.
- Docs state that apps must require a host release that includes this feature.
