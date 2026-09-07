"use client";

import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import {
  Database,
  FileText,
  Globe2,
  GripVertical,
  Layers3,
  Search,
  X,
} from "lucide-react";
import React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type DatasourceKind =
  | "slack"
  | "confluence"
  | "jira"
  | "webex"
  | "web"
  | "file"
  | "other";

export interface KnowledgeCardStats {
  documentCount: number;
  chunkCount: number;
}

export interface KnowledgeCardItem {
  id: string;
  name: string;
  kind: "collection" | "datasource";
  subtitle: string;
  datasourceKind?: DatasourceKind;
  stats?: KnowledgeCardStats;
  muted?: boolean;
}

export interface KnowledgeDragCandidate {
  id: string;
  kind: "collection" | "datasource";
}

interface CardTheme {
  label: string;
  border: string;
  surface: string;
  icon: string;
  labelColor: string;
}

interface KnowledgeCardHandProps {
  items: KnowledgeCardItem[];
  onRemove: (item: KnowledgeCardItem) => void;
  disabled?: boolean;
  dragCandidate?: KnowledgeDragCandidate | null;
  onDropCandidate?: (candidate: KnowledgeDragCandidate) => void;
  ariaLabel?: string;
  emptyTitle?: string;
  emptyDescription?: string;
}

interface DatasourceOptionRowProps {
  datasourceId: string;
  name: string;
  sourceType?: string;
  annotation?: string;
  muted?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  onDragStart?: React.DragEventHandler<HTMLButtonElement>;
  onDragEnd?: React.DragEventHandler<HTMLButtonElement>;
}

export const KNOWLEDGE_DRAG_TYPE = "application/x-agent-knowledge-card";
const CARD_SEARCH_THRESHOLD = 12;
const MAX_RENDERED_CARDS = 24;

const COLLECTION_THEME: CardTheme = {
  label: "Collection",
  border: "border-violet-400/60 hover:border-violet-300",
  surface:
    "bg-gradient-to-br from-violet-500/25 via-fuchsia-500/10 to-card shadow-violet-500/10",
  icon: "bg-violet-400/15 text-violet-300",
  labelColor: "text-violet-300",
};

const DATASOURCE_THEMES: Record<DatasourceKind, CardTheme> = {
  slack: {
    label: "Slack",
    border: "border-[#E01E5A]/60 hover:border-[#36C5F0]",
    surface:
      "bg-gradient-to-br from-[#4A154B]/45 via-[#36C5F0]/10 to-[#ECB22E]/10 shadow-[#4A154B]/20",
    icon: "bg-white/90 text-[#4A154B]",
    labelColor: "text-[#36C5F0]",
  },
  confluence: {
    label: "Confluence",
    border: "border-[#579DFF]/60 hover:border-[#85B8FF]",
    surface:
      "bg-gradient-to-br from-[#1868DB]/35 via-[#0C66E4]/15 to-card shadow-[#0C66E4]/15",
    icon: "bg-white/90 text-[#1868DB]",
    labelColor: "text-[#85B8FF]",
  },
  jira: {
    label: "Jira",
    border: "border-[#2684FF]/60 hover:border-[#579DFF]",
    surface:
      "bg-gradient-to-br from-[#0052CC]/35 via-[#2684FF]/15 to-card shadow-[#0052CC]/15",
    icon: "bg-white/90 text-[#0052CC]",
    labelColor: "text-[#579DFF]",
  },
  webex: {
    label: "Webex",
    border: "border-[#00BCEB]/60 hover:border-[#30D5C8]",
    surface:
      "bg-gradient-to-br from-[#00BCEB]/30 via-[#30D5C8]/15 to-card shadow-[#00BCEB]/15",
    icon: "bg-white/90 text-[#087E8B]",
    labelColor: "text-[#30D5C8]",
  },
  web: {
    label: "Web",
    border: "border-cyan-400/60 hover:border-sky-300",
    surface:
      "bg-gradient-to-br from-cyan-500/25 via-sky-500/10 to-card shadow-cyan-500/10",
    icon: "bg-cyan-400/15 text-cyan-300",
    labelColor: "text-cyan-300",
  },
  file: {
    label: "File",
    border: "border-amber-400/60 hover:border-orange-300",
    surface:
      "bg-gradient-to-br from-amber-500/25 via-orange-500/10 to-card shadow-amber-500/10",
    icon: "bg-amber-400/15 text-amber-300",
    labelColor: "text-amber-300",
  },
  other: {
    label: "Datasource",
    border: "border-slate-400/50 hover:border-slate-300",
    surface:
      "bg-gradient-to-br from-slate-500/20 via-slate-500/5 to-card shadow-slate-500/10",
    icon: "bg-slate-400/15 text-slate-300",
    labelColor: "text-slate-300",
  },
};

export function datasourceKind(
  sourceType: string | undefined,
  datasourceId: string,
): DatasourceKind {
  const value = `${sourceType ?? ""} ${datasourceId}`.toLowerCase();
  if (value.includes("slack")) return "slack";
  if (value.includes("confluence")) return "confluence";
  if (value.includes("jira")) return "jira";
  if (value.includes("webex")) return "webex";
  if (value.includes("local_file") || value.includes("local-file"))
    return "file";
  if (value.includes("web") || value.includes("url")) return "web";
  return "other";
}

export function knowledgeCardStats(
  documentCount: unknown,
  chunkCount: unknown,
): KnowledgeCardStats | undefined {
  const documents = metricCount(documentCount);
  const chunks = metricCount(chunkCount);
  return documents === undefined || chunks === undefined
    ? undefined
    : { documentCount: documents, chunkCount: chunks };
}

export function startKnowledgeDrag(
  event: React.DragEvent,
  candidate: KnowledgeDragCandidate,
): void {
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(KNOWLEDGE_DRAG_TYPE, JSON.stringify(candidate));
}

function metricCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

function DatasourceIcon({
  kind,
  className,
}: {
  kind: DatasourceKind;
  className?: string;
}) {
  const logo =
    kind === "slack"
      ? "/slack.svg"
      : kind === "confluence"
        ? "/confluence.svg"
        : kind === "jira"
          ? "/jira.svg"
          : kind === "webex"
            ? "/webex.svg"
            : null;

  if (logo) {
    return (
      // These are small, local SVG brand marks; native img avoids applying
      // Next Image optimization to assets already optimized for icon use.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logo} alt="" aria-hidden="true" className={className} />
    );
  }
  if (kind === "web") return <Globe2 className={className} />;
  if (kind === "file") return <FileText className={className} />;
  return <Database className={className} />;
}

function cardTheme(card: KnowledgeCardItem): CardTheme {
  return card.kind === "collection"
    ? COLLECTION_THEME
    : DATASOURCE_THEMES[card.datasourceKind ?? "other"];
}

function metricsLabel(stats: KnowledgeCardStats): string {
  return `${stats.documentCount.toLocaleString()} ${stats.documentCount === 1 ? "document" : "documents"} · ${stats.chunkCount.toLocaleString()} ${stats.chunkCount === 1 ? "chunk" : "chunks"}`;
}

function pointOutsideHand(
  point: { x: number; y: number },
  hand: HTMLElement,
): boolean {
  const bounds = hand.getBoundingClientRect();
  const x = point.x - window.scrollX;
  const y = point.y - window.scrollY;
  return (
    x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom
  );
}

function droppedCandidate(
  event: React.DragEvent,
  activeCandidate: KnowledgeDragCandidate | null | undefined,
): KnowledgeDragCandidate | null {
  if (activeCandidate) return activeCandidate;
  try {
    const raw = event.dataTransfer.getData(KNOWLEDGE_DRAG_TYPE);
    const parsed = JSON.parse(raw) as Partial<KnowledgeDragCandidate>;
    if (
      (parsed.kind === "collection" || parsed.kind === "datasource") &&
      typeof parsed.id === "string" &&
      parsed.id
    ) {
      return { kind: parsed.kind, id: parsed.id };
    }
  } catch {
    // Ignore unrelated drops.
  }
  return null;
}

export function KnowledgeCardHand({
  items,
  onRemove,
  disabled,
  dragCandidate,
  onDropCandidate,
  ariaLabel = "Selected knowledge",
  emptyTitle = "Drop a collection or datasource here.",
  emptyDescription = "No knowledge is currently selected.",
}: KnowledgeCardHandProps) {
  const handRef = React.useRef<HTMLDivElement>(null);
  const [dropActive, setDropActive] = React.useState(false);
  const [cardSearch, setCardSearch] = React.useState("");
  const matchingItems = React.useMemo(() => {
    const query = cardSearch.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      [
        item.name,
        item.id,
        item.subtitle,
        item.kind,
        item.datasourceKind ?? "",
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [cardSearch, items]);
  const visibleItems = matchingItems.slice(0, MAX_RENDERED_CARDS);
  const showSearch = items.length > CARD_SEARCH_THRESHOLD;

  function handleCardDragEnd(card: KnowledgeCardItem, info: PanInfo): void {
    const hand = handRef.current;
    if (hand && pointOutsideHand(info.point, hand)) onRemove(card);
  }

  return (
    <div
      ref={handRef}
      className={cn(
        "relative min-h-64 rounded-2xl border border-dashed px-4 py-6 transition-all",
        dropActive
          ? "border-primary bg-primary/10 shadow-inner shadow-primary/10"
          : "border-border/70 bg-background/45",
      )}
      aria-label={ariaLabel}
      onDragEnter={(event) => {
        if (
          !disabled &&
          onDropCandidate &&
          droppedCandidate(event, dragCandidate)
        ) {
          setDropActive(true);
        }
      }}
      onDragOver={(event) => {
        if (
          disabled ||
          !onDropCandidate ||
          !droppedCandidate(event, dragCandidate)
        ) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropActive(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        const candidate = droppedCandidate(event, dragCandidate);
        if (candidate) onDropCandidate?.(candidate);
        setDropActive(false);
      }}
    >
      {items.length > 0 ? (
        <div className="space-y-3">
          {showSearch && (
            <div className="flex items-center gap-3">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={cardSearch}
                  onChange={(event) => setCardSearch(event.target.value)}
                  placeholder="Find selected knowledge..."
                  aria-label="Find selected knowledge"
                  className="pl-9"
                />
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {cardSearch.trim()
                  ? `${matchingItems.length} of ${items.length}`
                  : `${items.length} selected`}
              </span>
            </div>
          )}
          {visibleItems.length > 0 ? (
            <div className="overflow-hidden px-3 pb-9 pt-10">
              <div
                className="relative mx-auto h-56"
                style={{
                  width: `min(100%, ${160 + Math.max(0, visibleItems.length - 1) * 120}px)`,
                }}
              >
                <TooltipProvider delayDuration={150}>
                  <AnimatePresence initial={false}>
                    {visibleItems.map((card, index) => {
                      const center = (visibleItems.length - 1) / 2;
                      const rotation = Math.max(
                        -7,
                        Math.min(7, (index - center) * 2.25),
                      );
                      const restingY = Math.abs(index - center) * 2;
                      const theme = cardTheme(card);
                      const position =
                        visibleItems.length === 1
                          ? "calc(50% - 80px)"
                          : `calc(${(index / (visibleItems.length - 1)) * 100}% - ${(index / (visibleItems.length - 1)) * 160}px)`;
                      return (
                        <motion.div
                          layout
                          drag={!disabled}
                          dragMomentum={false}
                          dragSnapToOrigin
                          key={`${card.kind}:${card.id}`}
                          initial={{
                            opacity: 0,
                            y: 28,
                            rotate: rotation - 8,
                            scale: 0.88,
                          }}
                          animate={{
                            opacity: 1,
                            y: restingY,
                            rotate: rotation,
                            scale: 1,
                          }}
                          whileHover={
                            disabled
                              ? undefined
                              : {
                                  y: restingY - 28,
                                  rotate: rotation * 0.2,
                                  scale: 1.04,
                                  zIndex: 30,
                                }
                          }
                          whileDrag={{ scale: 1.07, rotate: 0, zIndex: 50 }}
                          exit={{ opacity: 0, y: 28, scale: 0.88 }}
                          transition={{
                            type: "spring",
                            stiffness: 360,
                            damping: 28,
                          }}
                          onDragEnd={(_event, info) =>
                            handleCardDragEnd(card, info)
                          }
                          className={cn(
                            "absolute top-0",
                            disabled
                              ? "cursor-default"
                              : "cursor-grab active:cursor-grabbing",
                          )}
                          style={{ left: position }}
                          data-testid={`knowledge-card-${card.kind}-${card.id}`}
                        >
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                className={cn(
                                  "group relative isolate h-56 w-40 overflow-hidden rounded-xl border-2 bg-card p-3 shadow-lg transition-[border-color,box-shadow,filter] hover:brightness-110 hover:shadow-2xl",
                                  theme.border,
                                  card.muted &&
                                    "border-slate-500/50 grayscale saturate-0 hover:border-slate-400",
                                )}
                                data-knowledge-card-surface="true"
                                tabIndex={0}
                                aria-label={`Knowledge card: ${card.name}`}
                              >
                                <div
                                  aria-hidden="true"
                                  className={cn(
                                    "pointer-events-none absolute inset-0",
                                    theme.surface,
                                  )}
                                />
                                <div className="relative z-10 flex items-start gap-2">
                                  <div
                                    className={cn(
                                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                                      theme.icon,
                                    )}
                                  >
                                    {card.kind === "collection" ? (
                                      <Layers3 className="h-5 w-5" />
                                    ) : (
                                      <DatasourceIcon
                                        kind={card.datasourceKind ?? "other"}
                                        className="h-5 w-5 object-contain"
                                      />
                                    )}
                                  </div>
                                  <span
                                    className={cn(
                                      "mt-1 min-w-0 flex-1 truncate text-[10px] font-bold uppercase tracking-widest",
                                      theme.labelColor,
                                    )}
                                  >
                                    {theme.label}
                                  </span>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Remove ${card.name}`}
                                    onPointerDown={(event) =>
                                      event.stopPropagation()
                                    }
                                    onClick={() => onRemove(card)}
                                    disabled={disabled}
                                    className="h-7 w-7 shrink-0 opacity-65 hover:bg-background/40 hover:text-destructive group-hover:opacity-100"
                                  >
                                    <X className="h-4 w-4" />
                                  </Button>
                                </div>
                                <p className="relative z-10 mt-8 line-clamp-2 text-sm font-semibold">
                                  {card.name}
                                </p>
                                <p className="relative z-10 mt-2 line-clamp-2 text-[11px] text-muted-foreground">
                                  {card.subtitle}
                                </p>
                                {card.stats && (
                                  <p className="absolute inset-x-3 bottom-3 z-10 truncate text-[9px] text-muted-foreground">
                                    {metricsLabel(card.stats)}
                                  </p>
                                )}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent
                              side="top"
                              sideOffset={8}
                              className="max-w-xs whitespace-normal break-words text-left"
                            >
                              <p className="font-medium">{card.name}</p>
                              {card.stats && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {metricsLabel(card.stats)}
                                </p>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </TooltipProvider>
              </div>
              {matchingItems.length > visibleItems.length && (
                <p className="mt-3 text-center text-xs text-muted-foreground">
                  Showing {visibleItems.length} of {matchingItems.length}.
                  Search to find another item.
                </p>
              )}
            </div>
          ) : (
            <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
              No selected knowledge matches this search.
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-28 flex-col items-center justify-center rounded-xl text-center text-muted-foreground">
          <Layers3 className="mb-2 h-8 w-8 opacity-50" />
          <p className="text-sm font-medium">{emptyTitle}</p>
          <p className="mt-1 text-xs">{emptyDescription}</p>
        </div>
      )}
    </div>
  );
}

export function DatasourceOptionRow({
  datasourceId,
  name,
  sourceType,
  annotation,
  muted,
  disabled,
  title,
  onClick,
  onDragStart,
  onDragEnd,
}: DatasourceOptionRowProps) {
  const kind = datasourceKind(sourceType, datasourceId);
  const theme = DATASOURCE_THEMES[kind];
  return (
    <button
      type="button"
      draggable={!disabled}
      disabled={disabled}
      title={title}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={cn(
        "group flex w-full min-w-0 items-center gap-3 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50",
        muted && "border-slate-500/30 bg-muted/30 text-muted-foreground",
      )}
    >
      <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/40" />
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
          theme.icon,
        )}
      >
        <DatasourceIcon kind={kind} className="h-4 w-4 object-contain" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        {annotation && (
          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
            {annotation}
          </span>
        )}
      </span>
      <span
        className={cn(
          "shrink-0 text-[10px] font-semibold uppercase tracking-wide",
          theme.labelColor,
        )}
      >
        {theme.label}
      </span>
    </button>
  );
}
