/**
 * RAG Models - Ported directly from RAG WebUI
 */

import type { RagCollectionMembershipLabel } from "@/types/rag-collection";

export type QueryResult = {
	document: {
		page_content?: string
		metadata?: Record<string, unknown>
	}
	score: number
}

export type IngestionJob = {
	job_id: string
	status: 'pending' | 'in_progress' | 'completed' | 'completed_with_errors' | 'failed' | 'terminated'
	message: string
	progress_counter: number
	failed_counter: number
	total: number
	created_at: number  // Unix timestamp in seconds
	completed_at?: number  // Unix timestamp in seconds
	error_msgs?: string[]
	document_count?: number
	chunk_count?: number
}

export type IngestorInfo = {
	ingestor_id?: string
	ingestor_type: string
	ingestor_name: string
	description?: string
	last_seen?: number
	metadata?: Record<string, unknown>
	creator_subject?: string | null
	owner_subject?: string | null
	owner_team_slug?: string | null
	search_with_teams?: string[]
	shared_with_teams?: string[]
}

export type DataSourceInfo = {
	datasource_id: string
	/**
	 * Human-friendly display label. Auto-derived on creation, editable by admins.
	 * Falls back to the lazy-derived name from the server (or `datasource_id`
	 * for very legacy rows). NEVER used as an authorization key.
	 */
	name?: string | null
	ingestor_id: string
	description: string
	source_type: string
	default_chunk_size?: number
	default_chunk_overlap?: number
	reload_interval?: number  // Reload interval in seconds (default: 86400 = 24h)
	last_updated: number
	metadata?: Record<string, unknown>
	creator_subject?: string | null
	owner_subject?: string | null
	owner_team_slug?: string | null
	search_with_teams?: string[]
	search_with_users?: string[]
	owner_display_name?: string | null
	owner_email?: string | null
	search_user_display_names?: string[]
	rag_collections?: RagCollectionMembershipLabel[]
	/**
	 * Whether this datasource is governed by the independent source-management
	 * policy. Undefined means the BFF could not determine the policy state.
	 */
	has_source_config?: boolean
	_permissions?: {
		can_read_content: boolean
		can_ingest: boolean
		can_manage_query: boolean
		can_read_source_config: boolean
		can_manage_source: boolean
	}
}
