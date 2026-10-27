/** Current release and explicit legacy support; safe to import in the browser. */
export const CONTRACT_VERSION = "2.0";
export const LEGACY_NATIVE_CONTRACT_VERSION = "1.1";
export const CHECKER_VERSION = "2.0.0-rc.1";

export function isSupportedNativeContractVersion(version) {
  return version === CONTRACT_VERSION || version === LEGACY_NATIVE_CONTRACT_VERSION;
}
