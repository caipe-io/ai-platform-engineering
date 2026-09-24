import { authenticateRequest } from "@/lib/da-proxy";
import { resolveLlmModel } from "@/lib/server/platform-llm.server";
import { getAiAssistTask } from "@/lib/server/ai-assist-tasks";
import { fetchAssistantSuggest } from "@/lib/server/assistant-suggest-da";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/skills/generate
 *
 * Legacy SKILL.md generate/enhance endpoint. Now a thin delegator on top
 * of the per-task registry in `lib/server/ai-assist-tasks` — the route
 * exists for back-compat with the existing `useSkillAiAssist` hook (which
 * pre-dates the generic `/api/ai/assist` endpoint). New surfaces should
 * call `/api/ai/assist` directly.
 *
 * Wire format is unchanged:
 *   POST { type: "generate" | "enhance", description?, instruction?,
 *          current_content?, name?, skill_description? }
 *   Response: text/event-stream with `content` / `error` / `done` events.
 */

interface LegacyGenerateRequest {
  type: "generate" | "enhance";
  description?: string;
  instruction?: string;
  current_content?: string;
  name?: string;
  skill_description?: string;
}

function sseEvent(type: string, payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type, ...payload })}\n\n`;
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (type: string, payload: Record<string, unknown> = {}) =>
        controller.enqueue(encoder.encode(sseEvent(type, payload)));

      try {
        const body: LegacyGenerateRequest = await request.json();

        if (!["generate", "enhance"].includes(body.type)) {
          send("error", { message: "type must be 'generate' or 'enhance'" });
          return;
        }

        if (body.type === "generate" && !body.description?.trim()) {
          send("error", { message: "description is required for generate" });
          return;
        }
        if (body.type === "enhance" && !body.current_content?.trim()) {
          send("error", { message: "current_content is required for enhance" });
          return;
        }

        const taskId = body.type === "generate" ? "skill-md" : "enhance-skill-md";
        const task = getAiAssistTask(taskId);
        if (!task) {
          send("error", { message: `Internal: missing task ${taskId}` });
          return;
        }

        const auth = await authenticateRequest(request);
        const headers: Record<string, string> = {};
        if (!(auth instanceof Response) && auth.userContextHeader) {
          headers["X-User-Context"] = auth.userContextHeader;
        }

        const userMessage = task.buildUserMessage({
          instruction:
            body.type === "generate" ? body.description : body.instruction,
          current_value: body.current_content,
          name: body.name,
          skill_description: body.skill_description,
        });

        const model = await resolveLlmModel();

        const result = await fetchAssistantSuggest(headers, {
          system_prompt: task.systemPrompt,
          user_message: userMessage,
          model,
        });

        if (result.ok !== true) {
          send("error", { message: result.detail });
          return;
        }

        const content = task.postProcess
          ? task.postProcess(result.content)
          : result.content;

        const CHUNK = 200;
        for (let i = 0; i < content.length; i += CHUNK) {
          send("content", { text: content.slice(i, i + CHUNK) });
        }
        send("done");
      } catch (err: unknown) {
        controller.enqueue(
          encoder.encode(
            sseEvent("error", {
              message: err instanceof Error ? err.message : "Unknown error",
            }),
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
