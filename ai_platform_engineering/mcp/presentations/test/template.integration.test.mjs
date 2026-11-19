import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { inspectTemplate, renderDeck } from '../src/renderer.mjs';
const enabled = Boolean(process.env.PRESENTATION_TEST_TEMPLATE && process.env.PRESENTATION_TEST_PROFILE);
test('operator-supplied private template preserves each master, notes, editable text and source links', { skip: !enabled }, async () => {
  const bytes = await readFile(process.env.PRESENTATION_TEST_TEMPLATE);
  const [{ profile }] = JSON.parse(await readFile(process.env.PRESENTATION_TEST_PROFILE, 'utf8'));
  const original = await inspectTemplate(bytes, profile);
  for (const mode of Object.keys(profile.modes)) {
    const result = await renderDeck(bytes, profile, { title: 'An evidence-based briefing', subtitle: 'Integration fixture', mode, slides: [
      { kind: 'cover', title: 'An evidence-based briefing', subtitle: 'A private template fixture' },
      { title: 'A release reached its milestone', bullets: [{ text: 'The fixture records a release milestone.', sources: ['https://example.test/evidence'] }], notes: 'Full source context stays in notes.' },
      { title: 'Validation is still open', status: 'needs decision', bullets: [{ text: 'Confirm the latest validation status before presenting.', sources: [], verify: true }] },
      { kind: 'open_items', title: 'All open items', role: 'actionable', items: [{ text: 'Verify the validation status' }] },
      { kind: 'closing', title: 'Next step', subtitle: 'Verify the validation status' },
    ] });
    assert.equal(result.slide_count, 5);
    const rendered = await JSZip.loadAsync(result.bytes);
    const part = `ppt/slideMasters/slideMaster${profile.modes[mode].master}.xml`;
    assert.equal(await rendered.file(part).async('string'), await original.zip.file(part).async('string'));
    assert.doesNotMatch(await rendered.file('ppt/slides/slide3.xml').async('string'), /Verify/);
    assert.match(await rendered.file('ppt/notesSlides/notesSlide3.xml').async('string'), /Verify: Confirm/);
    assert.match(await rendered.file('ppt/notesSlides/notesSlide2.xml').async('string'), /Full source context/);
    assert.match(await rendered.file('ppt/slides/_rels/slide2.xml.rels').async('string'), /https:\/\/example.test\/evidence/);
    if (process.env.PRESENTATION_TEST_OUTPUT_DIR) await writeFile(`${process.env.PRESENTATION_TEST_OUTPUT_DIR}/presentation-${mode}.pptx`, result.bytes);
  }
});
