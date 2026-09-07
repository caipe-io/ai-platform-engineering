"use client";

import SearchView from "@/components/rag/SearchView";
import { pushWithNavigationProgress } from "@/lib/navigation-progress";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useCallback } from "react";

function SearchPage() {
  const router = useRouter();
  const handleExploreEntity = useCallback((entityType: string, primaryKey: string) => {
    // Navigate to graph view with query params
    pushWithNavigationProgress(router,`/knowledge-bases/graph?entityType=${encodeURIComponent(entityType)}&primaryKey=${encodeURIComponent(primaryKey)}`);
  }, [router]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <motion.div
        key="search"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex-1 flex flex-col min-h-0"
      >
        <SearchView onExploreEntity={handleExploreEntity} />
      </motion.div>
    </div>
  );
}

export default function Search() {
  return <SearchPage />;
}
