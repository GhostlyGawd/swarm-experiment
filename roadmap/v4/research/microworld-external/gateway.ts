/** Real Unix-socket transport boundary; drop a post-decision response once. */
import { existsSync, lstatSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, resolve } from 'node:path';

const [listenPath, targetPath, mode] = process.argv.slice(2);
if (!listenPath || !targetPath || !['forward', 'drop-first-response'].includes(mode))
  throw new Error('gateway arguments: LISTEN TARGET forward|drop-first-response');
for (const path of [listenPath, targetPath]) if (!path.startsWith('/') || !lstatSync(dirname(path)).isDirectory())
  throw new Error('gateway socket parent');
if (resolve(listenPath) === resolve(targetPath) || existsSync(listenPath)) throw new Error('gateway socket collision');
let dropping = mode === 'drop-first-response';
const server = createServer({ allowHalfOpen: true }, client => {
  const target = createConnection(targetPath);
  target.once('connect', () => client.pipe(target));
  if (!dropping) target.pipe(client);
  else {
    dropping = false; let finished = false;
    const finish = (): void => {
      if (finished) return; finished = true;
      // The sink sends response bytes only after its witnessed decision. The
      // campaign independently checks that decision before calling this a hit.
      client.destroy(); target.destroy();
      try { unlinkSync(listenPath); } catch {}
      process.exit(0);
    };
    target.once('data', finish);
    target.once('close', finish);
  }
  client.once('error', () => target.destroy());
  target.once('error', () => client.destroy());
  client.once('close', () => target.destroy());
  target.once('close', () => client.destroy());
});
server.listen(listenPath, () => process.stdout.write('gateway ready\n'));
process.once('SIGTERM', () => { try { unlinkSync(listenPath); } catch {} process.exit(0); });
