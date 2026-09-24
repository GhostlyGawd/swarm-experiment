# Direct resumable checkpoint replay retention

This bounded V4-T1-05/G2 slice adds an opt-in `aether.checkpoint-journal/2` profile to `ResumableCheckpointStore`. It binds one `CheckpointSemanticRetention` authority, built from one `DurableGraphStore` and `SemanticGarbageCollector`, to the checkpoint directory, execution ID, program digest, manifest digest, collector configuration, and exact AST roots. The roots are `manifest.astRoot` and each declared dependency `declaration` root. They are durable `replay` pins before any checkpoint head can be published. A crash before head publication may leave extra pins; there is no clock-based release.

Reopen, `head`, `history`, `save`, and `load` reject missing or changed authority markers, collector profiles, retention records, graph leases, or AST objects. The version 2 journal and initialization receipt reject reopening without the authority. Version 1 journals retain their original no-authority behavior and cannot be silently upgraded. A new version 2 journal cannot reuse a directory containing orphaned checkpoint objects if its head journal has disappeared.

The external dependency roots are intentionally `replay` pins. Current adapter retirement fails closed when it encounters pinned non-module dependency declarations. They cannot be downgraded to `audit` pins to make retirement pass. Manifest-associated liveness analysis is still required before such retirements can be admitted.

This direct-store boundary does not establish active-task pinning, ProcessHost integration, general adapter retirement, or full G2 closure. Its tests exercise draft-lease release, collection, reopen/load, missing and tampered marker/pins, and real process death before and after head publication.
