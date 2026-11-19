import { Worker } from 'node:worker_threads';
import { HttpError } from './auth.mjs';
let active = 0;
export function runRenderWorker(operation, bytes, profile, deck) {
  if (active >= 2) throw new HttpError(429, 'Rendering is busy; retry shortly');
  active++;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { operation, bytes, profile, deck },
      resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 8 },
    });
    const timer = setTimeout(() => { void worker.terminate(); reject(new HttpError(422, 'Rendering exceeded its time limit; shorten the deck')); }, 30_000);
    let answered = false;
    worker.once('message', result => {
      answered = true;
      if (result.error) reject(new HttpError(422, 'Template or deck cannot be rendered. Check the preset and content.'));
      else resolve(result);
    });
    worker.once('error', () => reject(new HttpError(422, 'Render worker failed; shorten the deck or check the template')));
    worker.once('exit', () => {
      active--; clearTimeout(timer);
      if (!answered) reject(new HttpError(422, 'Render worker ended before completion'));
    });
  });
}
