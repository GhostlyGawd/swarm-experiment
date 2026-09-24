# Portable certificate check latency preflight

This versioned research profile times a complete `checkPortableCertificate` call for the seven-obligation scalar-call bundle in `test/tier2/portable-proof.test.ts`. It includes independent obligation derivation and all formula-certificate checks. The unchanged v4 NFR-05 bound is **50 µs per certificate**; the preregistered decision uses the maximum of 200 measured calls after 20 warmups. Raw nanosecond samples, the certificate, source closure, environment and verdict are retained. Measurement can record a miss; only `--verify` independently checks source pins, certificate validity, raw-sample arithmetic and the saved verdict.

Run from a clean source commit:

```sh
node --experimental-strip-types roadmap/v4/research/proof-check-latency/campaign.ts --measure OUTPUT_DIRECTORY
node --experimental-strip-types roadmap/v4/research/proof-check-latency/campaign.ts --verify OUTPUT_DIRECTORY
```

This is one bounded portable-AST fixture on one machine. It is not a release-profile NFR-05 pass, a proof that timing repeats on other hardware, or evidence for all certificate sizes and kinds. The selected checker runs in Node and its current execution includes more than the small linear prototype used in early R03 research. The v4 release inventory keeps NFR-05 unmeasured until a representative, independently validated qualification profile is integrated.

The [clean-source preflight](../../../../docs/implementation/v4/evidence/nfr05-proof-check-5ce3447/REVIEW.md) at `5ce3447` observed a 1,903.583 µs median and 2,203.166 µs maximum over 200 full-bundle checks. All 200 missed 50 µs. This is a concrete optimization and qualification gap, not a release verdict for the full target corpus.

The later [exact-source run](../../../../docs/implementation/v4/evidence/nfr05-proof-check-18efdf5/REVIEW.md) also checks recorded hardware identity: median 1,790.375 µs, maximum 2,095.958 µs, and 200/200 above 50 µs. Both runs use the same bounded fixture and leave release NFR-05 unmeasured.
