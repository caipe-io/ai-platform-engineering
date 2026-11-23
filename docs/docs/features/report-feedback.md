---
title: Report feedback
description: Report bugs and improvements from CAIPE or an installed app.
---

# Report feedback

Since 1.3.5, CAIPE and installed apps can use the same **Provide Feedback** form. Signed-in users can report a bug or request an improvement when a destination is configured.

1. Open **Provide Feedback** from the application header or use thumbs down on a response when issue reporting is enabled.
2. Choose the **Component** and **Feature**. Review the destination shown on the form.
3. Describe what happened or what you want to accomplish. Add an editable chat excerpt or a screenshot only if you want to share it and the destination accepts it.
4. Submit the report and open the issue link if the destination returns one.

## Configure destinations

- Platform administrators select a direct GitHub handler or the configured GitHub/Jira agent handler.
- Installed apps can use their own configured GitHub destination or an app-owned feedback endpoint. CAIPE checks access to the app and any referenced conversation before submitting.
- A failed app report stays with its selected destination. Retry after checking that destination's configuration.
- See the [1.3.5 release configuration guide](/releases/release-1-3-5#upgrade-guide-134--135) for the handler, destination, and credential settings.

## Solution architecture

![The shared feedback form sends selected context to CAIPE. The backend validates the signed-in caller and routes the report to the configured platform or app destination.](/diagrams/report-feedback.svg)

[Download editable Excalidraw](/diagrams/report-feedback.excalidraw)
