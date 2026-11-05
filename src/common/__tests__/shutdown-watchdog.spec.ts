import { spawn } from 'node:child_process';
import { join } from 'node:path';

const GRACE_MS = 300;
const MARGIN_MS = 3_000;
const CHILD_TIMEOUT_MS = 10_000;

const HELPER = JSON.stringify(join(__dirname, '..', 'shutdown-watchdog'));

const CHILD_PRELUDE = `
require('ts-node/register/transpile-only');
const { armShutdownWatchdog } = require(${HELPER});
const t0 = Date.now();
process.on('exit', (code) => console.log('exit ' + code));
const cancel = armShutdownWatchdog(${GRACE_MS});
`;

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  elapsedMs: number;
}

function runChild(body: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['-e', CHILD_PRELUDE + body], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const hardStop = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('child still running after hard timeout'));
    }, CHILD_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(hardStop);
      resolve({ code, signal, stdout, elapsedMs: Date.now() - started });
    });
  });
}

describe('armShutdownWatchdog', () => {
  it('kills a process whose main thread is starved by a microtask spin', async () => {
    const result = await runChild(`
      setTimeout(() => { console.log('timer fired'); process.exit(1); }, ${GRACE_MS}).unref();
      (async () => { for (;;) await Promise.resolve(); })();
    `);

    expect(result.signal).toBe('SIGKILL');
    expect(result.stdout).not.toContain('timer fired');
    expect(result.elapsedMs).toBeLessThan(GRACE_MS + MARGIN_MS);
  }, 15_000);

  it('leaves the main-thread timer to win when the loop still yields', async () => {
    const result = await runChild(`
      setTimeout(() => { console.log('timer fired'); process.exit(1); }, ${GRACE_MS}).unref();
      setInterval(() => {}, 1000);
    `);

    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('timer fired');
  }, 15_000);

  it('does not fire once cancelled, even after the grace period passes', async () => {
    const result = await runChild(`
      setInterval(() => {}, 1000);
      setTimeout(() => { cancel(); }, 50);
      setTimeout(() => process.exit(0), ${GRACE_MS + 900});
    `);

    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
  }, 15_000);

  it('does not delay a clean exit while armed', async () => {
    const result = await runChild(`
      setTimeout(() => {}, 50);
    `);

    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.elapsedMs).toBeLessThan(GRACE_MS + MARGIN_MS);
  }, 15_000);
});
