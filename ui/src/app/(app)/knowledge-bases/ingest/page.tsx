"use client";

import IngestView from "@/components/rag/IngestView";
import { motion } from "framer-motion";

function IngestPage() {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <motion.div
        key="ingest"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="min-h-0 flex-1 overflow-hidden"
      >
        <IngestView />
      </motion.div>
    </div>
  );
}

export default function Ingest() {
  return <IngestPage />;
}
