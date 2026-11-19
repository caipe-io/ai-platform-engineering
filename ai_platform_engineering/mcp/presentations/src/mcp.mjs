import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { renderSchema } from './schema.mjs';
export async function handleMcp(request, response, body, identity, store) {
  const server = new McpServer({ name: 'presentations', version: '0.1.0' });
  const result = async operation => {
    try { const data = await operation(); return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.status ? error.message : 'Invalid deck or rendering failed. Check the schema and template profile.' }] }; }
  };
  server.registerTool('presentations_list_templates', {
    description: 'List presentation templates the signed-in user can use. Returns IDs, immutable content/profile versions and supported modes; never template bytes.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, () => result(async () => ({ templates: await store.list(identity) })));
  server.registerTool('presentations_plan', {
    description: 'Validate a proposed deck and calculate the actual slide count after density splits before asking the user to approve the outline. Include explicit cover, content, open_items and closing slides when the chosen template contract requires them. Uses URLs from any authorized source; no source fetching or live fact verification.',
    inputSchema: renderSchema.omit({ approved: true }).shape, annotations: { readOnlyHint: true },
  }, args => result(() => store.plan(identity, args)));
  server.registerTool('presentations_render', {
    description: 'Generate an editable PowerPoint from user-approved deck JSON and an accessible private template. Call presentations_plan before outline approval. Set approved only after user approval. Citations are source URLs supplied by the agent, never fetched. Mark unsupported statements verify=true. Return the actual slide count, review warnings and authenticated download URL. No project required. Does not perform visual QA. Never claim it does.',
    inputSchema: renderSchema.shape, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, args => result(() => store.render(identity, args)));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.once('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}
