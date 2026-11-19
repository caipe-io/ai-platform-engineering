import { z } from 'zod';
import { visualLayouts } from './visuals.mjs';
export const id = z.string().uuid();
export const retentionSchema = z.object({ keep: z.boolean() }).strict();
const placeholder = z.string().regex(/^\d{1,3}$/);
const layout = z.number().int().min(1).max(200);
export const profileSchema = z.object({
  modes: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), z.object({
    master: layout, cover: layout, content: layout, closing: layout, open_items: layout.optional(),
  }).strict()).refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 8),
  placeholders: z.object({ title: placeholder, subtitle: placeholder, eyebrow: placeholder.optional(),
    status: placeholder.optional(), meta: placeholder.optional(),
    items: z.array(placeholder).max(10).optional(), owners: z.array(placeholder).max(10).optional(), due: z.array(placeholder).max(10).optional(),
  }).strict(),
  canvas: z.tuple([z.number().min(0), z.number().min(0), z.number().positive(), z.number().positive()]),
  font: z.string().min(1).max(100).default('+mn-lt'),
  footer_y: z.number().positive(),
  // Accepted for existing stored profiles; review flags render only in speaker notes.
  verify_style: z.object({ fill: z.enum(['accent1','accent2','accent3','accent4','accent5','accent6']), text: z.enum(['dk1','dk2','lt1','lt2','tx1','tx2']) }).strict().optional(),
}).strict();
const text = z.string().max(2000);
const url = z.string().url().max(2048).refine(value => ['https:', 'http:'].includes(new URL(value).protocol));
const visualSchema = z.object({
  layout: z.enum(visualLayouts),
  groups: z.array(z.object({
    label: z.string().trim().min(1).max(100), value: z.string().max(24).optional(),
    items: z.array(z.string().trim().min(1).max(200)).max(3).default([]),
    sources: z.array(url).max(12).default([]), verify: z.boolean().default(false),
  }).strict()).min(2).max(5),
}).strict();
export const deckSchema = z.object({
  title: z.string().min(1).max(160), subtitle: z.string().max(300).default(''),
  mode: z.string().max(32), density: z.enum(['spacious', 'balanced', 'dense']).default('balanced'),
  slides: z.array(z.object({
    kind: z.enum(['cover', 'content', 'closing', 'open_items']).default('content'),
    title: z.string().min(1).max(160), subtitle: z.string().max(300).default(''),
    role: z.enum(['context', 'actionable', 'exploration']).default('context'),
    status: z.enum(['draft', 'needs decision', 'approved']).default('draft'),
    bullets: z.array(z.object({ text, sources: z.array(url).max(12).default([]), verify: z.boolean().default(false) }).strict()).max(12).default([]),
    visual: visualSchema.optional(),
    notes: z.string().max(12000).default(''),
    items: z.array(z.object({ text, owner: z.string().max(100).default('To assign'), due: z.string().max(100).default('To assign') }).strict()).max(10).default([]),
  }).strict()).min(1).max(40),
}).strict();
export const uploadSchema = z.object({
  name: z.string().trim().min(1).max(100), owner_team: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/),
  shared_with: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/)).max(30).default([]), profile: profileSchema,
}).strict();
export const renderSchema = z.object({ template_id: id, version: z.string().regex(/^[a-f0-9]{64}$/),
  approved: z.literal(true), deck: deckSchema }).strict();
