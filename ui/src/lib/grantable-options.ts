/**
 * Shared label↔ref option-building for scope pickers (Service Accounts admin
 * panel, Unlinked Access modal). Kept separate from any one component since
 * both use the identical `{ref, name}` grantable-item shape and disambiguation
 * rule.
 */
export interface GrantableItem {
  ref: string;
  name: string;
}

export interface LabelledGrantOption {
  ref: string;
  label: string;
}

/** Disambiguates same-named items within one list by appending `(ref)`. */
export function labelledGrantOptions(
  items: GrantableItem[],
): LabelledGrantOption[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  }
  return items.map((item) => ({
    ref: item.ref,
    label: counts.get(item.name) === 1 ? item.name : `${item.name} (${item.ref})`,
  }));
}
