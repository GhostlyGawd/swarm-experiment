/** One framed controller exchange from inside the candidate container. */
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

const [socketPath, mode] = process.argv.slice(2);
if (!socketPath?.startsWith('/run/aether/') || !['json', 'raw', 'peer-probe'].includes(mode)) throw new Error('client socket/mode');
if (mode === 'peer-probe') {
  await new Promise<void>((resolve, reject) => {
    const start = performance.now(); const socket = connect(socketPath); let connected = false, done = false;
    const timer = setTimeout(() => finish(null), 700);
    function finish(closedWithinMs: number | null, error?: Error): void {
      if (done) return; done = true; clearTimeout(timer); socket.destroy();
      if (error || !connected) reject(error ?? new Error('peer probe did not connect'));
      else { process.stdout.write(JSON.stringify({ connected, closedWithinMs }) + '\n'); resolve(); }
    }
    socket.once('connect', () => { connected = true; });
    socket.once('close', () => finish(performance.now() - start));
    socket.once('error', error => finish(null, error));
  });
  process.exit(0);
}
const input = readFileSync(0);
await new Promise<void>((resolve, reject) => {
  const socket = connect(socketPath); const chunks: Buffer[] = []; let done = false;
  const timer = setTimeout(() => finish(new Error('custody client timeout')), 20_000);
  function finish(error?: Error, result?: unknown): void {
    if (done) return; done = true; clearTimeout(timer); socket.destroy();
    if (error) reject(error); else { process.stdout.write(JSON.stringify(result) + '\n'); resolve(); }
  }
  socket.once('connect', () => {
    if (mode === 'json') socket.write(Buffer.from(input.toString() + '\n'));
    else socket.end(input);
  });
  socket.on('data', chunk => {
    chunks.push(chunk);
    if (mode !== 'json') return;
    const output = Buffer.concat(chunks).toString(), newline = output.indexOf('\n');
    if (newline < 0) return;
    try { const row = JSON.parse(output.slice(0, newline));
      if (row.error) finish(new Error(row.error)); else finish(undefined, row.result); }
    catch (error) { finish(error as Error); }
  });
  socket.once('error', error => finish(error));
  socket.once('close', () => {
    if (mode === 'json') { finish(new Error('custody candidate closed without result')); return; }
    const output = Buffer.concat(chunks);
    finish(undefined, { responseBytes: output.length });
  });
});
