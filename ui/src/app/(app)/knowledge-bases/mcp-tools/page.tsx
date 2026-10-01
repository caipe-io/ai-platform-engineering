"use client";

import MCPToolsView from "@/components/rag/MCPToolsView";
import { motion } from "framer-motion";

function MCPToolsPage() {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <motion.div
        key="mcp-tools"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="min-h-0 flex-1 overflow-hidden"
      >
        <MCPToolsView />
      </motion.div>
    </div>
  );
}

export default function MCPTools() {
  return <MCPToolsPage />;
}
