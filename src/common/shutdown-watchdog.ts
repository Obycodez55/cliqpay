import { Worker } from 'node:worker_threads';

const WATCHDOG_MARGIN_MS = 500;

const WATCHDOG_SOURCE = `
const { workerData } = require('node:worker_threads');
setTimeout(() => process.kill(process.pid, 'SIGKILL'), workerData);
`;

// The main-thread force-exit timer cannot fire while a microtask spin starves
// the event loop; the worker has its own loop, so it can. The margin keeps it
// behind the main-thread timer in the case where the loop is still yielding.
export function armShutdownWatchdog(graceMs: number): () => void {
  const worker = new Worker(WATCHDOG_SOURCE, {
    eval: true,
    workerData: graceMs + WATCHDOG_MARGIN_MS,
  });
  worker.unref();
  return () => {
    void worker.terminate();
  };
}
