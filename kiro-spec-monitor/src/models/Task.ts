/**
 * Pure domain models for a parsed Kiro task.
 *
 * This module contains no I/O and MUST NOT import `vscode`. It defines the
 * normalized shape produced by the `TaskParser` and consumed by the rest of the
 * extension (aggregator, tree provider, runtime service).
 *
 * `TaskStatus` is defined here as the single source of truth for the abstract
 * task state. The `TaskStateProvider` abstraction (task 8) imports it from this
 * module rather than redefining it, so the UI depends only on this union.
 */

/**
 * Abstract, source-decoupled state of a task.
 *
 * V1 only ever resolves to `completed | running | pending`. The remaining
 * members are V2 extension points reserved so future running-detection work
 * does not require changing the UI contract; V1 never emits them.
 */
export type TaskStatus =
  | 'completed'
  | 'running'
  | 'pending'
  // V2 extension points (never emitted in V1):
  | 'failed'
  | 'paused'
  | 'blocked'
  | 'skipped';

/**
 * A single task parsed from a `tasks.md` checkbox line.
 *
 * Fields are `readonly`: a parsed task is an immutable value. The aggregator
 * produces fresh `Task` values when it resolves `status`/`startedAt` rather than
 * mutating existing ones.
 *
 * Invariants (enforced by the parser / aggregator, documented here):
 * - `id` is non-empty and has no leading `- [ ] ` / `- [x] ` checkbox prefix
 *   (it is the trimmed, prefix-free checkbox body, so it matches the Kiro
 *   metadata task key exactly).
 * - `level >= 0`; a child's `level` is strictly greater than its parent's
 *   (`child.level === parent.level + 1`).
 * - `completed === true` implies `status !== 'running'` (a checked task is
 *   never reported as running).
 * - `children` contains only genuine tasks (checkbox lines), never detail
 *   bullets or prose.
 */
export interface Task {
  /**
   * Task text WITHOUT the checkbox, trimmed — matches the metadata taskId key
   * exactly. e.g. "12.3 Montar public/index.html ...".
   */
  readonly id: string;

  /** Display title (same text as `id` for V1; separated for future formatting). */
  readonly title: string;

  /** Resolved by the aggregator from the `TaskStateProvider`. */
  readonly status: TaskStatus;

  /** Raw checkbox state: `true` for `[x]`/`[X]`, `false` for `[ ]`. */
  readonly completed: boolean;

  /** Dotted number if present, e.g. "12.2.1"; `undefined` for unnumbered tasks. */
  readonly number?: string;

  /** 0-based line index of the checkbox line in `tasks.md`. */
  readonly line: number;

  /** Nesting depth; `0` = top-level. */
  readonly level: number;

  /** Requirement numbers from a `*Requirements: 6.3, 6.4*` line, if any. */
  readonly requirements?: string[];

  /** Child tasks (genuine checkbox lines only). */
  readonly children: Task[];

  /** Populated only when `status === 'running'`. ms epoch of execution start. */
  readonly startedAt?: number;
}
