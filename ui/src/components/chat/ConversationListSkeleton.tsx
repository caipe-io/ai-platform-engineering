import { Skeleton } from "@/components/ui/skeleton";

interface ConversationListSkeletonProps {
  collapsed?: boolean;
  rows?: number;
}

/** Sidebar-shaped placeholders shown only while the initial chat list loads. */
export function ConversationListSkeleton({
  collapsed = false,
  rows = 6,
}: ConversationListSkeletonProps) {
  return (
    <div
      aria-busy="true"
      className="space-y-1"
      data-testid="conversation-list-skeleton"
      role="status"
    >
      <span className="sr-only">Loading conversations...</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          aria-hidden="true"
          className="flex items-center gap-2 rounded-lg p-2"
          key={index}
        >
          <Skeleton className="h-8 w-8 shrink-0 rounded-md" />
          {!collapsed && (
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className={index % 2 === 0 ? "h-3.5 w-4/5" : "h-3.5 w-2/3"} />
              <div className="flex items-center gap-1.5">
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="h-2.5 w-20" />
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
