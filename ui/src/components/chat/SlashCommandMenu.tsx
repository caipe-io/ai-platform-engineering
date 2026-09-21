"use client";

import { AGENT_LOGOS } from "@/components/shared/AgentLogos";
import { cn } from "@/lib/utils";
import { AnimatePresence,motion } from "framer-motion";
import { Bot,Terminal,Zap } from "lucide-react";
import React,{ useEffect,useRef } from "react";

export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  category: "skill" | "mcp" | "subagent" | "command";
  icon?: React.ReactNode;
  action: "insert" | "execute";
  value: string;
}

interface SlashCommandMenuProps {
  filter: string;
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  visible: boolean;
}

const CATEGORY_ORDER: SlashCommand["category"][] = ["command", "skill", "mcp", "subagent"];

const CATEGORY_LABELS: Record<SlashCommand["category"], string> = {
  command: "Commands",
  skill: "Skills",
  mcp: "MCP Servers",
  subagent: "Subagents",
};

const CATEGORY_ICONS: Record<SlashCommand["category"], React.ReactNode> = {
  command: <Terminal className="h-3 w-3" />,
  skill: <Zap className="h-3 w-3" />,
  mcp: <Bot className="h-3 w-3" />,
  subagent: <Bot className="h-3 w-3" />,
};

export function getFilteredCommands(
  commands: SlashCommand[],
  filter: string,
): SlashCommand[] {
  if (!filter) return commands;
  const q = filter.toLowerCase();
  return commands.filter(
    (c) =>
      c.label.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q),
  );
}

export function SlashCommandMenu({
  filter,
  commands,
  selectedIndex,
  onSelect,
  visible,
}: SlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  const filtered = getFilteredCommands(commands, filter);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  // Group by category in defined order
  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    items: filtered.filter((c) => c.category === cat),
  })).filter((g) => g.items.length > 0);

  // Build a flat index mapping for keyboard navigation
  const flatItems = grouped.flatMap((g) => g.items);

  if (flatItems.length === 0 && visible) {
    return (
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          className="absolute bottom-full left-0 right-0 mb-2 bg-card border border-border rounded-xl shadow-lg overflow-hidden z-50"
        >
          <div className="px-4 py-3 text-sm text-muted-foreground">
            No matching commands
          </div>
        </motion.div>
      </AnimatePresence>
    );
  }

  return (
    <AnimatePresence>
      {visible && flatItems.length > 0 && (
        <motion.div
          ref={menuRef}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          className="absolute bottom-full left-0 right-0 mb-2 bg-card border border-border rounded-xl shadow-lg overflow-hidden z-50"
        >
          <div className="max-h-72 overflow-y-auto py-1">
            {grouped.map((group, gi) => {
              // Compute flat offset for this group
              const groupOffset = grouped
                .slice(0, gi)
                .reduce((acc, g) => acc + g.items.length, 0);

              return (
                <div key={group.category}>
                  {/* Category header */}
                  <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground font-medium uppercase tracking-wide">
                    {CATEGORY_ICONS[group.category]}
                    {CATEGORY_LABELS[group.category]}
                  </div>

                  {/* Items */}
                  {group.items.map((cmd, i) => {
                    const flatIndex = groupOffset + i;
                    const isSelected = flatIndex === selectedIndex;

                    return (
                      <button
                        key={cmd.id}
                        ref={isSelected ? selectedRef : undefined}
                        onClick={() => onSelect(cmd)}
                        className={cn(
                          "w-full flex items-center gap-3 px-3 py-2 text-left transition-colors",
                          isSelected
                            ? "bg-primary/10 text-foreground"
                            : "hover:bg-muted/80 text-foreground",
                        )}
                      >
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-muted/60">
                          {cmd.icon || (
                            cmd.category === "mcp" || cmd.category === "subagent" ? (
                              (() => {
                                const agentLogo = AGENT_LOGOS[cmd.label];
                                return agentLogo?.icon ? (
                                  <div className="w-5 h-5">{agentLogo.icon}</div>
                                ) : (
                                  <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                                );
                              })()
                            ) : cmd.category === "skill" ? (
                              <Zap className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
                            )
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium font-mono">
                              {cmd.category === "mcp" || cmd.category === "subagent" ? `/@${cmd.label}` : `/${cmd.id}`}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground truncate">
                            {cmd.description}
                          </p>
                        </div>
                        {isSelected && (
                          <span className="text-[10px] text-muted-foreground/60 shrink-0">
                            Tab
                          </span>
                        )}
                      </button>
                    );
                  })}

                  {/* Separator between groups */}
                  {gi < grouped.length - 1 && (
                    <div className="mx-3 my-1 border-t border-border/40" />
                  )}
                </div>
              );
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
