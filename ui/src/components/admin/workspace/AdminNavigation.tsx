"use client";

import {
  WorkspaceHierarchicalNavigationList,
  type WorkspaceNavigationCategory,
  type WorkspaceNavigationGroup,
} from "@/components/layout/WorkspaceNavigation";
import type {
  AdminCategoryDefinition,
  AdminDestinationDefinition,
} from "@/components/admin/workspace/admin-routes";

interface AdminNavigationProps {
  activeDestination?: AdminDestinationDefinition;
  categories: AdminCategoryDefinition[];
  searchParams: URLSearchParams;
}

export function adminDestinationHref(
  destination: AdminDestinationDefinition,
  searchParams: URLSearchParams,
  activeDestinationId: AdminDestinationDefinition["id"],
): string {
  const params = new URLSearchParams(searchParams.toString());
  if (destination.id === "stats" && activeDestinationId !== "stats") {
    params.set("dateRange", "30d");
    params.delete("from");
    params.delete("to");
  }
  if (destination.id !== "access-explorer") {
    params.delete("subtab");
    params.delete("openfgaTab");
  }
  const query = params.toString();
  return query ? `${destination.href}?${query}` : destination.href;
}

function destinationGroups(
  category: AdminCategoryDefinition,
  searchParams: URLSearchParams,
  activeDestinationId: AdminDestinationDefinition["id"],
): WorkspaceNavigationGroup[] {
  return [{
    id: `${category.id}-destinations`,
    items: category.destinations.map((destination) => ({
      ...destination,
      href: adminDestinationHref(destination, searchParams, activeDestinationId),
    })),
  }];
}

export function AdminNavigation({
  activeDestination,
  categories,
  searchParams,
}: AdminNavigationProps): React.ReactElement {
  const navigationCategories: WorkspaceNavigationCategory[] = categories.map(
    (category) => ({
      id: category.id,
      label: category.label,
      icon: category.icon,
      groups: destinationGroups(
        category,
        searchParams,
        activeDestination?.id ?? categories[0]?.destinations[0]?.id ?? "users",
      ),
    }),
  );
  const activeCategory = activeDestination ? categories.find((category) =>
    category.destinations.some(
      (destination) => destination.id === activeDestination.id,
    ),
  ) : undefined;

  return (
    <WorkspaceHierarchicalNavigationList
      activeCategoryId={
        activeDestination
          ? activeCategory?.id ?? categories[0]?.id ?? ""
          : ""
      }
      activeItemId={activeDestination?.id ?? ""}
      categories={navigationCategories}
      navigationLabel="Admin sections"
    />
  );
}
