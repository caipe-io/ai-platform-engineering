"use client";

/**
 * SearchView - Search UI using MCP tools
 *
 * Features:
 * - MCP tool selector (built-in 'search' + custom tools)
 * - Parsed results with structured cards (text_content, metadata, score)
 * - Collapsible result sections by search type
 * - Conditional filters based on tool schema
 * - Collapsible metadata sections
 * - Search disabled when no MCP tools available
 */

import { SearchablePicker } from '@/components/ui/searchable-picker';
import { getMCPTools } from '@/lib/rag-api';
import { formatFreshUntil } from '@/lib/utils';
import { AnimatePresence,motion } from 'framer-motion';
import { AlertCircle,ArrowRight,ChevronDown,ChevronUp,Database,ExternalLink,FileText,Hash,Search,Wrench,X } from 'lucide-react';
import { usePathname,useRouter,useSearchParams } from 'next/navigation';
import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MCPToolSchema } from './api';
import { getDataSources,getHealthStatus,getMCPToolSchemas,invokeMCPTool } from './api';
import { MetadataFilterKeyPicker } from './MetadataFilterKeyPicker';
import {
    parseSearchViewState,
    serializeSearchViewState,
    type SearchViewState,
} from './search-view-state';

// Fast animation transition
const fastTransition = { duration: 0.1 };

// Types for parsed search results
interface SearchResultItem {
    text_content: string;
    metadata: Record<string, unknown>;
    score: number;
}

interface ParsedResults {
    [label: string]: SearchResultItem[];
}

interface SearchViewProps {
    onExploreEntity?: (entityType: string, primaryKey: string) => void;
    onNavigateToDataSources?: () => void;
}

// Truncatable description component
function TruncatableDescription({ text }: { text: string }) {
    const [expanded, setExpanded] = useState(false);
    
    return (
        <div className="text-xs text-muted-foreground">
            <p className={`whitespace-pre-wrap ${!expanded ? 'line-clamp-1' : ''}`}>{text}</p>
            <button
                onClick={() => setExpanded(!expanded)}
                className="text-primary hover:underline mt-0.5"
            >
                {expanded ? 'Show less' : 'Show more'}
            </button>
        </div>
    );
}

// Result card component with collapsible metadata
function ResultCard({
    result,
    index,
    onExploreEntity,
}: {
    result: SearchResultItem;
    index: number;
    onExploreEntity?: (entityType: string, primaryKey: string) => void;
}) {
    const [showMetadata, setShowMetadata] = useState(false);
    
    // Extract useful metadata fields
    const metadata = result.metadata || {};
    const source = metadata.source as string | undefined;
    const docType = metadata.doc_type as string | undefined;
    const datasourceId = metadata.datasource_id as string | undefined;
    const title = metadata.title as string | undefined;
    const entityType = metadata.entity_type as string | undefined;
    const primaryKey = metadata.primary_key as string | undefined;
    
    return (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
            {/* Header with score and title */}
            <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-muted-foreground">#{index + 1}</span>
                    {title && (
                        <span className="text-sm font-medium text-foreground truncate max-w-md">
                            {title}
                        </span>
                    )}
                    {docType && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary rounded text-xs">
                            <FileText className="h-3 w-3" />
                            {docType}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                        Score: <span className="font-mono">{result.score.toFixed(3)}</span>
                    </span>
                    {onExploreEntity && entityType && primaryKey && (
                        <button
                            type="button"
                            onClick={() => onExploreEntity(entityType, primaryKey)}
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                            Explore <ArrowRight className="h-3 w-3" />
                        </button>
                    )}
                </div>
            </div>
            
            {/* Content - rendered as Markdown */}
            <div className="px-4 py-3">
                <div className="prose prose-sm dark:prose-invert max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {result.text_content}
                    </ReactMarkdown>
                </div>
            </div>
            
            {/* Collapsible metadata section */}
            <div className="border-t border-border">
                <button
                    onClick={() => setShowMetadata(!showMetadata)}
                    className="w-full px-4 py-2 flex items-center justify-between text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
                >
                    <span className="flex items-center gap-2">
                        <Hash className="h-3 w-3" />
                        Metadata
                    </span>
                    {showMetadata ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
                
                <AnimatePresence>
                    {showMetadata && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.15 }}
                            className="overflow-hidden"
                        >
                            <div className="px-4 py-3 bg-muted/20 space-y-2 text-xs">
                                {source && (
                                    <div className="flex items-start gap-2">
                                        <span className="text-muted-foreground min-w-[80px]">Source:</span>
                                        <a 
                                            href={source} 
                                            target="_blank" 
                                            rel="noopener noreferrer"
                                            className="text-primary hover:underline flex items-center gap-1 break-all"
                                        >
                                            {source}
                                            <ExternalLink className="h-3 w-3 flex-shrink-0" />
                                        </a>
                                    </div>
                                )}
                                {datasourceId && (
                                    <div className="flex items-start gap-2">
                                        <span className="text-muted-foreground min-w-[80px]">Datasource:</span>
                                        <span className="font-mono text-foreground">{datasourceId}</span>
                                    </div>
                                )}
                                {/* Show all other metadata */}
                                {Object.entries(metadata)
                                    .filter(([key]) => !['source', 'doc_type', 'datasource_id', 'title', 'text_content'].includes(key))
                                    .map(([key, value]) => (
                                        <div key={key} className="flex items-start gap-2">
                                            <span className="text-muted-foreground min-w-[80px]">{key}:</span>
                                            <span className="font-mono text-foreground break-all">
                                                {key === 'fresh_until' && typeof value === 'number'
                                                    ? formatFreshUntil(value)
                                                    : typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                            </span>
                                        </div>
                                    ))
                                }
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}

// Collapsible result section component
function ResultSection({
    label,
    items,
    onExploreEntity,
}: {
    label: string;
    items: SearchResultItem[];
    onExploreEntity?: (entityType: string, primaryKey: string) => void;
}) {
    const [expanded, setExpanded] = useState(true);
    
    return (
        <div className="mb-4">
            {/* Section header - clickable to collapse */}
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted/70 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <span className="px-2 py-1 bg-primary/10 text-primary rounded text-xs font-medium">
                        {label}
                    </span>
                    <span className="text-sm text-muted-foreground">
                        ({items.length} result{items.length !== 1 ? 's' : ''})
                    </span>
                </div>
                {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>
            
            <AnimatePresence>
                {expanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="overflow-hidden"
                    >
                        {items.length > 0 ? (
                            <div className="space-y-4 mt-3">
                                {items.map((result, index) => (
                                    <ResultCard 
                                        key={`${label}-${index}`} 
                                        result={result} 
                                        index={index} 
                                        onExploreEntity={onExploreEntity}
                                    />
                                ))}
                            </div>
                        ) : (
                            <p className="text-sm text-muted-foreground italic mt-3">
                                No results in this category.
                            </p>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

export default function SearchView({ onExploreEntity, onNavigateToDataSources }: SearchViewProps) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const searchParamsSignature = searchParams.toString();
    const initialUrlState = useMemo(
        () => parseSearchViewState(searchParams),
        // The initial value is intentionally captured once. Later URL changes
        // are applied by the deep-link effect after tool discovery completes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    );

    // Query state
    const [query, setQuery] = useState(initialUrlState.query);
    const [limit, setLimit] = useState(initialUrlState.limit);
    const [filters, setFilters] = useState<Record<string, string | boolean>>(initialUrlState.filters);
    const [parsedResults, setParsedResults] = useState<ParsedResults | null>(null);
    const [loadingQuery, setLoadingQuery] = useState(false);
    const [lastQuery, setLastQuery] = useState('');

    // MCP Tool selection
    const [availableTools, setAvailableTools] = useState<MCPToolSchema[]>([]);
    const [selectedTool, setSelectedTool] = useState<string>(initialUrlState.tool);
    const [loadingTools, setLoadingTools] = useState(false);
    const lastExecutedDeepLink = useRef<string | null>(null);

    // Filter configuration
    const [validFilterKeys, setValidFilterKeys] = useState<string[]>([]);
    const [filterKeyTypes, setFilterKeyTypes] = useState<Record<string, string>>({});
    const [, setSupportedDocTypes] = useState<string[]>([]);
    const [selectedFilterKey, setSelectedFilterKey] = useState('');
    const [customFilterKey, setCustomFilterKey] = useState('');
    const [filterValue, setFilterValue] = useState('');
    const [showCustomInput, setShowCustomInput] = useState(false);

    // Data sources count for empty state
    const [dataSourcesCount, setDataSourcesCount] = useState<number | null>(null);

    // Check if selected tool supports filters
    const selectedToolSchema = useMemo(() => 
        availableTools.find(t => t.name === selectedTool),
        [availableTools, selectedTool]
    );
    
    const toolSupportsFilters = useMemo(() => 
        selectedToolSchema?.parameters?.properties?.filters !== undefined,
        [selectedToolSchema]
    );

    // Fetch MCP tool schemas on mount
    useEffect(() => {
        const fetchToolSchemas = async () => {
            setLoadingTools(true);
            try {
                // Fetch all MCP tool schemas and custom tool configs
                const [schemasResponse, customTools] = await Promise.all([
                    getMCPToolSchemas(),
                    getMCPTools(),
                ]);
                
                // Get custom tool IDs
                const customToolIds = new Set(customTools.map(t => t.tool_id));
                
                // Filter to: built-in 'search' tool + all custom tools
                const searchTools = schemasResponse.tools.filter(tool => 
                    tool.name === 'search' || customToolIds.has(tool.name)
                );
                
                setAvailableTools(searchTools);
                setSelectedTool((currentTool) =>
                    searchTools.some((tool) => tool.name === currentTool)
                        ? currentTool
                        : (searchTools[0]?.name ?? currentTool),
                );
            } catch (error) {
                console.error('Failed to fetch MCP tool schemas:', error);
            } finally {
                setLoadingTools(false);
            }
        };
        fetchToolSchemas();
    }, []);

    // Fetch filter config on mount
    useEffect(() => {
        const fetchFilterConfig = async () => {
            try {
                const response = await getHealthStatus();
                setValidFilterKeys(response?.config?.search?.keys || []);
                // Build a type lookup from filter_keys (e.g., [{key: "is_structured_entity", type: "bool"}, ...])
                const typedKeys: Array<{key: string; type: string}> = response?.config?.search?.filter_keys || [];
                const typeMap: Record<string, string> = {};
                for (const entry of typedKeys) {
                    typeMap[entry.key] = entry.type;
                }
                setFilterKeyTypes(typeMap);
                setSupportedDocTypes(response?.config?.search?.supported_doc_types || []);
            } catch (error) {
                console.error('Failed to fetch filter configuration:', error);
            }
        };
        fetchFilterConfig();
    }, []);

    // Fetch data sources count for empty state
    useEffect(() => {
        const fetchDataSourcesCount = async () => {
            try {
                const response = await getDataSources();
                setDataSourcesCount(response.datasources?.length ?? 0);
            } catch (error) {
                console.error('Failed to fetch data sources:', error);
                setDataSourcesCount(0);
            }
        };
        fetchDataSourcesCount();
    }, []);

    // Filter management functions
    const getFilterKeyType = (key: string): string => filterKeyTypes[key] || 'string';

    const addFilter = () => {
        const keyToUse = showCustomInput ? customFilterKey.trim() : selectedFilterKey;
        if (!keyToUse) return;

        const keyType = getFilterKeyType(keyToUse);
        if (keyType === 'bool') {
            // Bool filters are added via toggle, not text input
            setFilters(prev => ({ ...prev, [keyToUse]: true }));
        } else if (filterValue.trim()) {
            setFilters(prev => ({ ...prev, [keyToUse]: filterValue.trim() }));
        } else {
            return;
        }
        setSelectedFilterKey('');
        setCustomFilterKey('');
        setFilterValue('');
        setShowCustomInput(false);
    };

    const handleFilterKeyChange = (value: string) => {
        if (value === '__custom__') {
            setShowCustomInput(true);
            setSelectedFilterKey('');
        } else {
            setShowCustomInput(false);
            setSelectedFilterKey(value);
            setCustomFilterKey('');
        }
    };

    const removeFilter = (key: string) => {
        setFilters(prev => {
            const newFilters = { ...prev };
            delete newFilters[key];
            return newFilters;
        });
    };

    const executeSearch = useCallback(async (state: SearchViewState) => {
        if (!state.query.trim()) return;
        setLoadingQuery(true);
        setParsedResults(null);
        try {
            // Build MCP tool arguments matching the tool's schema
            const mcpArgs: Record<string, unknown> = {
                query: state.query.trim(),
                limit: state.limit,
            };

            // Add filters if the tool supports them
            const schema = availableTools.find((tool) => tool.name === state.tool);
            const supportsFilters = schema?.parameters?.properties?.filters !== undefined;
            if (supportsFilters) {
                const combinedFilters: Record<string, string | boolean> = { ...state.filters };
                if (Object.keys(combinedFilters).length > 0) {
                    mcpArgs.filters = combinedFilters;
                }
            }

            const response = await invokeMCPTool(state.tool, mcpArgs);
            
            if (!response.success) {
                throw new Error(response.error || 'Search failed');
            }

            // Result is already parsed as dict with dynamic keys (labels)
            // Each key maps to an array of {text_content, metadata, score}
            if (response.result && typeof response.result === 'object') {
                setParsedResults(response.result as ParsedResults);
            } else if (response.result && typeof response.result === 'string') {
                // Fallback: if result is a string, show it as raw text
                setParsedResults({ 'results': [{ text_content: response.result, metadata: {}, score: 0 }] });
            } else {
                setParsedResults({});
            }
            setLastQuery(state.query.trim());
        } catch (e: unknown) {
            const errorMessage = e instanceof Error ? e.message : 'unknown error';
            alert(`Query failed: ${errorMessage}`);
        } finally {
            setLoadingQuery(false);
        }
    }, [availableTools]);

    const handleQuery = useCallback(async () => {
        const nextState: SearchViewState = {
            query: query.trim(),
            tool: selectedTool,
            limit,
            filters,
        };
        if (!nextState.query) return;
        const params = serializeSearchViewState(nextState).toString();
        lastExecutedDeepLink.current = params;
        router.push(`${pathname}${params ? `?${params}` : ''}`, { scroll: false });
        await executeSearch(nextState);
    }, [executeSearch, filters, limit, pathname, query, router, selectedTool]);

    // A shared URL is a request to repeat the search, not a cache of somebody
    // else's result set. Tool discovery is RBAC-filtered and the invocation is
    // still authorized server-side, so a URL cannot grant access to a tool or
    // datasource the recipient cannot use.
    useEffect(() => {
        const requested = parseSearchViewState(new URLSearchParams(searchParamsSignature));
        setQuery(requested.query);
        setLimit(requested.limit);
        setFilters(requested.filters);

        if (!requested.query.trim()) {
            setSelectedTool(requested.tool);
            setParsedResults(null);
            setLastQuery('');
            lastExecutedDeepLink.current = null;
            return;
        }
        if (loadingTools || availableTools.length === 0) return;

        const permittedTool = availableTools.some((tool) => tool.name === requested.tool)
            ? requested.tool
            : availableTools[0].name;
        const effective = { ...requested, tool: permittedTool };
        setSelectedTool(permittedTool);
        const effectiveParams = serializeSearchViewState(effective).toString();
        if (lastExecutedDeepLink.current === effectiveParams) return;

        lastExecutedDeepLink.current = effectiveParams;
        if (effectiveParams !== searchParamsSignature) {
            router.replace(`${pathname}?${effectiveParams}`, { scroll: false });
        }
        void executeSearch(effective);
    }, [
        availableTools,
        executeSearch,
        loadingTools,
        pathname,
        router,
        searchParamsSignature,
    ]);

    const clearResults = useCallback(() => {
        const cleared = serializeSearchViewState({
            query: '',
            tool: selectedTool,
            limit,
            filters,
        }).toString();
        lastExecutedDeepLink.current = null;
        router.replace(`${pathname}${cleared ? `?${cleared}` : ''}`, { scroll: false });
        setParsedResults(null);
        setLastQuery('');
        setQuery('');
    }, [filters, limit, pathname, router, selectedTool]);

    const hasResults = parsedResults !== null;

    // Count total results
    const totalResultCount = useMemo(() => {
        if (!parsedResults) return 0;
        return Object.values(parsedResults).reduce((sum, arr) => sum + arr.length, 0);
    }, [parsedResults]);

    // Check if search is available (has tools)
    const searchAvailable = availableTools.length > 0 && !loadingTools;

    // Settings panel
    const settingsPanel = (
        <div className="space-y-3 text-sm">
            {/* Row 1: Tool selector dropdown with description - full width */}
            <div>
                <div className="flex items-center gap-2 mb-2">
                    <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">MCP Tool</span>
                </div>
                {loadingTools ? (
                    <div className="w-full h-10 rounded-lg border border-border bg-muted/50 animate-pulse" />
                ) : !searchAvailable ? (
                    <div className="flex items-center gap-2 p-3 rounded-lg border border-destructive/30 bg-destructive/5">
                        <AlertCircle className="h-4 w-4 text-destructive" />
                        <span className="text-sm text-destructive">No search tools available</span>
                    </div>
                ) : (
                    <div>
                        <SearchablePicker
                            options={availableTools}
                            selected={availableTools.find(tool => tool.name === selectedTool)}
                            onSelect={(tool) => setSelectedTool(tool.name)}
                            getOptionKey={(tool) => tool.name}
                            getOptionLabel={(tool) => `${tool.name}${tool.name === 'search' ? ' (default)' : ''}`}
                            getSearchText={(tool) => [tool.name]}
                            placeholder="Select an MCP tool"
                            searchPlaceholder="Search MCP tools..."
                            emptyLabel="No MCP tools match"
                            ariaLabel="MCP Tool"
                            required
                            triggerClassName="h-10 rounded-lg px-4 py-2.5 text-sm"
                        />
                        {selectedToolSchema?.description && (
                            <div className="mt-2 px-1">
                                <TruncatableDescription text={selectedToolSchema.description} />
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Row 2: Limit */}
            <div className="flex flex-wrap items-center gap-4">
                {/* Result Limit */}
                <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Limit:</span>
                    <input
                        type="number"
                        min={1}
                        max={100}
                        value={limit}
                        onChange={(e) => setLimit(parseInt(e.target.value, 10))}
                        className="w-16 rounded border border-border bg-background px-2 py-1 text-xs focus:border-primary focus:outline-none text-foreground"
                    />
                </div>
            </div>

            {/* Row 3: Filters - boxed section, only show if tool supports filters */}
            {toolSupportsFilters && (
                <div className="p-3 rounded-lg border border-border bg-muted/30">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Filters</span>
                        <span className="text-xs text-muted-foreground">Supports metadata.* for custom fields</span>
                    </div>
                    
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                        {/* Filter key selector */}
                        <div className="flex items-center gap-2">
                            {!showCustomInput ? (
                                <MetadataFilterKeyPicker
                                    keys={validFilterKeys}
                                    value={selectedFilterKey}
                                    onChange={handleFilterKeyChange}
                                    triggerClassName="h-7 w-48 px-2 py-1 text-xs"
                                />
                            ) : (
                                <div className="flex items-center gap-1">
                                    <input
                                        type="text"
                                        placeholder="metadata.field_name"
                                        value={customFilterKey}
                                        onChange={(e) => setCustomFilterKey(e.target.value)}
                                        className="w-48 rounded border border-border bg-background px-2 py-1 text-xs focus:border-primary focus:outline-none text-foreground font-mono"
                                        autoFocus
                                    />
                                    <button
                                        onClick={() => {
                                            setShowCustomInput(false);
                                            setCustomFilterKey('');
                                        }}
                                        className="p-1 text-muted-foreground hover:text-foreground"
                                        title="Cancel custom key"
                                    >
                                        <X className="h-3 w-3" />
                                    </button>
                                </div>
                            )}
                            {(selectedFilterKey || (showCustomInput && customFilterKey)) && (
                                <>
                                    {getFilterKeyType(showCustomInput ? customFilterKey : selectedFilterKey) === 'bool' ? (
                                        <button
                                            onClick={addFilter}
                                            className="px-2 py-1 bg-primary text-primary-foreground rounded text-xs hover:bg-primary/90"
                                        >
                                            Add as true
                                        </button>
                                    ) : (
                                        <>
                                            <input
                                                type="text"
                                                placeholder="Value"
                                                value={filterValue}
                                                onChange={(e) => setFilterValue(e.target.value)}
                                                className="w-48 rounded border border-border bg-background px-2 py-1 text-xs focus:border-primary focus:outline-none text-foreground"
                                                onKeyDown={(e) => e.key === 'Enter' && addFilter()}
                                            />
                                            <button
                                                onClick={addFilter}
                                                disabled={!filterValue.trim()}
                                                className="px-2 py-1 bg-primary text-primary-foreground rounded text-xs hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
                                            >
                                                Add
                                            </button>
                                        </>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    {/* Active filters */}
                    {Object.keys(filters).length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                            {Object.entries(filters).map(([key, value]) => (
                                <span
                                    key={key}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary rounded text-xs"
                                >
                                    {typeof value === 'boolean' ? (
                                        <>
                                            {key}:
                                            <button
                                                onClick={() => setFilters(prev => ({ ...prev, [key]: !value }))}
                                                className={`font-semibold px-1 rounded ${value ? 'text-green-600' : 'text-red-600'}`}
                                                title={`Click to toggle to ${!value}`}
                                            >
                                                {String(value)}
                                            </button>
                                        </>
                                    ) : (
                                        <>{key}: {value}</>
                                    )}
                                    <button onClick={() => removeFilter(key)} className="hover:text-primary/80">
                                        <X className="h-3 w-3" />
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );

    return (
        <div className="h-full flex flex-col bg-background">
            <AnimatePresence mode="wait">
                {!hasResults ? (
                    // Centered search state (like Google homepage)
                    <motion.div
                        key="centered"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={fastTransition}
                        className="h-full flex flex-col items-center px-6 py-8 pt-[10vh] overflow-y-auto"
                    >
                        {/* Logo/Title */}
                        <div className="mb-6 text-center">
                            <div className="inline-flex p-4 rounded-2xl gradient-primary-br shadow-lg shadow-primary/20 mb-4">
                                <Search className="h-10 w-10 text-white" />
                            </div>
                            <h2 className="text-3xl font-bold gradient-text mb-2">Knowledge Search</h2>
                            <p className="text-muted-foreground">Search and explore your knowledge base</p>
                        </div>

                        {/* Search Input */}
                        <div className="flex gap-2 w-full max-w-2xl">
                            <div className="relative flex-1">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <input
                                    type="text"
                                    placeholder="Search your knowledge base..."
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    className="w-full pl-10 pr-4 py-3 border border-border rounded-full focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent bg-background text-foreground shadow-sm"
                                    onKeyDown={(e) => e.key === 'Enter' && searchAvailable && handleQuery()}
                                    disabled={!searchAvailable}
                                />
                            </div>
                            <button
                                onClick={handleQuery}
                                disabled={!query || loadingQuery || !searchAvailable}
                                className="px-6 py-3 bg-primary hover:bg-primary/90 text-primary-foreground rounded-full transition-colors disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed font-medium shadow-sm"
                                title={!searchAvailable ? 'No search tools available' : undefined}
                            >
                                {loadingQuery ? 'Searching…' : 'Search'}
                            </button>
                        </div>

                        {/* Quick tips */}
                        {searchAvailable && (
                            <div className="mt-4 text-center text-sm text-muted-foreground">
                                <p>Press <kbd className="px-2 py-0.5 rounded bg-muted border border-border text-xs">Enter</kbd> to search</p>
                            </div>
                        )}

                        {/* Settings Panel - Always visible */}
                        <div className="w-full max-w-2xl mt-6">
                            {settingsPanel}
                        </div>

                        {/* Empty data sources suggestion */}
                        {dataSourcesCount === 0 && (
                            <motion.div
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 0.2 }}
                                className="mt-6 p-4 rounded-xl bg-primary/5 border border-primary/20 max-w-lg text-center"
                            >
                                <div className="flex items-center justify-center gap-2 mb-2">
                                    <Database className="h-5 w-5 text-primary" />
                                    <span className="font-medium text-foreground">No data sources yet</span>
                                </div>
                                <p className="text-sm text-muted-foreground mb-3">
                                    To search your knowledge base, you need to ingest some data sources first.
                                </p>
                                {onNavigateToDataSources && (
                                    <button
                                        onClick={onNavigateToDataSources}
                                        className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-full text-sm font-medium hover:bg-primary/90 transition-colors"
                                    >
                                        Add Data Sources
                                        <ArrowRight className="h-4 w-4" />
                                    </button>
                                )}
                            </motion.div>
                        )}
                    </motion.div>
                ) : (
                    // Results state (search bar at top)
                    <motion.div
                        key="results"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={fastTransition}
                        className="h-full flex flex-col"
                    >
                        {/* Top search bar */}
                        <div className="shrink-0 border-b border-border bg-card/50 backdrop-blur-sm px-6 py-3">
                            <div className="max-w-4xl mx-auto flex items-center gap-4">
                                <button
                                    onClick={clearResults}
                                    className="p-2 rounded-lg gradient-primary-br shadow-sm"
                                >
                                    <Search className="h-5 w-5 text-white" />
                                </button>
                                {/* Compact search input */}
                                <div className="flex-1 flex gap-2">
                                    <div className="relative flex-1">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                        <input
                                            type="text"
                                            placeholder="Search your knowledge base..."
                                            value={query}
                                            onChange={(e) => setQuery(e.target.value)}
                                            className="w-full pl-10 pr-10 py-2 text-sm border border-border rounded-full focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent bg-background text-foreground shadow-sm"
                                            onKeyDown={(e) => e.key === 'Enter' && searchAvailable && handleQuery()}
                                            disabled={!searchAvailable}
                                        />
                                        <button
                                            onClick={clearResults}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                            title="Clear results"
                                        >
                                            <X className="h-4 w-4" />
                                        </button>
                                    </div>
                                    <button
                                        onClick={handleQuery}
                                        disabled={!query || loadingQuery || !searchAvailable}
                                        className="px-4 py-2 text-sm bg-primary hover:bg-primary/90 text-primary-foreground rounded-full transition-colors disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed font-medium shadow-sm"
                                        title={!searchAvailable ? 'No search tools available' : undefined}
                                    >
                                        {loadingQuery ? 'Searching…' : 'Search'}
                                    </button>
                                </div>
                                {/* Selected tool indicator */}
                                <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/10 border border-primary/20 rounded-lg">
                                    <Wrench className="h-4 w-4 text-primary" />
                                    <span className="text-sm font-medium text-primary">{selectedTool}</span>
                                </div>
                            </div>
                        </div>

                        {/* Results - scrollable area */}
                        <div className="flex-1 overflow-y-auto">
                            <div className="max-w-4xl mx-auto px-6 py-4">
                                <div className="flex items-center justify-between mb-4">
                                    <p className="text-sm text-muted-foreground">
                                        {totalResultCount} result{totalResultCount !== 1 ? 's' : ''} for &quot;{lastQuery}&quot;
                                    </p>
                                </div>

                                {/* Render results grouped by label */}
                                {parsedResults && Object.entries(parsedResults).map(([label, items]) => (
                                    <ResultSection
                                        key={label}
                                        label={label}
                                        items={items}
                                        onExploreEntity={onExploreEntity}
                                    />
                                ))}

                                {totalResultCount === 0 && (
                                    <div className="text-center py-12">
                                        <Search className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                                        <p className="text-muted-foreground">No results found for &quot;{lastQuery}&quot;</p>
                                        <p className="text-sm text-muted-foreground mt-2">
                                            Try different keywords or adjust your filters.
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
