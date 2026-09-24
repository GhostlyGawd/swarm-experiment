# Signed effectful LivingCampaign `/2` research profile

The [contract](../../../../docs/implementation/v4/LIVING-EFFECT-CAMPAIGN.md)
describes signed exact Aether subject, policy and response binding, durable
broker/sink evidence, admission and fail-closed unknown outcomes. The research
fixture builds a seeded Aether ledger module and signs its exact root, campaign
and deterministic local adapter with a fresh Ed25519 key during registration.
Only the public key and signed authorization are retained. This is local
campaign admission, with `productionAuthorized: false`.

[Exact-source run](../../../../docs/implementation/v4/evidence/t303-effect-4b5b7a7/REVIEW.md)
at clean `4b5b7a7` executed 5/5 generated cases with zero filters, 5/5 committed
broker effects, complete coverage and no unknown outcomes. The complete
admission campaign ran at **11.6202 cases/s**, failing the fixed R04 2M/s gate.
The benchmark does not include a process worker or external sink. A separate
[process/socket campaign](../../../../docs/implementation/v4/evidence/t303-process-4b5b7a7/REVIEW.md)
ran at **2.6580 cases/s** on the same source and also fails the gate. These
results cannot be averaged or substituted for one integrated release profile.

```sh
node --experimental-strip-types roadmap/v4/research/microworld-effect/campaign.ts --verify docs/implementation/v4/evidence/t303-effect-4b5b7a7
node --experimental-strip-types --test test/tier3/living-effect-campaign.test.ts
```
