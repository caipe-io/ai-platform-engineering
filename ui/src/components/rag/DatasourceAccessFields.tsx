"use client";

import { cn } from "@/lib/utils";
import { Search, Users } from "lucide-react";
import type { ReactNode } from "react";

interface DatasourceAccessFieldsProps {
  ownerControl: ReactNode;
  searchControl: ReactNode;
  ownerDescription: ReactNode;
  searchDescription: ReactNode;
  ownerDetails?: ReactNode;
  searchDetails?: ReactNode;
  className?: string;
}

export function DatasourceAccessFields({
  ownerControl,
  searchControl,
  ownerDescription,
  searchDescription,
  ownerDetails,
  searchDetails,
  className,
}: DatasourceAccessFieldsProps) {
  return (
    <div
      className={cn(
        "space-y-4 rounded-lg border border-border/60 p-4",
        className,
      )}
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Users
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span>Owner</span>
        </div>
        <div className="max-w-md">{ownerControl}</div>
        <div className="text-xs text-muted-foreground">{ownerDescription}</div>
        {ownerDetails}
      </div>

      <div className="space-y-2 border-t border-border/60 pt-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Search
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span>Search</span>
        </div>
        <div className="max-w-xl">{searchControl}</div>
        <div className="text-xs text-muted-foreground">
          {searchDescription}
        </div>
        {searchDetails}
      </div>
    </div>
  );
}
