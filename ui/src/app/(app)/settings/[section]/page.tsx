import { WorkspacePageHeader } from "@/components/layout/WorkspacePageHeader";
import { SettingsWorkspace } from "@/components/settings/SettingsWorkspace";
import {
  findSettingsRouteBySegment,
  PERSONAL_SETTINGS_ROUTES,
} from "@/components/settings/settings-routes";
import { notFound } from "next/navigation";

export default async function SettingsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}): Promise<React.ReactElement> {
  const { section } = await params;
  const route = findSettingsRouteBySegment(section);
  if (!route) notFound();

  const settingsHref = PERSONAL_SETTINGS_ROUTES[0].href;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto min-h-full w-full max-w-[108rem] space-y-6 px-4 pb-6 pt-3 sm:px-6 lg:pb-8">
        <WorkspacePageHeader
          breadcrumbs={[
            { label: "Home",href: "/" },
            { label: "Settings",href: settingsHref },
            { label: route.label,href: route.href },
          ]}
          description={route.description}
          title={route.label}
        />
        <SettingsWorkspace activeRouteId={route.id} />
      </div>
    </main>
  );
}
