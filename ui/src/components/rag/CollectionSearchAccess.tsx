"use client";

import { Badge } from "@/components/ui/badge";
import type { RagCollectionMembershipLabel } from "@/types/rag-collection";
import { Layers3 } from "lucide-react";

export function CollectionSearchAccessNotice({
  collections,
}: {
  collections: RagCollectionMembershipLabel[];
}) {
  if (collections.length === 0) return null;

  return (
    <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Layers3 className="h-4 w-4 text-primary" />
        Included in collections
      </div>
      <p className="text-xs text-muted-foreground">
        This datasource is a member of the collections below, but membership
        does not grant Search access on its own. Add people or teams above if
        they need to search this datasource directly.
      </p>
      <div className="flex flex-wrap gap-2">
        {collections.map((collection) => (
          <Badge key={collection.id} variant="outline">
            {collection.name}
          </Badge>
        ))}
      </div>
    </div>
  );
}
