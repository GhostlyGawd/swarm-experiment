# Portable certificate check latency preflight

This versioned research profile times a complete `checkPortableCertificate` call for the seven-obligation scalar-call bundle in `test/tier2/portable-proof.test.ts`. It includes independent obligation derivation and all formula-certificate checks. The unchanged v4 NFR-05 bound is **50 µs per certificate**; the preregistered decision uses the maximum of 200 measured calls after 20 warmups. Raw nanosecond samples, the certificate, source closure, environment and verdict are retained. Measurement can record a miss; only `--verify` independently checks source pins, certificate validity, raw-sample arithmetic and the saved verdict.

Run from a clean source commit:

```sh
node --experimental-strip-types roadmap/v4/research/proof-check-latency/campaign.ts --measure OUTPUT_DIRECTORY
node --experimental-strip-types roadmap/v4/research/proof-check-latency/campaign.ts --verify OUTPUT_DIRECTORY
```

This is one bounded portable-AST fixture on one machine. It is not a release-profile NFR-05 pass, a proof that timing repeats on other hardware, or evidence for all certificate sizes and kinds. The selected checker runs in Node and its current execution includes more than the small linear prototype used in early R03 research. The v4 release inventory keeps NFR-05 unmeasured until a representative, independently validated qualification profile is integrated.
