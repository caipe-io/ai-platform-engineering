/**
 * RAG Evaluator API Client for CAIPE UI
 *
 * Provides type-safe API functions to interact with the RAG Evaluator server
 * through the Next.js API proxy at /api/eval/*.
 *
 * Mirrors the structure and design pattern of ui/src/lib/rag-api.ts.
 */

// ============================================================================
// Types & Models
// ============================================================================

export interface QuestionItem {
  id?: string;
  question: string;
  ground_truth?: string;
  reference_contexts?: string[];
  metadata?: Record<string, unknown>;
}

export interface QuestionSet {
  id: string;
  name: string;
  description?: string;
  created_at?: string;
  items: QuestionItem[];
  metadata?: Record<string, unknown>;
}

export interface EvalRequest {
  dataset_name?: string;
  datasource_id?: string;
  question_set_id?: string;
  questions_file?: string;
  agent_url?: string;
  max_items?: number;
  top_k?: number;
  max_context_chars?: number;
  metadata?: Record<string, unknown>;
}

export interface EvalJob {
  job_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  dataset_name?: string;
  datasource_id?: string;
  created_at: string;
  updated_at?: string;
  progress?: number;
  error?: string;
  metrics_summary?: Record<string, number>;
  metadata?: Record<string, unknown>;
}

export interface EvalResult {
  eval_id: string;
  job_id?: string;
  question: string;
  answer?: string;
  contexts?: string[];
  ground_truth?: string;
  scores?: Record<string, number>;
  passed?: boolean;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface EvaluatorHealth {
  status: string;
  version?: string;
  timestamp?: number;
  details?: Record<string, unknown>;
}

// ============================================================================
// Error Class
// ============================================================================

const API_BASE = '/api/rag-evaluator';

export class RagEvalApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly serverMessage?: string;

  constructor(status: number, statusText: string, code?: string, serverMessage?: string) {
    super(`RagEval API Error: ${status} ${statusText}`);
    this.name = 'RagEvalApiError';
    this.status = status;
    this.code = code;
    if (serverMessage) this.serverMessage = serverMessage;
  }
}

async function toRagEvalApiError(response: Response): Promise<RagEvalApiError> {
  let code: string | undefined;
  let serverMessage: string | undefined;
  try {
    const body = await response.json();
    if (body && typeof body === 'object') {
      code = typeof body.code === 'string' ? body.code : undefined;
      serverMessage = typeof body.error === 'string' ? body.error : undefined;
    }
  } catch {
    // Non-JSON response
  }
  return new RagEvalApiError(response.status, response.statusText, code, serverMessage);
}

// ============================================================================
// HTTP Methods
// ============================================================================

async function get<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    throw await toRagEvalApiError(response);
  }

  return response.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const url = `${API_BASE}${path}`;

  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw await toRagEvalApiError(response);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

async function del<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;

  const response = await fetch(url, {
    method: 'DELETE',
    credentials: 'include',
  });

  if (!response.ok) {
    throw await toRagEvalApiError(response);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

// ============================================================================
// Exported API Client Methods
// ============================================================================

/** Check RAG Evaluator service health */
export async function getEvaluatorHealth(): Promise<EvaluatorHealth> {
  return get<EvaluatorHealth>('/health');
}

/** List available evaluation question sets */
export async function getQuestionSets(): Promise<QuestionSet[]> {
  return get<QuestionSet[]>('/api/v1/question-sets');
}

/** Trigger a new RAG evaluation job */
export async function triggerEval(request: EvalRequest): Promise<EvalJob> {
  return post<EvalJob>('/eval', request);
}

/** List all evaluation jobs */
export async function getEvalJobs(): Promise<EvalJob[]> {
  return get<EvalJob[]>('/jobs');
}

/** Get specific evaluation job by ID */
export async function getEvalJob(jobId: string): Promise<EvalJob> {
  return get<EvalJob>(`/jobs/${encodeURIComponent(jobId)}`);
}

/** List evaluation results */
export async function getEvalResults(jobId?: string): Promise<EvalResult[]> {
  const params = jobId ? { job_id: jobId } : undefined;
  return get<EvalResult[]>('/results', params);
}

/** Delete an evaluation job */
export async function deleteEvalJob(jobId: string): Promise<void> {
  return del<void>(`/jobs/${encodeURIComponent(jobId)}`);
}
