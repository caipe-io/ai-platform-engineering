"use client";

import { SigmaContainer } from "@react-sigma/core";
import { MultiDirectedGraph } from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { Filter,Loader2,RefreshCw,RotateCcw,Settings,Trash2,X } from 'lucide-react';
import { useTheme } from "@/components/theme-provider";
import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import type Sigma from 'sigma';
import '../shared/sigma-styles.css';

import { Permission,useRagPermissions } from '@/hooks/useRagPermissions';
import { clearOntology,getOntologyAgentStatus,getOntologyEntitiesBatch,getOntologyGraphStats,getOntologyRelationsBatch,regenerateOntology } from '../../api';
import { CameraController,GraphDragController,GraphEventsController,GraphSettingsController,SigmaInstanceCapture } from '../shared/SigmaGraph';
import { EvaluationResult,getColorForNode,getEvaluationResult } from '../shared/graphStyles';
import { extractRelationId,generateEdgeKey,generateNodeId } from '../shared/graphUtils';
import type { GraphEdgeAttributes,GraphNodeAttributes,GraphRelation } from '../shared/graphTypes';
import OntologyGraphDataController,{ OntologyFilters } from './OntologyGraphDataController';
import OntologyNodeDetailsCard from './OntologyNodeDetailsCard';
import OntologyNodeHoverCard from './OntologyNodeHoverCard';

type OntologyGraphProps = Record<string, never>;

// Helper function to truncate long labels
const truncateLabel = (label: string, maxLength: number = 30): string => {
    if (label.length <= maxLength) return label;
    return label.substring(0, maxLength - 3) + '...';
};

export default function OntologyGraphSigma({}: OntologyGraphProps) {
    const { hasPermission } = useRagPermissions();
    const canIngest = hasPermission(Permission.INGEST);
    const canDelete = hasPermission(Permission.DELETE);
    
    // Theme detection for label colors
    const { resolvedTheme } = useTheme();
    const isDarkMode = resolvedTheme === "dark" || resolvedTheme?.includes("night") || resolvedTheme === "midnight" || resolvedTheme === "nord";

    // Graph instance - use MultiDirectedGraph to allow multiple edges between same nodes
    const graph = useMemo(() => new MultiDirectedGraph<GraphNodeAttributes,GraphEdgeAttributes>(), []);

    // State management
    const [dataReady, setDataReady] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [refreshCounter, setRefreshCounter] = useState(0); // Used to trigger data reload
    const [layoutKey, setLayoutKey] = useState(0); // Used to force SigmaContainer remount after layout
    const [allEntityTypes, setAllEntityTypes] = useState<string[]>([]);
    const [selectedEntityTypes, setSelectedEntityTypes] = useState<Set<string>>(new Set());
    const [selectedNode, setSelectedNode] = useState<{ id: string; data: GraphNodeAttributes } | null>(null);
    const [hoveredNode, setHoveredNode] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState<boolean>(false);
    const [graphStats, setGraphStats] = useState<{ node_count: number; relation_count: number } | null>(null);
    const [, setSigmaInstance] = useState<Sigma<GraphNodeAttributes,GraphEdgeAttributes> | null>(null);
    const [relationFilterMode, setRelationFilterMode] = useState<'accepted-only' | 'all' | 'rejected-uncertain-only'>('all');

    // Advanced mode state (shared between node and edge cards)
    const [advancedMode, setAdvancedMode] = useState(false);

    // Modal states
    const [showFiltersModal, setShowFiltersModal] = useState(false);
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    const [isReanalyzing, setIsReanalyzing] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    // Agent status - matches the actual API response structure
    const [agentStatus, setAgentStatus] = useState<{
        status: string;
        is_processing?: boolean;
        is_evaluating?: boolean;
        agent_status_msg?: string;
        message?: string;
        progress?: { current: number; total: number };
    } | null>(null);

    // Track previous agent busy state to detect when processing completes
    const wasAgentBusyRef = useRef(false);

    // Layout settings
    const [layoutSettings, setLayoutSettings] = useState({
        iterations: 100,
        gravity: 1.0,
        scalingRatio: 10,
        slowDown: 0.6,
    });
    const [isApplyingLayout, setIsApplyingLayout] = useState(false);

    // Node click handler
    const handleNodeClick = useCallback((nodeId: string, nodeData: GraphNodeAttributes) => {
        console.log('Node clicked:', nodeId);
        setSelectedNode({ id: nodeId, data: nodeData });
    }, []);

    // Toggle advanced mode
    const toggleAdvancedMode = useCallback(() => {
        setAdvancedMode(prev => !prev);
    }, []);

    // Refresh function
    const handleRefresh = useCallback(() => {
        graph.clear();
        setDataReady(false);
        setIsLoading(true);
        setRefreshCounter(c => c + 1); // Increment to trigger useEffect
    }, [graph]);

    // Re-analyse (regenerate ontology)
    const handleReanalyze = useCallback(async () => {
        if (isReanalyzing) return;
        setIsReanalyzing(true);
        try {
            await regenerateOntology();
            // Refresh the graph after regeneration
            handleRefresh();
        } catch (err) {
            console.error('Failed to regenerate ontology:', err);
        } finally {
            setIsReanalyzing(false);
        }
    }, [isReanalyzing, handleRefresh]);

    // Delete (clear ontology)
    const handleDelete = useCallback(async () => {
        if (isDeleting) return;
        if (!confirm('Are you sure you want to delete the ontology? This action cannot be undone.')) {
            return;
        }
        setIsDeleting(true);
        try {
            await clearOntology();
            // Clear local state
            graph.clear();
            setGraphStats(null);
            setDataReady(false);
            setAllEntityTypes([]);
            setSelectedEntityTypes(new Set());
        } catch (err) {
            console.error('Failed to clear ontology:', err);
        } finally {
            setIsDeleting(false);
        }
    }, [isDeleting, graph]);

    // Apply layout with current settings
    const applyLayout = useCallback(() => {
        if (!dataReady || graph.order === 0) return;

        setIsApplyingLayout(true);
        try {
            // Randomize positions first so new layout settings have visible effect
            graph.forEachNode((node) => {
                const angle = Math.random() * 2 * Math.PI;
                const radius = Math.random() * 500;
                graph.setNodeAttribute(node, 'x', Math.cos(angle) * radius);
                graph.setNodeAttribute(node, 'y', Math.sin(angle) * radius);
            });
            
            // Apply ForceAtlas2 with current settings
            forceAtlas2.assign(graph, {
                iterations: layoutSettings.iterations,
                settings: {
                    gravity: layoutSettings.gravity,
                    scalingRatio: layoutSettings.scalingRatio,
                    slowDown: layoutSettings.slowDown,
                    barnesHutOptimize: true,
                    barnesHutTheta: 0.5,
                },
            });
            
            // Force SigmaContainer to remount with new positions
            setLayoutKey(k => k + 1);
            setShowSettingsModal(false);
        } catch (err) {
            console.error('Failed to apply layout:', err);
        } finally {
            setIsApplyingLayout(false);
        }
    }, [dataReady, graph, layoutSettings]);

    // Toggle entity type filter
    const toggleEntityType = useCallback((entityType: string) => {
        setSelectedEntityTypes(prev => {
            const newSet = new Set(prev);
            if (newSet.has(entityType)) {
                newSet.delete(entityType);
            } else {
                newSet.add(entityType);
            }
            return newSet;
        });
    }, []);

    // Select/Deselect all entity types
    const selectAllEntityTypes = useCallback(() => {
        setSelectedEntityTypes(new Set(allEntityTypes));
    }, [allEntityTypes]);

    const deselectAllEntityTypes = useCallback(() => {
        setSelectedEntityTypes(new Set());
    }, []);

    // Poll agent status
    useEffect(() => {
        const pollAgentStatus = async () => {
            try {
                const status = await getOntologyAgentStatus() as {
                    status: string;
                    is_processing?: boolean;
                    is_evaluating?: boolean;
                    agent_status_msg?: string;
                    message?: string;
                    progress?: { current: number; total: number };
                };
                
                const isCurrentlyBusy = status.is_processing || status.is_evaluating;
                
                // Detect transition from busy to idle - trigger refresh
                if (wasAgentBusyRef.current && !isCurrentlyBusy) {
                    console.log('Agent finished processing, refreshing graph...');
                    handleRefresh();
                }
                
                // Update the ref for next poll
                wasAgentBusyRef.current = !!isCurrentlyBusy;
                
                setAgentStatus(status);
            } catch (err) {
                console.error('Failed to get agent status:', err);
                setAgentStatus({ status: 'error', message: 'Failed to connect' });
            }
        };

        // Initial fetch
        pollAgentStatus();

        // Poll every 3 seconds
        const interval = setInterval(pollAgentStatus, 3000);

        return () => clearInterval(interval);
    }, [handleRefresh]);

    // Load ontology data
    useEffect(() => {
        const loadOntologyData = async () => {
            if (dataReady) return;

            setIsLoading(true);
            try {
                console.log('Fetching ontology graph data...');

                // Fetch stats first
                const stats = await getOntologyGraphStats();
                setGraphStats(stats);

                if (stats.node_count === 0) {
                    console.log('No ontology data found');
                    setIsLoading(false);
                    return;
                }

                // Fetch all entities
                const entitiesResponse = await getOntologyEntitiesBatch({ limit: 1000 });
                const entities = entitiesResponse.entities || [];

                // Fetch all relations
                const relationsResponse = await getOntologyRelationsBatch({ limit: 1000 });
                const relations = relationsResponse.relations || [];

                console.log(`Loaded ${entities.length} entities, ${relations.length} relations`);

                // Clear any existing graph data before rebuilding
                // This prevents duplicate node errors when useEffect runs multiple times
                graph.clear();

                // Build the graph
                const entityTypes = new Set<string>();
                const nodeDegrees = new Map<string, number>();

                // Add nodes (skip duplicates to prevent graph errors)
                entities.forEach((entity) => {
                    const pk = entity.all_properties?._entity_pk || entity._entity_pk;
                    const entityType = entity.entity_type || entity.all_properties?._entity_type;

                    if (pk && entityType) {
                        const nodeId = generateNodeId(entityType, pk);

                        // Skip if node already exists (handles duplicate entities in data)
                        if (graph.hasNode(nodeId)) {
                            return;
                        }

                        const color = getColorForNode(entityType);
                        entityTypes.add(entityType);

                        // Random initial position
                        const angle = Math.random() * 2 * Math.PI;
                        const radius = Math.random() * 500;

                        graph.addNode(nodeId, {
                            label: truncateLabel(entityType),
                            size: 15,
                            color: color,
                            entityType: entityType,
                            entityData: entity,
                            x: Math.cos(angle) * radius,
                            y: Math.sin(angle) * radius,
                        });

                        nodeDegrees.set(nodeId, 0);
                    }
                });

                // Group relations and add edges
                const relationGroups = new Map<string, GraphRelation[]>();

                relations.forEach((relation) => {
                    const fromPk = relation.from_entity?.primary_key;
                    const toPk = relation.to_entity?.primary_key;
                    const fromType = relation.from_entity?.entity_type;
                    const toType = relation.to_entity?.entity_type;

                    if (!fromPk || !toPk || !fromType || !toType) return;

                    const sourceNodeId = generateNodeId(fromType, fromPk);
                    const targetNodeId = generateNodeId(toType, toPk);

                    if (!graph.hasNode(sourceNodeId) || !graph.hasNode(targetNodeId)) return;

                    const evalResult = getEvaluationResult(relation);
                    const status = evalResult || 'NONE';

                    const normalizedNodeKey = sourceNodeId < targetNodeId
                        ? `${sourceNodeId}<->${targetNodeId}`
                        : `${targetNodeId}<->${sourceNodeId}`;
                    const normalizedKey = `${normalizedNodeKey}-${status}`;

                    if (!relationGroups.has(normalizedKey)) {
                        relationGroups.set(normalizedKey, []);
                    }
                    relationGroups.get(normalizedKey)!.push(relation);
                });

                // Add edges
                relationGroups.forEach((groupRelations, normalizedKey) => {
                    const primaryRelation = groupRelations[0];
                    const sourceNodeId = generateNodeId(
                        primaryRelation.from_entity.entity_type,
                        primaryRelation.from_entity.primary_key
                    );
                    const targetNodeId = generateNodeId(
                        primaryRelation.to_entity.entity_type,
                        primaryRelation.to_entity.primary_key
                    );

                    const status = normalizedKey.split('-').pop() || 'NONE';
                    const evalResult = status as EvaluationResult;

                    // Determine edge color
                    let edgeColor = '#d1d5db';
                    if (evalResult === EvaluationResult.ACCEPTED) {
                        edgeColor = '#d1d5db';
                    } else if (evalResult === EvaluationResult.REJECTED) {
                        edgeColor = '#ef4444';
                    } else if (evalResult === EvaluationResult.UNSURE) {
                        edgeColor = '#f97316';
                    } else {
                        edgeColor = '#9ca3af';
                    }

                    const relationIds = groupRelations.map((relation) => extractRelationId(relation) || '');
                    const edgeKey = generateEdgeKey(sourceNodeId, targetNodeId, relationIds, status);

                    const label = groupRelations.length === 1
                        ? primaryRelation.relation_name
                        : `... ×${groupRelations.length}`;

                    // Skip if edge already exists (handles duplicates)
                    if (graph.hasEdge(edgeKey)) {
                        return;
                    }

                    try {
                        graph.addEdgeWithKey(edgeKey, sourceNodeId, targetNodeId, {
                            label: truncateLabel(label, 40),
                            type: "arrow",
                            size: 3,  // Slightly larger for better click detection
                            color: edgeColor,
                            originalColor: edgeColor,
                            originalSize: 3,
                            evaluationResult: evalResult,
                            relationCount: groupRelations.length,
                            relationIds: relationIds,  // Store relation IDs on edge for click handler
                        });

                        nodeDegrees.set(sourceNodeId, (nodeDegrees.get(sourceNodeId) || 0) + 1);
                        nodeDegrees.set(targetNodeId, (nodeDegrees.get(targetNodeId) || 0) + 1);
                    } catch (error) {
                        // Silently ignore duplicate edge errors, log others
                        if (!(error instanceof Error && error.message.includes('already exists'))) {
                            console.error('Failed to add edge:', error);
                        }
                    }
                });

                // Normalize node sizes based on degree
                const degrees = Array.from(nodeDegrees.values());
                const minDegree = Math.min(...degrees, 0);
                const maxDegree = Math.max(...degrees, 1);
                const degreeRange = maxDegree - minDegree || 1;

                nodeDegrees.forEach((degree, nodeId) => {
                    const normalized = (degree - minDegree) / degreeRange;
                    const nodeSize = 8 + (normalized * 17);
                    graph.setNodeAttribute(nodeId, 'size', nodeSize);
                });

                // Apply ForceAtlas2 layout with default settings
                forceAtlas2.assign(graph, {
                    iterations: 100,
                    settings: {
                        gravity: 1.0,
                        scalingRatio: 10,
                        slowDown: 0.6,
                        barnesHutOptimize: true,
                        barnesHutTheta: 0.5,
                    }
                });

                // Set entity types for filters
                const entityTypesArray = Array.from(entityTypes).sort();
                setAllEntityTypes(entityTypesArray);
                setSelectedEntityTypes(new Set(entityTypesArray));

                setDataReady(true);
                setIsLoading(false);

                console.log(`Graph built: ${graph.order} nodes, ${graph.size} edges`);

            } catch (err) {
                console.error('Failed to fetch graph data:', err);
                setIsLoading(false);
            }
        };

        loadOntologyData();
    }, [dataReady, refreshCounter, graph]);

    // Compute filters for controllers
    const filters: OntologyFilters = useMemo(() => {
        let showAcceptedValue = false;
        let showRejectedValue = false;
        let showUncertainValue = false;

        if (relationFilterMode === 'accepted-only') {
            showAcceptedValue = true;
        } else if (relationFilterMode === 'all') {
            showAcceptedValue = true;
            showRejectedValue = true;
            showUncertainValue = true;
        } else if (relationFilterMode === 'rejected-uncertain-only') {
            showRejectedValue = true;
            showUncertainValue = true;
        }

        return {
            entityTypes: selectedEntityTypes,
            showAccepted: showAcceptedValue,
            showRejected: showRejectedValue,
            showUncertain: showUncertainValue,
            focusedNodeId: null,
        };
    }, [selectedEntityTypes, relationFilterMode]);

    // Count visible nodes and edges
    const visibleStats = useMemo(() => {
        let visibleNodes = 0;
        let visibleEdges = 0;

        graph.forEachNode((node, attributes) => {
            if (!attributes.hidden) visibleNodes++;
        });

        graph.forEachEdge((edge, attributes) => {
            if (!attributes.hidden) visibleEdges++;
        });

        return { nodes: visibleNodes, edges: visibleEdges };
    }, [graph]);

    return (
        <div className="absolute inset-0 bg-background flex flex-col">
            {/* Graph Container - takes full height */}
            <div className="flex-1 bg-card min-h-0 flex flex-col relative overflow-hidden">
                    {/* Hover Card */}
                    {hoveredNode && (
                        <OntologyNodeHoverCard
                            hoveredNode={hoveredNode}
                            graph={graph}
                            truncateLabel={truncateLabel}
                        />
                    )}

                    {!dataReady && !isLoading ? (
                        <div className="absolute inset-0 flex items-center justify-center p-8">
                            <div className="text-center space-y-4 max-w-md">
                                {/* Show processing status when agent is working */}
                                {agentStatus && (agentStatus.is_processing || agentStatus.is_evaluating) ? (
                                    <>
                                        <Loader2 className="h-16 w-16 animate-spin text-primary mx-auto" />
                                        <h3 className="text-2xl font-bold text-foreground">
                                            {agentStatus.is_processing ? 'Processing Ontology' : 'Evaluating Relations'}
                                        </h3>
                                        <p className="text-muted-foreground">
                                            {agentStatus.agent_status_msg || 'Please wait while the ontology is being analysed...'}
                                        </p>
                                        {agentStatus.progress && (
                                            <p className="text-sm text-muted-foreground">
                                                Progress: {agentStatus.progress.current}/{agentStatus.progress.total}
                                            </p>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        <div className="text-6xl text-primary mb-4">🌐</div>
                                        <h3 className="text-2xl font-bold text-foreground">Ontology Graph</h3>
                                        <p className="text-muted-foreground">
                                            No ontology data found. Use Data Sources to ingest entities, then analyze the ontology.
                                        </p>
                                        {canIngest && (
                                        <button
                                            onClick={handleReanalyze}
                                            disabled={isReanalyzing}
                                            className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center gap-2 mx-auto disabled:opacity-50 disabled:cursor-not-allowed"
                                            title="Analyse ontology relationships"
                                        >
                                            <RotateCcw className={`h-4 w-4 ${isReanalyzing ? 'animate-spin' : ''}`} />
                                            Analyse
                                        </button>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="absolute inset-0">
                            {/* Loading Overlay */}
                            {isLoading && (
                                <div className="absolute inset-0 bg-background/90 flex items-center justify-center z-10">
                                    <div className="text-center space-y-4">
                                        <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto" />
                                        <p className="text-lg font-semibold text-foreground">Loading graph data...</p>
                                        <p className="text-sm text-muted-foreground">Fetching entities and relations</p>
                                    </div>
                                </div>
                            )}

                            <SigmaContainer
                                key={layoutKey}
                                graph={graph}
                                style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}
                                settings={{
                                    allowInvalidContainer: true,
                                    renderEdgeLabels: true,
                                    defaultEdgeType: "arrow",
                                    labelRenderedSizeThreshold: 1,  // Show labels on all nodes (was 10)
                                    labelDensity: 1.0,  // Show all labels (was 0.3)
                                    labelGridCellSize: 100,  // Smaller grid for better label placement
                                    labelFont: "Inter, system-ui, sans-serif",
                                    labelWeight: "600",
                                    labelSize: 12,
                                    labelColor: { attribute: "labelColor", color: isDarkMode ? "#ffffff" : "#1f2937" },
                                    zIndex: true,
                                }}
                            >
                                <SigmaInstanceCapture onSigmaReady={setSigmaInstance} />
                                <CameraController />
                                <GraphDragController setIsDragging={setIsDragging} />
                                <GraphSettingsController
                                    hoveredNode={hoveredNode}
                                    selectedNodeId={selectedNode?.id || null}
                                />
                                <GraphEventsController
                                    setHoveredNode={setHoveredNode}
                                    onNodeClick={handleNodeClick}
                                    isDragging={isDragging}
                                />
                                <OntologyGraphDataController filters={filters} />

                                {/* Node Details Card - shown when a node is clicked */}
                                {selectedNode && (
                                    <OntologyNodeDetailsCard
                                        nodeId={selectedNode.id}
                                        nodeData={selectedNode.data}
                                        graph={graph}
                                        onClose={() => setSelectedNode(null)}
                                        advancedMode={advancedMode}
                                        onToggleAdvanced={toggleAdvancedMode}
                                        onRefreshGraph={handleRefresh}
                                    />
                                )}
                                
                            </SigmaContainer>

                            {/* Bottom Controls - Overlay */}
                            {graphStats && (
                                <div className="absolute bottom-3 left-3 right-3 z-20">
                                    <div className="flex items-center justify-between text-sm p-2 rounded-lg shadow-lg border bg-card/95 backdrop-blur-sm text-muted-foreground">
                                        <div className="flex gap-1.5 flex-wrap">
                                            <button
                                                onClick={() => setShowFiltersModal(true)}
                                                className="px-2 py-1 text-xs rounded-md bg-green-500 hover:bg-green-600 text-white font-medium flex items-center gap-1"
                                                title="Filter entity types"
                                            >
                                                <Filter className="h-3 w-3" />
                                                Filters
                                            </button>
                                            <button
                                                onClick={() => setShowSettingsModal(true)}
                                                className="px-2 py-1 text-xs rounded-md bg-blue-500 hover:bg-blue-600 text-white font-medium flex items-center gap-1"
                                                title="Layout settings"
                                            >
                                                <Settings className="h-3 w-3" />
                                                Settings
                                            </button>
                                            <button
                                                onClick={handleRefresh}
                                                className="px-2 py-1 text-xs rounded-md bg-gray-500 hover:bg-gray-600 text-white font-medium flex items-center gap-1"
                                                title="Refresh graph data"
                                            >
                                                <RefreshCw className="h-3 w-3" />
                                                Refresh
                                            </button>
                                            {canIngest && (
                                            <button
                                                onClick={handleReanalyze}
                                                disabled={isReanalyzing}
                                                className="px-2 py-1 text-xs rounded-md bg-purple-500 hover:bg-purple-600 text-white font-medium flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                                                title="Re-analyse ontology relationships"
                                            >
                                                <RotateCcw className={`h-3 w-3 ${isReanalyzing ? 'animate-spin' : ''}`} />
                                                Re-analyse
                                            </button>
                                            )}
                                            {canDelete && (
                                            <button
                                                onClick={handleDelete}
                                                disabled={isDeleting}
                                                className="px-2 py-1 text-xs rounded-md bg-red-500 hover:bg-red-600 text-white font-medium flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                                                title="Delete ontology"
                                            >
                                                <Trash2 className="h-3 w-3" />
                                                Delete
                                            </button>
                                            )}
                                        </div>
                                        <span className="text-xs ml-2 shrink-0">
                                            {visibleStats.nodes}/{graphStats?.node_count ?? 0} nodes
                                        </span>
                                    </div>
                                </div>
                            )}

                            {/* Agent Status Bar - Overlay */}
                            {agentStatus && (agentStatus.is_processing || agentStatus.is_evaluating || agentStatus.status === 'error') && (
                                <div className={`absolute top-3 left-3 right-3 z-20 p-2 rounded-lg flex items-center gap-2 shadow-lg ${
                                    agentStatus.is_processing || agentStatus.is_evaluating ? 'bg-primary text-primary-foreground' :
                                    agentStatus.status === 'error' ? 'bg-destructive text-destructive-foreground' :
                                    'bg-muted/95 backdrop-blur-sm'
                                }`}>
                                    {(agentStatus.is_processing || agentStatus.is_evaluating) && (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    )}
                                    <span className="text-sm font-medium">
                                        {agentStatus.is_processing && (agentStatus.agent_status_msg || 'Processing...')}
                                        {agentStatus.is_evaluating && !agentStatus.is_processing && (agentStatus.agent_status_msg || 'Evaluating...')}
                                        {agentStatus.status === 'error' && (agentStatus.message || 'Error')}
                                    </span>
                                    {agentStatus.progress && (
                                        <span className="text-xs opacity-80">
                                            ({agentStatus.progress.current}/{agentStatus.progress.total})
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>

            {/* Filters Modal */}
            {showFiltersModal && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                    <div className="bg-card rounded-lg shadow-xl border border-border w-full max-w-md max-h-[80vh] overflow-hidden">
                        <div className="flex items-center justify-between p-4 border-b border-border">
                            <h3 className="text-lg font-semibold text-foreground">Filter Settings</h3>
                            <button onClick={() => setShowFiltersModal(false)} className="text-muted-foreground hover:text-foreground">
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        <div className="p-4 space-y-4 overflow-y-auto max-h-[60vh]">
                            <div>
                                <h4 className="text-sm font-medium text-foreground mb-2">Entity Types</h4>
                                <div className="flex gap-2 mb-3">
                                    <button onClick={selectAllEntityTypes} className="px-2 py-1 text-xs rounded bg-primary text-primary-foreground">Select All</button>
                                    <button onClick={deselectAllEntityTypes} className="px-2 py-1 text-xs rounded bg-muted text-foreground border border-border">Deselect All</button>
                                </div>
                                <div className="space-y-1 max-h-48 overflow-y-auto">
                                    {allEntityTypes.map(entityType => (
                                        <label key={entityType} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 p-1 rounded">
                                            <input
                                                type="checkbox"
                                                checked={selectedEntityTypes.has(entityType)}
                                                onChange={() => toggleEntityType(entityType)}
                                                className="rounded border-border"
                                            />
                                            <span className="text-foreground">{entityType}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                            <div>
                                <h4 className="text-sm font-medium text-foreground mb-2">Relations</h4>
                                <div className="space-y-2">
                                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                                        <input
                                            type="radio"
                                            name="relationFilter"
                                            checked={relationFilterMode === 'accepted-only'}
                                            onChange={() => setRelationFilterMode('accepted-only')}
                                        />
                                        <span className="text-muted-foreground">— Accepted Only</span>
                                    </label>
                                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                                        <input
                                            type="radio"
                                            name="relationFilter"
                                            checked={relationFilterMode === 'all'}
                                            onChange={() => setRelationFilterMode('all')}
                                        />
                                        <span className="text-orange-500">— — Show All</span>
                                    </label>
                                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                                        <input
                                            type="radio"
                                            name="relationFilter"
                                            checked={relationFilterMode === 'rejected-uncertain-only'}
                                            onChange={() => setRelationFilterMode('rejected-uncertain-only')}
                                        />
                                        <span className="text-red-500">— — Rejected & Uncertain Only</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Settings Modal */}
            {showSettingsModal && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                    <div className="bg-card rounded-lg shadow-xl border border-border w-full max-w-md">
                        <div className="flex items-center justify-between p-4 border-b border-border">
                            <h3 className="text-lg font-semibold text-foreground">Layout Settings</h3>
                            <button onClick={() => setShowSettingsModal(false)} className="text-muted-foreground hover:text-foreground">
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        <div className="p-4 space-y-5">
                            <p className="text-xs text-muted-foreground">
                                Adjust ForceAtlas2 layout parameters. Click Apply to re-layout the graph.
                            </p>

                            {/* Iterations */}
                            <div className="space-y-2">
                                <div className="flex justify-between items-center">
                                    <label className="text-sm font-medium text-foreground">Iterations</label>
                                    <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{layoutSettings.iterations}</span>
                                </div>
                                <input
                                    type="range"
                                    min="10"
                                    max="500"
                                    step="10"
                                    value={layoutSettings.iterations}
                                    onChange={(e) => setLayoutSettings(prev => ({ ...prev, iterations: parseInt(e.target.value) }))}
                                    className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                                />
                                <p className="text-xs text-muted-foreground">Higher = more accurate layout, but slower</p>
                            </div>

                            {/* Gravity */}
                            <div className="space-y-2">
                                <div className="flex justify-between items-center">
                                    <label className="text-sm font-medium text-foreground">Gravity</label>
                                    <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{layoutSettings.gravity.toFixed(1)}</span>
                                </div>
                                <input
                                    type="range"
                                    min="0.1"
                                    max="10"
                                    step="0.1"
                                    value={layoutSettings.gravity}
                                    onChange={(e) => setLayoutSettings(prev => ({ ...prev, gravity: parseFloat(e.target.value) }))}
                                    className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                                />
                                <p className="text-xs text-muted-foreground">Higher = nodes pull toward center</p>
                            </div>

                            {/* Scaling Ratio */}
                            <div className="space-y-2">
                                <div className="flex justify-between items-center">
                                    <label className="text-sm font-medium text-foreground">Scaling Ratio</label>
                                    <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{layoutSettings.scalingRatio}</span>
                                </div>
                                <input
                                    type="range"
                                    min="1"
                                    max="50"
                                    step="1"
                                    value={layoutSettings.scalingRatio}
                                    onChange={(e) => setLayoutSettings(prev => ({ ...prev, scalingRatio: parseInt(e.target.value) }))}
                                    className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                                />
                                <p className="text-xs text-muted-foreground">Higher = more spread out nodes</p>
                            </div>

                            {/* Slow Down */}
                            <div className="space-y-2">
                                <div className="flex justify-between items-center">
                                    <label className="text-sm font-medium text-foreground">Slow Down</label>
                                    <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{layoutSettings.slowDown.toFixed(1)}</span>
                                </div>
                                <input
                                    type="range"
                                    min="0.1"
                                    max="2"
                                    step="0.1"
                                    value={layoutSettings.slowDown}
                                    onChange={(e) => setLayoutSettings(prev => ({ ...prev, slowDown: parseFloat(e.target.value) }))}
                                    className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                                />
                                <p className="text-xs text-muted-foreground">Higher = more stable but slower convergence</p>
                            </div>

                            {/* Action Buttons */}
                            <div className="flex gap-2 pt-2 border-t border-border">
                                <button
                                    onClick={() => setLayoutSettings({ iterations: 100, gravity: 1.0, scalingRatio: 10, slowDown: 0.6 })}
                                    className="flex-1 px-3 py-2 text-sm rounded-md bg-muted hover:bg-muted/80 text-foreground"
                                >
                                    Reset Defaults
                                </button>
                                <button
                                    onClick={applyLayout}
                                    disabled={isApplyingLayout}
                                    className="flex-1 px-3 py-2 text-sm rounded-md bg-primary hover:bg-primary/90 text-primary-foreground disabled:opacity-50 flex items-center justify-center gap-2"
                                >
                                    {isApplyingLayout && <Loader2 className="h-3 w-3 animate-spin" />}
                                    Apply Layout
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
