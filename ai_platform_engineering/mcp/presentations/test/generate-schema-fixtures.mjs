import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { template, profile, deck, visualDeck } from './fixture.mjs';
import { renderDeck } from '../src/renderer.mjs';

const directory = process.argv[2];
if (!directory) throw new Error('Choose an output directory');
await mkdir(directory, { recursive: true });
const bytes = await (await template()).generateAsync({ type: 'nodebuffer' });
await writeFile(join(directory, 'template.pptx'), bytes);
const input = { ...deck, slides: [
  { kind: 'cover', title: 'An approved briefing retains its full framing statement through the final milestone' },
  { title: 'Evidence and review', bullets: [
    { text: 'A sourced fixture marker', sources: ['https://example.test/evidence'] },
    { text: 'Verify the pending fixture result', sources: [], verify: true },
  ], notes: 'Review this synthetic fixture before distribution.' },
  { kind: 'open_items', title: 'Open items', items: [{ text: 'Review the result', owner: 'Example owner', due: 'To assign' }] },
  { kind: 'closing', title: 'Next step', subtitle: 'Review and verify' },
] };
for (const density of ['spacious', 'balanced', 'dense']) {
  const result = await renderDeck(bytes, { ...profile, verify_style: { fill: 'accent6', text: 'dk1' } }, { ...input, density });
  await writeFile(join(directory, `generated-${density}.pptx`), result.bytes);
}

await writeFile(join(directory, 'generated-visuals.pptx'), (await renderDeck(bytes, profile, visualDeck)).bytes);
