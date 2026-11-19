import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { inspectTemplate, planDeck, renderDeck, MAX_FILE } from '../src/renderer.mjs';
import { deck, profile, template } from './fixture.mjs';
test('renders editable content, full notes, source URLs and inherited masters without extra slides', async () => {
  const input = await (await template()).generateAsync({ type: 'nodebuffer' });
  const result = await renderDeck(input, profile, deck);
  assert.equal(result.slide_count, 3);
  const zip = await JSZip.loadAsync(result.bytes);
  assert.match(await zip.file('ppt/slides/slide2.xml').async('string'), /fixture marker/);
  assert.doesNotMatch(await zip.file('ppt/slides/slide2.xml').async('string'), /Click to edit/);
  assert.match(await zip.file('ppt/notesSlides/notesSlide2.xml').async('string'), /source-backed fixture/);
  assert.match(await zip.file('ppt/slides/_rels/slide2.xml.rels').async('string'), /https:\/\/example.test\/evidence/);
  assert.equal(await zip.file('ppt/slideMasters/slideMaster1.xml').async('string'), await (await JSZip.loadAsync(input)).file('ppt/slideMasters/slideMaster1.xml').async('string'));
});
test('plans density splits before approval and preserves all words in notes', async () => {
  const long = { ...deck, slides: [{ title: 'Detailed evidence', bullets: [{ text: 'A word '.repeat(250), sources: [] }] }] };
  assert.ok(planDeck(long, profile).slide_count > 1);
  const result = await renderDeck(await (await template()).generateAsync({ type: 'nodebuffer' }), profile, long);
  const zip = await JSZip.loadAsync(result.bytes);
  assert.doesNotMatch(await zip.file('ppt/slides/slide1.xml').async('string'), /Verify/);
  assert.match(await zip.file('ppt/notesSlides/notesSlide1.xml').async('string'), /Verify: A word/);
  assert.match(await zip.file('ppt/notesSlides/notesSlide1.xml').async('string'), /A word A word/);
});
test('notes inherit their master color map through a dedicated theme part', async () => {
  const input = await template();
  const masterPath = 'ppt/slideMasters/slideMaster1.xml';
  input.file(masterPath, (await input.file(masterPath).async('string')).replace('bg1="lt1" tx1="dk1"', 'bg1="dk1" tx1="lt1"'));
  const result = await renderDeck(await input.generateAsync({ type: 'nodebuffer' }), profile, deck);
  const zip = await JSZip.loadAsync(result.bytes);
  const parse = text => new DOMParser().parseFromString(text, 'application/xml');
  const master = parse(await zip.file('ppt/notesMasters/notesMaster1.xml').async('string'));
  const map = master.getElementsByTagNameNS('http://schemas.openxmlformats.org/presentationml/2006/main', 'clrMap')[0];
  assert.equal(map.getAttribute('bg1'), 'dk1');
  assert.equal(map.getAttribute('tx1'), 'lt1');
  const noteMasterRels = parse(await zip.file('ppt/notesMasters/_rels/notesMaster1.xml.rels').async('string'));
  const notesTheme = [...noteMasterRels.getElementsByTagName('Relationship')].find(entry => entry.getAttribute('Type').endsWith('/theme')).getAttribute('Target');
  assert.notEqual(notesTheme, '../theme/theme1.xml');
  assert.equal(await zip.file(`ppt/${notesTheme.slice(3)}`).async('string'), await input.file('ppt/theme/theme1.xml').async('string'));
  for (let i = 1; i <= 3; i++) {
    const relationships = parse(await zip.file(`ppt/notesSlides/_rels/notesSlide${i}.xml.rels`).async('string'));
    const entries = [...relationships.getElementsByTagName('Relationship')];
    assert.deepEqual(entries.map(entry => [entry.getAttribute('Type').split('/').pop(), entry.getAttribute('Target')]).sort(), [
      ['notesMaster', '../notesMasters/notesMaster1.xml'], ['slide', `../slides/slide${i}.xml`],
    ]);
  }
});
test('keeps full long titles and naturally wraps a fitting paragraph without arbitrary character splits', async () => {
  const title = 'A longer briefing title that preserves every approved word through the final milestone';
  const paragraph = 'The release includes an execution engine, isolated sessions, delegated agents, a unified catalog, saved model connections, guided setup, and access-revocation fixes for enterprise operators.';
  const input = { ...deck, slides: [{ kind: 'cover', title }, { title: 'Release summary', bullets: [{ text: paragraph, sources: ['https://example.test/evidence'] }] }] };
  assert.equal(planDeck(input, profile).pages[1].rows.length, 1);
  const result = await renderDeck(await (await template()).generateAsync({ type: 'nodebuffer' }), profile, input);
  const zip = await JSZip.loadAsync(result.bytes);
  assert.ok((await zip.file('ppt/slides/slide1.xml').async('string')).includes(title));
  assert.ok((await zip.file('ppt/slides/slide2.xml').async('string')).includes(paragraph));
});
test('escapes XML, rejects unsupported source schemes and profile keys', async () => {
  const bytes = await (await template()).generateAsync({ type: 'nodebuffer' });
  const result = await renderDeck(bytes, profile, { ...deck, title: '<tag>', slides: [{ title: '<tag>', bullets: [{ text: '& <test>', sources: [] }] }] });
  const zip = await JSZip.loadAsync(result.bytes);
  assert.match(await zip.file('ppt/slides/slide1.xml').async('string'), /&amp; &lt;test&gt;/);
  assert.throws(() => planDeck({ ...deck, slides: [{ title: 'Example', bullets: [{ text: 'Bad link', sources: ['file:///private/example'] }] }] }, profile));
  assert.throws(() => planDeck(deck, { ...profile, placeholders: { ...profile.placeholders, title: '__proto__' } }));
});
test('rejects macro/sample/embedded/external content, entities, excessive expansion and invalid layout mapping', async () => {
  for (const name of ['ppt/vbaProject.bin', 'ppt/slides/slide1.xml', 'ppt/embeddings/file.bin']) {
    const zip = await template(); zip.file(name, 'content');
    await assert.rejects(inspectTemplate(await zip.generateAsync({ type: 'nodebuffer' }), profile), /Unsupported/);
  }
  const zip = await template(); zip.file('evil.xml', '<!DOCTYPE x [<!ENTITY x "y">]><root/>');
  await assert.rejects(inspectTemplate(await zip.generateAsync({ type: 'nodebuffer' }), profile), /entities/);
  zip.remove('evil.xml'); zip.file('large.txt', 'x'.repeat(MAX_FILE + 1));
  await assert.rejects(inspectTemplate(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), profile), /Unsupported/);
  await assert.rejects(inspectTemplate(await (await template()).generateAsync({ type: 'nodebuffer' }), { ...profile, canvas: [0, 0, 100, 100] }), /canvas/);
});
