import type { ComponentType } from "react";

export interface NativeExtensionBreadcrumb {
  label: string;
  href?: string;
}

export interface NativeExtensionManifest {
  id: string;
  displayName: string;
  description: string;
  contractVersion: "1.0";
  hostPaths: string[];
  navigation: {
    label: string;
    href: string;
    placement: "after-chat";
    icon?: "book-open" | "layout-grid";
  };
  api: {
    appId: string;
    basePath: string;
    mounts: string[];
  };
}

export interface NativeExtensionProps {
  apiBasePath: string;
  pathname: string;
  search: string;
  navigate: (href: string) => void;
  setBreadcrumbs: (breadcrumbs: NativeExtensionBreadcrumb[]) => void;
}

export interface NativeExtensionModule {
  Component: ComponentType<NativeExtensionProps>;
  contractVersion: "1.0";
}

export interface InstalledNativeExtension {
  manifest: NativeExtensionManifest;
  module: NativeExtensionModule;
}
