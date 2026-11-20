---
title: Release announcements
description: Curate and preview release notes for the deployed CAIPE host version.
---

# Release announcements

Platform administrators can curate the release notes shown in CAIPE. In 1.3.6, the editor also shows the deployed host version and offers to retarget saved notes to that version.

1. Open **Admin → Platform configuration → Announcements** and find **Curated release notes**.
2. Enter Markdown or select a Markdown file from an approved GitHub repository. For a repository file, supply the ref and path.
3. Set the target release to the version shown in the editor, or choose **Use current host release**.
4. Save and use the current-release preview. If the target version differs from the running host, the editor explains when the note can appear.

Users can open the notes or turn off the sign-in prompt from **Settings → Notifications → Release notes**. The notes source is selected for the running CAIPE host version. An app version cannot trigger a CAIPE host announcement.

## Solution architecture

![The administrator saves curated notes in platform configuration. The release-notes service matches the running host version before delivering Markdown to the user's preview or sign-in dialog.](/diagrams/release-announcements.svg)

[Download editable Excalidraw](/diagrams/release-announcements.excalidraw)
