# Signed lineage audit AST retention

The strict `CausalLineageLedger` already writes physical `lineage-spec`, `lineage-intent`, and `lineage-artifact` AST leases before publishing each signed record. Reopen now checks that every published record still has its exact role-specific lease and that each leased root's stored bytes remain readable and hash-valid. This check runs before lineage can authorize another artifact or promotion. A different lease keeping the same AST bytes alive cannot hide a missing audit lease.

The check covers every historical signed specification, intent, and admitted artifact, including records invalidated by a later specification or policy epoch. Crash before lineage publication may leave a conservative orphan lease; crash after publication requires the matching lease. A missing lease fails closed on reopen, even before collection. Recovery requires investigation of the original durable record and AST store; a later process does not silently recreate a retired lease ID.

This is a bounded V4-T1-05/G2 audit-retention improvement. It does not prove safe audit expiration or release, all ProcessHost and replication lifecycles, effect-preserving production rewrites, or full task acceptance. Historical lineage leases remain nonexpiring.
