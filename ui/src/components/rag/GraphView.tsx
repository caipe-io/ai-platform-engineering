"use client";

/**
 * GraphView - Ported from RAG WebUI
 *
 * Full Sigma.js graph visualization for ontology and data exploration.
 */

import { GitFork,Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback,useEffect,useState } from 'react';
import { getHealthStatus } from './api';

// Dynamically import Sigma components with SSR disabled
// This is required because Sigma.js uses browser-only APIs
const OntologyGraphSigma = dynamic(
    () => import('./graph/OntologyGraph/OntologyGraphSigma'),
    {
        ssr: false,
        loading: () => (
            <div className="h-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        )
    }
);

const DataGraphSigma = dynamic(
    () => import('./graph/DataGraph/DataGraphSigma'),
    {
        ssr: false,
        loading: () => (
            <div className="h-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        )
    }
);

type GraphViewType = 'ontology' | 'data';

interface GraphViewProps {
    exploreEntityData?: { entityType: string; primaryKey: string } | null;
    onExploreComplete?: () => void;
    /** The ontology is deployment-global and is safe only for unrestricted callers. */
    allowOntology?: boolean;
}

export default function GraphView({
    exploreEntityData,
    onExploreComplete,
    allowOntology = false,
}: GraphViewProps) {
    const [activeView, setActiveView] = useState<GraphViewType>(
        allowOntology ? 'ontology' : 'data'
    );
    const [graphRagEnabled, setGraphRagEnabled] = useState<boolean | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchConfig = useCallback(async () => {
        try {
            const response = await getHealthStatus();
            const { config } = response;
            const enabled = config?.graph_rag_enabled ?? false;
            setGraphRagEnabled(enabled);
        } catch (error) {
            console.error('Failed to fetch config:', error);
            setGraphRagEnabled(false);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchConfig();
    }, [fetchConfig]);

    useEffect(() => {
        if (exploreEntityData) {
            setActiveView('data');
        }
    }, [exploreEntityData]);

    useEffect(() => {
        if (!allowOntology && activeView === 'ontology') {
            setActiveView('data');
        }
    }, [activeView, allowOntology]);

    if (loading) {
        return (
            <div className="h-full flex flex-col bg-background overflow-hidden">
                {/* Compact Header with Gradient */}
                <div className="relative overflow-hidden border-b border-border shrink-0">
                    <div 
                        className="absolute inset-0" 
                        style={{
                            background: `linear-gradient(to bottom right, color-mix(in srgb, var(--gradient-from) 15%, transparent) 0%, color-mix(in srgb, var(--gradient-to) 8%, transparent) 50%, transparent 100%)`
                        }}
                    />
                    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-primary/5 via-transparent to-transparent" />

                    <div className="relative px-6 py-3 flex items-center gap-3">
                        <div className="p-2 rounded-lg gradient-primary-br shadow-md shadow-primary/20">
                            <GitFork className="h-5 w-5 text-white" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold gradient-text">Knowledge Graph</h2>
                            <p className="text-muted-foreground text-xs">
                                Loading configuration...
                            </p>
                        </div>
                    </div>
                </div>

                <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                        <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-4" />
                        <p className="text-muted-foreground">Loading graph configuration...</p>
                    </div>
                </div>
            </div>
        );
    }

    if (!graphRagEnabled) {
        return (
            <div className="h-full flex flex-col bg-background overflow-hidden">
                {/* Compact Header with Gradient */}
                <div className="relative overflow-hidden border-b border-border shrink-0">
                    <div 
                        className="absolute inset-0" 
                        style={{
                            background: `linear-gradient(to bottom right, color-mix(in srgb, var(--gradient-from) 15%, transparent) 0%, color-mix(in srgb, var(--gradient-to) 8%, transparent) 50%, transparent 100%)`
                        }}
                    />
                    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-primary/5 via-transparent to-transparent" />

                    <div className="relative px-6 py-3 flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-muted shadow-sm">
                            <GitFork className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-muted-foreground">Knowledge Graph</h2>
                            <p className="text-muted-foreground text-xs">
                                Graph RAG is currently disabled
                            </p>
                        </div>
                    </div>
                </div>

                <div className="flex-1 flex flex-col items-center justify-center p-8">
                    <div className="text-center max-w-md">
                        <div className="text-6xl mb-4">🔗</div>
                        <h2 className="text-2xl font-bold text-foreground mb-4">
                            Graph RAG is Disabled
                        </h2>
                        <p className="text-muted-foreground mb-6">
                            Knowledge graph visualization is currently not available.
                            Graph RAG can be enabled in the RAG server configuration to unlock
                            entity relationship exploration and ontology visualization.
                        </p>
                        <div className="bg-card rounded-lg p-4 border border-border">
                            <h3 className="font-semibold text-foreground mb-2">What Graph RAG provides:</h3>
                            <ul className="text-sm text-muted-foreground text-left space-y-2">
                                <li className="flex items-start gap-2">
                                    <span className="text-green-500">✓</span>
                                    <span>Ontology graph visualization - see entity types and relationships</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-green-500">✓</span>
                                    <span>Data graph exploration - navigate between related entities</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-green-500">✓</span>
                                    <span>Entity neighborhood exploration from search results</span>
                                </li>
                            </ul>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // Graph RAG is enabled - show the graph interface
    return (
        <div className="relative h-full bg-background overflow-hidden flex flex-col">
            {/* Compact Header with Gradient */}
            <div className="relative overflow-hidden border-b border-border shrink-0">
                {/* Gradient Background */}
                <div 
                    className="absolute inset-0" 
                    style={{
                        background: `linear-gradient(to bottom right, color-mix(in srgb, var(--gradient-from) 15%, transparent) 0%, color-mix(in srgb, var(--gradient-to) 8%, transparent) 50%, transparent 100%)`
                    }}
                />
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-primary/5 via-transparent to-transparent" />

                <div className="relative px-6 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg gradient-primary-br shadow-md shadow-primary/20">
                            <GitFork className="h-5 w-5 text-white" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold gradient-text">Knowledge Graph</h2>
                            <p className="text-muted-foreground text-xs">
                                {allowOntology
                                    ? 'Explore entity relationships and ontology'
                                    : 'Explore entity relationships from your accessible data sources'}
                            </p>
                        </div>
                    </div>

                    {/* Tab Navigation */}
                    <div className="flex bg-card rounded-md shadow-sm border border-border overflow-hidden">
                        {allowOntology ? (
                            <button
                                onClick={() => setActiveView('ontology')}
                                className={`px-3 py-1.5 text-xs font-medium transition-all duration-200 flex items-center gap-1.5 ${
                                    activeView === 'ontology'
                                        ? 'bg-primary text-primary-foreground shadow-inner'
                                        : 'bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
                                }`}
                            >
                                <span className="text-sm">🌐</span> Ontology
                            </button>
                        ) : null}
                        <button
                            onClick={() => setActiveView('data')}
                            className={`px-3 py-1.5 text-xs font-medium transition-all duration-200 flex items-center gap-1.5 ${
                                activeView === 'data'
                                    ? 'bg-primary text-primary-foreground shadow-inner'
                                    : 'bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
                            }`}
                        >
                            <span className="text-sm">📊</span> Data
                        </button>
                    </div>
                </div>
            </div>

            {/* Graph Content */}
            <div className="flex-1 min-h-0 bg-muted/30 relative">
                {allowOntology && activeView === 'ontology' ? (
                    <OntologyGraphSigma />
                ) : (
                    <DataGraphSigma
                        exploreEntityData={exploreEntityData}
                        onExploreComplete={onExploreComplete}
                    />
                )}
            </div>
        </div>
    );
}
