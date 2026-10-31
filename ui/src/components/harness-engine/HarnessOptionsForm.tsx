"use client";

import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import type { HarnessOptionSchema } from "@/types/harness-engine";

interface Props {
  schema: { properties?: Record<string, HarnessOptionSchema>; required?: string[] };
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  disabled?: boolean;
}

function SchemaField({ schema, value, onChange, path, disabled, depth = 0 }: {
  schema: HarnessOptionSchema; value: unknown; onChange: (value: unknown) => void;
  path: string; disabled?: boolean; depth?: number;
}) {
  const title = schema.title ?? path.split(".").at(-1);
  if (depth > 6) return <p role="alert">{title}: nested options exceed the supported depth.</p>;
  if (schema.type === "object") {
    const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const properties = Object.entries(schema.properties ?? {});
    if (properties.length > 64) return <p role="alert">{title}: too many options.</p>;
    return <fieldset className="space-y-3 rounded-md border p-3" disabled={disabled}>
      <legend>{title}</legend>
      {properties.map(([key, child]) => <SchemaField key={key} schema={child} value={object[key]} path={`${path}.${key}`} depth={depth + 1} disabled={disabled}
        onChange={next => { const updated = { ...object }; if (next === undefined) delete updated[key]; else updated[key] = next; onChange(updated); }} />)}
    </fieldset>;
  }
  if (schema.type === "array") {
    if (!schema.items) return <p role="alert">{title}: an item schema is required.</p>;
    const array = Array.isArray(value) ? value : [];
    if (array.length > Math.min(schema.maxItems ?? 32, 32)) return <p role="alert">{title}: too many items.</p>;
    const itemSchema = schema.items;
    return <fieldset className="space-y-3 rounded-md border p-3" disabled={disabled}>
      <legend>{title}</legend>
      {array.map((item, index) => <div key={index} className="space-y-2">
        <SchemaField schema={itemSchema} value={item} path={`${path}.${index}`} depth={depth + 1} disabled={disabled}
          onChange={next => onChange(array.map((entry, offset) => offset === index ? next : entry))} />
        <Button type="button" variant="outline" disabled={disabled || array.length <= (schema.minItems ?? 0)}
          onClick={() => onChange(array.filter((_, offset) => offset !== index))}>Remove item</Button>
      </div>)}
      <Button type="button" variant="outline" disabled={disabled || array.length >= Math.min(schema.maxItems ?? 32, 32)}
        onClick={() => onChange([...array, itemSchema.default ?? (itemSchema.type === "object" ? {} : itemSchema.type === "boolean" ? false : "")])}>Add item</Button>
    </fieldset>;
  }
  const id = `harness-option-${path}`;
  const current = value ?? schema.default ?? "";
  return <label className="block space-y-1 text-sm" htmlFor={id}>
    <span className="font-medium">{title}</span>
    {schema.enum ? <Select id={id} value={String(current)} disabled={disabled}
      onChange={event => onChange(event.target.value === "" ? undefined : schema.enum?.find(choice => String(choice) === event.target.value))}>
      <option value="">Use profile default</option>
      {schema.enum.map(choice => <option key={String(choice)} value={String(choice)}>{String(choice)}</option>)}
    </Select> : schema.type === "boolean" ? <input id={id} type="checkbox" checked={Boolean(current)} disabled={disabled}
      onChange={event => onChange(event.target.checked)} /> : ["string", "integer", "number"].includes(schema.type) ?
      <input id={id} type={schema.type === "string" ? "text" : "number"} value={String(current)} disabled={disabled}
        min={schema.minimum} max={schema.maximum} maxLength={Math.min(schema.maxLength ?? 100_000, 100_000)}
        step={schema.type === "integer" ? 1 : "any"} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2"
        onChange={event => onChange(event.target.value === "" ? undefined : schema.type === "string" ? event.target.value : Number(event.target.value))} /> :
      <span role="alert">This option requires an unsupported editor.</span>}
    {schema.description && <span className="block text-xs text-muted-foreground">{schema.description}</span>}
  </label>;
}

export function HarnessOptionsForm({ schema, value, onChange, disabled }: Props) {
  return <div className="grid gap-3 md:grid-cols-2">{Object.entries(schema.properties ?? {}).map(([name, option]) =>
    <SchemaField key={name} schema={option} value={value[name]} path={name} disabled={disabled}
      onChange={next => { const updated = { ...value }; if (next === undefined) delete updated[name]; else updated[name] = next; onChange(updated); }} />,
  )}</div>;
}
