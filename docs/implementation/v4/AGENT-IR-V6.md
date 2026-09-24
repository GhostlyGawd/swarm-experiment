# Agent-IR V6 cold-bound model exchange

AE6 is an opt-in message protocol layered over the complete AE1 cold module.
The sender and receiver independently decode the same canonical cold wire and
retain its exact `ast:b3` module root. The cold wire is included in cold and
full-session accounting. No identity is inferred from a short session index.

`R6:<decimal root>:<member index>` identifies an unchanged function declaration
in that paid module. The decimal integer contains the complete 256-bit AST
digest, with canonical syntax and range checks. The receiver checks its local
cold root and reconstructs a detached declaration and full module.

`E6:<decimal base root>:<member index>:<decimal result declaration root>:<child path>:<new integer>`
changes exactly one integer literal in a function body. All other function
metadata, parameters, capabilities, contracts, surfaces and body nodes are
retained. The decoder checks the resulting declaration root, rejects stale or
malformed wires, and reconstructs the resulting full module root. An arbitrary
multi-node change requires a larger full declaration exchange and is not
covered by AE6.

The versioned `ledger-warm-v6/1` benchmark retains the legacy TypeScript
baseline and the complete warm-wire boundary. Four unchanged warm declarations
reach 5.629× cl100k and 5.694× o200k. Charging an additional JSONL role/purpose
frame still yields 4.599× and 4.669×. Cold (0.941× cl100k) and complete changed
session (1.141×) both miss 4×. The retained benchmark corpus and sample counts
include the cold AE1 module, executed failing `/100` candidate, checked `/200`
repair, and both tool responses. There was no model inference or training.

The accepted scope is a deterministic one-module ledger fixture, not a
representative change campaign. V4-T1-02/FR-1.2 and V4-Q03 remain open, as do
general edits, target-model chat-template billing, and autonomous agent
quality. The ≥4× release requirement is unchanged.
