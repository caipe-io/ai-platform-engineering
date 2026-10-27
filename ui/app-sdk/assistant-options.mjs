/** Shared publisher/runtime validation for native packages and iframe messages. */
export const ASSISTANT_EXTENSIONS = Object.freeze(["configuration.v1", "choices.v1", "presentation.v1"]);
const ID = /^[a-z][a-z0-9_-]{0,47}$/;
const PROTECTED = /(agent|conversation|thread|session|user|role|permission|scope|auth|token|secret|cookie|header|origin|url|path|protocol|message|file|context|tool|model|__proto__|constructor|prototype)/i;
function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)))
    throw new Error("Invalid assistant option fields");
}
function text(value, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid assistant option text");
}
function identifier(value) { if (typeof value !== "string" || !ID.test(value) || ["constructor", "prototype", "__proto__"].includes(value)) throw new Error("Invalid assistant option ID"); }
function unique(values) { if (new Set(values).size !== values.length) throw new Error("Duplicate assistant option ID"); }
function bounded(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("Assistant option out of bounds");
}
export function validateAssistantOptions(value) {
  object(value, ["version", "requireConfiguration", "includeLegacyAgentHistory", "legacyConversationQueryParams", "controls", "presentation"]);
  if (value.version !== "1.0") throw new Error("Unsupported assistant options version");
  for (const key of ["requireConfiguration", "includeLegacyAgentHistory"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error("Invalid assistant boolean");
  }
  if (value.legacyConversationQueryParams !== undefined) {
    if (!Array.isArray(value.legacyConversationQueryParams) || value.legacyConversationQueryParams.length > 4) throw new Error("Invalid conversation aliases");
    value.legacyConversationQueryParams.forEach(identifier);
    if (value.legacyConversationQueryParams.includes("assistant_chat")) throw new Error("Reserved conversation alias");
    unique(value.legacyConversationQueryParams);
  }
  if (value.controls !== undefined) {
    if (!Array.isArray(value.controls) || value.controls.length > 4) throw new Error("Too many assistant controls");
    for (const control of value.controls) {
      object(control, ["id", "label", "requestKey", "defaultChoice", "choices"]);
      identifier(control.id); text(control.label); identifier(control.requestKey);
      if (PROTECTED.test(control.requestKey) || !/^[a-z][a-z0-9_]*$/.test(control.requestKey)) throw new Error("Protected assistant request key");
      if (!Array.isArray(control.choices) || !control.choices.length || control.choices.length > 8) throw new Error("Invalid assistant choices");
      for (const choice of control.choices) {
        object(choice, ["id", "label", "value"]); identifier(choice.id); text(choice.label);
        if (choice.value !== undefined && !["boolean", "number", "string"].includes(typeof choice.value)) throw new Error("Invalid assistant choice value");
        if (typeof choice.value === "number" && !Number.isFinite(choice.value)) throw new Error("Invalid numeric choice");
        if (typeof choice.value === "string") text(choice.value, 200);
      }
      unique(control.choices.map(c => c.id));
      if (!control.choices.some(c => c.id === control.defaultChoice)) throw new Error("Unknown default choice");
    }
    unique(value.controls.map(c => c.id)); unique(value.controls.map(c => c.requestKey));
  }
  if (value.presentation !== undefined) {
    const p = value.presentation;
    object(p, ["placeholder", "showAuditNotice", "feedbackPrompt", "fontScale", "width", "height"]);
    if (p.placeholder !== undefined) text(p.placeholder, 120);
    if (p.showAuditNotice !== undefined && typeof p.showAuditNotice !== "boolean") throw new Error("Invalid audit presentation");
    if (p.fontScale !== undefined && !["compact", "default", "large"].includes(p.fontScale)) throw new Error("Invalid font scale");
    if (p.width !== undefined) bounded(p.width, 480, 1180);
    if (p.height !== undefined) bounded(p.height, 560, 940);
    if (p.feedbackPrompt !== undefined) {
      object(p.feedbackPrompt, ["message", "actionLabel", "trailingText"]);
      if (typeof p.feedbackPrompt.message !== "string" || p.feedbackPrompt.message.length > 240) throw new Error("Invalid feedback message");
      text(p.feedbackPrompt.actionLabel, 60);
      if (p.feedbackPrompt.trailingText !== undefined) text(p.feedbackPrompt.trailingText, 160);
    }
  }
}
export function validateAssistantConfiguration(value, options) {
  if (options) validateAssistantOptions(options);
  object(value, ["version", "visible", "controls", "bottomInset"]);
  if (value.version !== "1.0" || typeof value.visible !== "boolean") throw new Error("Unsupported assistant configuration");
  if (value.bottomInset !== undefined) bounded(value.bottomInset, 0, 400);
  if (value.controls !== undefined) {
    object(value.controls, (options?.controls ?? []).map(c => c.id));
    for (const [id, selection] of Object.entries(value.controls)) {
      const declared = options.controls.find(c => c.id === id);
      object(selection, ["choices", "defaultChoice"]);
      if (!Array.isArray(selection.choices) || !selection.choices.length || selection.choices.length > 8 ||
          selection.choices.some(id => !declared.choices.some(c => c.id === id)) || !selection.choices.includes(selection.defaultChoice))
        throw new Error("Undeclared assistant choice");
      unique(selection.choices);
    }
  }
}

/** Check again at the BFF before forwarding app choices to its runtime. */
export function validateAssistantRequestOptions(value, options) {
  validateAssistantOptions(options);
  const controls = options.controls ?? [];
  object(value, controls.map(c => c.requestKey));
  for (const [key, selected] of Object.entries(value)) {
    if (!controls.find(c => c.requestKey === key).choices.some(c => c.value !== undefined && c.value === selected))
      throw new Error("Undeclared assistant request value");
  }
}
