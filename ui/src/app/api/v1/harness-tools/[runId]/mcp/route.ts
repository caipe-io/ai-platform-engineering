import { getDynamicAgentsConfig } from "@/lib/da-proxy";
import { BodyLimitError, readBoundedBody } from "@/lib/dynamic-agents/bounded-body";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 14_400;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/** The run-scoped capability is the only authority; browser identity is never a fallback. */
export async function POST(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<Response> {
  const capability = request.headers.get("X-CAIPE-Harness-Capability");
  if (!capability || !/^[A-Za-z0-9_-]{32,256}$/.test(capability)) return fail(401, "A valid harness capability is required");
  const { runId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) return fail(400, "Invalid harness run ID");
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return fail(415, "JSON content is required");
  let body: string;
  try {
    body = await readBoundedBody(request.body, 256 * 1024);
    JSON.parse(body);
  } catch (error) {
    return fail(error instanceof BodyLimitError ? 413 : 400, error instanceof BodyLimitError ? "Harness request is too large" : "Invalid harness JSON request");
  }
  const config = getDynamicAgentsConfig();
  if (config instanceof NextResponse) return fail(503, "Harness tool service is unavailable");
  const observer = new AbortController();
  const abortObserver = () => observer.abort();
  request.signal.addEventListener("abort", abortObserver, { once: true });
  if (request.signal.aborted) abortObserver();
  const headerDeadline = setTimeout(abortObserver, 10_000);
  const cleanup = () => {
    clearTimeout(headerDeadline);
    request.signal.removeEventListener("abort", abortObserver);
  };
  try {
    const response = await fetch(new URL(`/api/v1/harness-tools/${encodeURIComponent(runId)}/mcp`, config.dynamicAgentsUrl), {
      method: "POST", body, redirect: "error", cache: "no-store", signal: observer.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-CAIPE-Harness-Capability": capability },
    });
    clearTimeout(headerDeadline);
    if (!response.ok) {
      await response.body?.cancel();
      cleanup();
      const status = [400, 401, 403, 404, 409, 410, 413, 429, 500, 503].includes(response.status) ? response.status : 502;
      return fail(status, "Harness tool request was rejected");
    }
    if ([202, 204].includes(response.status)) {
      await response.body?.cancel();
      cleanup();
      return new Response(null, { status: response.status });
    }
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (contentType === "text/event-stream" && response.body) {
      const reader = response.body.getReader();
      let size = 0;
      let finished = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (finished) return;
            const { done, value } = await reader.read();
            if (finished) return;
            if (done) {
              finished = true;
              cleanup();
              reader.releaseLock();
              controller.close();
              return;
            }
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) throw new BodyLimitError("Harness stream exceeds limit");
            controller.enqueue(value);
          } catch (error) {
            if (finished) return;
            finished = true;
            cleanup();
            observer.abort();
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
            console.warn("[harness-tools] Observer stream ended", { errorType: error instanceof Error ? error.name : "Unknown" });
            controller.error(new Error("Harness tool stream is unavailable"));
          }
        },
        async cancel() {
          finished = true;
          cleanup();
          observer.abort();
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        },
      });
      // Cancelling this HTTP observer never cancels the producer-owned tool operation.
      return new Response(stream, { status: response.status, headers: {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
      } });
    }
    if (contentType !== "application/json") {
      await response.body?.cancel();
      cleanup();
      return fail(502, "Harness tool service returned an unsupported response");
    }
    const text = await readBoundedBody(response.body, MAX_RESPONSE_BYTES);
    const result: unknown = JSON.parse(text);
    cleanup();
    return NextResponse.json(result, { status: response.status });
  } catch (error) {
    cleanup();
    observer.abort();
    console.warn("[harness-tools] Request failed", { errorType: error instanceof Error ? error.name : "Unknown" });
    return fail(502, "Harness tool service is unavailable");
  }
}
