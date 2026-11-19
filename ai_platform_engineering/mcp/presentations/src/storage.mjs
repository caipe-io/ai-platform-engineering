import { randomUUID, createHash } from 'node:crypto';
import { Binary } from 'mongodb';
import { canRead, HttpError, requireWriter } from './auth.mjs';
import { planDeck } from './renderer.mjs';
import { runRenderWorker } from './render-worker.mjs';
import { renderSchema, uploadSchema } from './schema.mjs';
export const metadata = (template, defaultTemplateId) => ({ id: template._id, name: template.name, owner_team: template.owner_team, is_default: template._id === defaultTemplateId,
  shared_with: template.shared_with, version: template.version, modes: Object.keys(template.profile.modes), updated_at: template.updated_at });
export class PresentationStore {
  constructor(db, { publicUrl, downloadUrl = publicUrl, defaultTemplateId, artifactDays = 7, renderer = (bytes, profile, deck) => runRenderWorker('render', bytes, profile, deck) } = {}) {
    this.db = db;
    this.templates = db.collection('presentation_templates');
    this.artifacts = db.collection('presentation_artifacts');
    this.publicUrl = publicUrl; this.downloadUrl = downloadUrl; this.defaultTemplateId = defaultTemplateId; this.artifactDays = artifactDays; this.renderer = renderer;
  }
  async ready() { await this.db.command({ ping: 1 }); }
  async initialize() { await this.artifacts.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }); }
  async list(identity) {
    return (await this.templates.find({ $or: [{ owner_team: { $in: [...identity.teams.keys()] } }, { shared_with: { $in: [...identity.teams.keys()] } }] }, { projection: { bytes: 0 } }).limit(200).toArray()).map(template => metadata(template, this.defaultTemplateId)).sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name));
  }
  async get(identity, id) {
    const template = await this.templates.findOne({ _id: id });
    if (!template || !canRead(identity, template)) throw new HttpError(404, 'Template not found');
    return template;
  }
  async upload(identity, input, bytes, templateId) {
    const data = uploadSchema.parse(input);
    requireWriter(identity, data.owner_team);
    if (data.shared_with.some(team => !identity.teams.has(team))) throw new HttpError(403, 'Choose a shared team you can access');
    if (templateId) {
      const existing = await this.get(identity, templateId);
      if (existing.owner_team !== data.owner_team) throw new HttpError(400, 'A template owner team cannot be changed');
    }
    const { version, profile } = await runRenderWorker('inspect', bytes, data.profile);
    const template = { _id: templateId || randomUUID(), name: data.name, owner_team: data.owner_team,
      shared_with: [...new Set(data.shared_with)].sort(), profile, version,
      bytes: new Binary(bytes), bytes_sha256: createHash('sha256').update(bytes).digest('hex'),
      updated_at: new Date(), uploaded_by: identity.subject };
    await this.templates.replaceOne({ _id: template._id }, template, { upsert: !templateId });
    return metadata(template, this.defaultTemplateId);
  }
  async plan(identity, input) {
    const parsed = renderSchema.omit({ approved: true }).parse(input);
    const template = await this.get(identity, parsed.template_id);
    if (template.version !== parsed.version) throw new HttpError(409, 'Template changed; list templates again');
    const plan = planDeck(parsed.deck, template.profile);
    return { slide_count: plan.slide_count, warnings: plan.warnings, template_version: template.version };
  }
  async render(identity, input) {
    const parsed = renderSchema.parse(input);
    const template = await this.get(identity, parsed.template_id);
    if (template.version !== parsed.version) throw new HttpError(409, 'Template changed; list templates again');
    const bytes = Buffer.from(template.bytes.buffer);
    if (createHash('sha256').update(bytes).digest('hex') !== template.bytes_sha256) throw new HttpError(503, 'Template integrity check failed');
    const result = await this.renderer(bytes, template.profile, parsed.deck);
    if (result.version !== template.version) throw new HttpError(503, 'Template profile integrity check failed');
    if (result.bytes.length > 12 * 1024 * 1024) throw new HttpError(413, 'Export too large; split the deck');
    // Recheck the live template policy after rendering, before persisting content.
    const current = await this.get(identity, template._id);
    if (current.version !== template.version) throw new HttpError(409, 'Template changed during rendering; retry');
    const id = randomUUID(); const expires_at = new Date(Date.now() + this.artifactDays * 86400_000);
    const filename = `${parsed.deck.title.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80) || 'presentation'}.pptx`;
    await this.artifacts.insertOne({ _id: id, template_id: template._id, template_version: template.version,
      owner: identity.subject, bytes: new Binary(result.bytes), expires_at, filename, title: parsed.deck.title, created_at: new Date() });
    return { artifact_id: id, filename, slide_count: result.slide_count, warnings: result.warnings,
      template_version: template.version, expires_at, download_url: `${this.downloadUrl}/artifacts/${id}` };
  }
  async download(identity, id) {
    const artifact = await this.artifacts.findOne({ _id: id, owner: identity.subject, expires_at: { $gt: new Date() } });
    if (!artifact) throw new HttpError(404, 'Artifact not found or expired');
    await this.get(identity, artifact.template_id);
    return artifact;
  }
  async history(identity) {
    return this.artifacts.find({ owner: identity.subject, expires_at: { $gt: new Date() } }, { projection: { bytes: 0 } }).sort({ created_at: -1 }).limit(50).toArray();
  }
}
