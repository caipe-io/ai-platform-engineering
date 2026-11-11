export interface FeedbackIssueStyle {
  titlePrefix?: boolean;
  labels?: string[];
  typeLabels?: Partial<Record<"Bug" | "Enhancement", string>>;
  featureLabels?: Record<string, string>;
  contextFields?: Record<string, string>;
}

/** Deployment rules only; requests cannot select labels or title conventions. */
export function parseFeedbackIssueStyle(value: unknown): FeedbackIssueStyle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Feedback issue style must be an object");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !["titlePrefix", "labels", "typeLabels", "featureLabels", "contextFields"].includes(key))) throw new Error("Unknown feedback issue style setting");
  const label = (input: unknown, max = 50): string => {
    if (typeof input !== "string" || !input.trim() || input.trim().length > max || /[\u0000-\u001f\u007f]/.test(input)) throw new Error("Invalid feedback label or field name");
    return input.trim();
  };
  const mapping = (input: unknown, context = false): Record<string, string> => {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 32) throw new Error("Invalid feedback label mapping");
    return Object.fromEntries(Object.entries(input).map(([key, entry]) => {
      if (context && !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) throw new Error("Invalid feedback context key");
      return [label(key, context ? 64 : 40), label(entry, context ? 80 : 50)];
    }));
  };
  const result: FeedbackIssueStyle = {};
  if (data.titlePrefix !== undefined) {
    if (typeof data.titlePrefix !== "boolean") throw new Error("Feedback titlePrefix must be a boolean");
    result.titlePrefix = data.titlePrefix;
  }
  if (data.labels !== undefined) {
    if (!Array.isArray(data.labels) || data.labels.length > 32) throw new Error("Invalid feedback labels");
    result.labels = [...new Set(data.labels.map(value => label(value)))];
  }
  if (data.typeLabels !== undefined) {
    const labels = mapping(data.typeLabels);
    if (Object.keys(labels).some(key => !["Bug", "Enhancement"].includes(key))) throw new Error("Unknown feedback issue type mapping");
    result.typeLabels = labels;
  }
  if (data.featureLabels !== undefined) result.featureLabels = mapping(data.featureLabels);
  if (data.contextFields !== undefined) result.contextFields = mapping(data.contextFields, true);
  return result;
}

export function parseFeedbackAppContext(input: unknown): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 16 ||
      Object.entries(input).some(([key, value]) => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || typeof value !== "string" || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new Error("Invalid feedback application context");
  }
  return Object.fromEntries(Object.entries(input).filter(([, value]) => (value as string).trim()).map(([key, value]) => [key, (value as string).trim()]));
}
