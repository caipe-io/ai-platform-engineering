/**
 * Shared server-side calls to dynamic-agents `/api/v1/assistant/suggest`.
 * Used by the Custom Agent Builder suggest route and the Skills AI generate route.
 */

export interface AssistantSuggestBody {
  system_prompt: string;
  user_message: string;
  model: { id: string; provider: string };
}

export type AssistantSuggestSuccess = { ok: true; content: string };
export type AssistantSuggestFailure = {
  ok: false;
  status: number;
  detail: string;
};

/**
 * Ports that almost certainly aren't the dynamic-agents service when paired
 * with `localhost`/`127.0.0.1`. Used to print a one-shot warning at boot so
 * misconfigurations like `DYNAMIC_AGENTS_URL=http://localhost:8001` are caught
 * before users hit the AI Assist / Skill Generate flow.
 */
const SUSPICIOUS_LOCAL_PORTS = new Set(["8000", "8001", "3000"]);

let warnedAboutBaseUrl = false;
function warnIfBaseSuspicious(base: string): void {
  if (warnedAboutBaseUrl) return;
  warnedAboutBaseUrl = true;
  try {
    const u = new URL(base);
    const isLocal =
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "0.0.0.0";
    if (isLocal && SUSPICIOUS_LOCAL_PORTS.has(u.port)) {
      console.warn(
        `[dynamic-agents] DYNAMIC_AGENTS_URL=${base} looks suspicious. ` +
          `The dynamic-agents host port is typically 8100 (compose: 8100->8001). ` +
          `Other localhost ports (8000 or 3000=UI) will refuse the request. ` +
          `Update ui/.env.local if AI Assist / Skill Generate is failing.`,
      );
    }
  } catch {
    console.warn(
      `[dynamic-agents] DYNAMIC_AGENTS_URL is not a valid URL: ${base}`,
    );
  }
}

export function getDynamicAgentsSuggestUrl(): string {
  const base = process.env.DYNAMIC_AGENTS_URL || "http://localhost:8100";
  warnIfBaseSuspicious(base);
  return `${base.replace(/\/$/, "")}/api/v1/assistant/suggest`;
}

function getFetchErrorCode(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "cause" in err &&
    err.cause &&
    typeof err.cause === "object" &&
    "code" in err.cause
  ) {
    return String((err.cause as { code?: string }).code);
  }
  return "";
}

export function formatAssistantSuggestFetchError(
  err: unknown,
  suggestUrl: string
): string {
  const code = getFetchErrorCode(err);
  if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
    return (
      `Cannot connect to dynamic-agents at ${suggestUrl} (${code}). ` +
      `Start the dynamic-agents service and ensure it listens on the same host/port. ` +
      `The UI server reads DYNAMIC_AGENTS_URL (e.g. ui/.env.local); default is http://localhost:8100. ` +
      `If your service uses another port, set DYNAMIC_AGENTS_URL to match (do not point at the UI or other services).`
    );
  }
  return `Cannot reach dynamic-agents at ${suggestUrl}: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * POST to assistant/suggest and return parsed JSON or a failure object.
 */
export async function fetchAssistantSuggest(
  headers: Record<string, string>,
  body: AssistantSuggestBody,
  /**
   * Abort after this many milliseconds. Callers on a user-facing write path
   * should set one: without it the request inherits Node's default, so an
   * unresponsive dynamic-agents would hold the caller open indefinitely.
   */
  timeoutMs?: number,
): Promise<AssistantSuggestSuccess | AssistantSuggestFailure> {
  const url = getDynamicAgentsSuggestUrl();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: formatAssistantSuggestFetchError(err, url),
    };
  }

  const data = (await response.json().catch(() => ({}))) as {
    content?: string;
    detail?: string;
  };

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      detail: data.detail || `Backend error: ${response.statusText}`,
    };
  }

  return { ok: true, content: data.content ?? "" };
}
