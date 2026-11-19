import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { deckSchema, profileSchema } from './schema.mjs';
import { planVisual } from './visuals.mjs';
export const MAX_FILE = 8 * 1024 * 1024;
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
const esc = value => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const parse = xml => new DOMParser({ onError: level => { if (level === 'fatalError') throw new Error('Invalid XML'); } }).parseFromString(xml, 'application/xml');
const xml = node => new XMLSerializer().serializeToString(node);
const emu = value => Math.round(value * 914400);
const rel = (id, kind, target, external = false) => `<Relationship Id="${id}" Type="${R}/${kind}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ''}/>`;
const rels = body => `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
function para(text, size = 18, color = 'tx1', font = '+mn-lt', link) {
  return `<a:p><a:pPr><a:buNone/></a:pPr><a:r><a:rPr sz="${size * 100}"><a:solidFill><a:schemeClr val="${color}"/></a:solidFill><a:latin typeface="${esc(font)}"/>${link ? `<a:hlinkClick r:id="${link}"/>` : ''}</a:rPr><a:t xml:space="preserve">${esc(text)}</a:t></a:r></a:p>`;
}
function box(id, text, x, y, w, h, size, font, color = 'tx1', link) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Evidence"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0" tIns="0" bIns="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${para(text, size, color, font, link)}</p:txBody></p:sp>`;
}
function connector(id, line) {
  return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Evidence relationship"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="${emu(line.x)}" y="${emu(line.y)}"/><a:ext cx="${emu(line.w)}" cy="${emu(line.h)}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="9525"><a:solidFill><a:schemeClr val="${line.color}"/></a:solidFill>${line.arrow ? '<a:tailEnd type="triangle"/>' : ''}</a:ln></p:spPr></p:cxnSp>`;
}
export async function inspectTemplate(bytes, profileInput) {
  if (!bytes.length || bytes.length > MAX_FILE) throw new Error('Template must be between 1 byte and 8 MiB');
  const profile = profileSchema.parse(profileInput);
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter(file => !file.dir);
  if (files.length > 1500) throw new Error('Too many template parts');
  let expanded = 0;
  for (const file of files) {
    const size = file._data.uncompressedSize;
    if (!Number.isSafeInteger(size) || size > MAX_FILE || (expanded += size) > 40 * 1024 * 1024 ||
      /vbaProject|activeX|embeddings|customUI/i.test(file.name) || /^ppt\/slides\/slide\d+\.xml$/.test(file.name)) throw new Error('Unsupported template content');
    if (/\.xml$|\.rels$/i.test(file.name)) {
      const body = await file.async('string');
      if (/<!DOCTYPE|<!ENTITY/i.test(body)) throw new Error('XML entities are unsupported');
      const document = parse(body);
      if (/\.rels$/i.test(file.name)) for (const relationship of Array.from(document.getElementsByTagName('Relationship'))) {
        if (relationship.getAttribute('TargetMode') === 'External' &&
            (!relationship.getAttribute('Type').endsWith('/hyperlink') || !/^https?:\/\//i.test(relationship.getAttribute('Target')))) throw new Error('External template content is unsupported');
      }
    }
  }
  const presentation = parse(await zip.file('ppt/presentation.xml')?.async('string'));
  const size = presentation.getElementsByTagNameNS(P, 'sldSz')[0];
  const width = Number(size?.getAttribute('cx')) / 914400;
  const height = Number(size?.getAttribute('cy')) / 914400;
  const [x, y, w, h] = profile.canvas;
  if (!(width > 0 && height > 0 && x + w <= width && y + h <= profile.footer_y && profile.footer_y + .25 < height)) throw new Error('Profile canvas must fit above the template footer');
  for (const mode of Object.values(profile.modes)) {
    if (!zip.file(`ppt/slideMasters/slideMaster${mode.master}.xml`)) throw new Error('Template master is missing');
    for (const key of ['cover', 'content', 'closing', 'open_items']) if (mode[key]) {
      const entry = zip.file(`ppt/slideLayouts/slideLayout${mode[key]}.xml`);
      if (!entry) throw new Error('Template layout is missing');
      const relationships = await zip.file(`ppt/slideLayouts/_rels/slideLayout${mode[key]}.xml.rels`)?.async('string');
      if (!relationships?.includes(`slideMaster${mode.master}.xml`)) throw new Error('Layout belongs to a different master');
    }
  }
  return { zip, profile, width, height, version: createHash('sha256').update(bytes).update(JSON.stringify(profile)).digest('hex') };
}
function fitPlaceholder(shape, body, style, text, fallbackSize) {
  const extent = shape.getElementsByTagNameNS(A, 'ext')[0];
  const bodyPr = body.getElementsByTagNameNS(A, 'bodyPr')[0];
  const width = (Number(extent?.getAttribute('cx')) - Number(bodyPr?.getAttribute('lIns') || 0) - Number(bodyPr?.getAttribute('rIns') || 0)) / 12700;
  const height = (Number(extent?.getAttribute('cy')) - Number(bodyPr?.getAttribute('tIns') || 0) - Number(bodyPr?.getAttribute('bIns') || 0)) / 12700;
  let size = Number(style?.getAttribute('sz')) / 100 || fallbackSize;
  if (!(width > 0 && height > 0)) return size; // Inherited geometry remains owned by the template.
  function lines(fontSize) {
    let count = 0;
    for (const paragraph of String(text).split('\n')) {
      let used = 0; count++;
      for (const word of paragraph.split(/\s+/u)) {
        // Conservative geometry estimate; PowerPoint retains editable, naturally wrapped text.
        const length = [...word].reduce((sum, char) => sum + (/[^\u0000-\u024f]/u.test(char) ? 1 : /[ilI.,!:;'|]/u.test(char) ? .3 : .62), 0) * fontSize;
        if (used && used + fontSize * .35 + length > width) { count++; used = 0; }
        if (length > width) { count += Math.ceil(length / width) - 1; used = length % width || width; }
        else used += (used ? fontSize * .35 : 0) + length;
      }
    }
    return count;
  }
  while (size > 12 && lines(size) * size * 1.2 > height) size -= 1;
  if (lines(size) * size * 1.2 > height) throw new Error('Template placeholder is too small; shorten its text');
  if (style) style.setAttribute('sz', String(Math.round(size * 100)));
  return size;
}
function fill(layout, values, profile, role) {
  const doc = parse(layout);
  return Array.from(doc.getElementsByTagNameNS(P, 'sp')).flatMap(shape => {
    const ph = shape.getElementsByTagNameNS(P, 'ph')[0];
    if (!ph) return []; // Layout artwork stays inherited; do not duplicate it.
    const index = ph.getAttribute('idx') || '0';
    if (values[index] === undefined) return [];
    const body = shape.getElementsByTagNameNS(P, 'txBody')[0];
    const style = shape.getElementsByTagNameNS(A, 'defRPr')[0];
    const size = fitPlaceholder(shape, body, style, values[index], index === profile.placeholders.title ? 32 : 12);
    if (style && (index === profile.placeholders.eyebrow || index === profile.placeholders.status)) {
      const scheme = style.getElementsByTagNameNS(A, 'schemeClr')[0];
      if (scheme) scheme.setAttribute('val', index === profile.placeholders.status
        ? { Draft: 'tx2', Approved: 'accent2', 'Needs decision': 'accent4' }[values[index]] || 'tx2'
        : { context: 'accent1', actionable: 'accent2', exploration: 'accent3' }[role]);
    }
    for (const paragraph of Array.from(body.getElementsByTagNameNS(A, 'p'))) body.removeChild(paragraph);
    const color = index === profile.placeholders.eyebrow ? { context: 'accent1', actionable: 'accent2', exploration: 'accent3' }[role] : 'tx1';
    const content = style ? `<a:p><a:r>${xml(style).replace(/a:defRPr/g, 'a:rPr')}<a:t>${esc(values[index])}</a:t></a:r></a:p>` : para(values[index], size, color, profile.font);
    const fragment = parse(`<root xmlns:a="${A}" xmlns:r="${R}">${content}</root>`);
    body.appendChild(doc.importNode(fragment.documentElement.firstChild, true));
    return [xml(shape)];
  }).join('');
}
export function planDeck(deckInput, profileInput) {
  const deck = deckSchema.parse(deckInput);
  const profile = profileSchema.parse(profileInput);
  const mode = profile.modes[deck.mode];
  if (!mode) throw new Error('Choose a mode supported by the template');
  const cap = { spacious: 35, balanced: 60, dense: 130 }[deck.density];
  const size = deck.density === 'dense' ? 16 : 18;
  const pages = [];
  for (const slide of deck.slides) {
    if (slide.visual && slide.kind !== 'content') throw new Error('Only content slides accept visuals');
    if (slide.visual && slide.bullets.length) throw new Error('Put visual evidence in groups and notes, without duplicate bullets');
    if (slide.kind === 'open_items' && !mode.open_items) throw new Error('Template has no open-items layout');
    if (slide.kind === 'open_items' && slide.items.length > (profile.placeholders.items?.length || 0)) throw new Error('Split open items to fit the template rows');
    if (slide.kind !== 'content') { if (slide.bullets.length) throw new Error('Only content slides accept bullets'); pages.push({ slide, rows: [] }); continue; }
    if (slide.visual) {
      pages.push({ slide, rows: [], visual: planVisual(slide.visual, profile, deck.density, slide.role) });
      continue;
    }
    const rows = slide.bullets.flatMap(bullet => {
      const tokens = bullet.text.match(/\S+\s*/gu) ?? [];
      const parts = []; let current = '';
      const lineChars = Math.max(10, Math.floor(profile.canvas[2] * 72 / size * 1.4));
      const maxChars = Math.max(10, Math.floor((profile.canvas[3] - .28) / (size / 72 * 1.5)) * lineChars);
      for (const word of tokens) {
        if (current && (current.length + word.length > maxChars || current.trim().split(/\s+/u).length >= cap)) { parts.push(current.trim()); current = ''; }
        // Very long tokens must also fit and retain their full wording in notes.
        for (let at = 0; at < word.length; at += maxChars) {
          if (at || word.length > maxChars) { if (current) parts.push(current.trim()); current = word.slice(at, at + maxChars); }
          else current += word;
        }
      }
      if (current.trim()) parts.push(current.trim());
      return parts.map(text => ({ ...bullet, text, verify: bullet.verify || !bullet.sources.length }));
    });
    let current = [], words = 0, used = 0;
    for (const row of rows) {
      const count = row.text.split(/\s+/u).length;
      const lines = Math.ceil(row.text.length / Math.max(10, Math.floor(profile.canvas[2] * 72 / size * 1.4)));
      const h = lines * size / 72 * 1.5 + .28;
      if (h > profile.canvas[3]) throw new Error('Template canvas is too small for the chosen density');
      if (current.length && (words + count > cap || used + h > profile.canvas[3] || current.length >= (deck.density === 'dense' ? 7 : deck.density === 'spacious' ? 3 : 4))) {
        pages.push({ slide, rows: current }); current = []; words = 0; used = 0;
      }
      current.push({ ...row, h }); words += count; used += h;
    }
    pages.push({ slide, rows: current });
  }
  for (const page of pages) {
    const parts = pages.filter(candidate => candidate.slide === page.slide);
    page.displayTitle = parts.length > 1 ? `${page.slide.title} (${parts.indexOf(page) + 1}/${parts.length})` : page.slide.title;
  }
  if (pages.length > 160) throw new Error('Deck splits into too many slides; shorten the content');
  return { deck, profile, mode, pages, size, slide_count: pages.length, warnings: [
    'Fonts are not embedded. Install the template fonts when presenting.',
    'Visual QA and live source verification have not run. Review the generated slides.',
    ...(pages.length !== deck.slides.length ? [`Density rules split ${deck.slides.length} input slides into ${pages.length} output slides.`] : []),
  ] };
}
export async function renderDeck(bytes, profileInput, deckInput) {
  const template = await inspectTemplate(bytes, profileInput);
  const plan = planDeck(deckInput, template.profile);
  const { zip } = template;
  const slideIds = [], relationships = [], overrides = [];
  const master = parse(await zip.file(`ppt/slideMasters/slideMaster${plan.mode.master}.xml`).async('string'));
  const colorMap = master.getElementsByTagNameNS(P, 'clrMap')[0];
  const masterRels = parse(await zip.file(`ppt/slideMasters/_rels/slideMaster${plan.mode.master}.xml.rels`)?.async('string'));
  const theme = Array.from(masterRels.getElementsByTagName('Relationship')).find(node => node.getAttribute('Type') === `${R}/theme`);
  if (!colorMap || !theme) throw new Error('Template master must include a color map and theme');
  const themeTarget = theme.getAttribute('Target');
  const themePath = themeTarget.startsWith('/') ? themeTarget.slice(1) : posix.normalize(`ppt/slideMasters/${themeTarget}`);
  const themeBytes = await zip.file(themePath)?.async('nodebuffer');
  if (!themeBytes) throw new Error('Template master theme is missing');
  let themeNumber = 1;
  while (zip.file(`ppt/theme/notesTheme${themeNumber}.xml`)) themeNumber++;
  const notesThemePath = `ppt/theme/notesTheme${themeNumber}.xml`;
  // A dedicated notes theme avoids PowerPoint repair caused by sharing the
  // slide master's Theme part, even when that shared graph passes schema checks.
  zip.file(notesThemePath, themeBytes);
  overrides.push(`<Override PartName="/${notesThemePath}" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`);
  zip.file('ppt/notesMasters/notesMaster1.xml', `${HEAD}<p:notesMaster xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>${GROUP}</p:spTree></p:cSld>${xml(colorMap)}<p:notesStyle/></p:notesMaster>`);
  zip.file('ppt/notesMasters/_rels/notesMaster1.xml.rels', rels(rel('rId1', 'theme', `../theme/notesTheme${themeNumber}.xml`)));
  overrides.push('<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>');
  for (const [index, page] of plan.pages.entries()) {
    const { slide, rows } = page; const n = index + 1;
    const placeholders = plan.profile.placeholders;
    const sources = [...new Set([...slide.bullets.flatMap(row => row.sources), ...(slide.visual?.groups.flatMap(group => group.sources) || [])])];
    const values = Object.assign(Object.create(null), { [placeholders.title]: page.displayTitle, [placeholders.subtitle]: slide.subtitle });
    if (placeholders.status && !['cover', 'closing'].includes(slide.kind)) values[placeholders.status] = { draft: 'Draft', approved: 'Approved', 'needs decision': 'Needs decision' }[slide.status];
    if (placeholders.eyebrow) values[placeholders.eyebrow] = slide.role.toUpperCase();
    for (const [i, item] of slide.items.entries()) {
      values[placeholders.items[i]] = item.text;
      if (placeholders.owners?.[i]) values[placeholders.owners[i]] = item.owner;
      if (placeholders.due?.[i]) values[placeholders.due[i]] = item.due;
    }
    let extra = '', y = plan.profile.canvas[1];
    for (const [i, row] of rows.entries()) {
      const [x, , w] = plan.profile.canvas;
      extra += box(200 + i, row.text, x, y, w, row.h, plan.size, plan.profile.font);
      y += row.h;
    }
    if (page.visual) {
      extra += page.visual.lines.map((line, i) => connector(1000 + i, line)).join('');
      extra += page.visual.boxes.map((shape, i) => box(1200 + i, shape.text, shape.x, shape.y, shape.w, shape.h, shape.size, plan.profile.font, shape.color || 'tx2')).join('');
    }
    for (const [i, source] of sources.slice(0, 1).entries()) extra += box(400 + i, `[${i + 1}] Source`, plan.profile.canvas[0], plan.profile.footer_y, plan.profile.canvas[2], .22, 11, plan.profile.font, 'tx2', `source${i}`);
    const layoutNumber = plan.mode[slide.kind === 'open_items' ? 'open_items' : slide.kind];
    const shapes = fill(await zip.file(`ppt/slideLayouts/slideLayout${layoutNumber}.xml`).async('string'), values, plan.profile, slide.role);
    zip.file(`ppt/slides/slide${n}.xml`, `${HEAD}<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>${GROUP}${shapes}${extra}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, rels(rel('layout', 'slideLayout', `../slideLayouts/slideLayout${layoutNumber}.xml`) + rel('notes', 'notesSlide', `../notesSlides/notesSlide${n}.xml`) + sources.slice(0, 1).map((source, i) => rel(`source${i}`, 'hyperlink', source, true)).join('')));
    const notes = [slide.title, slide.subtitle, slide.notes, ...slide.bullets.map(row => `${row.verify || !row.sources.length ? 'Verify: ' : ''}${row.text}`), ...slide.items.map(item => `${item.text} | ${item.owner} | ${item.due}`), ...(slide.visual?.groups.map(group => `${group.verify || !group.sources.length ? 'Verify: ' : ''}${group.label}: ${[group.value, ...group.items].filter(Boolean).join('; ')}`) || []), ...sources, ...plan.warnings].join('\n');
    zip.file(`ppt/notesSlides/notesSlide${n}.xml`, `${HEAD}<p:notes xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>${GROUP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${notes.split('\n').map(line => para(line, 12)).join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`);
    zip.file(`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, rels(rel('rId1', 'notesMaster', '../notesMasters/notesMaster1.xml') + rel('rId2', 'slide', `../slides/slide${n}.xml`)));
    slideIds.push(`<p:sldId id="${256 + index}" r:id="presentationSlide${n}"/>`);
    relationships.push(rel(`presentationSlide${n}`, 'slide', `slides/slide${n}.xml`));
    overrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`);
  }
  const doc = parse(await zip.file('ppt/presentation.xml').async('string'));
  for (const tag of ['sldIdLst', 'notesMasterIdLst']) for (const element of Array.from(doc.getElementsByTagNameNS(P, tag))) element.parentNode.removeChild(element);
  const masters = doc.getElementsByTagNameNS(P, 'sldMasterIdLst')[0];
  const pr = parse(await zip.file('ppt/_rels/presentation.xml.rels').async('string'));
  const masterRelation = Array.from(pr.documentElement.childNodes).find(node => node.getAttribute?.('Target') === `slideMasters/slideMaster${plan.mode.master}.xml`);
  if (!masterRelation) throw new Error('Master relationship is missing');
  for (const node of Array.from(masters.childNodes)) if (node.nodeType === 1 && node.getAttribute('r:id') !== masterRelation.getAttribute('Id')) masters.removeChild(node);
  const fragment = parse(`<root xmlns:p="${P}" xmlns:r="${R}"><p:notesMasterIdLst><p:notesMasterId r:id="presentationNotes"/></p:notesMasterIdLst><p:sldIdLst>${slideIds.join('')}</p:sldIdLst></root>`);
  for (const node of Array.from(fragment.documentElement.childNodes)) doc.documentElement.insertBefore(doc.importNode(node, true), doc.getElementsByTagNameNS(P, 'sldSz')[0]);
  zip.file('ppt/presentation.xml', xml(doc));
  zip.file('ppt/_rels/presentation.xml.rels', (await zip.file('ppt/_rels/presentation.xml.rels').async('string')).replace('</Relationships>', `${relationships.join('')}${rel('presentationNotes', 'notesMaster', 'notesMasters/notesMaster1.xml')}</Relationships>`));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml').async('string')).replace('</Types>', `${overrides.join('')}</Types>`));
  zip.file('docProps/core.xml', `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(plan.deck.title)}</dc:title></cp:coreProperties>`);
  if (zip.file('docProps/app.xml')) zip.file('docProps/app.xml', (await zip.file('docProps/app.xml').async('string')).replace(/<Slides>.*?<\/Slides>/, `<Slides>${plan.slide_count}</Slides>`));
  const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  if (output.length > 12 * 1024 * 1024) throw new Error('Output exceeds 12 MiB; split the deck');
  return { bytes: output, version: template.version, slide_count: plan.slide_count, warnings: plan.warnings };
}
