import { proxyHarnessEngineStream } from "@/lib/harness-engine-proxy";
import { translateCanonicalStream } from "@/lib/harness-gateway";
import { authorizeHarnessRunAccess } from "../../../../_run-authz";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await context.params;
  const access = await authorizeHarnessRunAccess(request, runId, "read");
  if (access instanceof NextResponse) return access;
  const after = request.nextUrl.searchParams.get("after") ?? request.headers.get("last-event-id");
  const protocol = request.nextUrl.searchParams.get("protocol");
  if (after !== null && !/^\d+(?:\.\d+)?$/.test(after)) return NextResponse.json({ error: "Invalid replay cursor" }, { status: 400 });
  // Replay translation state deterministically before skipping delivered subframes.
  const suffix = protocol === "agui" || protocol === "custom" ? "?after=0" : after === null ? "" : `?after=${encodeURIComponent(after)}`;

  // Aborting this fetch only drops this subscriber. The run was started by a
  // separate POST and is owned by Harness Engine, so provider execution and
  // event persistence continue after the browser/BFF connection disappears.
  const authorizedAt = Date.now();
  const subscriber = new AbortController();
  const disconnect = () => subscriber.abort();
  request.signal.addEventListener("abort", disconnect, { once: true });
  if (request.signal.aborted) disconnect();
  const response = await proxyHarnessEngineStream(
    access.config,
    access.auth,
    `/api/v1/runs/${encodeURIComponent(runId)}/events/stream${suffix}`,
    subscriber.signal,
    access.readScope,
  );
  if (!response.ok || !response.body) {
    request.signal.removeEventListener("abort", disconnect);
    return response;
  }
  const reader = response.body.getReader();
  let stopped = false;
  let nextCheck = authorizedAt + 15_000;
  let checking: Promise<boolean> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => {
    clearInterval(timer);
    request.signal.removeEventListener("abort", disconnect);
    subscriber.signal.removeEventListener("abort", close);
    subscriber.abort();
    void reader.cancel().catch(error => console.warn("[harness-engine] Subscriber cleanup failed", error));
  };
  const close = () => {
    if (stopped) return;
    stopped = true;
    cleanup();
    controller.close();
  };
  const authorized = (force = false): Promise<boolean> => {
    if (stopped) return Promise.resolve(false);
    if (checking) return checking;
    if (!force && Date.now() < nextCheck) return Promise.resolve(true);
    checking = (async () => {
      try {
        const current = await authorizeHarnessRunAccess(request, runId, "read");
        if (current instanceof NextResponse || current.auth.subject !== access.auth.subject ||
            current.readScope?.agentId !== access.readScope?.agentId ||
            current.readScope?.conversationId !== access.readScope?.conversationId) {
          close();
          return false;
        }
        nextCheck = Date.now() + 15_000;
        return !stopped;
      } catch (error) {
        console.warn("[harness-engine] Subscriber reauthorization failed", error);
        close();
        return false;
      } finally {
        checking = undefined;
      }
    })();
    return checking;
  };
  // Recheck even on a quiet stream; a slow read must also pass the check before
  // its next chunk is forwarded. Cancellation drops only this subscription.
  const timer = setInterval(() => { void authorized(true); }, 15_000);
  timer.unref();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      subscriber.signal.addEventListener("abort", close, { once: true });
      if (subscriber.signal.aborted) close();
    },
    async pull() {
      try {
        const result = await reader.read();
        if (stopped) return;
        if (result.done) close();
        else if (await authorized()) controller.enqueue(result.value);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          cleanup();
          controller.error(error);
        }
      }
    },
    cancel() {
      if (stopped) return;
      stopped = true;
      cleanup();
    },
  });
  if (protocol !== "agui" && protocol !== "custom") return new Response(body, response);

  const run = (await access.response.json()).data;
  return new Response(translateCanonicalStream(body, run, protocol, after ?? "0"), { status: 200, headers: { ...Object.fromEntries(response.headers), "X-Harness-Run-ID": runId, "X-Harness-Conversation-ID": run.conversation_id, "X-Harness-Agent-ID": run.agent_id } });
}
