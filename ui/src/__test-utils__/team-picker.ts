import { act,screen as defaultScreen,fireEvent,waitFor,within } from "@testing-library/react";

type ScreenLike = Pick<typeof defaultScreen, "getByLabelText" | "getByRole" | "getAllByRole" | "findByRole">;

/**
 * Open the picker whose trigger is labelled by `triggerLabel`, then
 * click the option whose rendered row contains `team:<slug>` (the
 * default `code` suffix the picker shows).
 *
 * It falls back to the global `screen` when the caller omits one and
 * waits for portalled popover content to mount.
 */
export async function pickTeam(
  screenOrLabel: ScreenLike | string | RegExp,
  triggerLabelOrSlug?: string | RegExp,
  maybeSlug?: string,
): Promise<void> {
  let screenObj: ScreenLike = defaultScreen;
  let triggerLabel: string | RegExp;
  let slug: string;
  if (typeof screenOrLabel === "object" && "getByLabelText" in screenOrLabel) {
    screenObj = screenOrLabel;
    triggerLabel = triggerLabelOrSlug as string | RegExp;
    slug = maybeSlug as string;
  } else {
    triggerLabel = screenOrLabel as string | RegExp;
    slug = triggerLabelOrSlug as string;
  }
  const trigger = await waitForEnabledTrigger(screenObj, triggerLabel);
  await act(async () => {
    fireEvent.click(trigger);
  });
  const listbox = await screenObj.findByRole("listbox");
  const targetCode = within(listbox).getByText(`team:${slug}`);
  const option = targetCode.closest("[role='option']");
  if (!option) {
    throw new Error(
      `pickTeam: could not find an option row whose code is "team:${slug}". ` +
      `Make sure the trigger labelled "${String(triggerLabel)}" is a TeamPicker and ` +
      `that an option for slug "${slug}" is in the rendered list.`,
    );
  }
  await act(async () => {
    fireEvent.click(option);
  });
}

async function waitForEnabledTrigger(
  screenObj: ScreenLike,
  triggerLabel: string | RegExp,
): Promise<HTMLElement> {
  let trigger: HTMLElement | null = null;
  await waitFor(() => {
    const node = screenObj.getByLabelText(triggerLabel);
    if (
      (node as HTMLButtonElement).disabled ||
      node.getAttribute("aria-disabled") === "true"
    ) {
      throw new Error(
        `Trigger labelled "${String(triggerLabel)}" is still disabled — waiting for the options list to populate.`,
      );
    }
    trigger = node;
  });
  if (!trigger) {
    throw new Error(
      `pickTeam: failed to resolve an enabled trigger for "${String(triggerLabel)}".`,
    );
  }
  return trigger;
}

/**
 * Open the picker whose trigger is labelled by `triggerLabel`, then
 * click the option whose rendered label matches `name`. Use this for
 * callers that render with `hideSlugSuffix` (KB / RAG team-access
 * panels) where the `team:<slug>` code isn't shown.
 */
export async function pickTeamByName(
  screenOrLabel: ScreenLike | string | RegExp,
  triggerLabelOrName?: string | RegExp,
  maybeName?: string | RegExp,
): Promise<void> {
  let screenObj: ScreenLike = defaultScreen;
  let triggerLabel: string | RegExp;
  let name: string | RegExp;
  if (typeof screenOrLabel === "object" && "getByLabelText" in screenOrLabel) {
    screenObj = screenOrLabel;
    triggerLabel = triggerLabelOrName as string | RegExp;
    name = maybeName as string | RegExp;
  } else {
    triggerLabel = screenOrLabel as string | RegExp;
    name = triggerLabelOrName as string | RegExp;
  }
  const trigger = await waitForEnabledTrigger(screenObj, triggerLabel);
  await act(async () => {
    fireEvent.click(trigger);
  });
  const listbox = await screenObj.findByRole("listbox");
  const option = within(listbox).getByRole("option", { name });
  await act(async () => {
    fireEvent.click(option);
  });
}

/**
 * Read the currently-selected single-team picker by its trigger
 * label. Returns the rendered team name, or an empty string when
 * nothing is selected (the trigger shows its placeholder text).
 *
 * Asymmetric with `pickTeam` because the picker is a `<button>`,
 * not a form control — `.toHaveValue(...)` does not apply.
 */
export function getSelectedTeamName(
  screenOrLabel: ScreenLike | string | RegExp,
  maybeTriggerLabel?: string | RegExp,
): string {
  const screenObj: ScreenLike =
    typeof screenOrLabel === "object" && "getByLabelText" in screenOrLabel
      ? screenOrLabel
      : defaultScreen;
  const triggerLabel =
    typeof screenOrLabel === "object" && "getByLabelText" in screenOrLabel
      ? (maybeTriggerLabel as string | RegExp)
      : (screenOrLabel as string | RegExp);
  const trigger = screenObj.getByLabelText(triggerLabel);
  return (trigger.textContent || "").trim();
}
