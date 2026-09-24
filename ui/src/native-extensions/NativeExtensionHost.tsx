"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { HeaderBreadcrumbPortal } from "@/components/layout/HeaderBreadcrumbSlot";
import { WorkspaceBreadcrumbs } from "@/components/layout/WorkspacePageHeader";
import { installedNativeExtensions } from "./installed.generated";
import type { NativeExtensionBreadcrumb } from "./types";

export function NativeExtensionHost({
  children,
  extensionId,
}: {
  children?: React.ReactNode;
  extensionId: string;
}): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const extension = useMemo(
    () =>
      installedNativeExtensions.find(
        (candidate) => candidate.manifest.id === extensionId,
      ),
    [extensionId],
  );
  const [breadcrumbs, setBreadcrumbs] = useState<
    NativeExtensionBreadcrumb[]
  >(() =>
    extension
      ? [
          { label: "Home", href: "/" },
          {
            label: extension.manifest.navigation.label,
            href: extension.manifest.navigation.href,
          },
        ]
      : [],
  );
  const navigate = useCallback(
    (href: string) => router.push(href, { scroll: false }),
    [router],
  );

  useEffect(() => {
    if (typeof performance.mark === "function") {
      performance.mark(`caipe-native-extension:${extensionId}:route-ready`);
    }
  }, [extensionId, pathname, search]);

  if (!extension) {
    return (
      <div className="p-6 text-sm text-destructive">
        Native extension is not installed.
      </div>
    );
  }

  const Component = extension.module.Component;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-native-extension={extensionId}>
      <HeaderBreadcrumbPortal>
        <WorkspaceBreadcrumbs breadcrumbs={breadcrumbs} portal={false} />
      </HeaderBreadcrumbPortal>
      <Component
        apiBasePath={extension.manifest.api.basePath}
        pathname={pathname}
        search={search}
        navigate={navigate}
        setBreadcrumbs={setBreadcrumbs}
      />
      {children}
    </div>
  );
}
