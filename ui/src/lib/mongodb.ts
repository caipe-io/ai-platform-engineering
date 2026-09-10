// MongoDB connection utility for Next.js API routes
// This creates a singleton connection that is reused across API requests
// Supports graceful degradation - if MongoDB is not configured, APIs will return appropriate errors

import { Collection,Db,Document,MongoClient } from 'mongodb';

// MongoDB is optional - check if it's configured
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DATABASE;

// Export flag to check if MongoDB is configured
export const isMongoDBConfigured = !!(uri && dbName);

if (!isMongoDBConfigured) {
  console.warn('⚠️  MongoDB not configured - running in localStorage-only mode');
  console.warn('   Set MONGODB_URI and MONGODB_DATABASE to enable persistent storage');
}

interface MongoDBConnection {
  client: MongoClient;
  db: Db;
}

let cachedConnection: MongoDBConnection | null = null;
let connectionPromise: Promise<MongoDBConnection> | null = null;
let indexesPromise: Promise<void> | null = null;

function mongoPoolSize(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Connect to MongoDB and return db instance
 * Uses connection pooling and caching for optimal performance
 * Throws error if MongoDB is not configured
 */
export async function connectToDatabase(): Promise<MongoDBConnection> {
  // Check if MongoDB is configured
  if (!isMongoDBConfigured) {
    throw new Error('MongoDB is not configured. Set MONGODB_URI and MONGODB_DATABASE environment variables.');
  }

  // Return cached connection if available
  if (cachedConnection) {
    return cachedConnection;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  // assisted-by Codex Codex-sonnet-4-6
  // Concurrent route cold-starts share one Mongo connection and one index
  // warmup; otherwise load tests can fan out dozens of duplicate createIndex calls.
  connectionPromise = (async () => {
    // Create new connection
    const client = new MongoClient(uri!, {
      maxPoolSize: mongoPoolSize('MONGODB_MAX_POOL_SIZE', 50),
      minPoolSize: mongoPoolSize('MONGODB_MIN_POOL_SIZE', 2),
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    await client.connect();

    const db = client.db(dbName);

    // Cache the connection
    cachedConnection = { client, db };

    // Create indexes on first connection
    indexesPromise ??= createIndexes(db);
    await indexesPromise;

    console.log(`✅ Connected to MongoDB database: ${dbName}`);

    return cachedConnection;
  })();

  try {
    return await connectionPromise;
  } catch (error) {
    connectionPromise = null;
    indexesPromise = null;
    throw error;
  }
}

/**
 * Get a specific collection with proper typing
 */
export async function getCollection<T extends Document = Document>(collectionName: string): Promise<Collection<T>> {
  const { db } = await connectToDatabase();
  return db.collection<T>(collectionName);
}

/**
 * Safely create a single index, logging and continuing on failure.
 * Returns true if the index was created (or already existed), false on error.
 */
async function safeCreateIndex(
  db: Db,
  collectionName: string,
  keys: Record<string, 1 | -1>,
  options?: { unique?: boolean; expireAfterSeconds?: number },
): Promise<boolean> {
  try {
    await db.collection(collectionName).createIndex(keys, options ?? {});
    return true;
  } catch (error: unknown) {
    const code = (error as { code?: number }).code;

    if (code === 11000 && options?.unique) {
      // Duplicate key — deduplicate then retry
      const keyFields = Object.keys(keys);
      console.warn(
        `⚠️  Duplicate values found in ${collectionName} for unique index ${JSON.stringify(keys)} — deduplicating...`,
      );
      await deduplicateCollection(db, collectionName, keyFields);
      try {
        await db.collection(collectionName).createIndex(keys, options);
        console.log(`  ✅ Index on ${collectionName} ${JSON.stringify(keys)} created after dedup`);
        return true;
      } catch (retryError) {
        console.error(
          `  ❌ Index on ${collectionName} ${JSON.stringify(keys)} still failed after dedup:`,
          retryError,
        );
        return false;
      }
    }

    // 85 = IndexOptionsConflict, 86 = IndexKeySpecsConflict — index already exists with different options
    if (code === 85 || code === 86) {
      console.warn(
        `⚠️  Index conflict on ${collectionName} ${JSON.stringify(keys)} (code ${code}) — skipping`,
      );
      return true; // Existing index is close enough
    }

    console.error(`❌ Failed to create index on ${collectionName} ${JSON.stringify(keys)}:`, error);
    return false;
  }
}

/**
 * Remove duplicate documents for the given key fields, keeping the newest
 * (by _id, which embeds a timestamp in MongoDB ObjectIds).
 */
async function deduplicateCollection(
  db: Db,
  collectionName: string,
  keyFields: string[],
): Promise<void> {
  const collection = db.collection(collectionName);

  // Build a $group stage that groups by the key fields
  const groupId: Record<string, string> = {};
  for (const field of keyFields) {
    groupId[field.replace(/\./g, '_')] = `$${field}`;
  }

  const pipeline = [
    { $sort: { _id: -1 as const } }, // newest first
    { $group: { _id: groupId, keepId: { $first: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ];

  const duplicates = await collection.aggregate(pipeline).toArray();
  let totalRemoved = 0;

  for (const dup of duplicates) {
    // Build a filter that matches the duplicate key values
    const filter: Record<string, unknown> = {};
    for (const field of keyFields) {
      const safeKey = field.replace(/\./g, '_');
      filter[field] = dup._id[safeKey];
    }
    // Delete all except the one we're keeping
    filter._id = { $ne: dup.keepId };

    const result = await collection.deleteMany(filter);
    totalRemoved += result.deletedCount;
  }

  if (totalRemoved > 0) {
    console.log(`  🗑️  Removed ${totalRemoved} duplicate(s) from ${collectionName}`);
  }
}

/**
 * Create indexes for all collections.
 * This runs once on first connection.
 *
 * Each index is created independently so a single failure (e.g. duplicate
 * key conflict) doesn't prevent other indexes from being created.
 * Unique index conflicts trigger automatic deduplication and retry.
 */
async function createIndexes(db: Db) {
  // Each index is created independently via Promise.all so a single failure
  // doesn't prevent other indexes from being created.

  await Promise.all([
    // Auth token cache — shared across replicas; auto-expires after 24h
    safeCreateIndex(db, 'auth_token_cache', { updatedAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 }),

    // Users collection
    safeCreateIndex(db, 'users', { email: 1 }, { unique: true }),
    safeCreateIndex(db, 'users', { keycloak_sub: 1 }),
    safeCreateIndex(db, 'users', { 'metadata.keycloak_sub': 1 }),
    safeCreateIndex(db, 'users', { 'metadata.sso_id': 1 }),
    safeCreateIndex(db, 'users', { last_login: -1 }),

    // Teams are resolved by slug throughout RBAC and connector discovery.
    safeCreateIndex(db, 'teams', { slug: 1 }),

    // Conversations collection
    safeCreateIndex(db, 'conversations', { owner_id: 1 }),
    safeCreateIndex(db, 'conversations', { created_at: -1 }),
    safeCreateIndex(db, 'conversations', { updated_at: -1 }),
    safeCreateIndex(db, 'conversations', { 'sharing.shared_with': 1 }),
    safeCreateIndex(db, 'conversations', { tags: 1 }),
    safeCreateIndex(db, 'conversations', { is_archived: 1, owner_id: 1 }),
    safeCreateIndex(db, 'conversations', { deleted_at: 1, owner_id: 1 }),
    safeCreateIndex(db, 'conversations', { source: 1 }),
    safeCreateIndex(db, 'conversations', { deleted_at: 1, client_type: 1, is_archived: 1, is_pinned: -1, updated_at: -1 }),
    safeCreateIndex(db, 'conversations', { deleted_at: 1, source: 1, is_archived: 1, is_pinned: -1, updated_at: -1 }),
    safeCreateIndex(db, 'conversations', { owner_id: 1, client_type: 1, is_archived: 1, deleted_at: 1, updated_at: -1 }),

    // Messages collection
    safeCreateIndex(db, 'messages', { conversation_id: 1, created_at: 1 }),
    safeCreateIndex(db, 'messages', { 'metadata.turn_id': 1 }),
    safeCreateIndex(db, 'messages', { role: 1 }),
    safeCreateIndex(db, 'messages', { 'metadata.source': 1, created_at: -1 }),
    safeCreateIndex(db, 'messages', { owner_id: 1, created_at: -1 }),
    safeCreateIndex(db, 'messages', { role: 1, created_at: -1 }),
    safeCreateIndex(db, 'messages', { role: 1, 'metadata.agent_name': 1, created_at: -1 }),

    // User settings collection
    safeCreateIndex(db, 'user_settings', { user_id: 1 }, { unique: true }),

    // Conversation bookmarks collection
    safeCreateIndex(db, 'conversation_bookmarks', { user_id: 1 }),
    safeCreateIndex(db, 'conversation_bookmarks', { conversation_id: 1 }),
    safeCreateIndex(db, 'conversation_bookmarks', { user_id: 1, conversation_id: 1 }),

    // Sharing access collection
    safeCreateIndex(db, 'sharing_access', { conversation_id: 1 }),
    safeCreateIndex(db, 'sharing_access', { granted_to: 1 }),
    safeCreateIndex(db, 'sharing_access', { conversation_id: 1, granted_to: 1 }),

    // Catalog API keys (Skills Gateway machine auth; BFF-owned)
    safeCreateIndex(db, 'catalog_api_keys', { key_id: 1 }, { unique: true }),
    safeCreateIndex(db, 'catalog_api_keys', { owner_user_id: 1, created_at: -1 }),

    // Service accounts (user-minted machine identities; BFF-owned display
    // metadata — credential lives in Keycloak, access in OpenFGA). See
    // docs/docs/specs/2026-06-05-service-accounts/data-model.md.
    // Name uniqueness (FR-002a) is enforced at the application layer (T007),
    // not via a partial unique index, to keep "freed on revoke" semantics simple.
    safeCreateIndex(db, 'service_accounts', { sa_sub: 1 }, { unique: true }),
    safeCreateIndex(db, 'service_accounts', { client_id: 1 }, { unique: true }),
    safeCreateIndex(db, 'service_accounts', { owning_team_id: 1, status: 1 }),
    safeCreateIndex(db, 'service_accounts', { owning_team_id: 1, name: 1, status: 1 }),
    safeCreateIndex(db, 'service_accounts', { created_by: 1 }),

    // Agent skills collection (catalog source agent_skills)
    safeCreateIndex(db, 'agent_skills', { id: 1 }, { unique: true }),
    safeCreateIndex(db, 'agent_skills', { owner_id: 1 }),
    safeCreateIndex(db, 'agent_skills', { category: 1 }),
    safeCreateIndex(db, 'agent_skills', { is_system: 1 }),
    safeCreateIndex(db, 'agent_skills', { name: 1 }),
    safeCreateIndex(db, 'agent_skills', { created_at: -1 }),
    safeCreateIndex(db, 'agent_skills', { 'metadata.tags': 1 }),

    // Dynamic agents list endpoint
    safeCreateIndex(db, 'dynamic_agents', { enabled: 1, name: 1 }),

    // Skill revisions collection (per-skill content history; pruned to
    // SKILL_REVISIONS_RETENTION on every write — see lib/skill-revisions.ts)
    safeCreateIndex(db, 'skill_revisions', { id: 1 }, { unique: true }),
    safeCreateIndex(db, 'skill_revisions', { skill_id: 1, revision_number: -1 }),
    safeCreateIndex(db, 'skill_revisions', { skill_id: 1, created_at: -1 }),

    // Skill hubs collection
    safeCreateIndex(db, 'skill_hubs', { id: 1 }, { unique: true }),
    safeCreateIndex(db, 'skill_hubs', { enabled: 1 }),
    safeCreateIndex(db, 'skill_hubs', { location: 1 }),

    // Workflow runs collection (v2 — uses _id as primary key)
    safeCreateIndex(db, 'workflow_runs', { workflow_config_id: 1 }),
    safeCreateIndex(db, 'workflow_runs', { status: 1 }),
    safeCreateIndex(db, 'workflow_runs', { started_at: -1 }),

    // Policies collection (global ASP policy for system workflows)
    safeCreateIndex(db, 'policies', { name: 1 }, { unique: true }),
    safeCreateIndex(db, 'policies', { is_system: 1 }),

    // Feedback collection (unified feedback from web + Slack)
    safeCreateIndex(db, 'feedback', { created_at: -1 }),
    safeCreateIndex(db, 'feedback', { source: 1, created_at: -1 }),
    safeCreateIndex(db, 'feedback', { rating: 1, created_at: -1 }),
    safeCreateIndex(db, 'feedback', { channel_name: 1, created_at: -1 }),
    safeCreateIndex(db, 'feedback', { trace_id: 1 }),

    // Turns collection (per-turn persistence decoupled from messages)
    safeCreateIndex(db, 'turns', { conversation_id: 1, client_type: 1, turn_id: 1 }, { unique: true }),
    safeCreateIndex(db, 'turns', { conversation_id: 1, client_type: 1, created_at: 1 }),

    // Slack metadata on conversations (for stats queries filtering by source)
    safeCreateIndex(db, 'conversations', { source: 1, created_at: -1 }),
    safeCreateIndex(db, 'conversations', { 'slack_meta.channel_name': 1, created_at: -1 }),
    safeCreateIndex(db, 'conversations', { 'slack_meta.escalated': 1, created_at: -1 }),

    // 098 RBAC: Team-scoped RAG tool configurations
    safeCreateIndex(db, 'team_rag_tools', { tool_id: 1 }, { unique: true }),
    safeCreateIndex(db, 'team_rag_tools', { team_id: 1, tenant_id: 1 }),
    safeCreateIndex(db, 'team_rag_tools', { tenant_id: 1 }),
    safeCreateIndex(db, 'team_rag_tools', { created_by: 1 }),
    safeCreateIndex(db, 'team_rag_tools', { updated_at: -1 }),

    // 098 US9: Slack channel ↔ team mappings + admin Slack dashboard
    safeCreateIndex(db, 'channel_team_mappings', { slack_channel_id: 1 }, { unique: true }),
    safeCreateIndex(db, 'slack_channel_agent_routes', { workspace_id: 1, channel_id: 1, agent_id: 1 }, { unique: true }),
    safeCreateIndex(db, 'slack_channel_agent_routes', { workspace_id: 1, channel_id: 1, status: 1 }),
    safeCreateIndex(db, 'slack_channel_agent_routes', { channel_id: 1, status: 1, priority: 1 }),
    safeCreateIndex(db, 'slack_user_metrics', { slack_user_id: 1 }, { unique: true }),

    // RAG ingestion source configuration (self-service ingestion, PR1)
    safeCreateIndex(db, 'rag_ingestion_sources', { source_id: 1 }, { unique: true }),
    safeCreateIndex(db, 'rag_ingestion_sources', { owner_team_slug: 1, updated_at: -1 }),
    safeCreateIndex(db, 'rag_ingestion_sources', { shared_with_teams: 1 }),
    safeCreateIndex(db, 'rag_ingestion_sources', { source_type: 1, status: 1 }),
    safeCreateIndex(db, 'rag_ingestion_sources', { config_driven: 1 }),

    // First-class RAG collections. Datasource content remains in Milvus under
    // datasource_id; this is control-plane membership and delegation only.
    safeCreateIndex(db, 'rag_collections', { is_platform: 1 }),
    safeCreateIndex(db, 'rag_collections', { owner_subject: 1, updated_at: -1 }),
    safeCreateIndex(db, 'rag_collections', { maintainer_team_slugs: 1 }),
    safeCreateIndex(db, 'rag_collections', { reader_team_slugs: 1 }),
    safeCreateIndex(db, 'rag_collections', { source_ids: 1 }),

    // Reusable publication approval workflow. Requested state remains
    // separate from effective state until a domain adapter applies approval.
    safeCreateIndex(db, 'publication_requests', { status: 1, created_at: -1 }),
    safeCreateIndex(db, 'publication_requests', { 'resource.kind': 1, 'resource.id': 1, status: 1 }),
    safeCreateIndex(db, 'publication_requests', { 'requested_state.source_ids': 1, status: 1 }),
    safeCreateIndex(db, 'publication_requests', { approver_team_slugs: 1, status: 1 }),
    safeCreateIndex(db, 'publication_requests', { approver_user_subjects: 1, status: 1 }),
    safeCreateIndex(db, 'publication_requests', { 'requester.subject': 1, created_at: -1 }),
    safeCreateIndex(db, 'publication_requests', { 'resource.kind': 1, 'requested_state.channel_defaults.channel_id': 1, status: 1 }),
    safeCreateIndex(db, 'publication_requests', { 'resource.kind': 1, 'requested_state.space_id': 1, status: 1 }),

    // Durable header notifications. Direct, team, organization-admin, and
    // global platform audiences share the feed while read state remains
    // personal to each viewer.
    safeCreateIndex(db, 'in_app_notifications', { event_key: 1 }, { unique: true }),
    safeCreateIndex(db, 'in_app_notifications', { recipient_user_subjects: 1, created_at: -1 }),
    safeCreateIndex(db, 'in_app_notifications', { recipient_team_slugs: 1, created_at: -1 }),
    safeCreateIndex(db, 'in_app_notifications', { recipient_organization_admins: 1, created_at: -1 }),
    safeCreateIndex(db, 'in_app_notifications', { recipient_platform_users: 1, created_at: -1 }),
    safeCreateIndex(db, 'in_app_notifications', { archived_at: 1, created_at: -1 }),
    safeCreateIndex(db, 'platform_health_notification_states', { active_incident_id: 1 }),
    safeCreateIndex(db, 'platform_health_notification_states', { current_status: 1, updated_at: -1 }),
  ]);

  console.log('✅ MongoDB indexes ensured');

  // Drop stale indexes left by previous schema versions (v1 used { id: 1 }
  // as unique key; v2 uses _id directly). MongoDB never drops indexes
  // automatically when createIndex calls are removed from code.
  const staleIndexes: Array<{ collection: string; index: string }> = [
    { collection: 'workflow_runs', index: 'id_1' },
    { collection: 'workflow_runs', index: 'workflow_id_1' },
    { collection: 'workflow_runs', index: 'owner_id_1' },
    { collection: 'workflow_runs', index: 'owner_id_1_workflow_id_1' },
    { collection: 'workflow_runs', index: 'owner_id_1_started_at_-1' },
  ];
  for (const { collection, index } of staleIndexes) {
    try {
      await db.collection(collection).dropIndex(index);
      console.log(`🗑️  Dropped stale index ${collection}.${index}`);
    } catch {
      // Index doesn't exist — nothing to do
    }
  }
}

/**
 * Close MongoDB connection
 * Use this for graceful shutdown
 */
export async function closeConnection() {
  if (cachedConnection) {
    await cachedConnection.client.close();
    cachedConnection = null;
    connectionPromise = null;
    indexesPromise = null;
    console.log('MongoDB connection closed');
  }
}
