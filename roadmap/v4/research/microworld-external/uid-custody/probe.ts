/** Read the signed sink head through the candidate's credential-gated witness socket. */
import { readFileSync } from 'node:fs';
import { createProcessWitnessClient } from '../../../../../src/fabric/witness-service.ts';
import { readSinkStateHead } from '../../../../../src/fabric/sink-state-witness.ts';
import { EXTERNAL_ARTIFACT, EXTERNAL_WITNESS_AUTHORITY } from '../fixture.ts';

const [socketPath, keyFile, registrationPath] = process.argv.slice(2);
if (!socketPath || !keyFile || !registrationPath) throw new TypeError('probe arguments');
const registration = JSON.parse(readFileSync(registrationPath, 'utf8'));
const client = createProcessWitnessClient({ socketPath, key: readFileSync(keyFile), timeoutMs: 3000 });
const witness = client.sinkStateWitness({ authorityId: EXTERNAL_WITNESS_AUTHORITY,
  anchor: registration.anchor, adapterArtifactDigest: EXTERNAL_ARTIFACT });
process.stdout.write(JSON.stringify(readSinkStateHead(witness)) + '\n');
