import type { ComponentType } from "react";
import type Link from "next/link";

export interface NativeExtensionBreadcrumb {
  label: string;
  href?: string;
}

export interface NativeExtensionManifest {
  id: string;
  displayName: string;
  description: string;
  contractVersion: "1.1";
  hostPaths: string[];
  slots?: Array<"home">;
  navigation?: {
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
  auth: {
    mode: "app-scoped-token" | "forward-user-access-token";
  };
}

export interface NativeExtensionProps {
  apiBasePath: string;
  pathname: string;
  search: string;
  navigate: (href: string) => void;
  Link?: typeof Link;
  setBreadcrumbs: (breadcrumbs: NativeExtensionBreadcrumb[]) => void;
}

export interface NativeExtensionModule {
  Component: ComponentType<NativeExtensionProps>;
  contractVersion: "1.1";
}
