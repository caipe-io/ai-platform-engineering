/**
 * Re-export DA proxy helpers from the shared lib.
 *
 * All Dynamic Agents proxy logic now lives in ``@/lib/da-proxy``.
 * This file exists so that existing relative imports
 * (e.g. ``from "../_helpers"``) continue to work.
 *
 * New code should import directly from ``@/lib/da-proxy``.
 */

export {
authenticateRequest,buildBackendHeaders,getDynamicAgentsConfig,getDynamicAgentsInvokeProxyOptions,proxyJSONRequest,
proxyRequest,proxySSEStream
} from "@/lib/da-proxy";

export type { AuthResult,DynamicAgentsConfig } from "@/lib/da-proxy";
