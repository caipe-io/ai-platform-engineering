/** Shared publisher/runtime validation for native packages and iframe messages. */
export const ASSISTANT_EXTENSIONS = Object.freeze(["configuration.v1", "choices.v1", "presentation.v1", "messageActions.v1"]);
export const MESSAGE_ACTION_ICONS = Object.freeze(["flag", "bookmark", "check", "star", "clipboard", "send"]);
export const MAX_MESSAGE_ACTIONS = 4;
export const MAX_MESSAGE_ACTION_LABEL = 24;
export const MAX_MESSAGE_ACTION_TEXT = 60000;
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
function validateMessageActions(actions) {
  if (!Array.isArray(actions) || actions.length > MAX_MESSAGE_ACTIONS) throw new Error("Too many message actions");
  for (const action of actions) {
    object(action, ["id", "label", "icon", "path", "dialog"]);
    identifier(action.id); text(action.label, MAX_MESSAGE_ACTION_LABEL);
    if (!MESSAGE_ACTION_ICONS.includes(action.icon)) throw new Error("Unknown message action icon");
    // The manifest validator applies the route and policy rules shared with the stream paths.
    if (typeof action.path !== "string" || !action.path) throw new Error("Invalid message action path");
    if (action.dialog === undefined) continue;
    const { dialog } = action;
    object(dialog, ["title", "description", "submitLabel", "field"]);
    text(dialog.title, 80); text(dialog.submitLabel, 40);
    if (dialog.description !== undefined) text(dialog.description, 240);
    object(dialog.field, ["label", "prefill", "optional", "maxLength"]);
    text(dialog.field.label, 80);
    if (!["message", "empty"].includes(dialog.field.prefill)) throw new Error("Invalid message action prefill");
    if (typeof dialog.field.optional !== "boolean") throw new Error("Invalid message action field flag");
    bounded(dialog.field.maxLength, 1, MAX_MESSAGE_ACTION_TEXT);
  }
  unique(actions.map(a => a.id));
}
export function validateAssistantOptions(value) {
  object(value, ["version", "requireConfiguration", "includeLegacyAgentHistory", "legacyConversationQueryParams", "controls", "presentation", "messageActions"]);
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
      object(control, ["id", "label", "requestKey", "defaultChoice", "choices", "kind"]);
      identifier(control.id); text(control.label); identifier(control.requestKey);
      if (control.kind !== undefined && !["select", "checkbox"].includes(control.kind)) throw new Error("Invalid assistant control kind");
      if (PROTECTED.test(control.requestKey) || !/^[a-z][a-z0-9_]*$/.test(control.requestKey)) throw new Error("Protected assistant request key");
      if (!Array.isArray(control.choices) || !control.choices.length || control.choices.length > 8) throw new Error("Invalid assistant choices");
      for (const choice of control.choices) {
        object(choice, ["id", "label", "value"]); identifier(choice.id); text(choice.label);
        if (choice.value !== undefined && !["boolean", "number", "string"].includes(typeof choice.value)) throw new Error("Invalid assistant choice value");
        if (typeof choice.value === "number" && !Number.isFinite(choice.value)) throw new Error("Invalid numeric choice");
        if (typeof choice.value === "string") text(choice.value, 200);
      }
      unique(control.choices.map(c => c.id));
      if (control.kind === "checkbox" && (control.choices.length !== 2 ||
          !control.choices.some(c => c.value === true) || !control.choices.some(c => c.value === false)))
        throw new Error("Checkbox controls require true and false choices");
      if (!control.choices.some(c => c.id === control.defaultChoice)) throw new Error("Unknown default choice");
    }
    unique(value.controls.map(c => c.id)); unique(value.controls.map(c => c.requestKey));
  }
  if (value.messageActions !== undefined) validateMessageActions(value.messageActions);
  if (value.presentation !== undefined) {
    const p = value.presentation;
    object(p, ["placeholder", "showAuditNotice", "feedbackPrompt", "fontScale", "width", "height", "showSuggestions", "suggestedPrompts"]);
    if (p.placeholder !== undefined) text(p.placeholder, 120);
    if (p.showAuditNotice !== undefined && typeof p.showAuditNotice !== "boolean") throw new Error("Invalid audit presentation");
    if (p.fontScale !== undefined && !["compact", "default", "large"].includes(p.fontScale)) throw new Error("Invalid font scale");
    if (p.width !== undefined) bounded(p.width, 480, 1180);
    if (p.height !== undefined) bounded(p.height, 560, 940);
    if (p.showSuggestions !== undefined && typeof p.showSuggestions !== "boolean") throw new Error("Invalid suggestions visibility");
    if (p.suggestedPrompts !== undefined) {
      if (!Array.isArray(p.suggestedPrompts) || p.suggestedPrompts.length > 8) throw new Error("Invalid suggested prompts");
      p.suggestedPrompts.forEach(prompt => text(prompt, 160));
    }
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
  object(value, ["version", "visible", "controls", "bottomInset", "messageActions"]);
  if (value.version !== "1.0" || typeof value.visible !== "boolean") throw new Error("Unsupported assistant configuration");
  if (value.messageActions !== undefined) {
    // Visibility is cosmetic. An id the manifest did not declare is accepted here and
    // ignored when the host decides what to show, so one stale id cannot drop the rest.
    if (!value.messageActions || typeof value.messageActions !== "object" || Array.isArray(value.messageActions))
      throw new Error("Invalid assistant option fields");
    for (const [id, state] of Object.entries(value.messageActions)) {
      identifier(id);
      object(state, ["visible"]);
      if (typeof state.visible !== "boolean") throw new Error("Invalid message action visibility");
    }
  }
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
