/**
 * TaskRuntimeService — owns the *runtime* (not logical) state of running tasks:
 * a per-task `startedAt`, the single shared 1-second tick interval, elapsed-time
 * formatting, and persistence of `startedAt` across sidebar close/reopen.
 *
 * This service is deliberately thin and never touches `tasks.md`: it computes
 * elapsed time as pure arithmetic (`Date.now() - startedAt`) and the parser is
 * never invoked on a tick (Req 10.7 / Property 16). Logical state
 * (completed/running/pending) is owned by the `TaskStateProvider`; this service
 * only cares about *when* a running task started and *for how long* it has run.
 *
 * Timer discipline (Req 10.9 / Property 15): there is EXACTLY ONE
 * `setInterval(1000)` and it is active if and only if at least one task is
 * running. The instant the running set empties, the interval is cleared.
 *
 * Persistence (Req 10.5 / 10.6 / Property 17): each running task's
 * `{ taskKey, startedAt, executionId }` is written to `workspaceState`. On a
 * later reconcile the persisted `startedAt` is reused ONLY when the current
 * execution's `executionId` matches the persisted one; otherwise a fresh
 * `startedAt` is adopted (from `sourceStartedAt`, else `Date.now()`) so no
 * misleading prior time is ever shown.
 */

import * as vscode from 'vscode';
import { Task } from '../models/Task';

/** Persisted runtime record for a single running task. */
export interface RunningTaskRuntime {
  /** `${specName}::${taskId}`. */
  readonly taskKey: string;
  /** ms epoch of execution start. */
  readonly startedAt: number;
  /**
   * Identifier of the execution the `startedAt` belongs to. A persisted
   * `startedAt` is reused only when the current execution's id matches this.
   */
  readonly executionId: string;
}

/** A currently-running task as reported by the aggregator to `reconcile`. */
export interface RunningTaskInput {
  readonly specName: string;
  readonly task: Task;
  /** Detected start timestamp from the metadata source, if available. */
  readonly sourceStartedAt?: number;
  /**
   * Optional explicit execution identifier for this run. When omitted it is
   * derived from `sourceStartedAt` (a stable execution has a stable detected
   * start), so the same execution reuses its persisted `startedAt` across
   * sidebar close/reopen while a new execution adopts a fresh one.
   */
  readonly executionId?: string;
}

export interface TaskRuntimeService {
  /** Reconcile the full set of currently-running tasks (with optional source startedAt). */
  reconcile(running: ReadonlyArray<RunningTaskInput>): void;

  /** Elapsed ms for a running task, or undefined if not running. */
  getElapsed(specName: string, taskId: string): number | undefined;

  /** Fires with the set of taskKeys needing a targeted repaint (every ~1s while any task runs). */
  readonly onTick: vscode.Event<ReadonlyArray<string>>;

  dispose(): void;
}

/** `${specName}::${taskId}` — the stable per-task runtime key. */
function taskKeyFor(specName: string, taskId: string): string {
  return `${specName}::${taskId}`;
}

/** Key under which the array of `RunningTaskRuntime` records is persisted. */
const STATE_KEY = 'kiroSpecMonitor.runningTasks';

const pad = (n: number): string => n.toString().padStart(2, '0');

/**
 * Format an elapsed duration (ms) exactly per the design:
 * - `${s}s` for durations under 60 seconds (e.g. "12s", "58s")
 * - `${m}m ${pad(s)}s` for 60s..<60min (e.g. "1m 04s", "12m 38s")
 * - `${h}h ${pad(m)}m` for 60min and above (e.g. "1h 03m")
 * Negative inputs are clamped to 0 so the formatter is total and never negative.
 */
export function formatElapsed(ms: number): string {
  const safeMs = ms > 0 ? ms : 0;
  const totalSec = Math.floor(safeMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  if (h > 0) {
    return `${h}h ${pad(m)}m`;
  }
  if (m > 0) {
    return `${m}m ${pad(s)}s`;
  }
  return `${s}s`;
}

/**
 * Internal per-task runtime entry held in memory while the task runs.
 */
interface RuntimeEntry {
  readonly startedAt: number;
  readonly executionId: string;
}

export class TaskRuntimeServiceImpl implements TaskRuntimeService {
  private readonly state: vscode.Memento;

  /** taskKey -> runtime entry for the currently-running tasks only. */
  private readonly running = new Map<string, RuntimeEntry>();

  private readonly onTickEmitter = new vscode.EventEmitter<ReadonlyArray<string>>();
  readonly onTick = this.onTickEmitter.event;

  /** The single shared tick interval; non-null iff at least one task runs. */
  private interval: ReturnType<typeof setInterval> | undefined;

  /**
   * @param context the extension's `workspaceState` Memento (the design shows
   *   `new TaskRuntimeService(context.workspaceState)`), or an `ExtensionContext`
   *   from which `workspaceState` is taken.
   */
  constructor(context: vscode.Memento | vscode.ExtensionContext) {
    this.state = isExtensionContext(context) ? context.workspaceState : context;
    // Hydrate the in-memory map from persisted records so an execution that was
    // running when the sidebar closed can keep its original startedAt, subject
    // to the executionId match check performed on the next reconcile.
    for (const rec of this.loadPersisted()) {
      this.running.set(rec.taskKey, { startedAt: rec.startedAt, executionId: rec.executionId });
    }
    // Do not start the interval here: it is activated by reconcile only when the
    // running set is non-empty (Property 15). Hydrated-but-unconfirmed entries
    // are reconciled (and possibly dropped) on the first refresh.
  }

  /**
   * Reconcile the complete running set.
   *
   * Postconditions:
   * - every newly-running task gets a `startedAt` set once (reused from
   *   persistence iff same `executionId`, else `sourceStartedAt`, else
   *   `Date.now()`);
   * - tasks no longer running have their `startedAt` cleared and are removed
   *   from persistence (Req 10.4);
   * - the tick interval is active iff the running set is non-empty.
   * Loop invariant: after processing, the running key set equals exactly the
   * set of taskKeys in `running`.
   */
  reconcile(running: ReadonlyArray<RunningTaskInput>): void {
    const next = new Map<string, RuntimeEntry>();

    for (const item of running) {
      const key = taskKeyFor(item.specName, item.task.id);
      // Last write wins for duplicate keys in the input; the final set still
      // satisfies the loop invariant (keys === set of input taskKeys).
      next.set(key, this.resolveEntry(key, item));
    }

    // Swap the in-memory running set to exactly the reconciled set.
    this.running.clear();
    for (const [key, entry] of next) {
      this.running.set(key, entry);
    }

    this.persist();
    this.updateIntervalActivity();
  }

  /**
   * Elapsed ms for a running task (`Date.now() - startedAt`), or `undefined`
   * when the task is not currently running. Pure arithmetic — no file I/O,
   * never reparses `tasks.md` (Req 10.7 / Property 16).
   */
  getElapsed(specName: string, taskId: string): number | undefined {
    const entry = this.running.get(taskKeyFor(specName, taskId));
    if (!entry) {
      return undefined;
    }
    return Date.now() - entry.startedAt;
  }

  dispose(): void {
    this.clearInterval();
    this.onTickEmitter.dispose();
  }

  // --- internals -----------------------------------------------------------

  /**
   * Decide the runtime entry for a (possibly already known) task key, honoring
   * the startedAt-reuse rule (Property 17):
   * - reuse the persisted/in-memory `startedAt` iff the executionId matches;
   * - otherwise adopt `sourceStartedAt` if present, else `Date.now()`.
   */
  private resolveEntry(key: string, item: RunningTaskInput): RuntimeEntry {
    const executionId = this.deriveExecutionId(item);
    const existing = this.running.get(key);
    if (existing && existing.executionId === executionId) {
      // Same execution → keep the original startedAt (set once per execution).
      return existing;
    }
    // New or changed execution → adopt a fresh startedAt; never show a stale time.
    const startedAt = item.sourceStartedAt ?? Date.now();
    return { startedAt, executionId };
  }

  /**
   * Derive a stable execution identifier for a running item. An explicit
   * `executionId` wins; otherwise it is derived from the detected
   * `sourceStartedAt` (a stable execution has a stable detected start). With no
   * signal at all a fresh unique id is used so persistence is never reused for
   * an unidentifiable run (no misleading prior time — Req 10.6).
   */
  private deriveExecutionId(item: RunningTaskInput): string {
    if (item.executionId !== undefined) {
      return item.executionId;
    }
    if (item.sourceStartedAt !== undefined) {
      return `src:${item.sourceStartedAt}`;
    }
    return `anon:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }

  /** Load persisted records defensively (tolerate absent/malformed state). */
  private loadPersisted(): RunningTaskRuntime[] {
    const raw = this.state.get<unknown>(STATE_KEY);
    if (!Array.isArray(raw)) {
      return [];
    }
    const records: RunningTaskRuntime[] = [];
    for (const entry of raw) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as RunningTaskRuntime).taskKey === 'string' &&
        typeof (entry as RunningTaskRuntime).startedAt === 'number' &&
        typeof (entry as RunningTaskRuntime).executionId === 'string'
      ) {
        const rec = entry as RunningTaskRuntime;
        records.push({ taskKey: rec.taskKey, startedAt: rec.startedAt, executionId: rec.executionId });
      }
    }
    return records;
  }

  /** Persist the current running set; tasks no longer running are removed. */
  private persist(): void {
    const records: RunningTaskRuntime[] = [];
    for (const [taskKey, entry] of this.running) {
      records.push({ taskKey, startedAt: entry.startedAt, executionId: entry.executionId });
    }
    // Fire-and-forget: Memento.update returns a Thenable; persistence failures
    // must not break the live UI.
    void this.state.update(STATE_KEY, records);
  }

  /** Keep exactly one interval, active iff the running set is non-empty. */
  private updateIntervalActivity(): void {
    const shouldRun = this.running.size > 0;
    if (shouldRun && this.interval === undefined) {
      this.interval = setInterval(() => this.tick(), 1000);
    } else if (!shouldRun && this.interval !== undefined) {
      this.clearInterval();
    }
  }

  /** On each tick fire onTick with the current running taskKeys. */
  private tick(): void {
    if (this.running.size === 0) {
      // Defensive: should not happen since the interval is cleared when empty.
      this.clearInterval();
      return;
    }
    this.onTickEmitter.fire(Array.from(this.running.keys()));
  }

  private clearInterval(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }
}

/** Narrow a Memento-or-ExtensionContext to the ExtensionContext case. */
function isExtensionContext(
  value: vscode.Memento | vscode.ExtensionContext,
): value is vscode.ExtensionContext {
  return (value as vscode.ExtensionContext).workspaceState !== undefined;
}
