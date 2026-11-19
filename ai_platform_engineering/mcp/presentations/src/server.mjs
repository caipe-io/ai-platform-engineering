import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { ZodError } from 'zod';
import { createAuthenticator, HttpError } from './auth.mjs';
import { PresentationStore } from './storage.mjs';
import { handleMcp } from './mcp.mjs';
import { profileSchema, id, retentionSchema } from './schema.mjs';
import { page, clientScript } from './ui.mjs';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const artifactMetadata = (artifact, store) => ({ id: artifact._id, title: artifact.title, filename: artifact.filename,
  created_at: artifact.created_at, kept: artifact.kept === true, expires_at: artifact.expires_at ?? null,
  download_url: `${store.downloadUrl}/artifacts/${artifact._id}` });
export function resolveUploadProfile(profiles, defaultProfileId, requestedProfileId) {
  const selected = requestedProfileId ?? defaultProfileId ?? (profiles.length === 1 ? profiles[0].id : undefined);
  const preset = profiles.find(profile => profile.id === selected);
  if (!preset) throw new HttpError(400, requestedProfileId !== undefined ? 'Unknown template type.' : 'Template uploads need an administrator to configure a default template type.');
  return preset;
}
export async function readBody(request, max) {
  const chunks = []; let size = 0;
  if (Number(request.headers['content-length']) > max) throw new HttpError(413, 'Request too large');
  for await (const chunk of request) { size += chunk.length; if (size > max) throw new HttpError(413, 'Request too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
export function createPresentationServer({ store, authenticate, profiles, defaultProfileId, basePath = '/apps/presentations', publicUrl }) {
  function send(response, status, body, headers = {}) {
    response.writeHead(status, { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'content-type': 'application/json', ...headers });
    response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname.startsWith(`${basePath}/`) ? url.pathname.slice(basePath.length) : url.pathname === basePath ? '/' : url.pathname;
      if (path === '/healthz') return send(response, 200, { ok: true });
      if (path === '/health/ready') { try { await store.ready(); } catch { throw new HttpError(503, 'Storage is unavailable'); } return send(response, 200, { ok: true }); }
      const identity = await authenticate(request);
      if (path === '/' && request.method === 'GET') return send(response, 200, page(basePath), { 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'" });
      if (path === '/client.js' && request.method === 'GET') return send(response, 200, clientScript, { 'content-type': 'text/javascript' });
      if (['/mcp', '/mcp/'].includes(path) && request.method === 'POST') {
        return await handleMcp(request, response, await readBody(request, 1024 * 1024), identity, store);
      }
      if (path === '/api/config' && request.method === 'GET') return send(response, 200, {
        teams: [...identity.teams].map(([slug, value]) => ({ slug, ...value })),
        profiles: profiles.map(profile => ({ id: profile.id, name: profile.name })),
        default_profile_id: defaultProfileId,
        artifact_days: store.artifactDays,
      });
      if (path === '/api/templates' && request.method === 'GET') return send(response, 200, { templates: await store.list(identity) });
      if ((path === '/api/templates' && request.method === 'POST') || (/^\/api\/templates\/[^/]+$/.test(path) && request.method === 'PUT')) {
        const data = await readBody(request, 12 * 1024 * 1024);
        const preset = resolveUploadProfile(profiles, defaultProfileId, data.profile_id);
        if (typeof data.file !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.file)) throw new HttpError(400, 'A PowerPoint file is required');
        const templateId = request.method === 'PUT' ? id.parse(path.split('/').pop()) : undefined;
        const result = await store.upload(identity, { name: data.name, owner_team: data.owner_team, shared_with: data.shared_with || [], profile: preset.profile }, Buffer.from(data.file, 'base64'), templateId);
        return send(response, 200, result);
      }
      if (path === '/api/artifacts' && request.method === 'GET') {
        const artifacts = await store.history(identity);
        return send(response, 200, { artifacts: artifacts.map(artifact => artifactMetadata(artifact, store)) });
      }
      if (/^\/api\/artifacts\/[^/]+\/retention$/.test(path) && request.method === 'PUT') {
        const { keep } = retentionSchema.parse(await readBody(request, 1024));
        const artifact = await store.retain(identity, id.parse(path.split('/')[3]), keep);
        return send(response, 200, artifactMetadata(artifact, store));
      }
      if (/^\/api\/artifacts\/[^/]+$/.test(path) && request.method === 'DELETE') {
        await store.deleteArtifact(identity, id.parse(path.split('/').pop()));
        return send(response, 200, { deleted: true });
      }
      if (/^\/artifacts\/[^/]+$/.test(path) && request.method === 'GET') {
        const artifact = await store.download(identity, id.parse(path.split('/').pop()));
        return send(response, 200, Buffer.from(artifact.bytes.buffer), { 'content-type': PPTX,
          'content-disposition': `attachment; filename="${artifact.filename}"` });
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      const status = error.status || (error instanceof ZodError ? 400 : 500);
      if (!response.headersSent) send(response, status, { error: error.status ? error.message : error instanceof ZodError ? 'Invalid input' : 'Presentation request failed' });
      else response.end();
    }
  });
}
export async function main() {
  const required = name => { if (!process.env[name]?.trim()) throw new Error(`${name} is required`); return process.env[name].trim(); };
  const publicUrl = required('PRESENTATION_PUBLIC_URL').replace(/\/$/, '');
  const publicUri = new URL(publicUrl);
  if (publicUri.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(publicUri.hostname)) throw new Error('Public URL must use HTTPS');
  const profiles = JSON.parse(await readFile(required('PRESENTATION_PROFILES_FILE'), 'utf8'));
  if (!Array.isArray(profiles) || !profiles.length || new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error('Invalid template presets');
  for (const preset of profiles) { if (!/^[a-z0-9-]{1,64}$/.test(preset.id) || typeof preset.name !== 'string') throw new Error('Invalid preset'); preset.profile = profileSchema.parse(preset.profile); }
  const defaultProfileId = process.env.PRESENTATION_DEFAULT_PROFILE_ID?.trim() || undefined;
  if (defaultProfileId && !profiles.some(profile => profile.id === defaultProfileId)) throw new Error('Default preset is not configured');
  const defaultTemplateId = process.env.PRESENTATION_DEFAULT_TEMPLATE_ID?.trim() || undefined;
  if (defaultTemplateId) id.parse(defaultTemplateId);
  const client = new MongoClient(required('MONGODB_URI'));
  await client.connect();
  const downloadUrl = (process.env.PRESENTATION_DOWNLOAD_URL || publicUrl).replace(/\/$/, '');
  if (new URL(downloadUrl).origin !== publicUri.origin) throw new Error('Download URL must use the public application origin');
  const store = new PresentationStore(client.db(required('MONGODB_DATABASE')), { publicUrl, downloadUrl, defaultTemplateId });
  await store.initialize();
  const authenticate = createAuthenticator({ issuer: required('OIDC_ISSUER'), jwks: required('OIDC_JWKS_URL'),
    audience: required('PRESENTATION_TOKEN_AUDIENCE'), hostOrigin: required('CAIPE_API_ORIGIN').replace(/\/$/, '') });
  const server = createPresentationServer({ store, authenticate, profiles, defaultProfileId, publicUrl, basePath: publicUri.pathname.replace(/\/$/, '') });
  server.requestTimeout = 90_000; server.headersTimeout = 10_000;
  server.listen(Number(process.env.PORT || 8088), process.env.HOST || '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(async () => { await client.close(); process.exit(0); }));
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Presentation service startup failed; check required configuration'); process.exit(1); });
