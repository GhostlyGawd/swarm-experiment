/** Shared in-process identity for adapters admitted from checked bytes. This
 * small runtime path has no loader or dynamic module dependencies. */
import { effectAdapterDigest, type EffectAdapter } from '../fabric/effects.ts';
import type { Digest } from '../fabric/identity.ts';
import type { CapabilityName } from '../tier1/ids.ts';

const admitted = new WeakMap<EffectAdapter, Digest>();
const admittedWasmCapability = new WeakMap<EffectAdapter, CapabilityName>();

export function recordAdmittedAdapter(adapter: EffectAdapter, digest: Digest,
  wasmCapability?: CapabilityName): void {
  admitted.set(adapter, digest);
  if (wasmCapability !== undefined) admittedWasmCapability.set(adapter, wasmCapability);
}
export function admittedAdapterArtifactDigest(adapter: EffectAdapter): Digest | null {
  const value = admitted.get(adapter);
  if (!value) return null;
  effectAdapterDigest(adapter); return value;
}
export function admittedWasmAdapterCapability(adapter: EffectAdapter): CapabilityName | null {
  return admittedWasmCapability.get(adapter) ?? null;
}
