import { act,screen as defaultScreen,fireEvent,waitFor,within } from "@testing-library/react";

type ScreenLike = Pick<typeof defaultScreen, "getByLabelText" | "getByRole" | "getAllByRole" | "findByRole">;

/**
 * Open the AgentPicker whose trigger is labelled by `triggerLabel`,
 * then click the option whose rendered row contains `agent:<id>`.
 */
export async function pickAgent(
  screenOrLabel: ScreenLike | string | RegExp,
  triggerLabelOrId?: string | RegExp,
  maybeId?: string,
): Promise<void> {
  let screenObj: ScreenLike = defaultScreen;
  let triggerLabel: string | RegExp;
  let id: string;
  if (typeof screenOrLabel === "object" && "getByLabelText" in screenOrLabel) {
    screenObj = screenOrLabel;
    triggerLabel = triggerLabelOrId as string | RegExp;
    id = maybeId as string;
  } else {
    triggerLabel = screenOrLabel as string | RegExp;
    id = triggerLabelOrId as string;
  }
  const trigger = await waitForEnabledTrigger(screenObj, triggerLabel);
  await act(async () => {
    fireEvent.click(trigger);
  });
  const listbox = await screenObj.findByRole("listbox");
  const targetCode = within(listbox).getByText(`agent:${id}`);
  const option = targetCode.closest("[role='option']");
  if (!option) {
    throw new Error(
      `pickAgent: could not find an option row whose code is "agent:${id}".`,
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
        `Trigger labelled "${String(triggerLabel)}" is still disabled.`,
      );
    }
    trigger = node;
  });
  if (!trigger) {
    throw new Error(
      `pickAgent: failed to resolve an enabled trigger for "${String(triggerLabel)}".`,
    );
  }
  return trigger;
}
