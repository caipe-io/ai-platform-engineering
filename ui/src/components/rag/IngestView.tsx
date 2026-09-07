"use client";

import { getErrorMessage } from "@/lib/error-utils";
import { RagApiError } from "@/lib/rag-api";
import {
  normalizeRagIngestorLimits,
  type RagIngestorLimits,
} from "@/lib/rag-ingestor-limits";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TeamMultiPicker, TeamPicker } from "@/components/ui/team-picker";
import { useToast } from "@/components/ui/toast";
import { Permission, useRagPermissions } from "@/hooks/useRagPermissions";
import {
  cn,
  DEFAULT_RELOAD_INTERVAL,
  formatFreshUntil,
  formatNextReload,
  formatRelativeTime,
  isRefreshOverdue,
} from "@/lib/utils";
import { AnimatePresence, motion } from "framer-motion";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Eraser,
  FileText,
  HelpCircle,
  Info,
  Layers,
  Link as LinkIcon,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings,
  StopCircle,
  Trash2,
  X,
} from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { IngestionSourceConfigWithPermissions } from "@/types/ingestion-source";
import type {
  PendingPublicationRequestView,
  PublicationRequestDocument,
} from "@/types/publication-approval";
import { DatasourceAccessBadges } from "./DatasourceAccessBadges";
import { DatasourceAccessFields } from "./DatasourceAccessFields";
import { WorkspacePageActions } from "@/components/layout/WorkspacePageActions";
import {
  dataSourceFilterProjection,
  datasourceTypeLabel,
  matchesDatasourceFilters,
  parseDatasourceViewState,
  searchAccessFilterLabel,
  sameDatasourceViewState,
  serializeDatasourceViewState,
  sourceConfigFilterProjection,
  type DatasourceViewState,
} from "./datasource-view-state";
import { FileUploadDropzone } from "./FileUploadDropzone";
import { IngestionSourceCard } from "./IngestionSourceCard";
import { IngestionSourceForm } from "./IngestionSourceForm";
import { KbSharingPanel } from "./KbSharingPanel";
import { ReuploadFileModal } from "./ReuploadFileModal";
import { useFileUploadSelection } from "./useFileUploadSelection";
import type { DataSourceInfo, IngestionJob, IngestorInfo } from "./Models";
import type {
  ChunkInfo,
  DatasourceDocumentsResponse,
  DocumentInfo,
} from "./api/index";
import {
  cleanupDataSource,
  deleteDataSource,
  getChunkContent,
  getDatasourceDocuments,
  getDataSources,
  getIngestors,
  getJobsBatch,
  getJobsByDataSource,
  getJobStatus,
  ingestLocalFile,
  ingestUrl,
  reloadDataSource,
  renameDataSource,
  reuploadLocalFile,
  terminateJob,
} from "./api/index";
import {
  getIconForType,
  INGESTOR_HEARTBEAT_MAX_AGE_SECONDS,
  ingestTypeConfigs,
  isIngestTypeAvailable,
  isIngestorOnline,
  supportsReupload,
  supportsScheduledReload,
} from "./typeConfig";

// Helper component to render icon (either emoji or SVG image)
const IconRenderer = ({
  icon,
  className = "w-5 h-5",
}: {
  icon: string;
  className?: string;
}) => {
  const isEmoji = !icon.startsWith("/");

  if (isEmoji) {
    return <span className="text-lg">{icon}</span>;
  }

  return (
    <Image
      src={icon}
      alt=""
      width={20}
      height={20}
      className={className}
      style={{ display: "inline-block" }}
    />
  );
};

// Status badge component with consistent styling
const StatusBadge = ({ status }: { status: string }) => {
  const getStatusConfig = (status: string) => {
    switch (status) {
      case "completed":
        return {
          className: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
          icon: <CheckCircle2 className="h-3 w-3" />,
        };
      case "failed":
      case "terminated":
        return {
          className: "bg-destructive/20 text-destructive border-destructive/30",
          icon: <AlertCircle className="h-3 w-3" />,
        };
      case "completed_with_errors":
        return {
          className: "bg-orange-500/20 text-orange-400 border-orange-500/30",
          icon: <AlertCircle className="h-3 w-3" />,
        };
      case "in_progress":
        return {
          className: "bg-primary/20 text-primary border-primary/30",
          icon: <Loader2 className="h-3 w-3 animate-spin" />,
        };
      case "pending":
        return {
          className: "bg-muted text-muted-foreground border-border",
          icon: <Clock className="h-3 w-3" />,
        };
      default:
        return {
          className: "bg-muted text-muted-foreground border-border",
          icon: null,
        };
    }
  };

  const config = getStatusConfig(status);
  const formatStatus = (status: string): string => {
    return status
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border",
        config.className,
      )}
    >
      {config.icon}
      {formatStatus(status)}
    </span>
  );
};

const DataSourceListSkeleton = ({ rows = 6 }: { rows?: number }) => (
  <div
    className="space-y-2"
    data-testid="datasource-list-skeleton"
    role="status"
    aria-label="Loading data sources"
  >
    <span className="sr-only">Loading data sources</span>
    {Array.from({ length: rows }, (_, index) => (
      <div
        key={index}
        className="flex min-h-[58px] items-center gap-3 rounded-lg border border-border px-4 py-3"
      >
        <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
        <Skeleton className="h-5 w-5 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-[min(16rem,45%)]" />
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="hidden h-5 w-28 rounded-full sm:block" />
          </div>
          <div className="flex items-center gap-3">
            <Skeleton className="h-3 w-36" />
            <Skeleton className="hidden h-3 w-24 sm:block" />
          </div>
        </div>
        <Skeleton className="hidden h-3 w-32 md:block" />
        <Skeleton className="h-5 w-20 shrink-0 rounded-full" />
        <Skeleton className="h-8 w-8 shrink-0 rounded-md" />
      </div>
    ))}
  </div>
);

// Progress bar component with gradient
const ProgressBar = ({
  progress,
  total,
  current,
}: {
  progress: number;
  total: number;
  current: number;
}) => {
  return (
    <div className="flex items-center gap-2 mt-2">
      <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
        <motion.div
          className="h-full rounded-full gradient-primary-br"
          initial={{ width: 0 }}
          animate={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
          transition={{ duration: 0.3 }}
        />
      </div>
      <span className="text-xs font-medium text-muted-foreground whitespace-nowrap tabular-nums">
        {current}/{total} ({Math.round(progress)}%)
      </span>
    </div>
  );
};

export default function IngestView() {
  const { hasPermission } = useRagPermissions();
  const canIngest = hasPermission(Permission.INGEST);
  const canDelete = hasPermission(Permission.DELETE);
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsSignature = searchParams.toString();
  const [viewState, setViewState] = useState<DatasourceViewState>(() =>
    parseDatasourceViewState(searchParams),
  );

  const replaceViewState = useCallback(
    (next: DatasourceViewState) => {
      setViewState(next);
      const params = serializeDatasourceViewState(next).toString();
      router.replace(`${pathname}${params ? `?${params}` : ""}`, {
        scroll: false,
      });
    },
    [pathname, router],
  );

  const updateViewState = useCallback(
    (patch: Partial<DatasourceViewState>) => {
      replaceViewState({ ...viewState, ...patch });
    },
    [replaceViewState, viewState],
  );

  // Keep browser back/forward navigation authoritative. All mutations below
  // use replaceViewState, so this effect does not need a competing state→URL
  // synchronization loop.
  useEffect(() => {
    const next = parseDatasourceViewState(
      new URLSearchParams(searchParamsSignature),
    );
    setViewState((current) =>
      sameDatasourceViewState(current, next) ? current : next,
    );
  }, [searchParamsSignature]);

  const {
    ingestType,
    sourceTypes: selectedSourceTypes,
    owners: selectedOwners,
    searchAccess: selectedSearchAccess,
    query: searchQuery,
    page: currentPage,
  } = viewState;

  // "Manage source" dialog for editing an existing structured source — who
  // can edit/reload/delete the source itself, not who can find it in search.
  // New sources are configured inline in the Ingest section.
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [editingSourceConfig, setEditingSourceConfig] =
    useState<IngestionSourceConfigWithPermissions | null>(null);
  const [openingSourceConfigId, setOpeningSourceConfigId] = useState<
    string | null
  >(null);

  // Legacy/direct datasource whose unified management/access dialog is open.
  const [sharingDatasource, setSharingDatasource] =
    useState<DataSourceInfo | null>(null);

  // Ingestion state
  const [url, setUrl] = useState("");
  const [ingestorLimits, setIngestorLimits] = useState<RagIngestorLimits>(() =>
    normalizeRagIngestorLimits(undefined),
  );
  const {
    selectedFiles,
    addFiles: updateSelectedFiles,
    removeFile: removeSelectedFile,
    reset: resetSelectedFiles,
  } = useFileUploadSelection(ingestorLimits.file);
  const ingestSectionRef = useRef<HTMLElement | null>(null);
  const [description, setDescription] = useState("");
  const [includeSubPages, setIncludeSubPages] = useState(false);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const selectedManagedSourceType = ingestTypeConfigs[ingestType]?.sourceType;

  // Scrapy settings state (for web ingest type)
  const [crawlMode, setCrawlMode] = useState<
    "single" | "sitemap" | "recursive"
  >("sitemap");
  const [maxDepth, setMaxDepth] = useState(2);
  const [maxPages, setMaxPages] = useState(2000);
  const [renderJavascript, setRenderJavascript] = useState(false);
  const [waitForSelector, setWaitForSelector] = useState("");
  const [downloadDelay, setDownloadDelay] = useState(0.05);
  const [concurrentRequests, setConcurrentRequests] = useState(30);
  const [respectRobotsTxt, setRespectRobotsTxt] = useState(true);
  const [followExternalLinks, setFollowExternalLinks] = useState(true); // Default true since crawlMode defaults to sitemap
  const [allowNonPublicUrls, setAllowNonPublicUrls] = useState(false);
  const [allowedUrlPatterns, setAllowedUrlPatterns] = useState("");
  const [deniedUrlPatterns, setDeniedUrlPatterns] = useState("");
  const [chunkSize, setChunkSize] = useState(10000);
  const [chunkOverlap, setChunkOverlap] = useState(2000);
  const [reloadInterval, setReloadInterval] = useState<number>(86400); // Default to 24 hours
  const [isCustomReloadInterval, setIsCustomReloadInterval] = useState(false);

  // The file form is initialized before the platform config request returns.
  // Bring its defaults inside any tighter admin policy as soon as that config
  // arrives so a normal first upload does not fail on an invisible stale
  // default.
  useEffect(() => {
    setChunkSize((current) =>
      Math.min(ingestorLimits.shared.max_chunk_size, Math.max(100, current)),
    );
  }, [ingestorLimits.shared.max_chunk_size]);
  useEffect(() => {
    setChunkOverlap((current) =>
      Math.min(
        ingestorLimits.shared.max_chunk_overlap,
        Math.max(0, chunkSize - 1),
        Math.max(0, current),
      ),
    );
  }, [chunkSize, ingestorLimits.shared.max_chunk_overlap]);

  // Optional owning-team state for new file ingestions. Leaving it unset
  // creates a personal source; the endpoint still requires the caller's
  // organization-level data-source author capability.
  const [ingestOwnerTeamSlug, setIngestOwnerTeamSlug] = useState("");
  const [availableTeams, setAvailableTeams] = useState<
    { _id: string; slug: string; name: string }[]
  >([]);
  const [availableSearchTeams, setAvailableSearchTeams] = useState<
    { _id?: string; slug: string; name: string }[]
  >([]);
  const [defaultSearchTeamSlug, setDefaultSearchTeamSlug] = useState("");
  const [ingestSearchTeamSlugs, setIngestSearchTeamSlugs] = useState<string[]>(
    [],
  );

  // Ingestion source config rows (spec 2026-07-21-rag-source-config-db),
  // keyed by source_id === datasource_id so the row loop below can join
  // config (source of truth for identity/ownership) against Redis status.
  const [ingestionSourceConfigs, setIngestionSourceConfigs] = useState<
    Map<string, IngestionSourceConfigWithPermissions>
  >(new Map());
  const [loadingIngestionSourceConfigs, setLoadingIngestionSourceConfigs] =
    useState(true);
  const [pendingPublicationRequests, setPendingPublicationRequests] = useState<
    Map<string, PendingPublicationRequestView>
  >(new Map());
  const [
    loadingPendingPublicationRequests,
    setLoadingPendingPublicationRequests,
  ] = useState(true);

  // DataSources state
  const [dataSources, setDataSources] = useState<DataSourceInfo[]>([]);
  const [loadingDataSources, setLoadingDataSources] = useState(true);
  const [refreshingDataSources, setRefreshingDataSources] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [dataSourceJobs, setDataSourceJobs] = useState<
    Record<string, IngestionJob[]>
  >({});
  const [loadingInitialDataSourceJobs, setLoadingInitialDataSourceJobs] =
    useState(true);
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());

  // Ingestors state
  const [ingestors, setIngestors] = useState<IngestorInfo[]>([]);
  const [loadingIngestors, setLoadingIngestors] = useState(false);
  const [refreshingIngestors, setRefreshingIngestors] = useState(false);
  const [expandedIngestors, setExpandedIngestors] = useState<Set<string>>(
    new Set(),
  );
  const [showIngestors, setShowIngestors] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const openInlineSourceCreator = useCallback(() => {
    const currentConfig = ingestTypeConfigs[ingestType];
    const currentTypeIsAvailable =
      Boolean(currentConfig?.sourceType) &&
      isIngestTypeAvailable(ingestType, ingestors);
    const nextType = currentTypeIsAvailable
      ? ingestType
      : (Object.entries(ingestTypeConfigs).find(
          ([type, config]) =>
            Boolean(config.sourceType) &&
            isIngestTypeAvailable(type, ingestors),
        )?.[0] ?? "file");

    setEditingSourceConfig(null);
    updateViewState({ ingestType: nextType });
    requestAnimationFrame(() => {
      ingestSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }, [ingestType, ingestors, updateViewState]);

  // Confirmation dialogs state
  const [showDeleteDataSourceConfirm, setShowDeleteDataSourceConfirm] =
    useState<string | null>(null);
  const [showReIngestConfirm, setShowReIngestConfirm] = useState<string | null>(
    null,
  );
  const [showCleanupConfirm, setShowCleanupConfirm] = useState<string | null>(
    null,
  );
  const [isDeletingDataSource, setIsDeletingDataSource] = useState(false);
  const [isReIngesting, setIsReIngesting] = useState(false);
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const [reIngestError, setReIngestError] = useState<string | null>(null);
  const [showReuploadModal, setShowReuploadModal] = useState<string | null>(
    null,
  );
  const [isReuploading, setIsReuploading] = useState(false);

  const itemsPerPage = 10;

  // Jobs section state (per datasource - collapsible)
  const [expandedJobsSections, setExpandedJobsSections] = useState<Set<string>>(
    new Set(),
  );

  // Documents state (per datasource)
  const [expandedDocumentsSections, setExpandedDocumentsSections] = useState<
    Set<string>
  >(new Set());
  const [datasourceDocuments, setDatasourceDocuments] = useState<
    Record<string, DatasourceDocumentsResponse>
  >({});
  const [loadingDocuments, setLoadingDocuments] = useState<Set<string>>(
    new Set(),
  );
  const [expandedDocuments, setExpandedDocuments] = useState<Set<string>>(
    new Set(),
  );
  const [expandedChunks, setExpandedChunks] = useState<Set<string>>(new Set());
  const [chunkContents, setChunkContents] = useState<Record<string, string>>(
    {},
  );
  const [loadingChunkContent, setLoadingChunkContent] = useState<Set<string>>(
    new Set(),
  );

  // Pagination state for documents (per datasource)
  const [documentsPagination, setDocumentsPagination] = useState<
    Record<
      string,
      {
        offset: number;
        hasMore: boolean;
      }
    >
  >({});

  // Inline-rename state for data source display names (datasource_id is immutable)
  const [renamingDsId, setRenamingDsId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>("");
  const [renameSaving, setRenameSaving] = useState(false);

  const beginRename = useCallback((ds: DataSourceInfo, displayName?: string) => {
    setRenamingDsId(ds.datasource_id);
    setRenameDraft(displayName || ds.name || "");
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingDsId(null);
    setRenameDraft("");
    setRenameSaving(false);
  }, []);

  const commitRename = useCallback(
    async (datasourceId: string) => {
      const trimmed = renameDraft.trim();
      if (!trimmed) {
        cancelRename();
        return;
      }
      setRenameSaving(true);
      try {
        const sourceConfig = ingestionSourceConfigs.get(datasourceId);
        let nextName = trimmed;
        if (sourceConfig) {
          const response = await fetch(
            `/api/rag/sources/${encodeURIComponent(datasourceId)}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: trimmed }),
            },
          );
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(
              body?.error ?? `Failed to rename source (${response.status})`,
            );
          }
          setIngestionSourceConfigs((prev) => {
            const next = new Map(prev);
            next.set(datasourceId, { ...sourceConfig, name: trimmed });
            return next;
          });
        } else {
          const res = await renameDataSource(datasourceId, trimmed);
          nextName = res.name;
        }
        setDataSources((prev) =>
          prev.map((d) =>
            d.datasource_id === datasourceId ? { ...d, name: nextName } : d,
          ),
        );
        cancelRename();
      } catch (err) {
        console.error("Failed to rename data source", err);
        setRenameSaving(false);
      }
    },
    [renameDraft, cancelRename, ingestionSourceConfigs],
  );

  // Metadata modal state
  const [metadataModal, setMetadataModal] = useState<{
    isOpen: boolean;
    type: "document" | "chunk";
    title: string;
    id: string;
    metadata: Record<string, unknown>;
  } | null>(null);

  // Calculate stats
  const stats = useMemo(() => {
    const activeJobs = Object.values(dataSourceJobs)
      .flat()
      .filter(
        (job) => job.status === "in_progress" || job.status === "pending",
      ).length;
    return {
      totalDataSources: dataSources.length,
      activeJobs,
      totalIngestors: ingestors.length,
    };
  }, [dataSources, dataSourceJobs, ingestors]);

  // Config rows with no matching DataSourceInfo yet — not-yet-ingested
  // structured sources (Slack/Confluence/Jira/Webex), shown as "pending"
  // cards ahead of the ingested-datasource list.
  const pendingSourceConfigs = useMemo(() => {
    const ingestedIds = new Set(dataSources.map((ds) => ds.datasource_id));
    return Array.from(ingestionSourceConfigs.values())
      .filter((source) => !ingestedIds.has(source.source_id))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [ingestionSourceConfigs, dataSources]);

  const datasourceProjections = useMemo(
    () =>
      new Map(
        dataSources.map((datasource) => [
          datasource.datasource_id,
          dataSourceFilterProjection(
            datasource,
            ingestionSourceConfigs.get(datasource.datasource_id),
          ),
        ]),
      ),
    [dataSources, ingestionSourceConfigs],
  );
  const pendingSourceProjections = useMemo(
    () =>
      new Map(
        pendingSourceConfigs.map((source) => [
          source.source_id,
          sourceConfigFilterProjection(source),
        ]),
      ),
    [pendingSourceConfigs],
  );

  const sourceTypes = useMemo(
    () =>
      Array.from(
        new Set([
          ...Array.from(
            datasourceProjections.values(),
            (projection) => projection.sourceType,
          ),
          ...Array.from(
            pendingSourceProjections.values(),
            (projection) => projection.sourceType,
          ),
          ...selectedSourceTypes,
        ]),
      ).sort((left, right) =>
        datasourceTypeLabel(left).localeCompare(datasourceTypeLabel(right)),
      ),
    [datasourceProjections, pendingSourceProjections, selectedSourceTypes],
  );
  const ownerOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...Array.from(
            datasourceProjections.values(),
            (projection) => projection.owner,
          ).filter((owner): owner is string => Boolean(owner)),
          ...Array.from(
            pendingSourceProjections.values(),
            (projection) => projection.owner,
          ).filter((owner): owner is string => Boolean(owner)),
          ...selectedOwners,
        ]),
      ).sort(),
    [datasourceProjections, pendingSourceProjections, selectedOwners],
  );
  const searchAccessOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...Array.from(datasourceProjections.values()).flatMap(
            (projection) => projection.searchAccess,
          ),
          ...Array.from(pendingSourceProjections.values()).flatMap(
            (projection) => projection.searchAccess,
          ),
          ...selectedSearchAccess,
        ]),
      ).sort(),
    [datasourceProjections, pendingSourceProjections, selectedSearchAccess],
  );

  const hasDatasourceFilters = Boolean(
    searchQuery.trim() ||
      selectedSourceTypes.length ||
      selectedOwners.length ||
      selectedSearchAccess.length,
  );

  const filteredPendingSourceConfigs = useMemo(
    () =>
      pendingSourceConfigs.filter((source) => {
        const projection = pendingSourceProjections.get(source.source_id);
        return projection
          ? matchesDatasourceFilters(projection, viewState)
          : false;
      }),
    [pendingSourceConfigs, pendingSourceProjections, viewState],
  );

  // Filters are applied only to rows already returned by RBAC-filtered server
  // endpoints. URL parameters therefore select among visible rows; they never
  // expand what the caller is authorized to discover.
  const filteredDataSources = useMemo(() => {
    return dataSources
      .filter((datasource) => {
        const projection = datasourceProjections.get(datasource.datasource_id);
        return projection
          ? matchesDatasourceFilters(projection, viewState)
          : false;
      })
      .sort((a, b) => {
        const typeComparison = a.source_type.localeCompare(b.source_type);
        if (typeComparison !== 0) return typeComparison;
        return b.last_updated - a.last_updated;
      });
  }, [dataSources, datasourceProjections, viewState]);

  // Calculate pagination
  const totalPages = Math.ceil(filteredDataSources.length / itemsPerPage);
  const paginatedDataSources = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    return filteredDataSources.slice(startIndex, endIndex);
  }, [filteredDataSources, currentPage, itemsPerPage]);

  useEffect(() => {
    const lastPage = Math.max(1, totalPages);
    if (currentPage > lastPage) updateViewState({ page: lastPage });
  }, [currentPage, totalPages, updateViewState]);

  useEffect(() => {
    if (ingestType !== "confluence") {
      setIncludeSubPages(false);
    }
  }, [ingestType]);

  // Effect to auto-select first available ingest type when ingestors load
  useEffect(() => {
    if (ingestors.length > 0) {
      const isCurrentTypeAvailable = isIngestTypeAvailable(
        ingestType,
        ingestors,
      );

      if (!isCurrentTypeAvailable) {
        const availableType = Object.keys(ingestTypeConfigs).find((type) =>
          isIngestTypeAvailable(type, ingestors),
        );
        if (availableType) {
          updateViewState({ ingestType: availableType });
        }
      }
    }
  }, [ingestors, ingestType, updateViewState]);

  // Track previously seen datasource IDs to avoid refetching jobs on refresh
  const previousDataSourceIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const fetchJobsForNewDataSources = async () => {
      const currentIds = new Set(dataSources.map((ds) => ds.datasource_id));
      const newDataSources = dataSources.filter(
        (ds) => !previousDataSourceIds.current.has(ds.datasource_id),
      );

      previousDataSourceIds.current = currentIds;

      if (newDataSources.length === 0) {
        if (!loadingDataSources) setLoadingInitialDataSourceJobs(false);
        return;
      }

      // Use bulk API instead of per-datasource fetches to reduce server load
      // Batch in chunks of 100 (server limit)
      const datasourceIds = newDataSources.map((ds) => ds.datasource_id);
      const BATCH_SIZE = 100;
      const chunks: string[][] = [];
      for (let i = 0; i < datasourceIds.length; i += BATCH_SIZE) {
        chunks.push(datasourceIds.slice(i, i + BATCH_SIZE));
      }

      // Fetch all chunks in parallel
      try {
        const results = await Promise.all(
          chunks.map((chunk) => getJobsBatch(chunk)),
        );

        setDataSourceJobs((prev) => {
          const updated = { ...prev };
          for (const result of results) {
            for (const [datasourceId, fetchedJobs] of Object.entries(
              result.jobs,
            )) {
              // Sort by created_at descending (newest first)
              const sortedJobs = [...fetchedJobs].sort(
                (a, b) => b.created_at - a.created_at,
              );
              updated[datasourceId] = sortedJobs;
            }
          }
          return updated;
        });
      } catch (error) {
        console.error("Failed to batch fetch jobs for new datasources:", error);
      } finally {
        setLoadingInitialDataSourceJobs(false);
      }
    };
    if (!loadingDataSources) {
      void fetchJobsForNewDataSources();
    }
  }, [dataSources, loadingDataSources]);

  useEffect(() => {
    const interval = setInterval(async () => {
      // Find all datasources that have active jobs (in_progress or pending)
      const datasourcesWithActiveJobs = Object.entries(dataSourceJobs)
        .filter(([, jobs]) =>
          jobs.some(
            (job) => job.status === "in_progress" || job.status === "pending",
          ),
        )
        .map(([datasourceId]) => datasourceId);

      if (datasourcesWithActiveJobs.length === 0) {
        return;
      }

      try {
        // Batch fetch ALL jobs for datasources with active jobs (no status filter)
        // This allows us to see when jobs transition from in_progress to completed
        const result = await getJobsBatch(datasourcesWithActiveJobs);

        // Update state with the fetched jobs
        setDataSourceJobs((prev) => {
          const updated = { ...prev };
          for (const datasourceId of datasourcesWithActiveJobs) {
            const fetchedJobs = result.jobs[datasourceId] || [];
            if (fetchedJobs.length > 0) {
              // Sort by created_at descending (newest first)
              const sortedJobs = [...fetchedJobs].sort(
                (a, b) => b.created_at - a.created_at,
              );
              updated[datasourceId] = sortedJobs;
            }
          }
          return updated;
        });
      } catch (error) {
        console.error("Error batch polling job statuses:", error);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [dataSourceJobs]);

  // Helper to clear documents state for a datasource (collapse and purge cached data)
  const clearDocumentsState = useCallback((datasourceId?: string) => {
    if (datasourceId) {
      // Clear specific datasource
      setExpandedDocumentsSections((prev) => {
        const next = new Set(prev);
        next.delete(datasourceId);
        return next;
      });
      setDatasourceDocuments((prev) => {
        const next = { ...prev };
        delete next[datasourceId];
        return next;
      });
      setDocumentsPagination((prev) => {
        const next = { ...prev };
        delete next[datasourceId];
        return next;
      });
      // Clear expanded documents/chunks for this datasource
      setExpandedDocuments((prev) => {
        const next = new Set(prev);
        for (const id of prev) {
          if (id.startsWith(datasourceId)) next.delete(id);
        }
        return next;
      });
      setExpandedChunks((prev) => {
        const next = new Set(prev);
        for (const id of prev) {
          if (id.startsWith(datasourceId)) next.delete(id);
        }
        return next;
      });
      setChunkContents((prev) => {
        const filtered: Record<string, string> = {};
        for (const [id, content] of Object.entries(prev)) {
          if (!id.startsWith(datasourceId)) filtered[id] = content;
        }
        return filtered;
      });
    } else {
      // Clear all documents state
      setExpandedDocumentsSections(new Set());
      setDatasourceDocuments({});
      setDocumentsPagination({});
      setExpandedDocuments(new Set());
      setExpandedChunks(new Set());
      setChunkContents({});
    }
  }, []);

  const fetchJobsForDataSource = async (datasourceId: string) => {
    try {
      const jobs = await getJobsByDataSource(datasourceId);
      // Sort by created_at (Unix timestamp in seconds) - newest first
      const sortedJobs = jobs.sort((a, b) => b.created_at - a.created_at);
      setDataSourceJobs((prev) => ({ ...prev, [datasourceId]: sortedJobs }));
      // Clear documents state since data may have changed
      clearDocumentsState(datasourceId);
    } catch (error) {
      console.error(
        `Failed to fetch jobs for datasource ${datasourceId}:`,
        error,
      );
    }
  };

  const pollJob = async (datasourceId: string, jobId: string) => {
    try {
      const job = await getJobStatus(jobId);
      setDataSourceJobs((prev) => {
        const jobs = prev[datasourceId] || [];
        const updatedJobs = jobs.map((j) => (j.job_id === jobId ? job : j));
        return { ...prev, [datasourceId]: updatedJobs };
      });
    } catch (error) {
      console.error(`Error polling job status for ${jobId}:`, error);
    }
  };

  const fetchDataSources = async (alsoRefreshJobs = false) => {
    const isRefresh = dataSources.length > 0;
    if (isRefresh) {
      setRefreshingDataSources(true);
      // Clear all documents state on refresh since data may have changed
      clearDocumentsState();
    } else {
      setLoadingDataSources(true);
    }
    try {
      const response = await getDataSources();
      const datasources = response.datasources;
      setDataSources(datasources);

      // Optionally refresh jobs for all datasources (on manual refresh)
      // Batch in chunks of 100 (server limit)
      if (alsoRefreshJobs && datasources.length > 0) {
        try {
          const datasourceIds = datasources.map((ds) => ds.datasource_id);
          const BATCH_SIZE = 100;
          const chunks: string[][] = [];
          for (let i = 0; i < datasourceIds.length; i += BATCH_SIZE) {
            chunks.push(datasourceIds.slice(i, i + BATCH_SIZE));
          }

          const results = await Promise.all(
            chunks.map((chunk) => getJobsBatch(chunk)),
          );

          setDataSourceJobs((prev) => {
            const updated = { ...prev };
            for (const result of results) {
              for (const [datasourceId, fetchedJobs] of Object.entries(
                result.jobs,
              )) {
                const sortedJobs = [...fetchedJobs].sort(
                  (a, b) => b.created_at - a.created_at,
                );
                updated[datasourceId] = sortedJobs;
              }
            }
            return updated;
          });
        } catch (error) {
          console.error("Failed to batch refresh jobs:", error);
        }
      }
    } catch (error) {
      console.error("Failed to fetch data sources", error);
    } finally {
      setLoadingDataSources(false);
      setRefreshingDataSources(false);
    }
  };

  const fetchIngestionSourceConfigs = async () => {
    try {
      const sources: IngestionSourceConfigWithPermissions[] = [];
      const pageSize = 200;
      let offset = 0;
      while (true) {
        const res = await fetch(
          `/api/rag/sources?limit=${pageSize}&offset=${offset}`,
        );
        if (!res.ok) return;
        const body = (await res.json()) as {
          success?: boolean;
          data?: {
            sources: IngestionSourceConfigWithPermissions[];
            pagination?: {
              has_more?: boolean;
              next_offset?: number | null;
            };
          };
        };
        const page = body?.data?.sources ?? [];
        sources.push(...page);
        if (!body?.data?.pagination?.has_more) break;
        const nextOffset = body.data.pagination.next_offset;
        if (typeof nextOffset !== "number" || nextOffset <= offset) {
          throw new Error("Datasource settings pagination did not advance");
        }
        offset = nextOffset;
      }
      setIngestionSourceConfigs(new Map(sources.map((s) => [s.source_id, s])));
    } catch (error) {
      console.error("Failed to fetch ingestion source configs", error);
    } finally {
      setLoadingIngestionSourceConfigs(false);
    }
  };

  const openDatasourceManager = useCallback(
    async (
      datasource: DataSourceInfo,
      cachedConfig: IngestionSourceConfigWithPermissions | undefined,
      canManageConfig: boolean,
    ) => {
      if (cachedConfig && canManageConfig) {
        setEditingSourceConfig(cachedConfig);
        setSourceDialogOpen(true);
        return;
      }

      const shouldLoadConfig = Boolean(
        datasource.has_source_config &&
          datasource._permissions?.can_manage_source,
      );
      if (!shouldLoadConfig) {
        setSharingDatasource(datasource);
        return;
      }

      setOpeningSourceConfigId(datasource.datasource_id);
      try {
        const response = await fetch(
          `/api/rag/sources/${encodeURIComponent(datasource.datasource_id)}`,
        );
        if (!response.ok) {
          throw new Error(`Failed to load datasource settings (${response.status})`);
        }
        const body = (await response.json()) as {
          data?: IngestionSourceConfigWithPermissions;
        };
        if (!body.data?._permissions.can_manage) {
          setSharingDatasource(datasource);
          return;
        }
        const config = {
          ...body.data,
          owner_display_name:
            body.data.owner_display_name ?? datasource.owner_display_name,
          rag_collections:
            body.data.rag_collections ?? datasource.rag_collections ?? [],
        };
        setIngestionSourceConfigs((current) => {
          const next = new Map(current);
          next.set(config.source_id, config);
          return next;
        });
        setEditingSourceConfig(config);
        setSourceDialogOpen(true);
      } catch (error) {
        toast(
          getErrorMessage(error, "Failed to load datasource settings"),
          "error",
        );
      } finally {
        setOpeningSourceConfigId(null);
      }
    },
    [toast],
  );

  const fetchPendingPublicationRequests = async () => {
    try {
      const response = await fetch(
        "/api/publication-requests?mine=true&status=pending,applying&kind=rag_datasource&limit=500",
      );
      if (!response.ok) return;
      const body = await response.json() as {
        data?: { requests?: PublicationRequestDocument[] };
        requests?: PublicationRequestDocument[];
      };
      const requests = body.data?.requests ?? body.requests ?? [];
      const next = new Map<string, PendingPublicationRequestView>();
      for (const request of requests) {
        if (
          next.has(request.resource.id) ||
          (request.status !== "pending" && request.status !== "applying")
        ) continue;
        next.set(request.resource.id, {
          id: request._id,
          status: request.status,
          requested_state: request.requested_state,
          effective_state: request.effective_state,
          risk_facts: request.risk_facts,
          requester: request.requester,
          created_at: request.created_at,
        });
      }
      setPendingPublicationRequests(next);
    } catch (error) {
      console.error("Failed to fetch pending publication requests", error);
    } finally {
      setLoadingPendingPublicationRequests(false);
    }
  };

  const fetchIngestors = async () => {
    const isRefresh = ingestors.length > 0;
    if (isRefresh) {
      setRefreshingIngestors(true);
    } else {
      setLoadingIngestors(true);
    }
    try {
      const ingestorList = await getIngestors();
      setIngestors(ingestorList);
    } catch (error) {
      console.error("Failed to fetch ingestors", error);
    } finally {
      setLoadingIngestors(false);
      setRefreshingIngestors(false);
    }
  };

  const fetchDataSourcesEvent = useEffectEvent(fetchDataSources);
  const fetchIngestorsEvent = useEffectEvent(fetchIngestors);
  const fetchIngestionSourceConfigsEvent = useEffectEvent(
    fetchIngestionSourceConfigs,
  );
  const fetchPendingPublicationRequestsEvent = useEffectEvent(
    fetchPendingPublicationRequests,
  );

  useEffect(() => {
    fetchDataSourcesEvent();
    fetchIngestorsEvent();
    fetchIngestionSourceConfigsEvent();
    fetchPendingPublicationRequestsEvent();
    Promise.all([
      fetch("/api/rbac/ingest-teams").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/dynamic-agents/teams").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/admin/platform-config").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([ownerTeams, searchTeams, platformConfig]) => {
        setAvailableTeams(ownerTeams?.teams ?? []);
        setAvailableSearchTeams(
          Array.isArray(searchTeams?.data) ? searchTeams.data : [],
        );
        const limits = normalizeRagIngestorLimits(
          platformConfig?.data?.rag_ingestor_limits,
        );
        setIngestorLimits(limits);
        const configuredDefault =
          typeof platformConfig?.data?.rag_default_search_team_slug === "string"
            ? platformConfig.data.rag_default_search_team_slug.trim()
            : "";
        const effectiveDefault =
          limits.shared.max_search_teams > 0 ? configuredDefault : "";
        setDefaultSearchTeamSlug(effectiveDefault);
        setIngestSearchTeamSlugs(effectiveDefault ? [effectiveDefault] : []);
      })
      .catch(() => {});

    // Workers can register after this page's first request during a stack
    // startup. Refresh their heartbeats so source buttons recover without a
    // manual click, and so stopped workers age out of availability.
    const ingestorRefresh = window.setInterval(() => {
      fetchIngestorsEvent();
    }, 30_000);
    return () => window.clearInterval(ingestorRefresh);
  }, []);

  const toggleRow = (datasourceId: string) => {
    setExpandedRows((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(datasourceId)) {
        newSet.delete(datasourceId);
      } else {
        newSet.add(datasourceId);
      }
      return newSet;
    });
  };

  const toggleJob = (jobId: string) => {
    setExpandedJobs((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(jobId)) {
        newSet.delete(jobId);
      } else {
        newSet.add(jobId);
      }
      return newSet;
    });
  };

  const toggleIngestor = (ingestorId: string) => {
    setExpandedIngestors((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(ingestorId)) {
        newSet.delete(ingestorId);
      } else {
        newSet.add(ingestorId);
      }
      return newSet;
    });
  };

  // Jobs section toggle (per datasource)
  const toggleJobsSection = (datasourceId: string) => {
    setExpandedJobsSections((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(datasourceId)) {
        newSet.delete(datasourceId);
      } else {
        newSet.add(datasourceId);
      }
      return newSet;
    });
  };

  // Documents section toggle and fetch
  const toggleDocumentsSection = async (datasourceId: string) => {
    const isExpanding = !expandedDocumentsSections.has(datasourceId);

    setExpandedDocumentsSections((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(datasourceId)) {
        newSet.delete(datasourceId);
      } else {
        newSet.add(datasourceId);
      }
      return newSet;
    });

    // Fetch first page if expanding and not already loaded
    if (isExpanding && !datasourceDocuments[datasourceId]) {
      await fetchDocumentsPage(datasourceId, 0);
    }
  };

  const fetchDocumentsPage = async (datasourceId: string, offset: number) => {
    setLoadingDocuments((prev) => new Set(prev).add(datasourceId));

    try {
      const response = await getDatasourceDocuments(datasourceId, offset, 100);

      if (offset === 0) {
        // First page - replace
        setDatasourceDocuments((prev) => ({
          ...prev,
          [datasourceId]: response,
        }));
      } else {
        // Subsequent pages - merge documents
        setDatasourceDocuments((prev) => {
          const existing = prev[datasourceId];
          if (!existing) return prev;

          // Merge documents by document_id
          const mergedDocsMap = new Map<string, DocumentInfo>();

          // Add existing documents
          existing.documents.forEach((doc) => {
            mergedDocsMap.set(doc.document_id, {
              ...doc,
              chunks: [...doc.chunks],
            });
          });

          // Merge new documents
          response.documents.forEach((doc) => {
            if (mergedDocsMap.has(doc.document_id)) {
              // Append chunks to existing document
              mergedDocsMap.get(doc.document_id)!.chunks.push(...doc.chunks);
            } else {
              // Add new document
              mergedDocsMap.set(doc.document_id, { ...doc });
            }
          });

          return {
            ...prev,
            [datasourceId]: {
              ...response,
              documents: Array.from(mergedDocsMap.values()),
              total_documents: mergedDocsMap.size,
              total_chunks: existing.total_chunks + response.total_chunks,
            },
          };
        });
      }

      // Update pagination state
      setDocumentsPagination((prev) => ({
        ...prev,
        [datasourceId]: {
          offset: offset + response.total_chunks,
          hasMore: response.has_more,
        },
      }));
    } catch (error) {
      console.error(`Failed to fetch documents for ${datasourceId}:`, error);
    } finally {
      setLoadingDocuments((prev) => {
        const newSet = new Set(prev);
        newSet.delete(datasourceId);
        return newSet;
      });
    }
  };

  const toggleDocument = (documentId: string) => {
    setExpandedDocuments((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(documentId)) {
        newSet.delete(documentId);
      } else {
        newSet.add(documentId);
      }
      return newSet;
    });
  };

  const toggleChunk = (chunkId: string) => {
    setExpandedChunks((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(chunkId)) {
        newSet.delete(chunkId);
        // Purge content from memory when collapsing to avoid MBs of data in state
        setChunkContents((prevContents) => {
          const next = { ...prevContents };
          delete next[chunkId];
          return next;
        });
      } else {
        newSet.add(chunkId);
      }
      return newSet;
    });
  };

  const fetchChunkContent = async (chunkId: string) => {
    if (chunkContents[chunkId] || loadingChunkContent.has(chunkId)) return;

    setLoadingChunkContent((prev) => new Set(prev).add(chunkId));
    try {
      const response = await getChunkContent(chunkId);
      setChunkContents((prev) => ({
        ...prev,
        [chunkId]: response.text_content,
      }));
    } catch (error) {
      console.error(`Failed to fetch chunk content for ${chunkId}:`, error);
    } finally {
      setLoadingChunkContent((prev) => {
        const newSet = new Set(prev);
        newSet.delete(chunkId);
        return newSet;
      });
    }
  };

  // Open metadata modal for document or chunk
  const openDocumentMetadata = (doc: DocumentInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    setMetadataModal({
      isOpen: true,
      type: "document",
      title: doc.title,
      id: doc.document_id,
      metadata: {
        document_id: doc.document_id,
        title: doc.title,
        total_chunks: doc.chunks.length,
      },
    });
  };

  const openChunkMetadata = (chunk: ChunkInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    setMetadataModal({
      isOpen: true,
      type: "chunk",
      title: `Chunk ${chunk.chunk_index + 1}/${chunk.total_chunks}`,
      id: chunk.id,
      metadata: {
        id: chunk.id,
        chunk_index: chunk.chunk_index,
        total_chunks: chunk.total_chunks,
        ...chunk.metadata,
      },
    });
  };

  // Personal ownership is available to every caller who holds the
  // organization-level data-source author capability. Assigning a team is an
  // optional ownership choice, not a prerequisite for using that capability.
  const ingestOwnerTeamRequired = false;
  const ingestOwnerTeamMissing = false;

  const handleIngest = async () => {
    if (ingestType === "file" && selectedFiles.length === 0) return;
    if (ingestType !== "file" && !url) return;
    if (ingestOwnerTeamMissing) {
      toast("Select an Owner team for this datasource", "error");
      return;
    }

    try {
      const response =
        ingestType === "file"
          ? await ingestLocalFile({
              files: selectedFiles,
              description,
              owner_team_slug: ingestOwnerTeamSlug || undefined,
              search_team_slugs: ingestSearchTeamSlugs,
              chunk_size: chunkSize,
              chunk_overlap: chunkOverlap,
            })
          : await ingestUrl({
              url,
              description: description,
              ingest_type: ingestType,
              get_child_pages:
                ingestType === "confluence" ? includeSubPages : undefined,
              owner_team_slug: ingestOwnerTeamSlug || undefined,
              search_team_slugs: ingestSearchTeamSlugs,
              // ScrapySettings for web ingest type
              settings:
                ingestType === "web"
                  ? {
                      crawl_mode: crawlMode,
                      max_depth: maxDepth,
                      max_pages: maxPages,
                      render_javascript: renderJavascript,
                      wait_for_selector: waitForSelector || null,
                      download_delay: downloadDelay,
                      concurrent_requests: concurrentRequests,
                      respect_robots_txt: respectRobotsTxt,
                      follow_external_links: followExternalLinks,
                      allowed_url_patterns: allowedUrlPatterns
                        ? allowedUrlPatterns.split("\n").filter((p) => p.trim())
                        : null,
                      denied_url_patterns: deniedUrlPatterns
                        ? deniedUrlPatterns.split("\n").filter((p) => p.trim())
                        : null,
                      chunk_size: chunkSize,
                      chunk_overlap: chunkOverlap,
                      allow_non_public_urls: allowNonPublicUrls,
                    }
                  : undefined,
              reload_interval: reloadInterval,
            });
      const { datasource_id } = response;
      await Promise.all([
        fetchDataSources(),
        fetchPendingPublicationRequests(),
      ]);
      if (datasource_id) {
        await fetchJobsForDataSource(datasource_id);
        // Ownership tuples for the owning team are written server-side during
        // ingest (spec 2026-06-03) — no client-side admin kb-assignment call.
      }
      if ("_publication_request" in response && response._publication_request) {
        toast(
          "Files ingested. Broader Search access is pending approval.",
          "info",
          6000,
        );
      } else {
        toast("Files ingested.", "success");
      }
      setUrl("");
      resetSelectedFiles();
      setDescription("");
      setIngestOwnerTeamSlug("");
      setIngestSearchTeamSlugs(
        defaultSearchTeamSlug ? [defaultSearchTeamSlug] : [],
      );
    } catch (error) {
      console.error("Error ingesting data:", error);
      toast(
        `Ingestion failed: ${getErrorMessage(error, "") || "unknown error"}`,
        "error",
      );
    }
  };

  const handleDeleteDataSource = async (datasourceId: string) => {
    setIsDeletingDataSource(true);
    try {
      const sourceConfig = ingestionSourceConfigs.get(datasourceId);
      if (sourceConfig) {
        // One idempotent BFF operation purges RAG data first, then exact
        // management/query tuples and Mongo config. A retry tolerates an
        // already-deleted RAG datasource and completes the remaining cleanup.
        const res = await fetch(
          `/api/rag/sources/${encodeURIComponent(datasourceId)}?purge_data=true`,
          {
            method: "DELETE",
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            body?.error ?? `Failed to delete source config (${res.status})`,
          );
        }
      } else {
        await deleteDataSource(datasourceId);
      }
      await fetchIngestionSourceConfigs();
      fetchDataSources();
    } catch (error) {
      console.error("Error deleting data source:", error);
      toast(
        `Failed to delete data source: ${getErrorMessage(error, "") || "unknown error"}`,
        "error",
      );
    } finally {
      setIsDeletingDataSource(false);
      setShowDeleteDataSourceConfirm(null);
    }
  };

  const handleReloadDataSource = async (datasourceId: string) => {
    setIsReIngesting(true);
    setReIngestError(null);
    try {
      await reloadDataSource(datasourceId);
      await fetchDataSources();
      await fetchJobsForDataSource(datasourceId);
    } catch (error) {
      console.error("Error re-ingesting data source:", error);
      setReIngestError(getErrorMessage(error, "") || "unknown error");
    } finally {
      setIsReIngesting(false);
      setShowReIngestConfirm(null);
    }
  };

  const handleReuploadFile = async (datasourceId: string, files: File[]) => {
    setIsReuploading(true);
    try {
      await reuploadLocalFile(datasourceId, files);
      await fetchDataSources();
      await fetchJobsForDataSource(datasourceId);
      toast("File re-uploaded.", "success");
      setShowReuploadModal(null);
    } catch (error) {
      console.error("Error re-uploading file:", error);
      toast(
        `Re-upload failed: ${getErrorMessage(error, "") || "unknown error"}`,
        "error",
      );
    } finally {
      setIsReuploading(false);
    }
  };

  const handleCleanupDataSource = async (datasourceId: string) => {
    setIsCleaningUp(true);
    try {
      const result = await cleanupDataSource(datasourceId);
      // Clear documents state since cleanup may have removed chunks
      clearDocumentsState(datasourceId);
      toast(result.message, "success");
    } catch (error) {
      console.error("Error cleaning up data source:", error);
      toast(
        `Cleanup failed: ${getErrorMessage(error, "") || "unknown error"}`,
        "error",
      );
    } finally {
      setIsCleaningUp(false);
      setShowCleanupConfirm(null);
    }
  };

  const handleSaveSourceConfig = async (payload: Record<string, unknown>) => {
    const isEdit = Boolean(editingSourceConfig);
    const url = isEdit
      ? `/api/rag/sources/${encodeURIComponent(editingSourceConfig!.source_id)}`
      : "/api/rag/sources";
    const method = isEdit ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new RagApiError(
        res.status,
        res.statusText,
        body?.code,
        body?.error,
      );
    }
    const responseBody = (await res.json().catch(() => ({}))) as {
      data?: {
        status?: string;
        last_error?: string;
        _publication_request?: {
          id: string;
          status: "pending";
          reason?: string;
        };
      };
    };
    if (!isEdit && responseBody.data?.status === "failed") {
      toast(
        `Source saved, but ingestion failed to start: ${responseBody.data.last_error || "unknown error"}`,
        "error",
      );
    } else if (responseBody.data?._publication_request) {
      toast(
        isEdit
          ? "Change request submitted for approval."
          : "Source created. Broader Search access is waiting for approval.",
        "info",
        6000,
      );
    } else {
      toast(
        isEdit ? "Source updated." : "Source created and ingestion started.",
        "success",
      );
    }
    setSourceDialogOpen(false);
    setEditingSourceConfig(null);
    await Promise.all([
      fetchIngestionSourceConfigs(),
      fetchDataSources(),
      fetchPendingPublicationRequests(),
    ]);
  };

  const handleDeleteSourceConfig = async (
    source: IngestionSourceConfigWithPermissions,
  ) => {
    try {
      const res = await fetch(
        `/api/rag/sources/${encodeURIComponent(source.source_id)}?purge_data=true`,
        {
          method: "DELETE",
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `Failed to delete (${res.status})`);
      }
      toast(`Source "${source.name}" deleted.`, "success");
      await fetchIngestionSourceConfigs();
    } catch (error) {
      toast(getErrorMessage(error, "Failed to delete source"), "error");
    }
  };

  const handleRetrySourceConfig = async (
    source: IngestionSourceConfigWithPermissions,
  ) => {
    try {
      const res = await fetch(
        `/api/rag/sources/${encodeURIComponent(source.source_id)}/ingest`,
        {
          method: "POST",
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body?.error ?? `Failed to retry ingestion (${res.status})`,
        );
      }
      toast(`Ingestion restarted for "${source.name}".`, "success");
      await Promise.all([fetchIngestionSourceConfigs(), fetchDataSources()]);
    } catch (error) {
      toast(
        getErrorMessage(error, "Failed to retry source ingestion"),
        "error",
      );
      await fetchIngestionSourceConfigs();
    }
  };

  const handleTerminateJob = async (datasourceId: string, jobId: string) => {
    try {
      await terminateJob(jobId);
      await pollJob(datasourceId, jobId);
      toast("Job termination requested...", "info");
    } catch (error) {
      console.error("Error terminating job:", error);
      toast(
        `Termination failed: ${getErrorMessage(error, "") || "unknown error"}`,
        "error",
      );
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <WorkspacePageActions>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/50 px-3 py-1.5">
            <FileText className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{stats.totalDataSources}</span>
            <span className="text-xs text-muted-foreground">Sources</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/50 px-3 py-1.5">
            <Activity
              className={cn(
                "h-4 w-4",
                stats.activeJobs > 0
                  ? "animate-pulse text-primary"
                  : "text-muted-foreground",
              )}
            />
            <span className="text-sm font-medium">{stats.activeJobs}</span>
            <span className="text-xs text-muted-foreground">Active</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/50 px-3 py-1.5">
            <Server className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{stats.totalIngestors}</span>
            <span className="text-xs text-muted-foreground">Ingestors</span>
          </div>
        </div>
      </WorkspacePageActions>

      {/* Scrollable Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-6 space-y-6">
          {/* Ingest Section — hidden for users without INGEST permission */}
          {canIngest && (
            <motion.section
              ref={ingestSectionRef}
              className="bg-card rounded-xl shadow-sm border border-border p-5"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <div className="flex items-center gap-2 mb-4">
                <Plus className="h-5 w-5 text-primary" />
                <h3 className="text-base font-semibold text-foreground">
                  Ingest
                </h3>
              </div>

              {/* Ingest Type Selection - Pill Style */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Source Type
                </label>
                <div className="flex gap-2 flex-wrap">
                  {Object.entries(ingestTypeConfigs).map(([type, config]) => {
                    const isAvailable = isIngestTypeAvailable(type, ingestors);
                    return (
                      <Button
                        key={type}
                        onClick={() => {
                          if (!isAvailable) return;
                          setEditingSourceConfig(null);
                          updateViewState({ ingestType: type });
                        }}
                        disabled={!isAvailable}
                        variant={ingestType === type ? "default" : "outline"}
                        size="sm"
                        className={cn(
                          "rounded-full transition-all",
                          ingestType === type && "shadow-sm",
                          !isAvailable && "opacity-50 cursor-not-allowed",
                        )}
                        title={
                          !isAvailable
                            ? `No ${config.requiredIngestorType} ingestor available`
                            : type === "file"
                              ? "Upload files"
                              : `Configure a ${config.label} source below`
                        }
                      >
                        {config.icon && (
                          <span className="mr-1">
                            <IconRenderer
                              icon={config.icon}
                              className="w-3.5 h-3.5"
                            />
                          </span>
                        )}
                        {config.label}
                      </Button>
                    );
                  })}
                </div>
                {ingestors.length === 0 && !loadingIngestors && (
                  <p className="text-xs text-orange-400 mt-2 flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    No ingestors detected. Please ensure ingestor services are
                    running.
                  </p>
                )}
              </div>

              {ingestType !== "file" && selectedManagedSourceType ? (
                <IngestionSourceForm
                  key={selectedManagedSourceType}
                  open
                  displayMode="inline"
                  onClose={() => updateViewState({ ingestType: "file" })}
                  onSave={handleSaveSourceConfig}
                  initial={null}
                  defaultSourceType={selectedManagedSourceType}
                />
              ) : (
                <>
                  {/* File source input */}
                  <FileUploadDropzone
                    selectedFiles={selectedFiles}
                    limits={ingestorLimits.file}
                    onFilesSelected={updateSelectedFiles}
                    onRemoveFile={removeSelectedFile}
                  />

                  {/* Quick options - Crawl Mode for web */}
                    {ingestType === "web" && (
                      <div className="flex items-center gap-4 mt-2 ml-1">
                        <span className="text-sm text-muted-foreground">
                          Crawl mode:
                        </span>
                        <div className="flex gap-2">
                          {[
                            { value: "single", label: "Single Page" },
                            { value: "sitemap", label: "Sitemap" },
                            { value: "recursive", label: "Follow Links" },
                          ].map((mode) => (
                            <button
                              key={mode.value}
                              onClick={() => {
                                setCrawlMode(
                                  mode.value as
                                    | "single"
                                    | "sitemap"
                                    | "recursive",
                                );
                                // Auto-enable follow_external_links for sitemap mode since sitemaps
                                // often contain URLs pointing to a canonical domain
                                setFollowExternalLinks(
                                  mode.value === "sitemap",
                                );
                              }}
                              className={`px-3 py-1 text-xs rounded-full transition-colors ${
                                crawlMode === mode.value
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-muted text-muted-foreground hover:bg-muted/80"
                              }`}
                            >
                              {mode.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {ingestType === "confluence" && (
                      <label className="flex items-center gap-2 mt-2 ml-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={includeSubPages}
                          onChange={(e) => setIncludeSubPages(e.target.checked)}
                          className="rounded border-border text-primary focus:ring-primary h-4 w-4"
                        />
                        <span className="text-sm text-muted-foreground">
                          Include child pages
                        </span>
                      </label>
                    )}

                    {/* Description - outside advanced options */}
                    <div className="mt-3">
                      <Input
                        placeholder="Description (optional) - helps agents understand this source"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        className="w-full"
                      />
                    </div>

                  {/* Advanced settings - Animated Collapsible */}
                  <div>
                    <button
                      onClick={() =>
                        setShowAdvancedOptions(!showAdvancedOptions)
                      }
                      className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Settings className="h-4 w-4" />
                      <span>Advanced settings</span>
                      <motion.div
                        animate={{ rotate: showAdvancedOptions ? 180 : 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <ChevronDown className="h-4 w-4" />
                      </motion.div>
                    </button>

                    <AnimatePresence>
                      {showAdvancedOptions && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden"
                        >
                          <div className="mt-4 p-4 rounded-lg bg-muted/50 border border-border/50 space-y-4">
                            {/* Web-specific Scrapy settings */}
                            {ingestType === "web" && (
                              <>
                                {/* Crawl Limits */}
                                <div className="grid grid-cols-2 gap-4">
                                  <div>
                                    <label className="block text-sm font-medium text-muted-foreground mb-1">
                                      Max Pages
                                    </label>
                                    <Input
                                      type="number"
                                      min={1}
                                      max={10000}
                                      value={maxPages}
                                      onChange={(e) =>
                                        setMaxPages(Number(e.target.value))
                                      }
                                      className="w-full"
                                    />
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      Maximum pages to crawl
                                    </p>
                                  </div>
                                  {crawlMode === "recursive" && (
                                    <div>
                                      <label className="block text-sm font-medium text-muted-foreground mb-1">
                                        Max Depth
                                      </label>
                                      <Input
                                        type="number"
                                        min={1}
                                        max={10}
                                        value={maxDepth}
                                        onChange={(e) =>
                                          setMaxDepth(Number(e.target.value))
                                        }
                                        className="w-full"
                                      />
                                      <p className="mt-1 text-xs text-muted-foreground">
                                        How deep to follow links (1-10)
                                      </p>
                                    </div>
                                  )}
                                </div>

                                {/* JavaScript Rendering */}
                                <div className="space-y-2">
                                  <label className="flex items-center gap-2 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={renderJavascript}
                                      onChange={(e) =>
                                        setRenderJavascript(e.target.checked)
                                      }
                                      className="rounded border-border text-primary focus:ring-primary h-4 w-4"
                                    />
                                    <span className="text-sm font-medium text-muted-foreground">
                                      Render JavaScript (slower, for SPAs)
                                    </span>
                                  </label>
                                  {renderJavascript && (
                                    <div className="ml-6">
                                      <label className="block text-sm font-medium text-muted-foreground mb-1">
                                        Wait for selector (optional)
                                      </label>
                                      <Input
                                        type="text"
                                        placeholder="e.g. .content-loaded, #main-content"
                                        value={waitForSelector}
                                        onChange={(e) =>
                                          setWaitForSelector(e.target.value)
                                        }
                                        className="w-full"
                                      />
                                      <p className="mt-1 text-xs text-muted-foreground">
                                        CSS selector to wait for before
                                        extracting content
                                      </p>
                                    </div>
                                  )}
                                </div>

                                {/* Rate Limiting */}
                                <div className="grid grid-cols-2 gap-4">
                                  <div>
                                    <label className="block text-sm font-medium text-muted-foreground mb-1">
                                      Download Delay (seconds)
                                    </label>
                                    <Input
                                      type="number"
                                      min={0}
                                      max={10}
                                      step={0.1}
                                      value={downloadDelay}
                                      onChange={(e) =>
                                        setDownloadDelay(Number(e.target.value))
                                      }
                                      className="w-full"
                                    />
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      Delay between requests to avoid rate
                                      limiting
                                    </p>
                                  </div>
                                  <div>
                                    <label className="block text-sm font-medium text-muted-foreground mb-1">
                                      Concurrent Requests
                                    </label>
                                    <Input
                                      type="number"
                                      min={1}
                                      max={50}
                                      value={concurrentRequests}
                                      onChange={(e) =>
                                        setConcurrentRequests(
                                          Number(e.target.value),
                                        )
                                      }
                                      className="w-full"
                                    />
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      Number of parallel requests (1-50)
                                    </p>
                                  </div>
                                </div>

                                {/* Crawl Behavior */}
                                <div className="space-y-2">
                                  <label className="flex items-center gap-2 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={respectRobotsTxt}
                                      onChange={(e) =>
                                        setRespectRobotsTxt(e.target.checked)
                                      }
                                      className="rounded border-border text-primary focus:ring-primary h-4 w-4"
                                    />
                                    <span className="text-sm text-muted-foreground">
                                      Respect robots.txt
                                    </span>
                                  </label>
                                  {(crawlMode === "recursive" ||
                                    crawlMode === "sitemap") && (
                                    <label className="flex items-center gap-2 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={followExternalLinks}
                                        onChange={(e) =>
                                          setFollowExternalLinks(
                                            e.target.checked,
                                          )
                                        }
                                        className="rounded border-border text-primary focus:ring-primary h-4 w-4"
                                      />
                                      <span className="text-sm text-muted-foreground">
                                        Follow external links
                                      </span>
                                    </label>
                                  )}
                                  <label className="flex items-center gap-2 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={allowNonPublicUrls}
                                      onChange={(e) =>
                                        setAllowNonPublicUrls(e.target.checked)
                                      }
                                      className="rounded border-border text-primary focus:ring-primary h-4 w-4"
                                    />
                                    <span className="text-sm text-muted-foreground">
                                      Allow internal/private URLs (bypass SSRF
                                      protection)
                                    </span>
                                  </label>
                                </div>

                                {/* URL Patterns */}
                                {crawlMode === "recursive" && (
                                  <div className="space-y-3">
                                    {/* Restrict to this page button */}
                                    {url && (
                                      <div className="flex items-center gap-2">
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          onClick={() => {
                                            try {
                                              const parsed = new URL(url);
                                              // Build regex: escape special chars, match base path
                                              const baseUrl = `${parsed.origin}${parsed.pathname}`;
                                              const escapedPattern = `^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
                                              setAllowedUrlPatterns(
                                                escapedPattern,
                                              );
                                            } catch {
                                              // Invalid URL, ignore
                                            }
                                          }}
                                          className="text-xs"
                                        >
                                          <LinkIcon className="h-3 w-3 mr-1" />
                                          Restrict to this page
                                        </Button>
                                        <span className="text-xs text-muted-foreground">
                                          Auto-generate pattern to only crawl
                                          tabs/sections of this page
                                        </span>
                                      </div>
                                    )}

                                    <div className="grid grid-cols-2 gap-4">
                                      <div>
                                        <label className="block text-sm font-medium text-muted-foreground mb-1">
                                          Allowed URL Patterns
                                        </label>
                                        <textarea
                                          placeholder="Regex patterns (one per line)&#10;e.g. /docs/.*&#10;/api/.*"
                                          value={allowedUrlPatterns}
                                          onChange={(e) =>
                                            setAllowedUrlPatterns(
                                              e.target.value,
                                            )
                                          }
                                          className="w-full px-3 py-2 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent bg-background text-foreground text-xs font-mono resize-none"
                                          rows={3}
                                        />
                                        <p className="mt-1 text-xs text-muted-foreground">
                                          Only crawl URLs matching these regex
                                          patterns. Use single backslash to
                                          escape:{" "}
                                          <code className="bg-muted px-1 rounded">
                                            Badge\?section=
                                          </code>
                                        </p>
                                      </div>
                                      <div>
                                        <label className="block text-sm font-medium text-muted-foreground mb-1">
                                          Denied URL Patterns
                                        </label>
                                        <textarea
                                          placeholder="Regex patterns (one per line)&#10;e.g. /blog/.*&#10;\.pdf$"
                                          value={deniedUrlPatterns}
                                          onChange={(e) =>
                                            setDeniedUrlPatterns(e.target.value)
                                          }
                                          className="w-full px-3 py-2 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent bg-background text-foreground text-xs font-mono resize-none"
                                          rows={3}
                                        />
                                        <p className="mt-1 text-xs text-muted-foreground">
                                          Skip URLs matching these regex
                                          patterns. Use single backslash to
                                          escape:{" "}
                                          <code className="bg-muted px-1 rounded">
                                            \.(pdf|zip)$
                                          </code>
                                        </p>
                                      </div>
                                    </div>
                                  </div>
                                )}

                                {/* Separator before Chunk Settings */}
                                <hr className="border-border/50" />

                                {/* Chunk Settings */}
                                <div className="grid grid-cols-2 gap-4">
                                  <div>
                                    <label className="block text-sm font-medium text-muted-foreground mb-1">
                                      Chunk Size
                                    </label>
                                    <Input
                                      type="number"
                                      min={100}
                                      max={ingestorLimits.shared.max_chunk_size}
                                      step={500}
                                      value={chunkSize}
                                      onChange={(e) =>
                                        setChunkSize(Number(e.target.value))
                                      }
                                      className="w-full"
                                    />
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      Max characters per chunk (default: 10000)
                                    </p>
                                  </div>
                                  <div>
                                    <label className="block text-sm font-medium text-muted-foreground mb-1">
                                      Chunk Overlap
                                    </label>
                                    <Input
                                      type="number"
                                      min={0}
                                      max={
                                        ingestorLimits.shared.max_chunk_overlap
                                      }
                                      step={100}
                                      value={chunkOverlap}
                                      onChange={(e) =>
                                        setChunkOverlap(Number(e.target.value))
                                      }
                                      className="w-full"
                                    />
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      Overlap between chunks (default: 2000)
                                    </p>
                                  </div>
                                </div>

                                {/* Separator before Auto-Reload Settings */}
                                <hr className="border-border/50" />

                                {/* Auto-Reload Settings */}
                                <div>
                                  <label className="block text-sm font-medium text-muted-foreground mb-1">
                                    Auto-Reload Interval
                                  </label>
                                  <Select
                                    value={
                                      isCustomReloadInterval
                                        ? "custom"
                                        : reloadInterval
                                    }
                                    onChange={(e) => {
                                      const value = e.target.value;
                                      if (value === "custom") {
                                        setReloadInterval(3600); // Default custom to 1h
                                        setIsCustomReloadInterval(true);
                                      } else {
                                        setReloadInterval(Number(value));
                                        setIsCustomReloadInterval(false);
                                      }
                                    }}
                                    className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                  >
                                    <option value="3600">Every 1 hour</option>
                                    <option value="21600">Every 6 hours</option>
                                    <option value="86400">
                                      Every 24 hours
                                    </option>
                                    <option value="259200">Every 3 days</option>
                                    <option value="604800">Every 7 days</option>
                                    <option value="custom">Custom...</option>
                                  </Select>
                                  {isCustomReloadInterval && (
                                    <div className="mt-2">
                                      <Input
                                        type="number"
                                        min={60}
                                        step={60}
                                        value={reloadInterval}
                                        onChange={(e) =>
                                          setReloadInterval(
                                            Math.max(
                                              60,
                                              Number(e.target.value),
                                            ),
                                          )
                                        }
                                        className="w-full"
                                        placeholder="Interval in seconds (min: 60)"
                                      />
                                      <p className="mt-1 text-xs text-muted-foreground">
                                        Custom interval in seconds (minimum: 60)
                                      </p>
                                    </div>
                                  )}
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    How often this data source should be
                                    automatically refreshed
                                  </p>
                                </div>
                              </>
                            )}
                            {ingestType === "file" && (
                              <div className="grid grid-cols-2 gap-4">
                                <div>
                                  <label className="block text-sm font-medium text-muted-foreground mb-1">
                                    Chunk Size
                                  </label>
                                  <Input
                                    type="number"
                                    min={100}
                                    max={ingestorLimits.shared.max_chunk_size}
                                    step={500}
                                    value={chunkSize}
                                    onChange={(e) =>
                                      setChunkSize(Number(e.target.value))
                                    }
                                    className="w-full"
                                  />
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    Max characters per chunk
                                  </p>
                                </div>
                                <div>
                                  <label className="block text-sm font-medium text-muted-foreground mb-1">
                                    Chunk Overlap
                                  </label>
                                  <Input
                                    type="number"
                                    min={0}
                                    max={
                                      ingestorLimits.shared.max_chunk_overlap
                                    }
                                    step={100}
                                    value={chunkOverlap}
                                    onChange={(e) =>
                                      setChunkOverlap(Number(e.target.value))
                                    }
                                    className="w-full"
                                  />
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    Overlap between chunks
                                  </p>
                                </div>
                              </div>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                  <DatasourceAccessFields
                    className="mt-4"
                    ownerControl={
                      <TeamPicker
                        value={ingestOwnerTeamSlug}
                        onChange={setIngestOwnerTeamSlug}
                        options={availableTeams.map((team) => ({
                          slug: team.slug,
                          name: team.name,
                          _id: team._id,
                        }))}
                        ariaLabel="Owner"
                        ariaInvalid={ingestOwnerTeamMissing}
                        placeholder={
                          ingestOwnerTeamRequired
                            ? "Select a team…"
                            : "You (personal)"
                        }
                        searchPlaceholder="Search your teams..."
                        emptyLabel={
                          availableTeams.length === 0
                            ? "No teams available"
                            : "No teams match"
                        }
                        disabled={availableTeams.length === 0}
                      />
                    }
                    ownerDescription={
                      <>
                        Leave this set to you for a personal datasource. You can
                        transfer it to a team later.
                      </>
                    }
                    searchControl={
                      <TeamMultiPicker
                        options={availableSearchTeams.map((team) => ({
                          slug: team.slug,
                          name: team.name,
                          _id: team._id,
                        }))}
                        selected={ingestSearchTeamSlugs}
                        onChange={setIngestSearchTeamSlugs}
                        disabled={
                          ingestorLimits.shared.max_search_teams === 0
                        }
                        maxSelections={ingestorLimits.shared.max_search_teams}
                        placeholder="Only you can search — add teams"
                        searchPlaceholder="Search teams..."
                        emptyLabel="No teams match"
                      />
                    }
                    searchDescription={
                      <>
                        Selected teams can search these files. They cannot
                        manage the datasource.
                      </>
                    }
                  />
                  <div className="mt-4 flex justify-end border-t border-border/50 pt-4">
                    <Button
                      onClick={handleIngest}
                      disabled={
                        selectedFiles.length === 0 ||
                        !hasPermission(Permission.INGEST) ||
                        ingestOwnerTeamMissing
                      }
                      title={
                        !hasPermission(Permission.INGEST)
                          ? "Insufficient permissions to ingest data"
                          : ingestOwnerTeamMissing
                            ? "Select an Owner team for this datasource"
                            : selectedFiles.length > 1
                              ? `Ingest ${selectedFiles.length} files`
                              : "Ingest this file"
                      }
                      className="w-full sm:w-auto"
                    >
                      {selectedFiles.length > 1
                        ? `Ingest ${selectedFiles.length} files`
                        : "Ingest file"}
                    </Button>
                  </div>
                </>
              )}
            </motion.section>
          )}

          {/* Data Sources Section */}
          <motion.section
            className="bg-card rounded-xl shadow-sm border border-border"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.1 }}
          >
            {/* Section Header */}
            <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <h3 className="text-base font-semibold text-foreground">
                  Data Sources
                </h3>
                <button
                  onClick={() => setShowHelp(true)}
                  className="p-1 rounded-full hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
                  title="Learn about Ingestors, Datasources, and Documents"
                >
                  <HelpCircle className="h-4 w-4" />
                </button>
                {loadingDataSources || loadingIngestionSourceConfigs ? (
                  <span role="status" aria-label="Loading data source count">
                    <Skeleton className="h-5 w-8 rounded-full" />
                  </span>
                ) : (
                  <Badge variant="secondary" className="text-xs">
                    {filteredDataSources.length +
                      filteredPendingSourceConfigs.length}
                    {hasDatasourceFilters
                      ? ` of ${dataSources.length + pendingSourceConfigs.length}`
                      : ""}
                  </Badge>
                )}
              </div>

              {/* Source actions - Right Aligned */}
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void Promise.all([
                    fetchDataSources(true),
                    fetchPendingPublicationRequests(),
                  ])}
                  disabled={loadingDataSources || refreshingDataSources}
                  className="gap-2"
                >
                  <RefreshCw
                    className={cn(
                      "h-4 w-4",
                      refreshingDataSources && "animate-spin",
                    )}
                  />
                  {refreshingDataSources ? "Refreshing..." : "Refresh"}
                </Button>
                {canIngest && (
                  <Button
                    size="sm"
                    className="gap-1.5"
                    onClick={openInlineSourceCreator}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New Source
                  </Button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-5 py-3">
              <div className="relative min-w-56 flex-1 sm:max-w-80">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Search datasource names..."
                  value={searchQuery}
                  onChange={(event) =>
                    updateViewState({ query: event.target.value, page: 1 })
                  }
                  className="h-8 pl-9 pr-8 text-xs"
                  aria-label="Search datasource names"
                />
                {searchQuery && (
                  <button
                    type="button"
                    aria-label="Clear datasource name search"
                    onClick={() => updateViewState({ query: "", page: 1 })}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <MultiSelect
                options={sourceTypes}
                selected={selectedSourceTypes}
                onChange={(sourceTypes) =>
                  updateViewState({ sourceTypes, page: 1 })
                }
                formatOption={datasourceTypeLabel}
                placeholder="All source types"
                searchPlaceholder="Search source types..."
                emptyLabel="No source types match"
                badgeLabel="source types"
              />
              <MultiSelect
                options={ownerOptions}
                selected={selectedOwners}
                onChange={(owners) => updateViewState({ owners, page: 1 })}
                placeholder="All owners"
                searchPlaceholder="Search owners..."
                emptyLabel="No owners match"
                badgeLabel="owners"
              />
              <MultiSelect
                options={searchAccessOptions}
                selected={selectedSearchAccess}
                onChange={(searchAccess) =>
                  updateViewState({ searchAccess, page: 1 })
                }
                placeholder="All search access"
                formatOption={searchAccessFilterLabel}
                searchPlaceholder="Search people or teams..."
                emptyLabel="No search access matches"
                badgeLabel="access grants"
              />
              {hasDatasourceFilters && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  onClick={() =>
                    updateViewState({
                      sourceTypes: [],
                      owners: [],
                      searchAccess: [],
                      query: "",
                      page: 1,
                    })
                  }
                >
                  <X className="h-3.5 w-3.5" />
                  Clear filters
                </Button>
              )}
            </div>

            {/* Pending sources — config rows with no DataSourceInfo yet */}
            {filteredPendingSourceConfigs.length > 0 && (
              <div className="px-5 py-4 border-b border-border/50 space-y-2">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Pending ({filteredPendingSourceConfigs.length})
                </h4>
                {filteredPendingSourceConfigs.map((source) => (
                  <IngestionSourceCard
                    key={source.source_id}
                    source={source}
                    onEdit={(s) => {
                      setEditingSourceConfig(s);
                      setSourceDialogOpen(true);
                    }}
                    onDelete={handleDeleteSourceConfig}
                    onRetry={handleRetrySourceConfig}
                    pendingPublicationRequest={pendingPublicationRequests.get(source.source_id)}
                  />
                ))}
              </div>
            )}

            {/* Data Sources List */}
            <div className="p-5" aria-busy={loadingDataSources}>
              {loadingDataSources && dataSources.length === 0 ? (
                <DataSourceListSkeleton />
              ) : dataSources.length === 0 &&
                pendingSourceConfigs.length === 0 ? (
                // Empty State
                <motion.div
                  className="flex flex-col items-center justify-center py-12 text-center"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                >
                  <div className="p-4 rounded-2xl gradient-primary-br shadow-lg shadow-primary/20 mb-4">
                    <Database className="h-8 w-8 text-white" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2">
                    No data sources yet
                  </h3>
                  <p className="text-muted-foreground text-sm max-w-sm mb-4">
                    Ingest a URL above to start building your knowledge base
                  </p>
                </motion.div>
              ) : filteredDataSources.length === 0 &&
                filteredPendingSourceConfigs.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">
                  No data sources match these filters.
                </p>
              ) : filteredDataSources.length === 0 ? null : (
                <div className="space-y-2">
                  <div>
                    {paginatedDataSources.map((ds, index) => {
                      const isExpanded = expandedRows.has(ds.datasource_id);
                      const jobs = dataSourceJobs[ds.datasource_id] || [];
                      const latestJob = jobs[0];
                      const hasActiveJob =
                        latestJob &&
                        (latestJob.status === "in_progress" ||
                          latestJob.status === "pending");
                      const sourceConfig = ingestionSourceConfigs.get(
                        ds.datasource_id,
                      );
                      const displayName =
                        sourceConfig?.name?.trim() || ds.name || "";
                      const configuredDescription =
                        sourceConfig?.description?.trim() || "";
                      const confluenceScopeDescription =
                        sourceConfig?.source_type === "confluence_space" &&
                        sourceConfig.start_page_url
                          ? sourceConfig.get_child_pages
                            ? `Confluence page and child pages starting at ${sourceConfig.start_page_url}`
                            : `Confluence page ${sourceConfig.start_page_url}`
                          : "";
                      const displayDescription =
                        configuredDescription ||
                        confluenceScopeDescription ||
                        ds.description;
                      const rowPermissions = ds._permissions;
                      const sourcePolicyStateKnown =
                        ds.has_source_config !== undefined ||
                        Boolean(sourceConfig);
                      const hasSourceManagementPolicy =
                        ds.has_source_config ?? Boolean(sourceConfig);
                      const canReadContent =
                        rowPermissions?.can_read_content ?? true;
                      const canManageDatasource = Boolean(
                        rowPermissions
                          ? hasSourceManagementPolicy || !sourcePolicyStateKnown
                            ? rowPermissions.can_manage_source
                            : rowPermissions.can_manage_query
                          : canDelete || sourceConfig?._permissions.can_manage,
                      );
                      const canRunLifecycle = canManageDatasource;
                      // Query-policy admins and independent source managers may
                      // administer who receives Search access. This
                      // does not make a source manager a content reader.
                      const canManageQueryAccess = rowPermissions
                        ? rowPermissions.can_manage_query ||
                          rowPermissions.can_manage_source
                        : canDelete;
                      const canManageSourceConfig = Boolean(
                        sourceConfig?._permissions.can_manage,
                      );
                      const canOpenDatasourceManager =
                        canManageQueryAccess || canManageSourceConfig;
                      const ownerTeamSlug =
                        sourceConfig?.owner_team_slug ?? ds.owner_team_slug;
                      const ownerSubject =
                        sourceConfig?.owner_subject ?? ds.owner_subject;
                      const searchTeamSlugs =
                        sourceConfig?.search_with_teams ??
                        (sourceConfig?.search_owner_team_slug
                          ? [sourceConfig.search_owner_team_slug]
                          : ds.search_with_teams);
                      const ragCollections =
                        sourceConfig?.rag_collections ??
                        ds.rag_collections ??
                        [];
                      const accessDetailsKnown =
                        Boolean(sourceConfig) ||
                        [
                          "owner_subject",
                          "owner_team_slug",
                          "search_with_teams",
                        ].some((key) =>
                          Object.prototype.hasOwnProperty.call(ds, key),
                        );
                      const loadingAccessDetails =
                        loadingIngestionSourceConfigs && !accessDetailsKnown;
                      const loadingJobs =
                        loadingInitialDataSourceJobs && jobs.length === 0;
                      const supportsReload = supportsScheduledReload(
                        ds.source_type,
                      );
                      const supportsFileReupload = supportsReupload(
                        ds.source_type,
                      );
                      // Helm-seeded config rows (`config_driven: true`) are immutable via
                      // the source-management API until they are adopted.
                      const isConfigDriven = Boolean(
                        sourceConfig?.config_driven,
                      );
                      const icon = getIconForType(ds.source_type);

                      // Get reload interval (first-class field or default)
                      const dsReloadInterval =
                        ds.reload_interval ?? DEFAULT_RELOAD_INTERVAL;
                      const hasReloadInterval =
                        supportsReload &&
                        ds.reload_interval !== undefined &&
                        ds.reload_interval !== null;
                      const isOverdue = isRefreshOverdue(
                        ds.last_updated,
                        dsReloadInterval,
                      );

                      // Find latest completed job for metrics display
                      const completedJob = jobs.find(
                        (j) =>
                          j.status === "completed" ||
                          j.status === "completed_with_errors",
                      );
                      const hasMetrics =
                        completedJob &&
                        ((completedJob.document_count ?? 0) > 0 ||
                          (completedJob.chunk_count ?? 0) > 0);

                      return (
                        <motion.div
                          key={ds.datasource_id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: index * 0.03 }}
                          className={cn(
                            "border border-border rounded-lg overflow-hidden transition-all duration-200",
                            isExpanded
                              ? "ring-1 ring-primary/20 shadow-sm"
                              : "hover:border-border/80",
                          )}
                        >
                          {/* Row Header */}
                          <div
                            className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                            onClick={() => toggleRow(ds.datasource_id)}
                          >
                            <motion.div
                              animate={{ rotate: isExpanded ? 90 : 0 }}
                              transition={{ duration: 0.2 }}
                            >
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            </motion.div>

                            {icon && (
                              <IconRenderer icon={icon} className="w-5 h-5" />
                            )}

                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                {renamingDsId === ds.datasource_id ? (
                                  <div
                                    className="flex items-center gap-1 max-w-md flex-1"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <Input
                                      autoFocus
                                      value={renameDraft}
                                      onChange={(e) =>
                                        setRenameDraft(e.target.value)
                                      }
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                          e.preventDefault();
                                          void commitRename(ds.datasource_id);
                                        } else if (e.key === "Escape") {
                                          e.preventDefault();
                                          cancelRename();
                                        }
                                      }}
                                      disabled={renameSaving}
                                      maxLength={120}
                                      className="h-7 text-sm"
                                      placeholder="Display name"
                                    />
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 w-7 p-0"
                                      disabled={
                                        renameSaving || !renameDraft.trim()
                                      }
                                      onClick={() =>
                                        void commitRename(ds.datasource_id)
                                      }
                                      title="Save name (Enter)"
                                    >
                                      <Check className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 w-7 p-0"
                                      disabled={renameSaving}
                                      onClick={cancelRename}
                                      title="Cancel (Esc)"
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                ) : (
                                  <>
                                    <span
                                      className="font-medium text-sm truncate max-w-md"
                                      title={
                                        displayName
                                          ? `${displayName}\n${ds.datasource_id}`
                                          : ds.datasource_id
                                      }
                                    >
                                      {displayName ||
                                        (ds.datasource_id.length > 60
                                          ? `${ds.datasource_id.substring(0, 60)}\u2026`
                                          : ds.datasource_id)}
                                    </span>
                                    {canManageDatasource && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-6 w-6 p-0 opacity-50 hover:opacity-100 shrink-0"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          beginRename(ds, displayName);
                                        }}
                                        title="Rename data source"
                                      >
                                        <Pencil className="h-3 w-3" />
                                      </Button>
                                    )}
                                  </>
                                )}
                                {canOpenDatasourceManager && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground shrink-0"
                                    title="Manage Datasource"
                                    aria-label="Manage Datasource"
                                    disabled={
                                      openingSourceConfigId === ds.datasource_id
                                    }
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void openDatasourceManager(
                                        ds,
                                        sourceConfig,
                                        canManageSourceConfig,
                                      );
                                    }}
                                  >
                                    {openingSourceConfigId ===
                                    ds.datasource_id ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Settings className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                )}
                                {loadingAccessDetails ? (
                                  <span
                                    className="flex items-center gap-2"
                                    role="status"
                                    aria-label="Loading datasource access"
                                  >
                                    <Skeleton className="h-5 w-28 rounded-full" />
                                    <Skeleton className="h-5 w-32 rounded-full" />
                                  </span>
                                ) : (
                                  <DatasourceAccessBadges
                                    ownerTeamSlug={ownerTeamSlug}
                                    ownerSubject={ownerSubject}
                                    ownerDisplayName={
                                      sourceConfig?.owner_display_name ??
                                      ds.owner_display_name
                                    }
                                    searchTeamSlugs={searchTeamSlugs}
                                    searchUserDisplayNames={
                                      sourceConfig?.search_user_display_names ??
                                      ds.search_user_display_names
                                    }
                                    ragCollections={ragCollections}
                                    pendingPublicationRequest={pendingPublicationRequests.get(
                                      ds.datasource_id,
                                    )}
                                    detailsKnown={accessDetailsKnown}
                                    canReadContent={canReadContent}
                                  />
                                )}
                                {loadingPendingPublicationRequests && (
                                  <Skeleton className="h-5 w-20 rounded-full" />
                                )}
                              </div>
                              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                                {displayName && (
                                  <>
                                    <span
                                      className="font-mono text-[10px] truncate max-w-[18rem]"
                                      title={ds.datasource_id}
                                    >
                                      {ds.datasource_id}
                                    </span>
                                    <span className="text-border">|</span>
                                  </>
                                )}
                                <span>
                                  Updated {formatRelativeTime(ds.last_updated)}
                                </span>
                                {hasReloadInterval && (
                                  <>
                                    <span className="text-border">|</span>
                                    <span
                                      className={
                                        isOverdue ? "text-amber-500" : ""
                                      }
                                    >
                                      {formatNextReload(
                                        ds.last_updated,
                                        dsReloadInterval,
                                      )}
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-3 shrink-0">
                              {loadingJobs ? (
                                <span
                                  className="flex items-center gap-3"
                                  role="status"
                                  aria-label="Loading ingestion status"
                                >
                                  <Skeleton className="h-3 w-32" />
                                  <Skeleton className="h-5 w-20 rounded-full" />
                                </span>
                              ) : (
                                <>
                                  {/* Metrics from latest completed job */}
                                  {hasMetrics && (
                                    <span className="text-xs text-muted-foreground">
                                      {completedJob.document_count} documents,{" "}
                                      {completedJob.chunk_count} chunks
                                    </span>
                                  )}

                                  {latestJob ? (
                                    <StatusBadge status={latestJob.status} />
                                  ) : (
                                    <span className="text-xs text-muted-foreground">
                                      No jobs
                                    </span>
                                  )}
                                </>
                              )}

                              {(canRunLifecycle || canManageDatasource) && (
                                <div
                                  className="flex gap-1"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {canRunLifecycle && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() =>
                                        supportsFileReupload
                                          ? setShowReuploadModal(
                                              ds.datasource_id,
                                            )
                                          : setShowReIngestConfirm(
                                              ds.datasource_id,
                                            )
                                      }
                                      disabled={
                                        loadingJobs ||
                                        hasActiveJob ||
                                        !(supportsReload || supportsFileReupload) ||
                                        isConfigDriven
                                      }
                                      className="h-7 w-7 p-0"
                                      title={
                                        loadingJobs
                                          ? "Loading job status"
                                          : isConfigDriven
                                          ? "Managed by ingestor config"
                                          : !supportsReload && !supportsFileReupload
                                            ? "Re-ingest not supported"
                                            : hasActiveJob
                                              ? "Job in progress"
                                              : supportsFileReupload
                                                ? "Re-upload file"
                                                : "Re-ingest"
                                      }
                                    >
                                      <RotateCcw className="h-3.5 w-3.5" />
                                    </Button>
                                  )}
                                  {canManageDatasource && (
                                    <>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          setShowCleanupConfirm(
                                            ds.datasource_id,
                                          )
                                        }
                                        disabled={hasActiveJob}
                                        className="h-7 w-7 p-0 hover:bg-amber-500/10 hover:text-amber-500"
                                        title={
                                          hasActiveJob
                                            ? "Job in progress"
                                            : "Cleanup stale data"
                                        }
                                      >
                                        <Eraser className="h-3.5 w-3.5" />
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          setShowDeleteDataSourceConfirm(
                                            ds.datasource_id,
                                          )
                                        }
                                        disabled={
                                          hasActiveJob || isConfigDriven
                                        }
                                        className="h-7 w-7 p-0 hover:bg-destructive/10 hover:text-destructive"
                                        title={
                                          isConfigDriven
                                            ? "Managed by ingestor config"
                                            : hasActiveJob
                                              ? "Job in progress"
                                              : "Delete"
                                        }
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </Button>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Expanded Content */}
                          <AnimatePresence>
                            {isExpanded && (
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.15 }}
                                className="overflow-hidden"
                              >
                                <div className="px-4 py-4 bg-muted/20 border-t border-border space-y-4">
                                  {/* Connector configuration belongs to the
                                      independent ingestion-source read policy. */}
                                  {(rowPermissions?.can_read_source_config ??
                                    true) && (
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                      <div>
                                        <p className="text-xs font-medium text-muted-foreground mb-1">
                                          Datasource ID
                                        </p>
                                        <p className="font-mono text-xs text-foreground break-all">
                                          {ds.datasource_id}
                                        </p>
                                      </div>
                                      <div>
                                        <p className="text-xs font-medium text-muted-foreground mb-1">
                                          Ingestor ID
                                        </p>
                                        <p className="font-mono text-xs text-foreground break-all">
                                          {ds.ingestor_id}
                                        </p>
                                      </div>
                                      <div>
                                        <p className="text-xs font-medium text-muted-foreground mb-1">
                                          Chunk Size
                                        </p>
                                        <p className="text-foreground">
                                          {ds.default_chunk_size}
                                        </p>
                                      </div>
                                      <div>
                                        <p className="text-xs font-medium text-muted-foreground mb-1">
                                          Chunk Overlap
                                        </p>
                                        <p className="text-foreground">
                                          {ds.default_chunk_overlap}
                                        </p>
                                      </div>
                                      <div>
                                        <p className="text-xs font-medium text-muted-foreground mb-1">
                                          Reload Interval
                                        </p>
                                        <p className="text-foreground">
                                          {(() => {
                                            const interval =
                                              ds.reload_interval ??
                                              DEFAULT_RELOAD_INTERVAL;
                                            if (interval >= 86400)
                                              return `${Math.round(interval / 86400)}d`;
                                            if (interval >= 3600)
                                              return `${Math.round(interval / 3600)}h`;
                                            return `${interval}s`;
                                          })()}
                                        </p>
                                      </div>
                                    </div>
                                  )}

                                  {displayDescription && (
                                    <div>
                                      <p className="text-xs font-medium text-muted-foreground mb-1">
                                        Description
                                      </p>
                                      <p className="text-sm text-foreground bg-muted/50 p-3 rounded-lg">
                                        {displayDescription}
                                      </p>
                                    </div>
                                  )}

                                  {ragCollections.length > 0 && (
                                    <div>
                                      <p className="text-xs font-medium text-muted-foreground mb-1">
                                        Collections
                                      </p>
                                      <div className="flex flex-wrap gap-2">
                                        {ragCollections.map((collection) => (
                                          <Badge
                                            key={collection.id}
                                            variant="outline"
                                            title={collection.name}
                                          >
                                            <Layers className="mr-1 h-3 w-3" />
                                            {collection.name}
                                          </Badge>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {ds.metadata &&
                                    Object.keys(ds.metadata).length > 0 && (
                                      <details className="rounded-lg bg-muted/50 border border-border/50">
                                        <summary className="cursor-pointer text-xs font-medium text-foreground px-3 py-2 hover:bg-muted/50">
                                          Metadata (
                                          {Object.keys(ds.metadata).length}{" "}
                                          fields)
                                        </summary>
                                        <div className="px-3 pb-3">
                                          <SyntaxHighlighter
                                            language="json"
                                            style={vscDarkPlus}
                                            customStyle={{
                                              margin: 0,
                                              borderRadius: "0.5rem",
                                              fontSize: "0.75rem",
                                              maxHeight: "300px",
                                            }}
                                          >
                                            {JSON.stringify(
                                              ds.metadata,
                                              null,
                                              2,
                                            )}
                                          </SyntaxHighlighter>
                                        </div>
                                      </details>
                                    )}

                                  {/* Jobs Section - Collapsible */}
                                  {jobs.length > 0 && (
                                    <div className="border-t border-border/50 pt-4">
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toggleJobsSection(ds.datasource_id);
                                        }}
                                        className="flex items-center gap-2 text-sm font-medium text-foreground hover:text-primary transition-colors w-full text-left"
                                      >
                                        <motion.div
                                          animate={{
                                            rotate: expandedJobsSections.has(
                                              ds.datasource_id,
                                            )
                                              ? 90
                                              : 0,
                                          }}
                                          transition={{ duration: 0.1 }}
                                          className="shrink-0"
                                        >
                                          <ChevronRight className="h-4 w-4" />
                                        </motion.div>
                                        <Activity className="h-4 w-4 shrink-0" />
                                        <span className="shrink-0">
                                          Ingestion Jobs
                                        </span>
                                        <Badge
                                          variant="secondary"
                                          className="text-[10px] shrink-0"
                                        >
                                          {jobs.length} total
                                        </Badge>
                                        {/* Show latest job status when collapsed */}
                                        {!expandedJobsSections.has(
                                          ds.datasource_id,
                                        ) &&
                                          jobs[0] && (
                                            <div className="flex items-center gap-2 min-w-0 flex-1">
                                              <span className="text-muted-foreground shrink-0">
                                                •
                                              </span>
                                              <StatusBadge
                                                status={jobs[0].status}
                                              />
                                              <span className="text-xs text-muted-foreground truncate">
                                                {jobs[0].message}
                                              </span>
                                            </div>
                                          )}
                                      </button>

                                      <AnimatePresence>
                                        {expandedJobsSections.has(
                                          ds.datasource_id,
                                        ) && (
                                          <motion.div
                                            initial={{ height: 0, opacity: 0 }}
                                            animate={{
                                              height: "auto",
                                              opacity: 1,
                                            }}
                                            exit={{ height: 0, opacity: 0 }}
                                            transition={{ duration: 0.15 }}
                                            className="overflow-hidden"
                                          >
                                            <div className="mt-3 space-y-2">
                                              {jobs.map((job) => {
                                                const isJobExpanded =
                                                  expandedJobs.has(job.job_id);
                                                const isJobActive =
                                                  job.status ===
                                                    "in_progress" ||
                                                  job.status === "pending";
                                                const jobTotal = job.total ?? 0;
                                                const progress =
                                                  jobTotal > 0 &&
                                                  job.progress_counter >= 0
                                                    ? Math.min(
                                                        100,
                                                        (job.progress_counter /
                                                          jobTotal) *
                                                          100,
                                                      )
                                                    : 0;

                                                return (
                                                  <div
                                                    key={job.job_id}
                                                    className="border border-border rounded-lg bg-card overflow-hidden"
                                                  >
                                                    <div
                                                      className="p-3 cursor-pointer hover:bg-muted/30 transition-colors"
                                                      onClick={(e) => {
                                                        e.stopPropagation();
                                                        toggleJob(job.job_id);
                                                      }}
                                                    >
                                                      <div className="flex items-center justify-between gap-2">
                                                        <div className="flex-1 min-w-0">
                                                          <div className="flex items-center gap-2">
                                                            <motion.div
                                                              animate={{
                                                                rotate:
                                                                  isJobExpanded
                                                                    ? 90
                                                                    : 0,
                                                              }}
                                                              transition={{
                                                                duration: 0.2,
                                                              }}
                                                            >
                                                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                                                            </motion.div>
                                                            <span className="font-mono text-xs text-muted-foreground truncate">
                                                              {job.job_id}
                                                            </span>
                                                            <StatusBadge
                                                              status={
                                                                job.status
                                                              }
                                                            />
                                                          </div>

                                                          {isJobActive &&
                                                            jobTotal > 0 && (
                                                              <ProgressBar
                                                                progress={
                                                                  progress
                                                                }
                                                                total={jobTotal}
                                                                current={
                                                                  job.progress_counter
                                                                }
                                                              />
                                                            )}

                                                          {!isJobExpanded && (
                                                            <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                                                              {job.message}
                                                            </p>
                                                          )}
                                                        </div>

                                                        {isJobActive &&
                                                          canRunLifecycle && (
                                                            <Button
                                                              variant="ghost"
                                                              size="sm"
                                                              onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleTerminateJob(
                                                                  ds.datasource_id,
                                                                  job.job_id,
                                                                );
                                                              }}
                                                              className="h-7 px-2 hover:bg-destructive/10 hover:text-destructive"
                                                            >
                                                              <StopCircle className="h-3.5 w-3.5 mr-1" />
                                                              Stop
                                                            </Button>
                                                          )}
                                                      </div>
                                                    </div>

                                                    <AnimatePresence>
                                                      {isJobExpanded && (
                                                        <motion.div
                                                          initial={{
                                                            height: 0,
                                                            opacity: 0,
                                                          }}
                                                          animate={{
                                                            height: "auto",
                                                            opacity: 1,
                                                          }}
                                                          exit={{
                                                            height: 0,
                                                            opacity: 0,
                                                          }}
                                                          transition={{
                                                            duration: 0.15,
                                                          }}
                                                          className="overflow-hidden"
                                                        >
                                                          <div
                                                            className="px-3 pb-3 pt-2 border-t border-border space-y-2"
                                                            onClick={(e) =>
                                                              e.stopPropagation()
                                                            }
                                                          >
                                                            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                                                              <div>
                                                                <span className="font-medium text-muted-foreground">
                                                                  Created:
                                                                </span>
                                                                <p className="text-foreground">
                                                                  {new Date(
                                                                    job.created_at *
                                                                      1000,
                                                                  ).toLocaleString()}
                                                                  <span className="text-muted-foreground ml-1">
                                                                    (
                                                                    {formatRelativeTime(
                                                                      job.created_at,
                                                                    )}
                                                                    )
                                                                  </span>
                                                                </p>
                                                              </div>
                                                              {job.completed_at && (
                                                                <div>
                                                                  <span className="font-medium text-muted-foreground">
                                                                    Completed:
                                                                  </span>
                                                                  <p className="text-foreground">
                                                                    {new Date(
                                                                      job.completed_at *
                                                                        1000,
                                                                    ).toLocaleString()}
                                                                    <span className="text-muted-foreground ml-1">
                                                                      (
                                                                      {formatRelativeTime(
                                                                        job.completed_at,
                                                                      )}
                                                                      )
                                                                    </span>
                                                                  </p>
                                                                </div>
                                                              )}
                                                              <div>
                                                                <span className="font-medium text-muted-foreground">
                                                                  Processed:
                                                                </span>
                                                                <p className="text-foreground">
                                                                  {
                                                                    job.progress_counter
                                                                  }
                                                                </p>
                                                              </div>
                                                              <div>
                                                                <span className="font-medium text-muted-foreground">
                                                                  Failed:
                                                                </span>
                                                                <p
                                                                  className={
                                                                    job.failed_counter >
                                                                    0
                                                                      ? "text-destructive"
                                                                      : "text-foreground"
                                                                  }
                                                                >
                                                                  {
                                                                    job.failed_counter
                                                                  }
                                                                </p>
                                                              </div>
                                                              <div>
                                                                <span className="font-medium text-muted-foreground">
                                                                  Documents:
                                                                </span>
                                                                <p className="text-foreground">
                                                                  {job.document_count ??
                                                                    0}
                                                                </p>
                                                              </div>
                                                              <div>
                                                                <span className="font-medium text-muted-foreground">
                                                                  Chunks:
                                                                </span>
                                                                <p className="text-foreground">
                                                                  {job.chunk_count ??
                                                                    0}
                                                                </p>
                                                              </div>
                                                            </div>

                                                            <div className="text-xs">
                                                              <span className="font-medium text-muted-foreground">
                                                                Status:
                                                              </span>
                                                              <div
                                                                className={cn(
                                                                  "mt-1 px-3 py-2 rounded-md font-mono text-xs",
                                                                  isJobActive
                                                                    ? "bg-zinc-900 text-green-400 border border-zinc-700"
                                                                    : "bg-muted/50 text-foreground",
                                                                )}
                                                              >
                                                                {job.message}
                                                                {isJobActive && (
                                                                  <span className="inline-flex ml-1">
                                                                    <span className="animate-[pulse_1s_ease-in-out_infinite]">
                                                                      .
                                                                    </span>
                                                                    <span className="animate-[pulse_1s_ease-in-out_0.2s_infinite]">
                                                                      .
                                                                    </span>
                                                                    <span className="animate-[pulse_1s_ease-in-out_0.4s_infinite]">
                                                                      .
                                                                    </span>
                                                                  </span>
                                                                )}
                                                              </div>
                                                            </div>

                                                            {job.error_msgs &&
                                                              job.error_msgs
                                                                .length > 0 && (
                                                                <details className="rounded-md bg-zinc-900 border border-zinc-700 overflow-hidden">
                                                                  <summary className="cursor-pointer text-xs font-mono px-3 py-1.5 hover:bg-zinc-800 flex items-center gap-2 text-zinc-400">
                                                                    <span className="text-red-400">
                                                                      ✗
                                                                    </span>
                                                                    <span className="text-red-400">
                                                                      {
                                                                        job
                                                                          .error_msgs
                                                                          .length
                                                                      }
                                                                    </span>{" "}
                                                                    error
                                                                    {job
                                                                      .error_msgs
                                                                      .length !==
                                                                    1
                                                                      ? "s"
                                                                      : ""}
                                                                  </summary>
                                                                  <div className="px-3 pb-2 pt-1 max-h-48 overflow-y-auto font-mono text-xs space-y-0.5 border-t border-zinc-800">
                                                                    {job.error_msgs.map(
                                                                      (
                                                                        error: string,
                                                                        index: number,
                                                                      ) => (
                                                                        <div
                                                                          key={
                                                                            index
                                                                          }
                                                                          className="text-red-400/90 py-0.5 flex"
                                                                        >
                                                                          <span className="text-zinc-600 mr-2 select-none">
                                                                            ›
                                                                          </span>
                                                                          <span className="break-all">
                                                                            {
                                                                              error
                                                                            }
                                                                          </span>
                                                                        </div>
                                                                      ),
                                                                    )}
                                                                  </div>
                                                                </details>
                                                              )}
                                                          </div>
                                                        </motion.div>
                                                      )}
                                                    </AnimatePresence>
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          </motion.div>
                                        )}
                                      </AnimatePresence>
                                    </div>
                                  )}

                                  {/* Indexed content is governed by Search,
                                      never by source-management grants. */}
                                  {canReadContent && (
                                    <div className="border-t border-border/50 pt-4">
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toggleDocumentsSection(
                                            ds.datasource_id,
                                          );
                                        }}
                                        className="flex items-center gap-2 text-sm font-medium text-foreground hover:text-primary transition-colors w-full text-left"
                                      >
                                        <motion.div
                                          animate={{
                                            rotate:
                                              expandedDocumentsSections.has(
                                                ds.datasource_id,
                                              )
                                                ? 90
                                                : 0,
                                          }}
                                          transition={{ duration: 0.1 }}
                                        >
                                          <ChevronRight className="h-4 w-4" />
                                        </motion.div>
                                        <FileText className="h-4 w-4" />
                                        <span>View Documents</span>
                                        {datasourceDocuments[
                                          ds.datasource_id
                                        ] && (
                                          <Badge
                                            variant="secondary"
                                            className="text-[10px] ml-1"
                                          >
                                            {
                                              datasourceDocuments[
                                                ds.datasource_id
                                              ].total_documents
                                            }{" "}
                                            docs /{" "}
                                            {
                                              datasourceDocuments[
                                                ds.datasource_id
                                              ].total_chunks
                                            }{" "}
                                            chunks
                                          </Badge>
                                        )}
                                        {loadingDocuments.has(
                                          ds.datasource_id,
                                        ) && (
                                          <Loader2 className="h-3 w-3 animate-spin ml-1" />
                                        )}
                                      </button>

                                      <AnimatePresence>
                                        {expandedDocumentsSections.has(
                                          ds.datasource_id,
                                        ) && (
                                          <motion.div
                                            initial={{ height: 0, opacity: 0 }}
                                            animate={{
                                              height: "auto",
                                              opacity: 1,
                                            }}
                                            exit={{ height: 0, opacity: 0 }}
                                            transition={{ duration: 0.15 }}
                                            className="overflow-hidden"
                                          >
                                            <div className="mt-3 space-y-2">
                                              {loadingDocuments.has(
                                                ds.datasource_id,
                                              ) ? (
                                                <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                                                  <Loader2 className="h-4 w-4 animate-spin" />
                                                  Loading documents...
                                                </div>
                                              ) : datasourceDocuments[
                                                  ds.datasource_id
                                                ]?.documents.length === 0 ? (
                                                <p className="text-sm text-muted-foreground py-2">
                                                  No documents found
                                                </p>
                                              ) : (
                                                <div className="space-y-1 max-h-[32rem] overflow-y-auto pr-2">
                                                  {datasourceDocuments[
                                                    ds.datasource_id
                                                  ]?.documents.map(
                                                    (doc: DocumentInfo) => {
                                                      const isDocExpanded =
                                                        expandedDocuments.has(
                                                          doc.document_id,
                                                        );
                                                      return (
                                                        <div
                                                          key={doc.document_id}
                                                          className="border border-border/50 rounded-lg bg-muted/30"
                                                        >
                                                          <button
                                                            onClick={(e) => {
                                                              e.stopPropagation();
                                                              toggleDocument(
                                                                doc.document_id,
                                                              );
                                                            }}
                                                            className="flex items-center gap-2 w-full p-2 text-left hover:bg-muted/50 rounded-lg transition-colors"
                                                          >
                                                            <motion.div
                                                              animate={{
                                                                rotate:
                                                                  isDocExpanded
                                                                    ? 90
                                                                    : 0,
                                                              }}
                                                              transition={{
                                                                duration: 0.1,
                                                              }}
                                                            >
                                                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                                                            </motion.div>
                                                            <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                                                            <div className="flex items-center gap-1 min-w-0 flex-1">
                                                              <span
                                                                className="text-xs font-medium truncate"
                                                                title={
                                                                  doc.title
                                                                }
                                                              >
                                                                {doc.title}
                                                              </span>
                                                              <Info
                                                                className="h-3 w-3 text-muted-foreground/40 hover:text-primary shrink-0 cursor-pointer transition-colors"
                                                                onClick={(e) =>
                                                                  openDocumentMetadata(
                                                                    doc,
                                                                    e,
                                                                  )
                                                                }
                                                              />
                                                            </div>
                                                            <span
                                                              className="text-[9px] text-muted-foreground/60 font-mono w-[360px] overflow-hidden text-ellipsis whitespace-nowrap shrink-0"
                                                              style={{
                                                                direction:
                                                                  "rtl",
                                                                textAlign:
                                                                  "right",
                                                              }}
                                                              title={
                                                                doc.document_id
                                                              }
                                                            >
                                                              {doc.document_id}
                                                            </span>
                                                            <Badge
                                                              variant="outline"
                                                              className="text-[9px] shrink-0"
                                                            >
                                                              {
                                                                doc.chunks
                                                                  .length
                                                              }{" "}
                                                              chunks
                                                            </Badge>
                                                          </button>

                                                          <AnimatePresence>
                                                            {isDocExpanded && (
                                                              <motion.div
                                                                initial={{
                                                                  height: 0,
                                                                  opacity: 0,
                                                                }}
                                                                animate={{
                                                                  height:
                                                                    "auto",
                                                                  opacity: 1,
                                                                }}
                                                                exit={{
                                                                  height: 0,
                                                                  opacity: 0,
                                                                }}
                                                                transition={{
                                                                  duration: 0.1,
                                                                }}
                                                                className="overflow-hidden"
                                                              >
                                                                <div className="px-2 pb-2 space-y-1">
                                                                  {doc.chunks.map(
                                                                    (
                                                                      chunk: ChunkInfo,
                                                                    ) => {
                                                                      const isChunkExpanded =
                                                                        expandedChunks.has(
                                                                          chunk.id,
                                                                        );
                                                                      const chunkContent =
                                                                        chunkContents[
                                                                          chunk
                                                                            .id
                                                                        ];
                                                                      const isLoadingChunk =
                                                                        loadingChunkContent.has(
                                                                          chunk.id,
                                                                        );

                                                                      return (
                                                                        <div
                                                                          key={
                                                                            chunk.id
                                                                          }
                                                                          className="border border-border/30 rounded bg-background/50"
                                                                        >
                                                                          <button
                                                                            onClick={(
                                                                              e,
                                                                            ) => {
                                                                              e.stopPropagation();
                                                                              toggleChunk(
                                                                                chunk.id,
                                                                              );
                                                                              if (
                                                                                !isChunkExpanded &&
                                                                                !chunkContent
                                                                              ) {
                                                                                fetchChunkContent(
                                                                                  chunk.id,
                                                                                );
                                                                              }
                                                                            }}
                                                                            className="flex items-center gap-2 w-full p-1.5 text-left hover:bg-muted/30 rounded transition-colors"
                                                                          >
                                                                            <motion.div
                                                                              animate={{
                                                                                rotate:
                                                                                  isChunkExpanded
                                                                                    ? 90
                                                                                    : 0,
                                                                              }}
                                                                              transition={{
                                                                                duration: 0.1,
                                                                              }}
                                                                              className="shrink-0"
                                                                            >
                                                                              <ChevronRight className="h-2.5 w-2.5 text-muted-foreground" />
                                                                            </motion.div>
                                                                            <Layers className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                                                                            <div className="flex items-center gap-1 shrink-0">
                                                                              <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                                                                                Chunk{" "}
                                                                                {chunk.chunk_index +
                                                                                  1}

                                                                                /
                                                                                {
                                                                                  chunk.total_chunks
                                                                                }
                                                                              </span>
                                                                              <Info
                                                                                className="h-2.5 w-2.5 text-muted-foreground/40 hover:text-primary cursor-pointer transition-colors"
                                                                                onClick={(
                                                                                  e,
                                                                                ) =>
                                                                                  openChunkMetadata(
                                                                                    chunk,
                                                                                    e,
                                                                                  )
                                                                                }
                                                                              />
                                                                            </div>
                                                                            {chunk
                                                                              .metadata
                                                                              .fresh_until && (
                                                                              <span
                                                                                className={cn(
                                                                                  "text-[9px] shrink-0 whitespace-nowrap",
                                                                                  chunk
                                                                                    .metadata
                                                                                    .fresh_until *
                                                                                    1000 <
                                                                                    Date.now()
                                                                                    ? "text-destructive"
                                                                                    : "text-muted-foreground",
                                                                                )}
                                                                              >
                                                                                {formatFreshUntil(
                                                                                  chunk
                                                                                    .metadata
                                                                                    .fresh_until,
                                                                                )}
                                                                              </span>
                                                                            )}
                                                                            <span className="flex-1 min-w-0" />
                                                                            {isLoadingChunk && (
                                                                              <Loader2 className="h-2.5 w-2.5 animate-spin shrink-0" />
                                                                            )}
                                                                            <span
                                                                              className="text-[8px] text-muted-foreground/60 font-mono w-[300px] overflow-hidden text-ellipsis whitespace-nowrap shrink-0"
                                                                              style={{
                                                                                direction:
                                                                                  "rtl",
                                                                                textAlign:
                                                                                  "right",
                                                                              }}
                                                                              title={
                                                                                chunk.id
                                                                              }
                                                                            >
                                                                              {
                                                                                chunk.id
                                                                              }
                                                                            </span>
                                                                          </button>

                                                                          <AnimatePresence>
                                                                            {isChunkExpanded && (
                                                                              <motion.div
                                                                                initial={{
                                                                                  height: 0,
                                                                                  opacity: 0,
                                                                                }}
                                                                                animate={{
                                                                                  height:
                                                                                    "auto",
                                                                                  opacity: 1,
                                                                                }}
                                                                                exit={{
                                                                                  height: 0,
                                                                                  opacity: 0,
                                                                                }}
                                                                                transition={{
                                                                                  duration: 0.1,
                                                                                }}
                                                                                className="overflow-hidden"
                                                                              >
                                                                                <div className="px-2 pb-2 pt-1 border-t border-border/30">
                                                                                  {/* Chunk metadata */}
                                                                                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted-foreground mb-2">
                                                                                    {chunk
                                                                                      .metadata
                                                                                      .document_type && (
                                                                                      <span>
                                                                                        Type:{" "}
                                                                                        {
                                                                                          chunk
                                                                                            .metadata
                                                                                            .document_type
                                                                                        }
                                                                                      </span>
                                                                                    )}
                                                                                    {chunk
                                                                                      .metadata
                                                                                      .document_ingested_at && (
                                                                                      <span>
                                                                                        Ingested:{" "}
                                                                                        {formatRelativeTime(
                                                                                          chunk
                                                                                            .metadata
                                                                                            .document_ingested_at,
                                                                                        )}
                                                                                      </span>
                                                                                    )}
                                                                                    {chunk
                                                                                      .metadata
                                                                                      .is_structured_entity && (
                                                                                      <Badge
                                                                                        variant="outline"
                                                                                        className="text-[8px] h-4 px-1"
                                                                                      >
                                                                                        Structured
                                                                                      </Badge>
                                                                                    )}
                                                                                    {chunk
                                                                                      .metadata
                                                                                      .source && (
                                                                                      <span
                                                                                        className="truncate max-w-[200px]"
                                                                                        title={
                                                                                          chunk
                                                                                            .metadata
                                                                                            .source
                                                                                        }
                                                                                      >
                                                                                        Source:{" "}
                                                                                        {
                                                                                          chunk
                                                                                            .metadata
                                                                                            .source
                                                                                        }
                                                                                      </span>
                                                                                    )}
                                                                                  </div>

                                                                                  {/* Chunk content */}
                                                                                  {isLoadingChunk ? (
                                                                                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground py-2">
                                                                                      <Loader2 className="h-3 w-3 animate-spin" />
                                                                                      Loading
                                                                                      content...
                                                                                    </div>
                                                                                  ) : chunkContent ? (
                                                                                    <div className="bg-zinc-900 rounded p-2 max-h-48 overflow-y-auto">
                                                                                      <pre className="text-[10px] text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed">
                                                                                        {
                                                                                          chunkContent
                                                                                        }
                                                                                      </pre>
                                                                                    </div>
                                                                                  ) : (
                                                                                    <p className="text-[10px] text-muted-foreground italic">
                                                                                      Content
                                                                                      not
                                                                                      loaded
                                                                                    </p>
                                                                                  )}
                                                                                </div>
                                                                              </motion.div>
                                                                            )}
                                                                          </AnimatePresence>
                                                                        </div>
                                                                      );
                                                                    },
                                                                  )}
                                                                </div>
                                                              </motion.div>
                                                            )}
                                                          </AnimatePresence>
                                                        </div>
                                                      );
                                                    },
                                                  )}
                                                </div>
                                              )}

                                              {/* Warning badge for approaching 16k Milvus limit */}
                                              {documentsPagination[
                                                ds.datasource_id
                                              ]?.offset >= 16000 &&
                                                documentsPagination[
                                                  ds.datasource_id
                                                ]?.hasMore && (
                                                  <div className="mt-2 px-3 py-2 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                                                    <p className="text-xs text-yellow-600 dark:text-yellow-500 flex items-center gap-1">
                                                      <AlertCircle className="h-3 w-3" />
                                                      Approaching Milvus query
                                                      limit (16,384 chunks).
                                                      Only first 16,383 chunks
                                                      can be loaded.
                                                    </p>
                                                  </div>
                                                )}

                                              {/* Load More button */}
                                              {documentsPagination[
                                                ds.datasource_id
                                              ]?.hasMore && (
                                                <div className="pt-2 text-center border-t border-border/50 mt-2">
                                                  <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      const pagination =
                                                        documentsPagination[
                                                          ds.datasource_id
                                                        ];
                                                      if (pagination) {
                                                        fetchDocumentsPage(
                                                          ds.datasource_id,
                                                          pagination.offset,
                                                        );
                                                      }
                                                    }}
                                                    disabled={loadingDocuments.has(
                                                      ds.datasource_id,
                                                    )}
                                                    className="text-xs"
                                                  >
                                                    {loadingDocuments.has(
                                                      ds.datasource_id,
                                                    ) ? (
                                                      <>
                                                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                                        Loading...
                                                      </>
                                                    ) : (
                                                      <>Load More Chunks</>
                                                    )}
                                                  </Button>
                                                </div>
                                              )}
                                            </div>
                                          </motion.div>
                                        )}
                                      </AnimatePresence>
                                    </div>
                                  )}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      );
                    })}
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-between pt-4 border-t border-border mt-4">
                      <p className="text-sm text-muted-foreground">
                        Showing {(currentPage - 1) * itemsPerPage + 1} to{" "}
                        {Math.min(
                          currentPage * itemsPerPage,
                          filteredDataSources.length,
                        )}{" "}
                        of {filteredDataSources.length}
                      </p>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            updateViewState({
                              page: Math.max(1, currentPage - 1),
                            })
                          }
                          disabled={currentPage === 1}
                        >
                          Previous
                        </Button>
                        {Array.from({ length: totalPages }, (_, i) => i + 1)
                          .filter(
                            (page) =>
                              page === 1 ||
                              page === totalPages ||
                              (page >= currentPage - 1 &&
                                page <= currentPage + 1),
                          )
                          .map((page, idx, arr) => (
                            <React.Fragment key={page}>
                              {idx > 0 && arr[idx - 1] !== page - 1 && (
                                <span className="px-2 text-muted-foreground">
                                  ...
                                </span>
                              )}
                              <Button
                                variant={
                                  currentPage === page ? "default" : "outline"
                                }
                                size="sm"
                                onClick={() => updateViewState({ page })}
                                className="w-8 h-8 p-0"
                              >
                                {page}
                              </Button>
                            </React.Fragment>
                          ))}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            updateViewState({
                              page: Math.min(totalPages, currentPage + 1),
                            })
                          }
                          disabled={currentPage === totalPages}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.section>

          {/* Ingestors Section */}
          <motion.section
            className="bg-card rounded-xl shadow-sm border border-border"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.2 }}
          >
            <div
              role="button"
              tabIndex={0}
              onClick={() => setShowIngestors(!showIngestors)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setShowIngestors(!showIngestors);
                }
              }}
              className="w-full px-5 py-4 flex items-center justify-between hover:bg-muted/30 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <Server className="h-5 w-5 text-muted-foreground" />
                <h3 className="text-base font-semibold text-foreground">
                  Ingestors
                </h3>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowHelp(true);
                  }}
                  className="p-1 rounded-full hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
                  title="Learn about Ingestors, Datasources, and Documents"
                >
                  <HelpCircle className="h-4 w-4" />
                </button>
                <Badge variant="secondary" className="text-xs">
                  {ingestors.length}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    fetchIngestors();
                  }}
                  disabled={loadingIngestors || refreshingIngestors}
                  className="gap-2"
                >
                  <RefreshCw
                    className={cn(
                      "h-4 w-4",
                      refreshingIngestors && "animate-spin",
                    )}
                  />
                </Button>
                <motion.div
                  animate={{ rotate: showIngestors ? 180 : 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </motion.div>
              </div>
            </div>

            <AnimatePresence>
              {showIngestors && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="px-5 pb-5 border-t border-border pt-4">
                    {loadingIngestors && ingestors.length === 0 ? (
                      <div className="flex items-center justify-center py-8 text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin mr-2" />
                        Loading ingestors...
                      </div>
                    ) : ingestors.length === 0 ? (
                      <p className="text-muted-foreground text-center py-8">
                        No ingestors found. Ingestors are background services
                        that process and ingest data.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {ingestors.map((ingestor, index) => {
                          const isExpanded = expandedIngestors.has(
                            ingestor.ingestor_id,
                          );
                          const icon = getIconForType(ingestor.ingestor_type);
                          const isOnline = isIngestorOnline(ingestor);

                          return (
                            <motion.div
                              key={ingestor.ingestor_id}
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: index * 0.03 }}
                              className={cn(
                                "border rounded-lg overflow-hidden",
                                isOnline
                                  ? "border-border"
                                  : "border-amber-500/40",
                              )}
                            >
                              <div
                                className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                                onClick={() =>
                                  toggleIngestor(ingestor.ingestor_id)
                                }
                              >
                                <motion.div
                                  animate={{ rotate: isExpanded ? 90 : 0 }}
                                  transition={{ duration: 0.2 }}
                                >
                                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                </motion.div>

                                {icon && (
                                  <IconRenderer
                                    icon={icon}
                                    className="w-4 h-4"
                                  />
                                )}

                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium text-sm">
                                      {ingestor.ingestor_name}
                                    </span>
                                    <Badge
                                      variant="outline"
                                      title={
                                        isOnline
                                          ? "Heartbeat received recently"
                                          : `No heartbeat received in the last ${Math.ceil(INGESTOR_HEARTBEAT_MAX_AGE_SECONDS / 60)} minutes`
                                      }
                                      className={cn(
                                        "gap-1 text-[10px]",
                                        isOnline
                                          ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                                          : "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                                      )}
                                    >
                                      {isOnline ? (
                                        <CheckCircle2 className="h-3 w-3" />
                                      ) : (
                                        <AlertCircle className="h-3 w-3" />
                                      )}
                                      {isOnline ? "Online" : "Offline"}
                                    </Badge>
                                  </div>
                                  <p className="text-xs text-muted-foreground mt-0.5">
                                    Last seen:{" "}
                                    {ingestor.last_seen
                                      ? formatRelativeTime(ingestor.last_seen)
                                      : "Never"}
                                  </p>
                                </div>
                              </div>

                              <AnimatePresence>
                                {isExpanded && (
                                  <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: "auto", opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.2 }}
                                    className="overflow-hidden"
                                  >
                                    <div className="px-4 py-4 bg-muted/20 border-t border-border space-y-3">
                                      <div className="grid grid-cols-2 gap-4 text-sm">
                                        <div>
                                          <p className="text-xs font-medium text-muted-foreground mb-1">
                                            Ingestor ID
                                          </p>
                                          <p className="font-mono text-xs text-foreground break-all">
                                            {ingestor.ingestor_id}
                                          </p>
                                        </div>
                                        <div>
                                          <p className="text-xs font-medium text-muted-foreground mb-1">
                                            Last Seen
                                          </p>
                                          <p className="text-foreground text-sm">
                                            {ingestor.last_seen
                                              ? new Date(
                                                  ingestor.last_seen * 1000,
                                                ).toLocaleString()
                                              : "Never"}
                                          </p>
                                        </div>
                                      </div>

                                      {ingestor.description && (
                                        <div>
                                          <p className="text-xs font-medium text-muted-foreground mb-1">
                                            Description
                                          </p>
                                          <p className="text-sm text-foreground bg-muted/50 p-3 rounded-lg">
                                            {ingestor.description}
                                          </p>
                                        </div>
                                      )}

                                      {ingestor.metadata &&
                                        Object.keys(ingestor.metadata).length >
                                          0 && (
                                          <details className="rounded-lg bg-muted/50 border border-border/50">
                                            <summary className="cursor-pointer text-xs font-medium text-foreground px-3 py-2 hover:bg-muted/50">
                                              Metadata (
                                              {
                                                Object.keys(ingestor.metadata)
                                                  .length
                                              }{" "}
                                              fields)
                                            </summary>
                                            <div className="px-3 pb-3">
                                              <SyntaxHighlighter
                                                language="json"
                                                style={vscDarkPlus}
                                                customStyle={{
                                                  margin: 0,
                                                  borderRadius: "0.5rem",
                                                  fontSize: "0.75rem",
                                                  maxHeight: "200px",
                                                }}
                                              >
                                                {JSON.stringify(
                                                  ingestor.metadata,
                                                  null,
                                                  2,
                                                )}
                                              </SyntaxHighlighter>
                                            </div>
                                          </details>
                                        )}
                                    </div>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </motion.div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.section>
        </div>
      </ScrollArea>

      {/* Delete Data Source Confirmation Dialog */}
      <AnimatePresence>
        {showDeleteDataSourceConfirm && (
          <motion.div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowDeleteDataSourceConfirm(null)}
          >
            <motion.div
              className="bg-card p-6 rounded-xl shadow-2xl max-w-md w-full mx-4 border border-border"
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg bg-destructive/10">
                  <Trash2 className="h-5 w-5 text-destructive" />
                </div>
                <h3 className="text-lg font-bold text-foreground">
                  Delete Data Source
                </h3>
              </div>
              <p className="text-muted-foreground mb-6">
                Are you sure you want to delete this data source? This will
                permanently remove all associated documents and data. This
                action cannot be undone.
              </p>
              <div className="flex justify-end gap-3">
                <Button
                  variant="ghost"
                  onClick={() => setShowDeleteDataSourceConfirm(null)}
                  disabled={isDeletingDataSource}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() =>
                    handleDeleteDataSource(showDeleteDataSourceConfirm)
                  }
                  disabled={isDeletingDataSource}
                >
                  {isDeletingDataSource && (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  )}
                  {isDeletingDataSource ? "Deleting..." : "Delete Data Source"}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Re-ingest Confirmation Dialog */}
      <AnimatePresence>
        {showReIngestConfirm && (
          <motion.div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowReIngestConfirm(null)}
          >
            <motion.div
              className="bg-card p-6 rounded-xl shadow-2xl max-w-md w-full mx-4 border border-border"
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg bg-primary/10">
                  <RotateCcw className="h-5 w-5 text-primary" />
                </div>
                <h3 className="text-lg font-bold text-foreground">
                  Re-ingest Data Source
                </h3>
              </div>
              <p className="text-muted-foreground mb-6">
                This will re-fetch and re-process all content from this data
                source. Existing documents will be updated with fresh content.
              </p>
              <div className="flex justify-end gap-3">
                <Button
                  variant="ghost"
                  onClick={() => setShowReIngestConfirm(null)}
                  disabled={isReIngesting}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => handleReloadDataSource(showReIngestConfirm)}
                  disabled={isReIngesting}
                >
                  {isReIngesting && (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  )}
                  {isReIngesting ? "Re-ingesting..." : "Re-ingest"}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <ReuploadFileModal
        open={Boolean(showReuploadModal)}
        limits={ingestorLimits.file}
        isSubmitting={isReuploading}
        onClose={() => setShowReuploadModal(null)}
        onSubmit={(files) => {
          if (!showReuploadModal) return;
          return handleReuploadFile(showReuploadModal, files);
        }}
      />

      {/* Re-ingest Error Dialog */}
      <Dialog
        open={Boolean(reIngestError)}
        onOpenChange={(open) => !open && setReIngestError(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Re-ingest failed
            </DialogTitle>
            <DialogDescription>
              The data source could not be re-ingested. Check your ReBAC
              assignment for this knowledge base and try again.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {reIngestError}
          </div>
          <div className="flex justify-end">
            <Button onClick={() => setReIngestError(null)}>OK</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Legacy/direct datasources (for example local file uploads) do not
          have an ingestion-source config row, so this dialog manages both the
          singular owner and independent Search grants. */}
      <Dialog
        open={Boolean(sharingDatasource)}
        onOpenChange={(open) => !open && setSharingDatasource(null)}
      >
        <DialogContent className="h-[82vh] max-h-[720px] w-[95vw] grid-rows-[auto_minmax(0,1fr)] overflow-visible sm:max-w-[960px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-muted-foreground" />
              Manage Datasource
            </DialogTitle>
            <DialogDescription
              className="truncate"
              title={
                sharingDatasource?.name ?? sharingDatasource?.datasource_id
              }
            >
              {sharingDatasource?.name ?? sharingDatasource?.datasource_id}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto pr-1">
            {sharingDatasource && (
              <KbSharingPanel
                knowledgeBaseId={sharingDatasource.datasource_id}
                onSaved={() => Promise.all([
                  fetchDataSources(),
                  fetchPendingPublicationRequests(),
                ]).then(() => undefined)}
                onCancel={() => setSharingDatasource(null)}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit dialog for existing structured ingestion source config rows. */}
      <IngestionSourceForm
        open={sourceDialogOpen}
        onClose={() => {
          setSourceDialogOpen(false);
          setEditingSourceConfig(null);
        }}
        onSave={handleSaveSourceConfig}
        initial={editingSourceConfig}
        pendingPublicationRequest={editingSourceConfig
          ? pendingPublicationRequests.get(editingSourceConfig.source_id)
          : null}
        onPublicationRequestWithdrawn={async () => {
          await fetchPendingPublicationRequests();
        }}
      />

      {/* Cleanup Confirmation Dialog */}
      <AnimatePresence>
        {showCleanupConfirm && (
          <motion.div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowCleanupConfirm(null)}
          >
            <motion.div
              className="bg-card p-6 rounded-xl shadow-2xl max-w-md w-full mx-4 border border-border"
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg bg-amber-500/10">
                  <Eraser className="h-5 w-5 text-amber-500" />
                </div>
                <h3 className="text-lg font-bold text-foreground">
                  Cleanup Stale Data
                </h3>
              </div>
              <p className="text-muted-foreground mb-4">
                This will delete stale chunks and graph entities from this data
                source where the{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">
                  fresh_until
                </code>{" "}
                timestamp has expired.
              </p>
              <div className="bg-amber-500/10 border-l-4 border-amber-500 p-3 mb-6 rounded-r-lg">
                <p className="text-sm text-amber-600 dark:text-amber-400">
                  <strong>Note:</strong> This only removes data that is past its
                  expiration time. Active data will not be affected.
                </p>
              </div>
              <div className="flex justify-end gap-3">
                <Button
                  variant="ghost"
                  onClick={() => setShowCleanupConfirm(null)}
                  disabled={isCleaningUp}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => handleCleanupDataSource(showCleanupConfirm)}
                  disabled={isCleaningUp}
                  className="bg-amber-500 hover:bg-amber-600 text-white"
                >
                  {isCleaningUp && (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  )}
                  {isCleaningUp ? "Cleaning up..." : "Cleanup"}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Help Popup */}
      <AnimatePresence>
        {showHelp && (
          <motion.div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowHelp(false)}
          >
            <motion.div
              className="bg-card p-6 rounded-xl shadow-2xl max-w-lg w-full mx-4 border border-border"
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <HelpCircle className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="text-lg font-bold text-foreground">
                    How It Works
                  </h3>
                </div>
                <button
                  onClick={() => setShowHelp(false)}
                  className="p-1 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Diagram */}
              <div className="mb-6 p-4 bg-muted/30 rounded-lg border border-border/50">
                <div className="flex items-center justify-center gap-2 text-sm">
                  <div className="flex flex-col items-center gap-1">
                    <div className="p-2 rounded-lg bg-blue-500/20 border border-blue-500/30">
                      <Server className="h-5 w-5 text-blue-400" />
                    </div>
                    <span className="text-xs font-medium text-blue-400">
                      Ingestor
                    </span>
                  </div>
                  <div className="flex flex-col items-center">
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground">
                      creates
                    </span>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <div className="p-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30">
                      <Database className="h-5 w-5 text-emerald-400" />
                    </div>
                    <span className="text-xs font-medium text-emerald-400">
                      Datasource
                    </span>
                  </div>
                  <div className="flex flex-col items-center">
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground">
                      contains
                    </span>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <div className="p-2 rounded-lg bg-purple-500/20 border border-purple-500/30">
                      <FileText className="h-5 w-5 text-purple-400" />
                    </div>
                    <span className="text-xs font-medium text-purple-400">
                      Documents
                    </span>
                  </div>
                  <div className="flex flex-col items-center">
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground">
                      split into
                    </span>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <div className="p-2 rounded-lg bg-orange-500/20 border border-orange-500/30">
                      <Layers className="h-5 w-5 text-orange-400" />
                    </div>
                    <span className="text-xs font-medium text-orange-400">
                      Chunks
                    </span>
                  </div>
                </div>
              </div>

              {/* Definitions */}
              <div className="space-y-4">
                <div className="flex gap-3">
                  <div className="p-2 rounded-lg bg-blue-500/20 border border-blue-500/30 h-fit">
                    <Server className="h-4 w-4 text-blue-400" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-foreground text-sm">
                      Ingestors
                    </h4>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Background services that fetch and process content from
                      external sources. Each ingestor type (web, Confluence,
                      GitHub, etc.) handles a specific source type and can
                      create multiple datasources.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="p-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30 h-fit">
                    <Database className="h-4 w-4 text-emerald-400" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-foreground text-sm">
                      Datasources
                    </h4>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      A collection of documents from a single source URL or
                      location. Each datasource tracks its own refresh schedule
                      and contains one or more documents. Example: a
                      documentation website.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="p-2 rounded-lg bg-purple-500/20 border border-purple-500/30 h-fit">
                    <FileText className="h-4 w-4 text-purple-400" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-foreground text-sm">
                      Documents
                    </h4>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Individual pages or files extracted from a datasource.
                      Each document is split into smaller chunks for efficient
                      vector embedding and semantic search.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="p-2 rounded-lg bg-orange-500/20 border border-orange-500/30 h-fit">
                    <Layers className="h-4 w-4 text-orange-400" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-foreground text-sm">
                      Chunks
                    </h4>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Small segments of text that are converted into vector
                      embeddings for semantic search. Chunk size and overlap can
                      be configured per datasource.
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-6 flex justify-end">
                <Button onClick={() => setShowHelp(false)}>Got it</Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Metadata Modal */}
      <Dialog
        open={metadataModal?.isOpen ?? false}
        onOpenChange={(open) => !open && setMetadataModal(null)}
      >
        <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {metadataModal?.type === "document" ? (
                <FileText className="h-4 w-4" />
              ) : (
                <Layers className="h-4 w-4" />
              )}
              {metadataModal?.type === "document" ? "Document" : "Chunk"}{" "}
              Metadata
            </DialogTitle>
            <DialogDescription
              className="truncate"
              title={metadataModal?.title}
            >
              {metadataModal?.title}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto">
            <div className="space-y-2">
              {metadataModal?.metadata &&
                Object.entries(metadataModal.metadata).map(([key, value]) => (
                  <div
                    key={key}
                    className="flex flex-col gap-0.5 py-1.5 border-b border-border/50 last:border-0"
                  >
                    <span className="text-xs font-medium text-muted-foreground">
                      {key}
                    </span>
                    <span className="text-sm font-mono break-all">
                      {value === null || value === undefined ? (
                        <span className="text-muted-foreground/50 italic">
                          null
                        </span>
                      ) : typeof value === "boolean" ? (
                        <Badge
                          variant={value ? "default" : "secondary"}
                          className="text-[10px]"
                        >
                          {value ? "true" : "false"}
                        </Badge>
                      ) : typeof value === "number" ? (
                        key.includes("time") ||
                        key.includes("until") ||
                        key.includes("at") ? (
                          <span title={new Date(value * 1000).toISOString()}>
                            {formatRelativeTime(value)}{" "}
                            <span className="text-muted-foreground/60">
                              ({value})
                            </span>
                          </span>
                        ) : (
                          String(value)
                        )
                      ) : typeof value === "object" ? (
                        <pre className="text-[10px] bg-muted/50 p-2 rounded overflow-x-auto">
                          {JSON.stringify(value, null, 2)}
                        </pre>
                      ) : (
                        String(value)
                      )}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
