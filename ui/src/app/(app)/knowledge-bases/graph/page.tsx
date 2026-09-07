"use client";

import { AuthGuard } from "@/components/auth-guard";
import GraphView from "@/components/rag/GraphView";
import { NoKbAccessEmpty } from "@/components/rag/NoKbAccessEmpty";
import { useKbTabGates } from "@/hooks/use-kb-tab-gates";
import { motion } from "framer-motion";
import { useRouter,useSearchParams } from "next/navigation";

function GraphInfoBanner({
  kbCount,
  ontologyAvailable,
}: {
  kbCount: number;
  ontologyAvailable: boolean;
}) {
  return (
    <div
      role="status"
      data-testid="graph-info-banner"
      className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      <strong className="font-medium">
        {ontologyAvailable ? "Unrestricted graph access." : "Source-scoped data graph."}
      </strong>{" "}
      {ontologyAvailable
        ? "You can view the deployment-wide ontology and data graph."
        : "Only entities from knowledge bases you can read are shown. The deployment-wide ontology is limited to organization admins because it does not yet carry source-level provenance."}{" "}
      {!ontologyAvailable && kbCount >= 0 ? (
        <span className="text-xs text-amber-800/80 dark:text-amber-300/70">
          (you have Search access to {kbCount} knowledge {kbCount === 1 ? "base" : "bases"})
        </span>
      ) : null}
    </div>
  );
}

function GraphPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { gates, loading, orgAdminBypass } = useKbTabGates();

  // Derive exploreData directly from URL search params — no useState/useEffect needed.
  const entityType = searchParams?.get('entityType');
  const primaryKey = searchParams?.get('primaryKey');
  const exploreData = entityType && primaryKey ? { entityType, primaryKey } : null;

  const handleExploreComplete = () => {
    router.replace('/knowledge-bases/graph');
  };

  if (loading) {
    return <div className="flex-1 bg-background" aria-busy="true" />;
  }

  // Do not rely on sidebar visibility to secure a deep link. The RAG server
  // also enforces this boundary, but avoiding the mount prevents a flash of
  // unauthorized graph requests and gives the caller a useful empty state.
  if (!gates.graph) {
    return <NoKbAccessEmpty surface="the graph" />;
  }

  const kbCount = gates?.kb_count ?? -1;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <GraphInfoBanner
        kbCount={kbCount}
        ontologyAvailable={orgAdminBypass}
      />
      <motion.div
        key="graph"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex-1 overflow-hidden"
      >
        <GraphView
          exploreEntityData={exploreData}
          onExploreComplete={handleExploreComplete}
          allowOntology={orgAdminBypass}
        />
      </motion.div>
    </div>
  );
}

export default function Graph() {
  return (
    <AuthGuard>
      <GraphPage />
    </AuthGuard>
  );
}
