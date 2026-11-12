"use client";

import { RemoteAgentRegistry, type RemoteAgentsPickerProps } from "./RemoteAgentRegistry";

export function RemoteAgentsPicker(props: RemoteAgentsPickerProps) {
  return <RemoteAgentRegistry selection={props} />;
}
