"use client";

import { Button } from "@/components/ui/button";
import { getConfig } from "@/lib/config";
import { cn } from "@/lib/utils";
import { AnimatePresence,motion } from "framer-motion";
import { ChevronUp,ExternalLink,Layers,X } from "lucide-react";
import { useEffect,useRef,useState } from "react";

interface TechItem {
  name: string;
  description: string;
  url: string;
  logo?: string;
  category: "platform" | "protocol" | "frontend" | "backend" | "community";
}

// Helper to get platform name dynamically — uses getConfig('appName')
// since techStack is defined at module level (outside component scope).
function getPlatformName(): string {
  return getConfig('appName');
}

// Helper to get platform description dynamically — uses hardcoded defaults
// since techStack is defined at module level (outside component scope).
function getPlatformDescription(): string {
  return "Multi-Agent Workflow Automation - Where Humans and AI agents collaborate to deliver high quality outcomes.";
}

const techStack: TechItem[] = [
  // Platform
  {
    get name() { return getPlatformName(); },
    get description() { return getPlatformDescription(); },
    url: "https://caipe.io",
    category: "platform",
  },

  // Protocols
  {
    name: "A2A Protocol",
    description: "Agent-to-Agent protocol for inter-agent communication (by Google)",
    url: "https://google.github.io/A2A/",
    category: "protocol",
  },
  {
    name: "A2UI",
    description: "Agent-to-User Interface specification for declarative UI widgets",
    url: "https://a2ui.org/",
    category: "protocol",
  },
  {
    name: "MCP",
    description: "Model Context Protocol for AI tool integration (by Anthropic)",
    url: "https://modelcontextprotocol.io/",
    category: "protocol",
  },

  // Frontend Stack
  {
    name: "Next.js 15",
    description: "React framework with App Router and Server Components",
    url: "https://nextjs.org/",
    category: "frontend",
  },
  {
    name: "React 19",
    description: "JavaScript library for building user interfaces",
    url: "https://react.dev/",
    category: "frontend",
  },
  {
    name: "TypeScript",
    description: "Typed superset of JavaScript for better developer experience",
    url: "https://www.typescriptlang.org/",
    category: "frontend",
  },
  {
    name: "Tailwind CSS",
    description: "Utility-first CSS framework for rapid UI development",
    url: "https://tailwindcss.com/",
    category: "frontend",
  },
  {
    name: "Radix UI",
    description: "Unstyled, accessible UI components for React",
    url: "https://www.radix-ui.com/",
    category: "frontend",
  },
  {
    name: "Zustand",
    description: "Lightweight state management for React applications",
    url: "https://zustand-demo.pmnd.rs/",
    category: "frontend",
  },
  {
    name: "Framer Motion",
    description: "Production-ready animation library for React",
    url: "https://www.framer.com/motion/",
    category: "frontend",
  },
  {
    name: "Sigma.js",
    description: "JavaScript library for graph visualization and analysis",
    url: "https://www.sigmajs.org/",
    category: "frontend",
  },
  {
    name: "NextAuth.js",
    description: "Authentication for Next.js applications with OAuth 2.0 support",
    url: "https://next-auth.js.org/",
    category: "frontend",
  },

  // Backend Stack
  {
    name: "LangGraph",
    description: "Framework for building stateful, multi-actor applications with LLMs",
    url: "https://langchain-ai.github.io/langgraph/",
    category: "backend",
  },
  {
    name: "Python 3.14",
    description: "Backend agent implementation with asyncio support",
    url: "https://www.python.org/",
    category: "backend",
  },

  // Community
  {
    name: "CNOE",
    description: "Cloud Native Operational Excellence - Open source IDP reference implementations",
    url: "https://cnoe.io/",
    category: "community",
  },
];

const categoryLabels: Record<TechItem["category"], string> = {
  platform: "Platform",
  protocol: "Protocols",
  frontend: "Frontend",
  backend: "Backend",
  community: "Community",
};

const categoryColors: Record<TechItem["category"], string> = {
  platform: "from-[hsl(173,80%,40%)] to-[hsl(173,80%,30%)]",
  protocol: "from-purple-500 to-purple-600",
  frontend: "from-blue-500 to-blue-600",
  backend: "from-orange-500 to-orange-600",
  community: "from-green-500 to-green-600",
};

interface TechStackButtonProps {
  variant?: "floating" | "compact";
}

export function TechStackButton({ variant = "floating" }: TechStackButtonProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  // Group by category
  const grouped = techStack.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {} as Record<TechItem["category"], TechItem[]>);

  const isCompact = variant === "compact";

  return (
    <div className={cn("z-50", isCompact ? "relative" : "fixed bottom-4 left-4")} ref={panelRef}>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: isCompact ? -10 : 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: isCompact ? -10 : 20, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className={cn(
              "absolute w-80 max-h-[70vh] overflow-hidden rounded-xl bg-card border border-border shadow-2xl",
              isCompact
                ? "top-full right-0 mt-2"
                : "bottom-full left-0 mb-2"
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-border bg-muted/30">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg gradient-primary-br">
                  <Layers className="h-4 w-4 text-white" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm">Technology Stack</h3>
                  <p className="text-[10px] text-muted-foreground">Powered by open standards</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content */}
            <div className="p-2 max-h-[50vh] overflow-y-auto">
              {(["platform", "protocol", "frontend", "backend", "community"] as const).map((category) => (
                grouped[category] && (
                  <div key={category} className="mb-3 last:mb-0">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-2 mb-1">
                      {categoryLabels[category]}
                    </p>
                    <div className="space-y-1">
                      {grouped[category].map((tech) => (
                        <a
                          key={tech.name}
                          href={tech.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-start gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors group"
                        >
                          <div className={cn(
                            "w-8 h-8 rounded-lg bg-gradient-to-br flex items-center justify-center shrink-0 text-white text-xs font-bold",
                            categoryColors[tech.category]
                          )}>
                            {tech.name.slice(0, 2).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-sm group-hover:text-primary transition-colors">
                                {tech.name}
                              </span>
                              <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">
                              {tech.description}
                            </p>
                          </div>
                        </a>
                      ))}
                    </div>
                  </div>
                )
              ))}
            </div>

            {/* Footer */}
            <div className="p-2 border-t border-border bg-muted/20">
              <p className="text-[10px] text-center text-muted-foreground">
                Built with ❤️ by the{" "}
                <a
                  href="https://caipe.io/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  caipe.io
                </a>{" "}
                OSS community
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toggle Button */}
      <motion.button
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-2 transition-all",
          isCompact
            ? cn(
                "px-2.5 py-1 rounded-full text-xs font-medium",
                open
                  ? "bg-primary/15 text-primary border border-primary/30"
                  : "bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-muted"
              )
            : cn(
                "px-3 py-2 rounded-full border",
                open
                  ? "bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/30"
                  : "bg-card/90 backdrop-blur-sm border-border hover:border-primary/50 hover:shadow-lg text-muted-foreground hover:text-foreground"
              )
        )}
        whileHover={{ scale: isCompact ? 1 : 1.02 }}
        whileTap={{ scale: 0.98 }}
      >
        <span className={cn(
          "rounded-full gradient-primary",
          isCompact ? "w-1.5 h-1.5" : "w-2 h-2"
        )} />
        <span className="text-xs font-medium">{isCompact ? "Tech" : "Powered By"}</span>
        <ChevronUp className={cn(
          "h-3 w-3 transition-transform",
          open ? (isCompact ? "rotate-0" : "rotate-180") : (isCompact ? "rotate-180" : "rotate-0")
        )} />
      </motion.button>
    </div>
  );
}
