import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessFreshGuestCampaign, validateFreshGuestProfile, type FreshGuestProfile, type ControllerExecution } from '../../roadmap/v4/research/native/guest-campaign.ts';
import { assessFreshGuestCampaign as assessInitializedCampaign, validateFreshGuestProfile as validateInitializedProfile } from '../../roadmap/v4/research/native/initialized-guest-campaign.ts';

const profile = { ...JSON.parse(readFileSync(new URL('../../roadmap/v4/research/native/guest-campaign-profile.json', import.meta.url), 'utf8')), trialCount: 3 } as FreshGuestProfile;
function campaign(durations = [100, 200, 300]): ControllerExecution {
  return { exitCode: 0, signal: null, timedOut: false, processLaunchToReadyNs: 10000000, stderr: '', error: null, events: [
    { kind: 'controller_ready', format: 'aether.fresh-guest-controller/1', pid: 123, requestedTrials: 3, timebaseNumer: 1, timebaseDenom: 1, imageBytes: 60, createdVmsBeforeCampaign: 0, createdVcpusBeforeCampaign: 0, guestBytesBeforeCampaign: 0 },
    ...durations.map((duration, trial) => ({ kind: 'guest_sample', trial, guestId: `123:${trial}`, gross: String(1000 + 200 * trial), adjustment: '7', expected: String(12 + trial), actual: String(12 + trial), status: '0', exceptionReason: 1, syndrome: String(0x16 * 2 ** 26), startTick: '100', validatedResponseTick: String(100 + duration), durationTicks: String(duration), freshGuestToValidatedResponseNs: duration, responseValidated: true, freshVmCreated: true, freshVcpuCreated: true, cleanupSucceeded: true, guestImageBytes: 60, guestMappedBytes: 65536, guestResidentObservedBytes: 65536, guestResidentPeakUpperBoundBytes: 65536, controllerCurrentRssBytes: 6000000, controllerPeakRssBytes: 7000000, errorStage: null, errorCode: '0' })),
    { kind: 'campaign_complete', completedTrials: 3, createdVms: 3, destroyedVms: 3, createdVcpus: 3, destroyedVcpus: 3, unmappedGuests: 3 },
  ] };
}

test('fresh guest qualification uses maximum of all preregistered guests and excludes controller RSS from guest scope', () => {
  const valid = assessFreshGuestCampaign(profile, campaign());
  assert.equal(valid.qualification, 'bounded_campaign_pass');
  assert.equal(valid.guestMemory.verdict, 'pass');
  assert.equal(valid.diagnostics.controllerPeakRssBytes?.max, 7000000);
  const missed = assessFreshGuestCampaign(profile, campaign([1000001, 1, 1]));
  assert.equal(missed.boot.verdict, 'fail');
  assert.deepEqual(missed.boot.misses, [{ trial: 0, nanoseconds: 1000001 }]);
  assert.equal(missed.recordedTrials, 3);
});

test('fresh guest qualification rejects first-guest omission, repeats, malformed timing, invalid responses and incomplete cleanup', () => {
  for (const mutate of [
    (run: ControllerExecution) => { run.events.splice(1, 1); },
    (run: ControllerExecution) => { run.events[2].guestId = '123:0'; },
    (run: ControllerExecution) => { run.events[1].responseValidated = false; },
    (run: ControllerExecution) => { run.events[1].actual = '999'; },
    (run: ControllerExecution) => { run.events[1].freshVmCreated = false; },
    (run: ControllerExecution) => { run.events[1].cleanupSucceeded = false; },
    (run: ControllerExecution) => { run.events[1].durationTicks = '1'; },
    (run: ControllerExecution) => { run.events[1].guestResidentObservedBytes = 0; },
    (run: ControllerExecution) => { run.events[0].createdVmsBeforeCampaign = 1; },
    (run: ControllerExecution) => { run.events.at(-1)!.destroyedVms = 2; },
    (run: ControllerExecution) => { run.timedOut = true; run.signal = 'SIGKILL'; },
  ]) {
    const run = campaign(); mutate(run);
    assert.equal(assessFreshGuestCampaign(profile, run).qualification, 'not_qualified');
  }
});

test('fresh guest profile keeps approved numeric bounds and prohibits guest warmups/reuse', () => {
  validateFreshGuestProfile(profile);
  assert.throws(() => validateFreshGuestProfile({ ...profile, bootMaximumNanoseconds: 1000001 }));
  assert.throws(() => validateFreshGuestProfile({ ...profile, guestResidentMaximumBytes: 2000001 }));
  assert.throws(() => validateFreshGuestProfile({ ...profile, guestWarmupCount: 1 }));
  assert.throws(() => validateFreshGuestProfile({ ...profile, parallelGuests: 2 }));
});

test('initialized hypervisor campaign requires a destroyed empty VM/vCPU context and zero executed guest warmups', () => {
  const initializedProfile = { ...JSON.parse(readFileSync(new URL('../../roadmap/v4/research/native/initialized-guest-campaign-profile.json', import.meta.url), 'utf8')), trialCount: 3 } as FreshGuestProfile;
  validateInitializedProfile(initializedProfile);
  const initialized = () => {
    const run = campaign();
    Object.assign(run.events[0], { format: 'aether.fresh-guest-controller/2', createdVmsBeforeCampaign: 1, destroyedVmsBeforeCampaign: 1, createdVcpusBeforeCampaign: 1, destroyedVcpusBeforeCampaign: 1, executedGuestsBeforeCampaign: 0, hypervisorInitializationNs: 2000000 });
    return run;
  };
  const report = assessInitializedCampaign(initializedProfile, initialized());
  assert.equal(report.qualification, 'bounded_campaign_pass');
  assert.equal(report.diagnostics.hypervisorInitializationNs, 2000000);
  for (const change of [{ createdVmsBeforeCampaign: 0 }, { destroyedVmsBeforeCampaign: 0 }, { destroyedVcpusBeforeCampaign: 0 }, { executedGuestsBeforeCampaign: 1 }]) {
    const run = initialized(); Object.assign(run.events[0], change);
    assert.equal(assessInitializedCampaign(initializedProfile, run).qualification, 'not_qualified');
  }
  assert.throws(() => validateInitializedProfile({ ...initializedProfile, hypervisorBootstrap: { ...(initializedProfile.hypervisorBootstrap as object), guestExecutions: 1 } }));
});
