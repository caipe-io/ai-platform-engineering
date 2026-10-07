"use client";

import { Tabs,TabsContent,TabsList,TabsTrigger } from "@/components/ui/tabs";
import { usePathname,useRouter,useSearchParams } from "next/navigation";
import { useCallback,useEffect } from "react";

const NO_RESET_PARAMS: string[] = [];

export interface SecurityWorkspaceTab {
  content: React.ReactNode;
  id: string;
  label: string;
}

interface SecurityWorkspaceTabsProps {
  ariaLabel: string;
  items: SecurityWorkspaceTab[];
  queryKey: string;
  resetParams?: string[];
}

export function SecurityWorkspaceTabs({
  ariaLabel,
  items,
  queryKey,
  resetParams = NO_RESET_PARAMS,
}: SecurityWorkspaceTabsProps): React.ReactElement | null {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const resetParamNames = resetParams.join("\0");
  const requestedId = searchParams.get(queryKey);
  const activeId = items.some((item) => item.id === requestedId)
    ? requestedId!
    : items[0]?.id;

  const selectTab = useCallback((nextId: string) => {
    const params = new URLSearchParams(query);
    params.set(queryKey,nextId);
    for (const key of resetParamNames.split("\0").filter(Boolean)) params.delete(key);
    const nextQuery = params.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname,{ scroll: false });
  },[pathname,query,queryKey,resetParamNames,router]);

  useEffect(() => {
    if (activeId && requestedId !== activeId) selectTab(activeId);
  },[activeId,requestedId,selectTab]);

  if (!activeId) return null;

  return (
    <Tabs className="space-y-4" onValueChange={selectTab} value={activeId}>
      <TabsList aria-label={ariaLabel}>
        {items.map((item) => (
          <TabsTrigger key={item.id} value={item.id}>{item.label}</TabsTrigger>
        ))}
      </TabsList>
      {items.map((item) => (
        <TabsContent className="space-y-4" key={item.id} value={item.id}>
          {item.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
