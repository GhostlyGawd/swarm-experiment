# D07 — Measured native target and ABI direction

- **Decision version:** 0.2.0, 2026-09-22.
- **Owner:** V4-R02, specification 0.1.0.
- **Status:** bounded native feasibility demonstrated; production native, accelerator and unikernel requirements remain open.
- **Reference implementation:** TypeScript retains the language semantics.

## User-approved qualification boundary

On 2026-09-22, the user selected **fresh guest creation on an already-running hypervisor, and guest resident memory** for the 1 ms / 2 MB requirements. The versioned [qualification profile](D07-native-qualification-profile.json) records that decision. Controller startup and host/VMM RSS remain required diagnostics; they are not the selected guest limits. Maximum latency still applies, not the median. No existing guest may be reused as a cold instance.

The original research campaign below is retained unchanged. Its fresh-VM diagnostic maximum is **2.832 ms**, so it still does not establish the 1 ms bound. The measured 65,536-byte guest allocation fits the selected memory bound for this small arithmetic prototype, but does not qualify a complete native runtime or its drivers. A campaign on a running controller with freshly created guests must use the approved profile before release qualification.

Version 0.2.0 records this user clarification; it does not alter historical measurements or lower numeric thresholds. The source implementation specification already delegates exact target boundaries to versioned profiles, so its interface/functional contracts remain at 0.1.0.

## Decision

Use **AArch64, little endian, checked i64 values** as the first native prototype.
Lower the supported typed AST subset into auditable C, compile it with Clang,
and link a freestanding ELF/raw image. The native experiment uses the existing
Apple Hypervisor.framework to execute that image as an actual EL1 guest. This
choice makes native behavior and boot costs measurable on the available host.
It does not select macOS as the only eventual deployment platform.

The target executes a real AST-derived function. `lower.ts` rejects unbounded
`Int`, effects, contracts, unknown kinds, captures, generic declarations and
unsupported bodies. It never silently changes arbitrary-precision arithmetic
into machine-width arithmetic. Its 1,345 arithmetic cases agree with the
TypeScript runtime, including signed boundaries, overflow, negative division,
division by zero and `INT64_MIN % -1`.

C/Clang and the linker are part of this prototype's trusted computing base.
Differential tests establish bounded conformance, not a proof that the compiler
preserves every program. Portable proof certificates for AST semantics cannot
be reused as native-machine correctness evidence without a validated lowering
or an explicitly admitted compiler trust policy.

## Native ABI contract

`aether.native-i64/1` accepts two signed 64-bit arguments and returns:

| Offset | Field | Meaning |
|---|---|---|
| 0 | `int64_t value` | Valid when status is zero |
| 8 | `uint32_t status` | 0 = value, 1 = checked overflow, 2 = division by zero |
| 12 | `uint32_t reserved` | Zero; rejects accidental implicit ABI expansion |

The result occupies 16 bytes. Compile-time assertions check its layout. The
AArch64 guest uses the platform procedure-call rules and returns the result in
registers; the loader checks both the value and status after the HVC exit. This
follows the [Arm AAPCS64 procedure-call specification](https://github.com/ARM-software/abi-aa/blob/main/aapcs64/aapcs64.rst).

Signed add/subtract/multiply lower through Clang's overflow builtins. Division
checks zero and `INT64_MIN / -1` before executing C division. Remainder explicitly
handles `INT64_MIN % -1` as zero, matching the reference semantics while avoiding
C's undefined division edge case. See the [Clang checked-arithmetic builtins](https://clang.llvm.org/docs/LanguageExtensions.html#checked-arithmetic-builtins)
and [LLVM integer operation semantics](https://llvm.org/docs/LangRef.html).

Raw pointers, JS closures and native registers are not portable logical heap
identities. V4-T3-10 must separately define relative-reference bounds, packed
field alignment, aliases, overflow policies and checkpoint translation to C1
logical records. A native execution manifest must bind ABI, compiler, flags,
artifact, policy and semantic versions through the existing C1 target fields.

## Actual boot artifact and driver boundary

The measured host is an **Apple M4 Pro, 12 logical CPUs, 24 GiB RAM**, running
macOS 26.7 / Darwin 25.6.0. Tools are Apple Clang 21.0.0 and the installed Rust
LLVM linker, LLD 22.1.6. No dependency installation or paid service was needed.

A local, ad-hoc signed executable with the
`com.apple.security.hypervisor` entitlement successfully calls `hv_vm_create`.
The entitlement is required by [Apple's Hypervisor API](https://developer.apple.com/documentation/hypervisor?changes=latest_major&language=objc_5).
The exact SDK headers were also inspected for VM mapping, vCPU creation,
register setup and exit behavior.

The image is **60 bytes of linked AArch64 machine code**. Its entry is
`0x40000000`; the ELF is retained alongside the raw image. The loader maps one
read/execute code page and remaining read/write, nonexecutable memory, sets EL1h,
a stack and two input registers, then runs the vCPU. Guest code calculates
`1000 / 200 + 7 = 12` and returns through an HVC exception. The loader verifies
exception class, value and status. This is actual hardware virtualization, with
no guest Linux, libc or filesystem.

The only prototype device contract is an **HVC result mailbox**. There is no
network, disk, interrupt-controller or general syscall implementation. The host
VMM still runs on Darwin. This experiment does not establish deployment on an
independently qualified bare-metal hypervisor, nor formal capability containment.
For a second system target, use a pinned AArch64 `virt` platform with real
hardware acceleration and an explicit device whitelist; [QEMU documents the
versioned `virt` machine](https://www.qemu.org/docs/master/system/arm/virt) and
[separates hardware virtualization from software emulation](https://www.qemu.org/docs/master/system/security.html).
No QEMU, KVM, GPU, Wasm SIMD or SPIR-V performance result is claimed here.

## Measured results

The [measurement manifest](../../../../roadmap/v4/research/native/results/m4-pro-2026-09-22/manifest.json)
binds the Git baseline, dirty-tree state, source digests, AST roots, toolchain,
hardware and binary/raw-sample digests. This research run used baseline commit
`3dce2d61686129cff45a76d256d3e2681c897fcc` plus the source inventory recorded in
that manifest; it is not represented as an already committed release build.

| Measurement | Recorded result | Interpretation |
|---|---:|---|
| Native/reference arithmetic agreement | 1,345 / 1,345 cases | Bounded conformance passes |
| Warm dispatch selection | median 1.668 ns/call; max batch mean 1.895 ns/call | Diagnostic amortized branch-selection cost |
| Complete pure fallback fixture | median 8.788 ns/call; max batch mean 10.890 ns/call | Includes speculative computation, fault-status guard, frame restoration and a newly executed conservative calculation |
| Individually timed fallback fixture | max observed 41.667 ns; many zero-tick observations | **50 ns gate inconclusive**; timer granularity is 41.667 ns and observer cost is visible |
| Fresh VM, `main` to useful response | median 0.541 ms; max 2.832 ms | Narrow diagnostic still misses a 1 ms observed maximum |
| Fresh process + VM to first useful response | median 7.060 ms; max 138.786 ms | Exceeds the original provisional full-launch interpretation; **controller diagnostic under the subsequently approved profile**. All 20 launches are retained. |
| Raw guest image | 60 bytes | Image-size diagnostic |
| Guest mapped memory | 65,536 bytes | Guest memory diagnostic |
| Full VMM process peak RSS | max 6,275,072 bytes | Exceeds the original provisional total-footprint interpretation; **host diagnostic under the subsequently approved guest-memory profile** |

Fallback timing has 30 batches of 100,000 calls after 10,000 warmup calls,
plus 2,000 individual timer-pair and operation observations. The pure fixture
has three paths: speculative success, rollback followed by conservative
calculation, and static trap preserving previous state. Its permission flag
exercises refusal, not the full object-capability implementation. The measured
fallback trigger is an injected error status; checked arithmetic faults are
also exercised by conformance tests.

The first timing prototype let Clang reuse a previously computed conservative
value. Inspection of generated assembly found that flaw. The retained version
uses a compiler register barrier and contains a second arithmetic calculation
after restoration; the [assembly artifact](../../../../roadmap/v4/research/native/results/m4-pro-2026-09-22/native-driver.s)
was inspected directly. Both tiers still use the same bounded arithmetic
semantics; this is not an independently verified production fallback hierarchy.

Clock quantization prevents treating a measured zero as zero-cost execution.
Batch means cannot prove the required per-event maximum. The entire native
runtime, external-effect reconciliation, repair notification and target-specific
worst-case timing analysis remain required for V4-Q02. No threshold has been
relaxed to classify this prototype as full success.

The historical boot measurement includes image loading, guest allocation, VM and vCPU creation
and the first validated response. Its original primary boundary also includes launching
the host process and observing its first complete response line. The OS file
cache is uncontrolled; each sample uses a fresh host process and a fresh VM.
No pre-existing VM is substituted for cold boot. Future qualification uses the user-approved boundary above. Host-process RSS is not called
guest memory, and the tiny code image is not called the total footprint.

## Reproduction and follow-on work

```sh
node --experimental-strip-types --test test/research/native.test.ts
node --experimental-strip-types roadmap/v4/research/native/run.ts --output /tmp/aether-native-r02-new-run
```

Native arithmetic tests need a C compiler. Boot measurements additionally need
Apple silicon, the macOS SDK, `codesign`, Hypervisor.framework and the installed
Rust `ld.lld`. The runner records explicit failure if boot tooling or permission
is unavailable. Ad-hoc entitlement signing applies only to the generated loader.

Next implementation obligations remain:

1. V4-T3-10: versioned packed heap and native checkpoint/alias semantics.
2. V4-T3-07 and V4-Q02: actual runtime fallback integration, external-effect
   recovery, high-resolution timing and a preregistered complete workload.
3. V4-T3-05: real Wasm SIMD/SPIR-V lowering and named numerical baselines;
   this scalar experiment supplies no accelerator performance evidence.
4. V4-T4-05: a complete supported image compiler, required drivers and useful
   application behavior under native capability enforcement.
5. V4-Q02: optimize and remeasure cold launch and total resident footprint on
   each claimed deployment target. The current 1 ms and 2 MB misses remain open.

There is no present hypervisor-access blocker on this machine. The unresolved
items are implementation and qualification work, not a request for credentials,
spending or a weaker acceptance gate.
