import { Card,CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function AgentsListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      aria-busy="true"
      className="space-y-3"
      data-testid="agents-list-skeleton"
      role="status"
    >
      <span className="sr-only">Loading agents...</span>
      <div
        aria-hidden="true"
        className="grid grid-cols-12 gap-4 border-b px-2 pb-2 text-xs font-medium text-muted-foreground"
      >
        <div className="col-span-4">Name</div>
        <div className="col-span-2">Visibility</div>
        <div className="col-span-1">Tools</div>
        <div className="col-span-1">Grade</div>
        <div className="col-span-2">Status</div>
        <div className="col-span-2 text-right">Actions</div>
      </div>
      <Skeleton className="ml-2 h-3 w-20" />
      {Array.from({ length: rows }, (_, index) => (
        <div
          aria-hidden="true"
          className="grid grid-cols-12 items-center gap-4 rounded-lg px-2 py-3"
          key={index}
        >
          <div className="col-span-4 flex min-w-0 items-center gap-3">
            <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
          <div className="col-span-2">
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <div className="col-span-1">
            <Skeleton className="h-4 w-5" />
          </div>
          <div className="col-span-1">
            <Skeleton className="h-6 w-14 rounded-full" />
          </div>
          <div className="col-span-2">
            <Skeleton className="h-5 w-20" />
          </div>
          <div className="col-span-2 flex justify-end gap-2">
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-8 w-8 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function AgentEditorSkeleton() {
  return (
    <Card aria-busy="true" data-testid="agent-editor-skeleton" role="status">
      <CardContent className="p-6">
        <span className="sr-only">Loading agent...</span>
        <div aria-hidden="true" className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <div className="space-y-3">
            <Skeleton className="h-5 w-28" />
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton className="h-10 w-full rounded-lg" key={index} />
            ))}
          </div>
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <Skeleton className="h-12 w-12 rounded-xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-3 w-72 max-w-full" />
              </div>
            </div>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
