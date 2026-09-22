/** Versioned implementation planning. These types describe work, not runtime APIs. */
export type Milestone = 'baseline' | 'v2' | 'v3' | 'v4';
export type Status = 'planned' | 'in_progress' | 'blocked' | 'verified';
export interface Requirement {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly target: string;
}
export interface Gate {
  readonly id: string;
  readonly criterion: string;
}
export interface Task {
  readonly id: string;
  readonly title: string;
  readonly milestone: Milestone;
  readonly owner: string;
  readonly kind: 'implementation' | 'research' | 'assurance' | 'release';
  /** Prerequisites for closing the task; exploration can begin earlier. */
  readonly deps: readonly string[];
  readonly requirements: readonly string[];
  readonly deliverables: readonly string[];
  readonly gates: readonly Gate[];
  readonly status: Status;
  readonly blockedReason?: string;
  /** Repository-relative JSON EvidenceManifest; required only when verified. */
  readonly evidence?: string;
}
export interface EvidenceManifest {
  readonly task: string;
  readonly specVersion: string;
  readonly subjectCommit: string;
  readonly recordedAt: string;
  readonly checks: readonly {
    readonly gate: string;
    readonly result: 'pass' | 'fail' | 'not_run';
    readonly method: string;
    readonly artifact: string;
  }[];
}
export interface Plan {
  readonly version: string;
  readonly requirements: readonly Requirement[];
  readonly tasks: readonly Task[];
  readonly firstSlice: readonly string[];
}
