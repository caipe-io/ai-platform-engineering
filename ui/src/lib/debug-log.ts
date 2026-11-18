import { getConfig } from '@/lib/config';

export function isDebugLoggingEnabled(): boolean {
  return getConfig('uiDebugLogging') === true;
}

/** console.log that only emits when `uiDebugLogging` is enabled. */
export function debugLog(...args: unknown[]): void {
  if (isDebugLoggingEnabled()) console.log(...args);
}
