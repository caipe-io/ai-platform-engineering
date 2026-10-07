"use client";

import { Suspense } from "react";

import { RagCollectionsView } from "@/components/rag/RagCollectionsView";

export default function RagCollectionsPage() {
  return (
    <Suspense
      fallback={
        <div className="p-6 text-sm text-muted-foreground">
          Loading collections...
        </div>
      }
    >
      <RagCollectionsView />
    </Suspense>
  );
}
