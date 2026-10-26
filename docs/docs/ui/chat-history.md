---
sidebar_position: 6
---

# Organize chat history

The chat sidebar has one menu with independent **Chat source** and **Group by** sections.
The button shows only the selected source, such as **Web chats**.
Choose one of these grouping views inside the menu:

- **Ungrouped**: the current conversation list, including chats assigned to folders.
- **Group by agent**: a collapsible group for each agent represented in the loaded history.
- **Folders**: personal folders and an **Unfiled** group.

Folders and folder actions are available for Web/API chat history. Autonomous
and Scheduled run history each offer **Ungrouped** and **Agent**, with separate
saved grouping, collapse state and agent order. Run views default to Ungrouped;
they do not inherit the chat view's folders. Webhook history keeps its run list.
Returning to chat history restores the saved chat organization. Run conversations
cannot be moved into folders, including from All chats.

Use **New chat folder** beside the history dropdown to create a folder.
The sidebar collapse/expand control is at the bottom, beside Archive. Hover or focus a conversation's
folder button to move it. In Folders view, drag a chat onto a folder header
to move it; drop onto **Unfiled** to remove its folder assignment. Drop targets
highlight while dragging, and a collapsed destination opens after a successful move.
The move button remains available for keyboard and touch use.
Folder headers support collapse, rename and removal.

Reorder folder or agent groups using the grip beside a group heading. Drag it
above or below another heading, or click it for **Move up** / **Move down**.
Keyboard users can focus the grip and press **Alt + Arrow Up/Down**.
Each grouping view keeps its own order, including Unfiled. Collapse state and
chat assignments stay attached to their groups. Groups hidden by a source filter
retain their saved positions; newly encountered groups appear after saved groups.
Ungrouped keeps the existing conversation order.
Removing a folder returns its chats to Unfiled; it does not archive chats.

Folders, assignments, view selection, group order and collapsed groups are saved in the
signed-in user's `user_settings.preferences.chat_history`. They do not change
conversation ownership, sharing or agent access. Browser-only installations
store the same preferences locally, scoped to the current account.

Grouping applies to the current chat-type filter and loaded pages. Use **Load
older chats** to include more history, including when all groups are collapsed.
Folder assignments for older, unloaded chats remain saved.

The preferences API validates folder IDs, unique names, assignments and limits
before saving. Limits are 100 folders, 80 characters per name and 10,000 saved
assignments. No migration of existing conversations is required. An account
without organization preferences starts in Ungrouped view.
