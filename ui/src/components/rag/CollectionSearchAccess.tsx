"use client";

import { Badge } from "@/components/ui/badge";
import type {
  AccessSubjectRef,
} from "@/components/ui/access-subject-picker";
import type { RagCollectionMembershipLabel } from "@/types/rag-collection";
import { Layers3 } from "lucide-react";
import { searchTeamLabel } from "./datasource-view-state";

function accessRefKey(ref: AccessSubjectRef): string {
  return `${ref.kind}:${ref.id}`;
}

export interface CollectionDerivedSearchAccess {
  selections: AccessSubjectRef[];
  labelFor: (ref: AccessSubjectRef) => string | undefined;
}

/** Search grants supplied by collections, grouped by audience for picker use. */
export function collectionDerivedSearchAccess(
  collections: RagCollectionMembershipLabel[],
): CollectionDerivedSearchAccess {
  const collectionNamesByTeam = new Map<string, string[]>();

  for (const collection of collections) {
    for (const teamSlug of collection.reader_team_slugs ?? []) {
      const current = collectionNamesByTeam.get(teamSlug) ?? [];
      if (!current.includes(collection.name)) current.push(collection.name);
      collectionNamesByTeam.set(teamSlug, current);
    }
  }

  const labels = new Map(
    Array.from(collectionNamesByTeam, ([teamSlug, names]) => [
      accessRefKey({ kind: "team", id: teamSlug }),
      `From ${names.join(", ")}`,
    ]),
  );

  return {
    selections: Array.from(collectionNamesByTeam.keys(), (id) => ({
      kind: "team" as const,
      id,
    })),
    labelFor: (ref) => labels.get(accessRefKey(ref)),
  };
}

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
        Search from collections
      </div>
      <p className="text-xs text-muted-foreground">
        Collection access is shown in the Search list but cannot be changed
        here. Edit the collection or remove this datasource from it instead.
      </p>
      <div className="flex flex-wrap gap-2">
        {collections.map((collection) => (
          <Badge key={collection.id} variant="outline">
            {collection.name}
            {collection.reader_team_slugs.length > 0
              ? ` · ${collection.reader_team_slugs.map(searchTeamLabel).join(", ")}`
              : " · No Search access"}
          </Badge>
        ))}
      </div>
    </div>
  );
}
