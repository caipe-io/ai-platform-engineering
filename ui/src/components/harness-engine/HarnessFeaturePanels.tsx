"use client";

import type { ReactNode } from "react";
import { harnessBuilderSections, supportsHarnessCapability, type HarnessRenderer } from "@/lib/harness-builder";
import type { HarnessDescriptor } from "@/types/harness-engine";

/** Server descriptors choose among reviewed host panels, never executable UI. */
export function HarnessFeaturePanels({ descriptor, step, panels }: {
  descriptor?: HarnessDescriptor;
  step: string;
  panels: Partial<Record<HarnessRenderer, ReactNode>>;
}) {
  if (!descriptor) return <>{Object.values(panels)}</>;
  let sections;
  try { sections = harnessBuilderSections(descriptor); }
  catch (error) { return <p role="alert">{error instanceof Error ? error.message : "Unsupported editor"}</p>; }
  return <>{sections.filter(section => section.step === step).map(section => {
    const supported = section.requires.every(capability => supportsHarnessCapability(descriptor, capability));
    return <div key={section.id}>
      {!supported && <p role="alert">{section.title} is unavailable for the selected harness.</p>}
      <fieldset disabled={!supported}>{panels[section.renderer] ?? <p role="alert">This editor panel is unavailable.</p>}</fieldset>
    </div>;
  })}</>;
}
