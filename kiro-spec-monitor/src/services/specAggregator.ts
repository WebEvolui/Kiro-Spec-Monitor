/**
 * SpecAggregator — composes the scanner + parser into ordered `Spec[]` and owns
 * the progress calculation and spec ordering.
 *
 * This module exposes two PURE, side-effect-free helpers that are the primary
 * property-test targets of this layer and MUST stay importable without a
 * `vscode` runtime:
 *
 * - `computeProgress(roots)` — leaf-only progress figures (design Properties
 *   8, 9, 10, 11; Req 4.1, 4.2, 4.4, 4.5, 4.6).
 * - `orderSpecs(specs)` — stable three-group ordering (design Property 18;
 *   Req 11).
 *
 * It also provides a SKELETON `SpecAggregator` that scans + parses and computes
 * progress with every task defaulting to `pending`. Full wiring of the state
 * provider and runtime (status resolution, running detection, timers) is owned
 * by task 10; this skeleton only establishes the shape, the event, and a real
 * (if minimal) `refresh` so later tasks can layer state on top.
 *
 * The aggregator imports `vscode` solely for `EventEmitter`/`Event`; the pure
 * helpers above do not touch `vscode` and can be unit/property-tested in a
 * plain Node environment.
 */

import * as vscode from 'vscode';

import type { Spec } from '../models/Spec';
import type { Task } from '../models/Task';
import type { SpecScanner } from './specScanner';
import type { TaskParser } from './taskParser';
import type { TaskStateInfo, TaskStateProvider } from './taskStateProvider';
import type { RunningTaskInput, TaskRuntimeService } from './taskRuntimeService';

/**
 * Progress figures derived from a forest of tasks, counting ONLY leaf tasks.
 */
export interface ProgressResult {
  /** Count of leaf tasks (`children.length === 0`). Parents contribute 0. */
  readonly total: number;
  /** Completed leaf tasks; always `0 <= completed <= total`. */
  readonly completed: number;
  /** `completed / total` in `[0, 1]`; `0` when `total === 0`. */
  readonly progress: number;
  /** Number of tasks (at any depth) whose `status === 'running'`. */
  readonly runningCount: number;
}

/**
 * Compute leaf-only progress for a forest of tasks.
 *
 * Rule (Req 4.1, 4.2): only leaf tasks — tasks with no children — count toward
 * `total`. A parent task that merely groups subtasks is an organizational node
 * and contributes `0`. A top-level task with no children is itself a leaf and
 * counts normally. `runningCount` counts every task whose `status === 'running'`
 * regardless of depth (a running node may be a parent).
 *
 * Guarantees (design Properties 8–11):
 * - `0 <= completed <= total` and `progress ∈ [0, 1]` (Req 4.5), enforced by
 *   clamping so a malformed tree can never produce out-of-range figures.
 * - `total === 0 ⇒ progress === 0` with no division by zero (Req 4.4).
 * - If every leaf is completed and `total > 0`, `progress === 1` and the spec
 *   is "complete" (Req 4.6).
 *
 * Pure and deterministic: no I/O, no clock, no `vscode`.
 *
 * @param roots the top-level tasks (tree roots)
 * @returns the derived `{ total, completed, progress, runningCount }`
 */
export function computeProgress(roots: ReadonlyArray<Task>): ProgressResult {
  let total = 0;
  let completed = 0;
  let runningCount = 0;

  const walk = (task: Task): void => {
    const children = task.children ?? [];
    if (children.length === 0) {
      // LEAF — the only counted unit of work.
      total += 1;
      if (task.completed) {
        completed += 1;
      }
    } else {
      for (const child of children) {
        walk(child);
      }
    }
    if (task.status === 'running') {
      runningCount += 1;
    }
  };

  for (const root of roots ?? []) {
    walk(root);
  }

  // Clamp defensively so the result is always well-formed (Req 4.5), even if a
  // caller passes an inconsistent tree.
  if (total < 0) {
    total = 0;
  }
  if (completed < 0) {
    completed = 0;
  }
  if (completed > total) {
    completed = total;
  }
  if (runningCount < 0) {
    runningCount = 0;
  }

  // No division by zero (Req 4.4); otherwise clamp the ratio into [0, 1].
  let progress = total === 0 ? 0 : completed / total;
  if (progress < 0) {
    progress = 0;
  } else if (progress > 1) {
    progress = 1;
  }

  return { total, completed, progress, runningCount };
}

/**
 * True iff the spec counts as "complete": it has at least one counted (leaf)
 * task and all counted tasks are done (Req 4.6).
 */
export function isSpecComplete(spec: Pick<Spec, 'total' | 'completed'>): boolean {
  return spec.total > 0 && spec.completed === spec.total;
}

/**
 * True iff the spec counts as "incomplete": it has an uncompleted counted task,
 * OR it has zero counted tasks (the zero-total edge case, Req 11.2).
 */
function isSpecIncomplete(spec: Pick<Spec, 'total' | 'completed'>): boolean {
  return spec.total === 0 || spec.completed < spec.total;
}

/**
 * Order specs into three groups, in this priority order (Req 11.1):
 *   (1) specs with at least one running task (`runningCount > 0`),
 *   (2) incomplete specs (`completed < total`, or `total === 0`),
 *   (3) complete specs (`total > 0 && completed === total`).
 *
 * The sort is STABLE: within each group the original relative order of the
 * input is preserved (design Property 18, Req 11.4) — the input is expected to
 * already be in the scanner's deterministic alphabetical order. A running spec
 * is placed in group 1 even if it would also qualify as complete/incomplete, so
 * the groups are mutually exclusive and exhaustive.
 *
 * Pure and deterministic: no I/O, no clock, no `vscode`. Returns a new array;
 * the input is not mutated.
 *
 * @param specs the specs to order (typically scanner-alphabetical)
 * @returns a new array ordered by group, stable within each group
 */
export function orderSpecs(specs: ReadonlyArray<Spec>): Spec[] {
  const running: Spec[] = [];
  const incomplete: Spec[] = [];
  const complete: Spec[] = [];

  for (const spec of specs ?? []) {
    if (spec.runningCount > 0) {
      running.push(spec);
    } else if (isSpecIncomplete(spec)) {
      incomplete.push(spec);
    } else {
      complete.push(spec);
    }
  }

  // Concatenation preserves each group's internal order → overall stable.
  return [...running, ...incomplete, ...complete];
}

/**
 * Orchestrates scanner + parser + (later) state provider into an ordered
 * `Spec[]`, owning progress calculation and ordering.
 */
export interface SpecAggregator {
  /** The current ordered snapshot of specs. */
  getSpecs(): ReadonlyArray<Spec>;

  /**
   * Re-scan, re-parse, recompute progress, re-order, and fire
   * `onDidChangeSpecs` once. Never throws.
   */
  refresh(): Promise<void>;

  /** Fires once per `refresh` with the new ordered snapshot. */
  readonly onDidChangeSpecs: vscode.Event<ReadonlyArray<Spec>>;
}

/**
 * Default `SpecAggregator` composing scanner + parser + state provider + runtime.
 *
 * `refresh()` runs the full pipeline (design "Refresh pipeline" + "Running
 * detection + live timer" sequence diagrams):
 *
 *   scan → for each spec: read + parse `tasks.md` → `stateProvider.getStates`
 *   → rebuild the task tree applying the resolved `status`/`startedAt`
 *   (`Task` fields are `readonly`, so new values are produced, never mutated)
 *   → `computeProgress` on the status-resolved tree → mark complete via
 *   `isSpecComplete`; then collect the full running set across all specs,
 *   `runtime.reconcile(...)` it, `orderSpecs` the result, store it, and fire
 *   `onDidChangeSpecs` EXACTLY ONCE (Req 11, Property 18, Req 4.3).
 *
 * Error handling (design refresh postconditions): `refresh` NEVER throws. A
 * single spec whose `tasks.md` is unreadable is skipped; a spec whose state
 * resolution fails degrades to checkbox-only (`FallbackStateProvider` shape:
 * `[x]` → completed, else → pending) via `buildSpec`'s inner guard. Either way
 * the refresh completes and the event still fires once.
 *
 * The resolved running `Task` nodes carry `startedAt` so the tree provider /
 * badge can render elapsed time (the actual per-second elapsed is computed by
 * `TaskRuntimeService` from the reconciled running set — Req 10.2, 10.8).
 */
export class DefaultSpecAggregator implements SpecAggregator {
  private readonly emitter = new vscode.EventEmitter<ReadonlyArray<Spec>>();

  readonly onDidChangeSpecs: vscode.Event<ReadonlyArray<Spec>> = this.emitter.event;

  private specs: ReadonlyArray<Spec> = [];

  constructor(
    private readonly scanner: SpecScanner,
    private readonly parser: TaskParser,
    private readonly stateProvider: TaskStateProvider,
    private readonly runtime: TaskRuntimeService,
  ) {}

  getSpecs(): ReadonlyArray<Spec> {
    return this.specs;
  }

  async refresh(): Promise<void> {
    const specs: Spec[] = [];
    // The full running set across ALL specs, reconciled once at the end so the
    // runtime holds exactly the tasks that are running this refresh (Req 10.4,
    // runtime loop invariant).
    const runningItems: RunningTaskInput[] = [];

    let locations: Awaited<ReturnType<SpecScanner['findSpecs']>>;
    try {
      locations = await this.scanner.findSpecs();
    } catch {
      // The scanner is documented never to throw, but guard anyway so a single
      // failure degrades to an empty view rather than crashing the refresh.
      locations = [];
    }

    for (const location of locations) {
      try {
        const spec = await this.buildSpec(location, runningItems);
        if (spec) {
          specs.push(spec);
        }
      } catch {
        // Defense in depth: a single spec must never crash the whole refresh.
        // buildSpec already degrades internally; this guard covers any
        // unexpected throw so the loop continues and the event still fires.
      }
    }

    // Reconcile the runtime with the complete running set so timers start for
    // newly-running tasks and stop for tasks that are no longer running. Done
    // once per refresh regardless of how many specs are running (Req 10.9).
    try {
      this.runtime.reconcile(runningItems);
    } catch {
      // Runtime reconciliation failure must not break the view.
    }

    // Order into the three contractual groups (running → incomplete → complete,
    // stable within each). runningCount now reflects real running tasks, so the
    // running group is populated when the state source reports running tasks.
    this.specs = orderSpecs(specs);
    // Fire EXACTLY ONCE per refresh (Req 4.3, Property 18).
    this.emitter.fire(this.specs);
  }

  /**
   * Read + parse one spec's `tasks.md`, resolve each task's state via the
   * `TaskStateProvider`, rebuild the tree with the resolved `status`/`startedAt`,
   * and compute its progress. Appends every resolved running task to
   * `runningItems` for the single end-of-refresh `runtime.reconcile`.
   *
   * Degrades a single failing spec rather than throwing (design refresh
   * postconditions):
   * - unreadable `tasks.md` → `undefined` (spec skipped; watcher retries later);
   * - state-provider failure → checkbox-only fallback (`[x]` → completed, else
   *   → pending), so the spec still renders without running state.
   */
  private async buildSpec(
    location: Awaited<ReturnType<SpecScanner['findSpecs']>>[number],
    runningItems: RunningTaskInput[],
  ): Promise<Spec | undefined> {
    let markdown: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(location.tasksFile);
      markdown = Buffer.from(bytes).toString('utf8');
    } catch {
      // Unreadable tasks.md: skip this spec for now (watcher retries later).
      return undefined;
    }

    const parsed = this.parser.parse(markdown);

    // Resolve abstract state (completed/running/pending + optional startedAt)
    // per task. On any state-source error, degrade this whole spec to
    // checkbox-only state so completed/pending still render (Req 8.7, 13.5).
    let states: Map<string, TaskStateInfo>;
    try {
      states = await this.stateProvider.getStates(location.name, parsed);
    } catch {
      states = this.fallbackStates(parsed);
    }

    // Rebuild the tree applying the resolved status/startedAt. `Task` fields are
    // readonly, so new Task values are produced — the parse-time tree is never
    // mutated. Running tasks are collected for the runtime reconcile.
    const tasks = parsed.map((root) =>
      this.resolveTask(root, states, location.name, runningItems),
    );

    // Progress is computed on the status-resolved tree, so `runningCount`
    // reflects the real running tasks (Req 4.1–4.6).
    const { total, completed, progress, runningCount } = computeProgress(tasks);

    return {
      name: location.name,
      path: location.specDir.fsPath,
      tasksFile: location.tasksFile.fsPath,
      tasks,
      total,
      completed,
      progress,
      runningCount,
    };
  }

  /**
   * Produce a NEW `Task` (and recursively its children) with the resolved
   * `status`/`startedAt` applied from `states`. Preserves the model invariant
   * `completed === true ⇒ status !== 'running'`: a checked task is forced to
   * `completed` and never carries `startedAt`, regardless of what the state
   * source reported. Running tasks (with their `startedAt`) are appended to
   * `runningItems` for the end-of-refresh runtime reconcile.
   */
  private resolveTask(
    task: Task,
    states: Map<string, TaskStateInfo>,
    specName: string,
    runningItems: RunningTaskInput[],
  ): Task {
    const children = (task.children ?? []).map((child) =>
      this.resolveTask(child, states, specName, runningItems),
    );

    const info = states.get(task.id);

    // Checkbox completion is authoritative and can never be 'running'
    // (Req 8.2, Task model invariant). Fall back to pending when the source
    // supplied nothing.
    let status = info?.status ?? (task.completed ? 'completed' : 'pending');
    let startedAt = info?.startedAt;

    if (task.completed) {
      status = 'completed';
      startedAt = undefined;
    } else if (status === 'running') {
      // Carry startedAt so the UI/badge can render elapsed; register the task
      // with the runtime (which owns the live per-second elapsed computation).
      runningItems.push({ specName, task, sourceStartedAt: startedAt });
    } else {
      // Non-running, non-completed tasks never carry a startedAt.
      startedAt = undefined;
    }

    return {
      ...task,
      status,
      startedAt,
      children,
    };
  }

  /**
   * Checkbox-only state map (`[x]` → completed, else → pending) for every task
   * in the forest. Used when the state provider fails for a spec so it still
   * renders without running state (never emits 'running').
   */
  private fallbackStates(roots: ReadonlyArray<Task>): Map<string, TaskStateInfo> {
    const states = new Map<string, TaskStateInfo>();
    const walk = (task: Task): void => {
      states.set(task.id, { status: task.completed ? 'completed' : 'pending' });
      for (const child of task.children ?? []) {
        walk(child);
      }
    };
    for (const root of roots) {
      walk(root);
    }
    return states;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
