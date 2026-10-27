# Release announcements

- The platform announcement switch and each user's notification preference are
  independent. Existing deployed-version release notes remain the default.
- Deployment operators approve comparison repositories through the server-side
  `RELEASE_NOTES_ALLOWED_REPOSITORIES` environment variable (comma-separated
  HTTPS GitHub repository URLs, up to 32). Unset permits only the canonical
  upstream repository. An explicit value replaces that default; an empty or
  malformed list permits no comparisons. Matching ignores case and `.git`.
- Administrators select an approved `repository_url` and configure `previous_commit` and
  `latest_commit` together, or clear all three. Refs may be commit SHAs,
  ordinary branch names, or tags. Repository URLs must identify GitHub
  owner/repository coordinates, without credentials, ports, query or fragment.
- Both configuration writes and comparison reads enforce the deployment list.
  Removing a repository blocks existing stored ranges and cached comparisons.
  Changing the policy requires a deployment rollout; the admin API cannot edit it.
- Forks can use this umbrella Helm values override (the existing UI ConfigMap
  injects `caipe-ui.config` as environment variables):

  ```yaml
  caipe-ui:
    config:
      RELEASE_NOTES_ALLOWED_REPOSITORIES: "https://github.com/example/platform-fork"
  ```

  After rollout, select that repository and save its refs in Release announcements.
  This controls commit comparisons; deployed-version release posts keep their
  existing resolution behavior. For the standalone UI chart, use `config` directly.
- The announcement toggle PATCH changes only `release_notes.enabled`. A range
  PATCH changes only its three fields, so concurrent toggle/range writes cannot
  overwrite one another. Edits made during a save remain dirty.
- `GET /api/release-notes?version=...&compare=platform` authenticates through the
  shared bearer/session provider on every request before reading configuration,
  cache, or GitHub. Ordinary admitted users may read configured announcements;
  configuration writes retain existing administrator and resource gates.
- Configuring a private repository shares its commit subjects and links with
  those admitted users. Choose an appropriate announcement repository/range.
  Raw source and access tokens are not returned.
- The server uses `RELEASE_NOTES_GITHUB_TOKEN`, then `GITHUB_TOKEN`, then
  `GITHUB_PERSONAL_ACCESS_TOKEN`. Private responses are `private, no-store`.
  The bounded in-process compare cache is not an authentication cache.
- Concurrent reads of the same repository and ref pair share one in-progress
  comparison per UI process. Failed requests are not cached and can be retried.
- Session skips and permanent dismissals include the deployed version, repository
  and both refs. Changing any of these identifies a new announcement.
- Requests do not accept arbitrary repository coordinates. GitHub redirects are
  rejected, fetch and response-body reads are timed out, and pagination fails
  rather than silently returning a partial comparison at its limit.
- A build-provided `public/main-increment-release-notes.json` may supply notes
  for its exact version. This is a public build artifact, not a private
  GitHub-token read. Do not place confidential material in public artifacts.
