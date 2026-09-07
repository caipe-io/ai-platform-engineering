"use client";

import { SigmaContainer } from "@react-sigma/core";
import { MultiDirectedGraph } from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { Loader2 } from 'lucide-react';
import { useTheme } from "@/components/theme-provider";
import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import type Sigma from 'sigma';
import { exploreEntityNeighborhood } from '../../api';
import { getColorForNode } from '../shared/graphStyles';
import { extractRelationId,generateEdgeKey,generateNodeId } from '../shared/graphUtils';
import type {
    GraphEdgeAttributes,
    GraphEntity,
    GraphNodeAttributes,
    GraphProperties,
    GraphRelation,
    SelectedGraphNode,
} from '../shared/graphTypes';
import '../shared/sigma-styles.css';
import DataNodeDetailsCard from './DataNodeDetailsCard';
import DataNodeHoverCard from './DataNodeHoverCard';

// Import controllers
import CameraController from '../shared/SigmaGraph/controllers/CameraController';
import GraphDragController from '../shared/SigmaGraph/controllers/GraphDragController';
import GraphEventsController from '../shared/SigmaGraph/controllers/GraphEventsController';
import GraphSettingsController from '../shared/SigmaGraph/controllers/GraphSettingsController';
import SigmaInstanceCapture from '../shared/SigmaGraph/controllers/SigmaInstanceCapture';

interface DataGraphSigmaProps {
    exploreEntityData?: { entityType: string; primaryKey: string } | null;
    onExploreComplete?: () => void;
}

type EntityData = GraphEntity & {
    all_properties: GraphProperties;
    entity_type: string;
    primary_key: string;
};

type RelationData = GraphRelation;

// Truncate label helper
const truncateLabel = (text: string, maxLength: number = 25): string => {
    if (!text) return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
};

export default function DataGraphSigma({ exploreEntityData, onExploreComplete }: DataGraphSigmaProps) {
    // Theme detection for label colors
    const { resolvedTheme } = useTheme();
    const isDarkMode = resolvedTheme === "dark" || resolvedTheme?.includes("night") || resolvedTheme === "midnight" || resolvedTheme === "nord";

    // Graph instance
    const graph = useMemo(() => new MultiDirectedGraph<GraphNodeAttributes,GraphEdgeAttributes>(), []);

    // State management
    const [dataReady, setDataReady] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [selectedElement, setSelectedElement] = useState<SelectedGraphNode | null>(null);
    const [exploredEntity, setExploredEntity] = useState<GraphEntity | null>(null);
    const [hoveredNode, setHoveredNode] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState<boolean>(false);
    const [, setSigmaInstance] = useState<Sigma<GraphNodeAttributes,GraphEdgeAttributes> | null>(null);
    const [graphStats, setGraphStats] = useState<{ node_count: number; relation_count: number } | null>(null);
    const [layoutKey, setLayoutKey] = useState(0);

    // Data storage
    const graphData = useRef<{
        entitiesById: Map<string, EntityData>;
        relationsById: Map<string, RelationData>;
    }>({
        entitiesById: new Map(),
        relationsById: new Map()
    });

    // Initial entity to restore on clear
    const initialEntity = useRef<{ entityType: string; primaryKey: string } | null>(null);
    const buildGraphRef = useRef<(centerNodeId: string, relations: RelationData[]) => Promise<void>>(async () => {});

    // Main exploration function
    const exploreEntity = useCallback(async (entityType: string, primaryKey: string, merge: boolean = false) => {
        if (!entityType || !primaryKey) {
            console.error('Missing entityType or primaryKey:', { entityType, primaryKey });
            return;
        }

        console.log('Starting exploration:', { entityType, primaryKey, merge });

        setIsLoading(true);

        try {
            // Clear existing graph data if not merging
            if (!merge) {
                graphData.current = {
                    entitiesById: new Map(),
                    relationsById: new Map()
                };
                graph.clear();
            }

            // Call the neighborhood exploration API
            const response = await exploreEntityNeighborhood(entityType, primaryKey, 1);
            const { entity, entities, relations } = response;

            if (!entity) {
                console.warn('No entity found');
                setIsLoading(false);
                return;
            }

            const centerEntityPk = entity.all_properties?._entity_pk || primaryKey;
            const centerEntityType = entity.entity_type || entityType;
            const centerNodeId = generateNodeId(centerEntityType, centerEntityPk);

            // Store all entities
            if (entities && Array.isArray(entities)) {
                for (const ent of entities) {
                    const pk = ent.all_properties?._entity_pk || ent.primary_key;
                    const entType = ent.entity_type || 'Entity';
                    const entNodeId = generateNodeId(entType, pk);

                    if (pk) {
                        const entityData: EntityData = {
                            ...ent,
                            primary_key: pk,
                            entity_type: entType,
                            all_properties: ent.all_properties || ent,
                        };
                        graphData.current.entitiesById.set(entNodeId, entityData);
                    }
                }
            }

            // Build the graph
            await buildGraphRef.current(centerNodeId, relations || []);
            setExploredEntity(entity);
            setDataReady(true);
            setLayoutKey(k => k + 1); // Force remount

            // Store the initial entity if this is the first exploration
            if (!initialEntity.current) {
                initialEntity.current = { entityType, primaryKey };
            }

            // Update stats
            setGraphStats({
                node_count: graphData.current.entitiesById.size,
                relation_count: (relations || []).length
            });

        } catch (err) {
            console.error('Failed to explore entity:', err);
        }

        setIsLoading(false);
    }, [graph]);

    // Build graph from stored data
    const buildGraph = useCallback(async (centerNodeId: string, relations: RelationData[]) => {
        const nodeDegrees = new Map<string, number>();

        // Add all entities as nodes
        graphData.current.entitiesById.forEach((entity, nodeId) => {
            if (graph.hasNode(nodeId)) return;

            const entityType = entity.entity_type || 'Entity';
            const color = getColorForNode(entityType);

            const angle = Math.random() * 2 * Math.PI;
            const radius = Math.random() * 300;

            const isCenterNode = nodeId === centerNodeId;
            const nodeSize = isCenterNode ? 25 : 15;

            // Use primary key as label for data nodes
            const pk = entity.primary_key || entity.all_properties?._entity_pk || '';
            const labelText = pk ? `${entityType}: ${truncateLabel(pk, 20)}` : entityType;

            graph.addNode(nodeId, {
                label: labelText,
                size: nodeSize,
                color: color,
                entityType: entityType,
                entityData: entity,
                x: Math.cos(angle) * radius,
                y: Math.sin(angle) * radius,
                highlighted: isCenterNode,
                hidden: false,
            });

            nodeDegrees.set(nodeId, 0);
        });

        // Group relations
        const relationGroups = new Map<string, RelationData[]>();

        relations.forEach((relation) => {
            const sourceNodeId = generateNodeId(relation.from_entity.entity_type, relation.from_entity.primary_key);
            const targetNodeId = generateNodeId(relation.to_entity.entity_type, relation.to_entity.primary_key);

            if (!graph.hasNode(sourceNodeId) || !graph.hasNode(targetNodeId)) return;

            const normalizedKey = sourceNodeId < targetNodeId
                ? `${sourceNodeId}<->${targetNodeId}`
                : `${targetNodeId}<->${sourceNodeId}`;

            if (!relationGroups.has(normalizedKey)) {
                relationGroups.set(normalizedKey, []);
            }
            relationGroups.get(normalizedKey)!.push(relation);
        });

        // Add edges
        relationGroups.forEach((groupRelations) => {
            const primaryRelation = groupRelations[0];
            const sourceNodeId = generateNodeId(
                primaryRelation.from_entity.entity_type,
                primaryRelation.from_entity.primary_key
            );
            const targetNodeId = generateNodeId(
                primaryRelation.to_entity.entity_type,
                primaryRelation.to_entity.primary_key
            );

            const hasBidirectional = groupRelations.some((relation) =>
                relation.from_entity.primary_key === primaryRelation.to_entity.primary_key
            );

            const relationIds = groupRelations.map((relation) => extractRelationId(relation) || '');
            const edgeKey = generateEdgeKey(sourceNodeId, targetNodeId, relationIds, 'DATA');

            const edgeColor = '#94a3b8'; // slate-400
            const label = groupRelations.length === 1
                ? primaryRelation.relation_name
                : `${hasBidirectional ? '⟷ ' : ''}${groupRelations.length} relations`;

            if (!graph.hasEdge(edgeKey)) {
                try {
                    graph.addEdgeWithKey(edgeKey, sourceNodeId, targetNodeId, {
                        label: truncateLabel(label, 30),
                        type: hasBidirectional ? "line" : "arrow",
                        size: 2,
                        color: edgeColor,
                        originalColor: edgeColor,
                        originalSize: 2,
                        relationCount: groupRelations.length,
                        isBidirectional: hasBidirectional,
                        hidden: false,
                    });

                    nodeDegrees.set(sourceNodeId, (nodeDegrees.get(sourceNodeId) || 0) + 1);
                    nodeDegrees.set(targetNodeId, (nodeDegrees.get(targetNodeId) || 0) + 1);
                } catch (error) {
                    console.error('Failed to add edge:', error);
                }
            }
        });

        // Normalize node sizes
        const degrees = Array.from(nodeDegrees.values());
        const minDegree = Math.min(...degrees, 0);
        const maxDegree = Math.max(...degrees, 1);
        const degreeRange = maxDegree - minDegree || 1;

        nodeDegrees.forEach((degree, nodeId) => {
            if (!graph.hasNode(nodeId)) return;

            const isHighlighted = nodeId === centerNodeId;
            if (isHighlighted) {
                graph.setNodeAttribute(nodeId, 'size', 25);
                graph.setNodeAttribute(nodeId, 'highlighted', true);
                return;
            }

            const normalized = (degree - minDegree) / degreeRange;
            const nodeSize = 10 + (normalized * 15);
            graph.setNodeAttribute(nodeId, 'size', nodeSize);
        });

        // Apply ForceAtlas2 layout
        forceAtlas2.assign(graph, {
            iterations: 100,
            settings: {
                gravity: 1.0,
                scalingRatio: 10,
                slowDown: 0.6,
                barnesHutOptimize: true,
            }
        });

        console.log(`Graph built: ${graph.order} nodes, ${graph.size} edges`);
    }, [graph]);

    useEffect(() => {
        buildGraphRef.current = buildGraph;
    }, [buildGraph]);

    // Node click handler
    const handleNodeClick = useCallback((nodeId: string, nodeData: GraphNodeAttributes) => {
        console.log('Node clicked:', nodeId);
        setSelectedElement({ type: 'node', id: nodeId, data: nodeData });
    }, []);

    // Handle expand from details card
    const handleExpandNode = useCallback((entityType: string, primaryKey: string) => {
        exploreEntity(entityType, primaryKey, true); // merge = true to expand
        setSelectedElement(null);
    }, [exploreEntity]);

    const handleClearExploration = async () => {
        if (initialEntity.current) {
            graph.clear();
            graphData.current = { entitiesById: new Map(), relationsById: new Map() };
            setSelectedElement(null);
            await exploreEntity(initialEntity.current.entityType, initialEntity.current.primaryKey, false);
        } else {
            setExploredEntity(null);
            setDataReady(false);
            graph.clear();
            graphData.current = { entitiesById: new Map(), relationsById: new Map() };
            setSelectedElement(null);
        }
    };

    // Handle entity exploration from SearchView
    useEffect(() => {
        if (!exploreEntityData) return;
        const timeout = window.setTimeout(() => {
            void exploreEntity(exploreEntityData.entityType, exploreEntityData.primaryKey, false);
            onExploreComplete?.();
        }, 0);
        return () => window.clearTimeout(timeout);
    }, [exploreEntityData, onExploreComplete, exploreEntity]);

    // Empty state
    if (!dataReady && !isLoading) {
        return (
            <div className="w-full h-full bg-background flex flex-col">
                <div className="flex-1 flex items-center justify-center p-8">
                    <div className="text-center space-y-4 max-w-md">
                        <div className="text-6xl text-blue-500 mb-4">📊</div>
                        <h3 className="text-2xl font-bold text-foreground">Data Exploration</h3>
                        <p className="text-muted-foreground">
                            Search for entities in the Search tab, then click &quot;Explore&quot; to visualize their relationships.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full h-full bg-background flex flex-col">
            <div className="flex-1 flex flex-col p-4 min-h-0">
                {/* Small exploration indicator */}
                {exploredEntity && (
                    <div className="flex-shrink-0 mb-2 p-1">
                        <p className="text-sm">
                            <strong className="text-foreground">🎯 Exploring:</strong>{' '}
                            <span
                                className="font-semibold px-1.5 py-0.5 rounded"
                                style={{
                                    backgroundColor: `${getColorForNode(exploredEntity.entity_type)}20`,
                                    color: getColorForNode(exploredEntity.entity_type),
                                }}
                            >
                                {exploredEntity.entity_type}
                            </span>
                            {' → '}
                            <code className="bg-muted text-foreground px-1.5 py-0.5 rounded font-mono text-xs">
                                {exploredEntity.primary_key || exploredEntity.all_properties?._entity_pk}
                            </code>
                        </p>
                    </div>
                )}

                {/* Graph Container */}
                <div className="flex-1 rounded-lg shadow-sm bg-card min-h-0 flex flex-col relative border border-border overflow-hidden">
                    {/* Loading Overlay */}
                    {isLoading && (
                        <div className="absolute inset-0 bg-background/90 flex items-center justify-center z-10 rounded-lg">
                            <div className="text-center space-y-4">
                                <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto" />
                                <p className="text-lg font-semibold text-foreground">Loading graph data...</p>
                                <p className="text-sm text-muted-foreground">Fetching entities and relations</p>
                            </div>
                        </div>
                    )}

                    {/* Hover Card */}
                    {hoveredNode && !selectedElement && (
                        <DataNodeHoverCard hoveredNode={hoveredNode} graph={graph} />
                    )}

                    <div className="flex-1 min-h-0 w-full">
                        <SigmaContainer
                            key={layoutKey}
                            graph={graph}
                            style={{ width: '100%', height: '100%' }}
                            settings={{
                                renderEdgeLabels: true,
                                defaultEdgeType: "arrow",
                                labelRenderedSizeThreshold: 5, // Lower threshold to show more labels
                                labelDensity: 0.5,
                                labelGridCellSize: 100,
                                labelFont: "Inter, system-ui, sans-serif",
                                labelWeight: "600",
                                labelSize: 11,
                                labelColor: { attribute: "labelColor", color: isDarkMode ? "#ffffff" : "#1f2937" },
                                edgeLabelSize: 10,
                                zIndex: true,
                                allowInvalidContainer: true,
                            }}
                        >
                            <SigmaInstanceCapture onSigmaReady={setSigmaInstance} />
                            <CameraController />
                            <GraphDragController setIsDragging={setIsDragging} />
                            <GraphSettingsController
                                hoveredNode={hoveredNode}
                                selectedNodeId={selectedElement?.type === 'node' ? selectedElement.id : null}
                            />
                            <GraphEventsController
                                setHoveredNode={setHoveredNode}
                                onNodeClick={handleNodeClick}
                                isDragging={isDragging}
                            />

                            {/* Node Details Card - shown when a node is clicked */}
                            {selectedElement && selectedElement.type === 'node' && (
                                <DataNodeDetailsCard
                                    nodeId={selectedElement.id}
                                    nodeData={selectedElement.data}
                                    graph={graph}
                                    onClose={() => setSelectedElement(null)}
                                    onExplore={handleExpandNode}
                                />
                            )}
                        </SigmaContainer>
                    </div>
                </div>

                {/* Bottom Controls */}
                {graphStats && dataReady && (
                    <div className="flex gap-4 mt-4 flex-shrink-0">
                        <div className="flex items-center justify-between text-sm p-3 rounded-lg shadow-sm border bg-card text-muted-foreground flex-1">
                            <div className="flex gap-2">
                                {exploredEntity && (
                                    <button
                                        onClick={handleClearExploration}
                                        className="px-2 py-1 text-xs rounded bg-orange-500 hover:bg-orange-600 text-white"
                                        title="Reset to initial entity"
                                    >
                                        Reset
                                    </button>
                                )}
                            </div>
                            <span className="text-xs">
                                {graphStats.node_count} nodes, {graphStats.relation_count} relations
                            </span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
