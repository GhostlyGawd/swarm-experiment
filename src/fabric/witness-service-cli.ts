/** Launch an operator-owned witness service in a separate Node process.
 * `node --experimental-strip-types src/fabric/witness-service-cli.ts --config /private/config.json`
 * Config names a 0600 key file; the key itself is never in argv or env. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCanonical, encodeCanonical, exactObject } from './encoding.ts';
import { startWitnessService, type WitnessNamespace } from './witness-service.ts';

export async function runWitnessServiceCli(args: readonly string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== '--config' || !path.isAbsolute(args[1]))
    throw new TypeError('usage: witness-service-cli --config /absolute/private/config.json');
  const bytes = fs.readFileSync(args[1]);
  const config = exactObject(decodeCanonical(bytes), ['socketPath', 'storageDir', 'keyFile', 'namespaces']);
  if (!Buffer.from(encodeCanonical(config)).equals(bytes)) throw new TypeError('noncanonical witness configuration');
  if (typeof config.keyFile !== 'string' || !path.isAbsolute(config.keyFile) || !Array.isArray(config.namespaces))
    throw new TypeError('invalid witness configuration');
  const keyStat = fs.lstatSync(config.keyFile);
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || (keyStat.mode & 0o077) || keyStat.uid !== process.getuid?.())
    throw new Error('witness key file must be private and owned by the service user');
  const key = fs.readFileSync(config.keyFile);
  await startWitnessService({ socketPath: config.socketPath as string, storageDir: config.storageDir as string,
    key, namespaces: config.namespaces as WitnessNamespace[] });
  process.stdout.write('witness service ready\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWitnessServiceCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`witness service startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
