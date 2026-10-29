import assert from "node:assert/strict";
import test from "node:test";

import { validateAssistantConfiguration, validateAssistantOptions, validateAssistantRequestOptions } from "../../app-sdk/assistant-options.mjs";

const options = () => ({ version: "1.0", controls: [{
  id: "research", label: "Personal research", kind: "checkbox", requestKey: "personal_research", defaultChoice: "disabled",
  choices: [{ id: "disabled", label: "Disabled", value: false }, { id: "enabled", label: "Enabled", value: true }],
}] });

test("checkboxes preserve publisher-declared booleans through runtime and request validation", () => {
  const declared = options();
  validateAssistantOptions(declared);
  validateAssistantConfiguration({ version: "1.0", visible: true,
    controls: { research: { choices: ["disabled"], defaultChoice: "disabled" } } }, declared);
  validateAssistantRequestOptions({ personal_research: false }, declared);
  validateAssistantRequestOptions({ personal_research: true }, declared);
  assert.throws(() => validateAssistantRequestOptions({ personal_research: "true" }, declared));
  assert.throws(() => validateAssistantRequestOptions({ auth_token: true }, declared));
});

test("checkbox declarations require exactly one true and one false choice", () => {
  for (const values of [[false], [true, true], [false, "true"], [false, true, "extra"]]) {
    const declared = options();
    declared.controls[0].choices = values.map((value, index) => ({ id: `choice-${index}`, label: `Choice ${index}`, value }));
    declared.controls[0].defaultChoice = "choice-0";
    assert.throws(() => validateAssistantOptions(declared), /Checkbox controls/);
  }
});

test("existing selects stay compatible and unknown control kinds fail closed", () => {
  const declared = options();
  delete declared.controls[0].kind;
  validateAssistantOptions(declared);
  declared.controls[0].kind = "select";
  validateAssistantOptions(declared);
  declared.controls[0].kind = "toggle";
  assert.throws(() => validateAssistantOptions(declared), /control kind/);
});
