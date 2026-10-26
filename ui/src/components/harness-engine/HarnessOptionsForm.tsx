"use client";

import { Select } from "@/components/ui/select";
import type { HarnessOptionSchema } from "@/types/harness-engine";

interface Props {
  schema: { properties?: Record<string, HarnessOptionSchema>; required?: string[] };
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  disabled?: boolean;
}

export function HarnessOptionsForm({ schema, value, onChange, disabled }: Props) {
  const entries = Object.entries(schema.properties ?? {});
  if (entries.length === 0) return null;

  const update = (name: string, option: HarnessOptionSchema, raw: string | boolean) => {
    const next = { ...value };
    if (raw === "" && !schema.required?.includes(name)) {
      delete next[name];
    } else if (option.type === "integer" || option.type === "number") {
      next[name] = Number(raw);
    } else {
      next[name] = raw;
    }
    onChange(next);
  };

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {entries.map(([name, option]) => {
        const id = `harness-option-${name}`;
        const current = value[name] ?? option.default ?? "";
        return (
          <label className="space-y-1 text-sm" htmlFor={id} key={name}>
            <span className="font-medium">{option.title ?? name}</span>
            {option.enum ? (
              <Select
                id={id}
                value={String(current)}
                onChange={(event) => update(name, option, event.target.value)}
                disabled={disabled}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2"
              >
                {!schema.required?.includes(name) && <option value="">Use profile default</option>}
                {option.enum.map((choice) => <option key={String(choice)} value={String(choice)}>{choice}</option>)}
              </Select>
            ) : option.type === "boolean" ? (
              <input
                id={id}
                type="checkbox"
                checked={Boolean(current)}
                onChange={(event) => update(name, option, event.target.checked)}
                disabled={disabled}
              />
            ) : (
              <input
                id={id}
                type={option.type === "string" ? "text" : "number"}
                value={String(current)}
                min={option.minimum}
                max={option.maximum}
                onChange={(event) => update(name, option, event.target.value)}
                disabled={disabled}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2"
              />
            )}
            {option.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}
          </label>
        );
      })}
    </div>
  );
}
