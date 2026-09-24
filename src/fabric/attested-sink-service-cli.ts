/** Operator-run bounded sink fixture.
 * node --experimental-strip-types src/fabric/attested-sink-service-cli.ts --config /private/sink.json
 * The private signing key and transport secret are read from private files,
 * never supplied as argument or environment values. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeCanonical, encodeCanonical, exactObject } from './encoding.ts';
import { validateSinkAdapterArtifactDigest, validateSinkPublicAnchor, type SinkPublicAnchorV1 } from './sink-receipt.ts';
import { startAttestedSinkService } from './attested-sink-service.ts';
import { createProcessWitnessClient } from './witness-service.ts';

function privateFile(file: string, label: string): Buffer {
  if (!path.isAbsolute(file)) throw new TypeError(`${label} path must be absolute`);
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077))
    throw new Error(`${label} must be private and owned by the service user`);
  return fs.readFileSync(file);
}

export async function runAttestedSinkServiceCli(args: readonly string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== '--config')
    throw new TypeError('usage: attested-sink-service-cli --config /absolute/private/config.json');
  const bytes = privateFile(args[1], 'sink configuration');
  const decoded = decodeCanonical(bytes) as Record<string, unknown>;
  const witnessed = decoded?.format === 'aether.attested-sink-config/2';
  const config = exactObject(decoded, witnessed
    ? ['format', 'socketPath', 'storageDir', 'authKeyFile', 'signingKeyFile', 'anchor',
      'adapterArtifactDigest', 'witnessSocketPath', 'witnessKeyFile', 'witnessAuthorityId']
    : ['socketPath', 'storageDir', 'authKeyFile', 'signingKeyFile', 'anchor', 'adapterArtifactDigest']);
  if (!Buffer.from(encodeCanonical(config)).equals(bytes)) throw new TypeError('noncanonical sink configuration');
  if (typeof config.socketPath !== 'string' || typeof config.storageDir !== 'string'
    || typeof config.authKeyFile !== 'string' || typeof config.signingKeyFile !== 'string')
    throw new TypeError('invalid sink configuration');
  validateSinkPublicAnchor(config.anchor); validateSinkAdapterArtifactDigest(config.adapterArtifactDigest);
  const authKey = privateFile(config.authKeyFile, 'sink auth key');
  const privateKey = createPrivateKey(privateFile(config.signingKeyFile, 'sink signing key'));
  let sinkStateWitness;
  if (witnessed) {
    if (typeof config.witnessSocketPath !== 'string' || !path.isAbsolute(config.witnessSocketPath)
      || typeof config.witnessKeyFile !== 'string' || !path.isAbsolute(config.witnessKeyFile)
      || typeof config.witnessAuthorityId !== 'string') throw new TypeError('invalid sink witness configuration');
    const sinkStore = path.resolve(config.storageDir);
    if (path.resolve(config.witnessSocketPath) === path.resolve(config.socketPath)
      || path.resolve(config.witnessSocketPath).startsWith(`${sinkStore}${path.sep}`)
      || path.resolve(config.witnessKeyFile).startsWith(`${sinkStore}${path.sep}`))
      throw new Error('sink witness socket/key must be outside sink storage');
    const witnessKey = privateFile(config.witnessKeyFile, 'sink witness key');
    if (witnessKey.equals(authKey)) throw new Error('sink witness key must differ from sink auth key');
    sinkStateWitness = createProcessWitnessClient({ socketPath: config.witnessSocketPath,
      key: witnessKey }).sinkStateWitness({ authorityId: config.witnessAuthorityId,
      anchor: config.anchor as SinkPublicAnchorV1, adapterArtifactDigest: config.adapterArtifactDigest as string });
  }
  await startAttestedSinkService({ socketPath: config.socketPath, storageDir: config.storageDir,
    authKey, privateKey, anchor: config.anchor as SinkPublicAnchorV1,
    adapterArtifactDigest: config.adapterArtifactDigest as string, sinkStateWitness });
  process.stdout.write('attested sink service ready\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAttestedSinkServiceCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`attested sink service startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
