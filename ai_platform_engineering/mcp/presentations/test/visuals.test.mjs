import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { planDeck, renderDeck } from '../src/renderer.mjs';
import { deck, visualDeck, profile, template } from './fixture.mjs';

test('structured evidence preserves groups, sources, notes and native editable relationships', async () => {
  const plan = planDeck(visualDeck, profile);
  assert.equal(plan.slide_count, 8);
  assert.deepEqual(plan.pages.slice(1, -1).map(page => page.visual.layout), ['metrics', 'comparison', 'flow', 'timeline', 'layers', 'ledger']);
  const bytes = await (await template()).generateAsync({ type: 'nodebuffer' });
  const zip = await JSZip.loadAsync((await renderDeck(bytes, profile, visualDeck)).bytes);
  const parse = value => new DOMParser().parseFromString(value, 'application/xml');
  for (let n = 2; n <= 7; n++) {
    const document = parse(await zip.file(`ppt/slides/slide${n}.xml`).async('string'));
    assert.ok(document.getElementsByTagNameNS('http://schemas.openxmlformats.org/presentationml/2006/main', 'cxnSp').length > 0);
    assert.equal(document.getElementsByTagNameNS('http://schemas.openxmlformats.org/presentationml/2006/main', 'pic').length, 0);
    const text = [...document.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 't')].map(node => node.textContent).join(' ');
    assert.match(text, /Primary|First/);
    assert.match(text, /Example evidence/);
    assert.match(await zip.file(`ppt/notesSlides/notesSlide${n}.xml`).async('string'), /Synthetic fixture values/);
    assert.match(await zip.file(`ppt/slides/_rels/slide${n}.xml.rels`).async('string'), /https:\/\/example.test\/evidence/);
  }
  assert.match(await zip.file('ppt/slides/slide2.xml').async('string'), /sz="7200"/);
  assert.match(await zip.file('ppt/slides/slide4.xml').async('string'), /tailEnd type="triangle"/);
  assert.equal(Object.keys(zip.files).filter(name => name.startsWith('ppt/media/')).length, 0);
});

test('visuals fail closed on unsupported inputs, excess density, missing values and overflowing labels', () => {
  const slide = visualDeck.slides[1];
  const input = visual => ({ ...deck, slides: [{ ...slide, visual }] });
  assert.throws(() => planDeck({ ...deck, slides: [{ ...slide, kind: 'cover' }] }, profile), /Only content/);
  assert.throws(() => planDeck({ ...deck, slides: [{ ...slide, bullets: [{ text: 'Duplicate' }] }] }, profile), /duplicate bullets/);
  assert.throws(() => planDeck(input({ ...slide.visual, groups: slide.visual.groups.map(({ value, ...group }) => group) }), profile), /explicit sourced values/);
  assert.throws(() => planDeck(input({ ...slide.visual, groups: slide.visual.groups.map(group => ({ ...group, items: ['Example '.repeat(25)] })) }), profile), /density/);
  assert.throws(() => planDeck(input({ ...slide.visual, groups: slide.visual.groups.map(group => ({ ...group, value: '012345678901234567890123' })) }), profile), /does not fit/);
  assert.throws(() => planDeck(input({ ...slide.visual, groups: slide.visual.groups.map(group => ({ ...group, sources: ['file:///private/example'] })) }), profile));
  assert.throws(() => planDeck(input({ ...slide.visual, image_url: 'https://example.test/remote' }), profile));
});

test('review flags stay in notes without visible badges for every visual layout', async () => {
  const input = { ...deck, slides: [{ title: 'Example review', visual: { layout: 'comparison', groups: [
    { label: '<First>', items: ['Unconfirmed & editable'], sources: [] },
    { label: 'Second', items: ['Source exists; review required'], sources: ['https://example.test/evidence'], verify: true },
  ] } }] };
  for (const layout of ['metrics', 'comparison', 'flow', 'timeline', 'layers', 'ledger']) {
    for (const style of [undefined, { fill: 'accent6', text: 'dk1' }]) {
      const visual = { ...input.slides[0].visual, layout, groups: input.slides[0].visual.groups.map(group => ({ ...group, value: '12' })) };
      const result = await renderDeck(await (await template()).generateAsync({ type: 'nodebuffer' }), { ...profile, verify_style: style }, { ...input, slides: [{ ...input.slides[0], visual }] });
      const zip = await JSZip.loadAsync(result.bytes);
      const slide = await zip.file('ppt/slides/slide1.xml').async('string');
      assert.match(slide, /&lt;First&gt;/);
      assert.doesNotMatch(slide, /Verify/);
      const notes = await zip.file('ppt/notesSlides/notesSlide1.xml').async('string');
      assert.match(notes, /Verify: &lt;First&gt;/);
      assert.match(notes, /Verify: Second/);
      assert.match(notes, /https:\/\/example.test\/evidence/);
    }
  }
});
