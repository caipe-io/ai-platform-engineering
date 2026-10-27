export const CONTRACT_VERSION: "2.0";
export const LEGACY_NATIVE_CONTRACT_VERSION: "1.1";
export const CHECKER_VERSION: "2.0.0-rc.1";
export type NativeExtensionContractVersion =
  | typeof CONTRACT_VERSION
  | typeof LEGACY_NATIVE_CONTRACT_VERSION;
export function isSupportedNativeContractVersion(
  version: unknown,
): version is NativeExtensionContractVersion;
