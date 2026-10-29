const MAX_FEEDBACK_TITLE_LENGTH = 240;

export interface UserFeedbackTitleInput {
  description: string;
  area: string;
  type: string;
}

/** Build the canonical title used by every user-feedback ticket provider. */
export function buildUserFeedbackTitle(input: UserFeedbackTitleInput): string {
  const summary = input.description.trim().replace(/\s+/g, " ");
  const title = `[User Feedback][${input.area}][${input.type}]: ${summary}`;

  if (title.length <= MAX_FEEDBACK_TITLE_LENGTH) return title;
  return `${title.slice(0, MAX_FEEDBACK_TITLE_LENGTH - 1)}…`;
}
