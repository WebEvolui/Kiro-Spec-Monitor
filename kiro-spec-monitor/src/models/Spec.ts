/**
 * Pure domain model for a Kiro Spec.
 *
 * This module contains no I/O and MUST NOT import `vscode`. A `Spec` is the
 * normalized aggregate produced by the `SpecAggregator`: its parsed task tree
 * plus the derived progress figures.
 */

import type { Task } from './Task';

/**
 * A Kiro Spec: a `.kiro/specs/<name>/` folder containing a `tasks.md`, with its
 * parsed task tree and derived progress.
 *
 * Fields are `readonly`: a `Spec` is an immutable snapshot produced per refresh.
 *
 * Progress counts only leaf tasks (`children.length === 0`). Parent tasks that
 * merely group subtasks are organizational nodes and contribute `0` to `total`.
 *
 * Invariants (enforced by the aggregator's `computeProgress`, documented here):
 * - `0 <= completed <= total`.
 * - `progress` is in `[0, 1]` and equals `completed / total`, defined as `0`
 *   when `total === 0` (no division by zero).
 * - The spec is "complete" iff `total > 0 && completed === total`.
 * - `runningCount` is the number of tasks whose `status === 'running'`.
 */
export interface Spec {
  /** Spec folder name, e.g. "aimores-map". */
  readonly name: string;

  /** Spec directory fsPath. */
  readonly path: string;

  /** `tasks.md` fsPath. */
  readonly tasksFile: string;

  /** Top-level tasks (tree roots). */
  readonly tasks: Task[];

  /** Count of tasks that COUNT toward progress (leaf tasks only). */
  readonly total: number;

  /** Completed count among counted (leaf) tasks. */
  readonly completed: number;

  /** `completed / total` in `[0, 1]`; `0` when `total === 0`. */
  readonly progress: number;

  /** Number of tasks currently in the `running` state. */
  readonly runningCount: number;
}
