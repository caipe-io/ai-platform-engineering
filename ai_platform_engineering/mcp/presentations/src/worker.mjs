import { parentPort, workerData } from 'node:worker_threads';
import { inspectTemplate, renderDeck } from './renderer.mjs';
try {
  if (workerData.operation === 'inspect') {
    const { version, profile } = await inspectTemplate(workerData.bytes, workerData.profile);
    parentPort.postMessage({ version, profile });
  } else parentPort.postMessage(await renderDeck(workerData.bytes, workerData.profile, workerData.deck));
} catch (error) { parentPort.postMessage({ error: error.message }); }
