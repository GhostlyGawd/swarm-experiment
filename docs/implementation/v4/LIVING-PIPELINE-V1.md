# Living boundary pipeline `/1`

`LivingCampaignPipelineV1` records exactly which cases a signed V4 candidate
generated and actually executed. It is an opt-in measurement and durability
profile. The constructor calls the candidate's real `generate()`, rejects
duplicate case digests/seeds or mixed manifest subjects, and publishes one
canonical generation record. Each `execute()` call requires an exact generated
case and an explicit `original`, `retry` or `duplicate` reason. Every attempt
is timed, recorded with its full Aether result and fsynced. Recovery calls are
timed and retained separately. A failed partition attempt remains an attempt;
it cannot be filtered away when a later retry succeeds.

`finish()` requires all generated case identities to have a successful final
execution, recounts failed and filtered attempts, and checks declared coverage.
It publishes an immutable `/1` report with separate generation, candidate
execution, recovery, observation-publication and pipeline wall times. The
offline auditor reopens every record and rederives counts, digests, coverage and
rate arithmetic. `complete` means the accounting set is complete after explicit
recovery; it does not mean every attempt passed or that T3-03/G1 is qualified.
The report always says `productionAuthorized: false`. It is
not a proof of external deployment, an admission receipt, or a performance
qualification by itself.

The [witnessed external campaign](../../../roadmap/v4/research/microworld-external/README.md)
uses this profile inside its real candidate worker. Its outer timer additionally
includes process launch, gateway partition/rejoin, copied witness/sink evidence
and final raw audit. The fixed R04 four-field JSON kernel is measured and saved
separately with its original one warmup and five 20,000-input trials. A direct
file-plus-directory fsync probe retains individual raw samples as a diagnostic
for the current serial durability path. Neither a fast kernel nor a probe can
substitute for the complete candidate/sink campaign result.

The current manifest validates at most 10,000 declared cases in total and the
signed external fixture declares 15. This pipeline measures those 15 exactly;
it does not claim millions of distinct admitted cases, native-thread races,
cross-machine partitions, independent operator custody, or a full v4 release.
