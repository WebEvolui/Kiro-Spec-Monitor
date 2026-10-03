/**
 * TaskStateProvider — the key abstraction that decouples the UI from the source
 * of task state.
 *
 * The rest of the extension (aggregator, tree provider) depends ONLY on the
 * abstract `completed | running | pending` state exposed here, never on where
 * that state comes from. Two concrete implementations are provided:
 *
 * - `FallbackStateProvider` — derives state purely from the `tasks.md` checkbox
 *   (`[x]` → completed, `[ ]` → pending) and NEVER emits `running`. Used when
 *   the Kiro internal metadata / `workspaceId` cannot be resolved.
 * - `KiroMetadataStateProvider` — reads Kiro's internal, unofficial, READ-ONLY
 *   metadata under `~/.kiro` and heuristically infers `running`. (The real
 *   metadata reading + `inferStatus` are implemented in task 8.2; this file
 *   currently ships a compiling stub, see the class below.)
 *
 * `createStateProvider` selects between them based on the resolved
 * `workspaceId`: a resolved id → `KiroMetadataStateProvider`, otherwise the
 * `FallbackStateProvider`.
 *
 * `TaskStatus` is NOT redefined here — it is imported from `models/Task.ts`,
 * the single source of truth for the abstract state union.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Task, TaskStatus } from '../models/Task';
import { WorkspaceIdResolver } from './workspaceIdResolver';

/**
 * State for a single task, decoupled from its source.
 *
 * `status` is the abstract state the UI renders. `startedAt`/`rawExecutionStatus`
 * are optional source-supplied extras: `startedAt` drives the live elapsed timer
 * when a task is running; `rawExecutionStatus` surfaces the raw metadata value
 * (e.g. "succeed") for V2 and is unused by the V1 UI.
 */
export interface TaskStateInfo {
  readonly status: TaskStatus;
  /** ms epoch of the most recent execution start, if the source can supply it. */
  readonly startedAt?: number;
  /** Raw executionStatus observed in metadata (e.g. "succeed"); surfaced for V2, unused by V1 UI. */
  readonly rawExecutionStatus?: string;
}

export interface TaskStateProvider {
  /**
   * Returns state for the given tasks of a spec, keyed by `task.id`.
   * MUST default to 'pending' for completed=false and 'completed' for checkbox [x].
   * MUST only return 'running' when it has a trustworthy signal. If unsure, return 'pending'.
   */
  getStates(specName: string, tasks: ReadonlyArray<Task>): Promise<Map<string, TaskStateInfo>>;

  /** Fired when the underlying source changes (debounced upstream). */
  readonly onDidChangeState: vscode.Event<void>;

  /** Drop any cache; next getStates re-reads the source. */
  invalidate(): void;
}

/**
 * Walks a task forest (tasks and all their descendants) applying `visit` to
 * every node. Shared by the providers so completion/running state is derived
 * for the full tree, not just the roots.
 */
function walkTasks(tasks: ReadonlyArray<Task>, visit: (task: Task) => void): void {
  for (const task of tasks) {
    visit(task);
    if (task.children.length > 0) {
      walkTasks(task.children, visit);
    }
  }
}

/**
 * Derives task state purely from the `tasks.md` checkbox:
 * `completed === true` → 'completed', `completed === false` → 'pending'.
 *
 * This provider NEVER emits 'running' — there is no trustworthy running source
 * when it is in use. The completed/pending tree remains fully functional, and
 * the live timer stays inactive (Req 8.7, 13.5).
 *
 * `onDidChangeState` is backed by a real `EventEmitter` (so wiring that
 * subscribes to it works uniformly), and `invalidate()` is a no-op because the
 * state is a pure function of the already-parsed tasks — there is no cache to
 * drop.
 */
export class FallbackStateProvider implements TaskStateProvider {
  private readonly _onDidChangeState = new vscode.EventEmitter<void>();
  readonly onDidChangeState: vscode.Event<void> = this._onDidChangeState.event;

  async getStates(
    _specName: string,
    tasks: ReadonlyArray<Task>,
  ): Promise<Map<string, TaskStateInfo>> {
    const states = new Map<string, TaskStateInfo>();
    walkTasks(tasks, (task) => {
      states.set(task.id, {
        status: task.completed ? 'completed' : 'pending',
      });
    });
    return states;
  }

  /** No cache to drop — state is derived directly from the parsed tasks. */
  invalidate(): void {
    // Intentionally empty: FallbackStateProvider is stateless.
  }

  dispose(): void {
    this._onDidChangeState.dispose();
  }
}

/**
 * Shape of a single execution record inside a task's `executionHistory`.
 * Only `timestamp` matters to V1 running inference (the max picks the latest
 * execution start); the other fields are observed but unused here.
 */
interface MetaExecutionRecord {
  readonly executionId?: string;
  readonly chatSessionId?: string;
  /** ms epoch of when this execution ran. */
  readonly timestamp?: number;
}

/**
 * Shape of a single task entry in `<spec>.meta.json` under `tasks[<taskId>]`.
 * The `<taskId>` KEY equals the checkbox-stripped task text (so it matches
 * `Task.id` exactly). `executionStatus` (e.g. "succeed") is present only on
 * some entries and signals a recorded final outcome.
 */
interface MetaTaskEntry {
  readonly taskId?: string;
  readonly specUri?: string;
  readonly executionHistory?: ReadonlyArray<MetaExecutionRecord>;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly executionStatus?: string;
}

/** Parsed shape of `<spec>.meta.json`: a map of taskId -> entry under `tasks`. */
interface SpecMeta {
  readonly tasks?: Record<string, MetaTaskEntry>;
}

/**
 * Reads Kiro's internal, unofficial, READ-ONLY metadata under `~/.kiro` and
 * heuristically infers the `running` state.
 *
 * For each spec it reads `~/.kiro/tasks/<workspaceId>/<specName>.meta.json`
 * (the `<workspaceId>` is supplied by the resolver via the constructor) and
 * builds a `taskId -> metaEntry` map. `inferStatus` then derives the abstract
 * state per the design's single, isolated running-inference point (case 4).
 *
 * This provider is STRICTLY READ-ONLY — it never writes metadata or `tasks.md`
 * (Req 8.8). On ANY read/parse error for a spec it degrades that whole spec to
 * checkbox-only state (completed → completed, else pending) and never throws
 * (Req 8.3/8.4/13.5, Property 14).
 *
 * The parsed meta is cached per spec name until `invalidate()` drops the cache
 * (the watcher calls `invalidate()` on metadata change — task 14), so the next
 * `getStates` re-reads disk.
 */
export class KiroMetadataStateProvider implements TaskStateProvider {
  private readonly _onDidChangeState = new vscode.EventEmitter<void>();
  readonly onDidChangeState: vscode.Event<void> = this._onDidChangeState.event;

  /**
   * Per-spec cache of the parsed `taskId -> metaEntry` map. A cached `undefined`
   * value means "already read this spec and it degraded to checkbox-only"
   * (missing file or parse error), so we don't re-read it until `invalidate()`.
   */
  private readonly cache = new Map<string, Map<string, MetaTaskEntry> | undefined>();

  constructor(
    private readonly workspaceId: string,
    // Retained for parity with the wiring contract / future providers.
    private readonly context: vscode.ExtensionContext,
  ) {
    void this.context;
  }

  async getStates(
    specName: string,
    tasks: ReadonlyArray<Task>,
  ): Promise<Map<string, TaskStateInfo>> {
    const metaMap = this.getSpecMetaMap(specName);
    const states = new Map<string, TaskStateInfo>();
    walkTasks(tasks, (task) => {
      // `metaMap === undefined` => graceful degradation for the whole spec:
      // inferStatus still returns completed/pending from the checkbox alone.
      const metaEntry = metaMap?.get(task.id);
      states.set(task.id, inferStatus(task, metaEntry));
    });
    return states;
  }

  /**
   * Returns the cached `taskId -> metaEntry` map for `specName`, reading and
   * parsing `<spec>.meta.json` once on first access. Returns `undefined` (and
   * caches it) when the file is missing or cannot be read/parsed, which routes
   * every task of the spec to checkbox-only state via `inferStatus`.
   */
  private getSpecMetaMap(specName: string): Map<string, MetaTaskEntry> | undefined {
    if (this.cache.has(specName)) {
      return this.cache.get(specName);
    }
    const map = this.readSpecMeta(specName);
    this.cache.set(specName, map);
    return map;
  }

  /**
   * Read + parse `~/.kiro/tasks/<workspaceId>/<specName>.meta.json` into a
   * `taskId -> metaEntry` map. READ-ONLY. Returns `undefined` on ANY read/parse
   * error or unexpected shape so the caller degrades the spec gracefully; never
   * throws (Property 14).
   */
  private readSpecMeta(specName: string): Map<string, MetaTaskEntry> | undefined {
    try {
      const metaPath = path.join(
        os.homedir(),
        '.kiro',
        'tasks',
        this.workspaceId,
        `${specName}.meta.json`,
      );
      const raw = fs.readFileSync(metaPath, 'utf8');
      const parsed = JSON.parse(raw) as SpecMeta;
      const tasks = parsed?.tasks;
      if (tasks === null || typeof tasks !== 'object') {
        return undefined;
      }
      const map = new Map<string, MetaTaskEntry>();
      for (const [taskId, entry] of Object.entries(tasks)) {
        if (entry !== null && typeof entry === 'object') {
          map.set(taskId, entry as MetaTaskEntry);
        }
      }
      return map;
    } catch {
      // Missing file, bad JSON, or any other read error => degrade this spec.
      return undefined;
    }
  }

  /** Drop the cached metadata so the next `getStates` re-reads disk. */
  invalidate(): void {
    this.cache.clear();
    this._onDidChangeState.fire();
  }

  dispose(): void {
    this._onDidChangeState.dispose();
  }
}

/**
 * Infers the abstract `TaskStateInfo` for a single task from its checkbox and
 * its (possibly absent) metadata entry — the design's `inferStatus` algorithm.
 *
 * This is the SINGLE, isolated running-inference point (Property 13): `running`
 * is returned ONLY in case 4 (unchecked + has executionHistory + no final
 * executionStatus). Running is never inferred from the next pending task, a
 * bare `[ ]`, a recently-modified file, or an open file (Req 8.6).
 *
 * Precondition: `task.id` equals the metadata key (both are the
 * checkbox-stripped task text).
 */
export function inferStatus(
  task: Task,
  metaEntry: MetaTaskEntry | undefined,
): TaskStateInfo {
  // 1. Checkbox is authoritative for completion — completed is never running
  //    (Req 8.2, Property 12).
  if (task.completed) {
    return { status: 'completed', rawExecutionStatus: metaEntry?.executionStatus };
  }

  // 2. No metadata / no execution history => cannot know running => pending
  //    (Req 8.3).
  const history = metaEntry?.executionHistory;
  if (!metaEntry || !history || history.length === 0) {
    return { status: 'pending' };
  }

  // 3. A recorded final outcome means NOT running; V1 collapses the unchecked
  //    task to pending while surfacing the raw status (Req 8.4). V2 maps
  //    "failed" here.
  const final = metaEntry.executionStatus;
  if (final !== undefined && final !== '') {
    return { status: 'pending', rawExecutionStatus: final };
  }

  // 4. Heuristic running: unchecked, has execution history, no final status.
  //    startedAt is the latest execution timestamp (Req 8.5, Property 13).
  let latestTimestamp: number | undefined;
  for (const record of history) {
    const ts = record?.timestamp;
    if (typeof ts === 'number' && (latestTimestamp === undefined || ts > latestTimestamp)) {
      latestTimestamp = ts;
    }
  }
  return { status: 'running', startedAt: latestTimestamp };
}

/**
 * Selects the concrete `TaskStateProvider` for the current workspace: when the
 * resolver yields a `workspaceId` the Kiro-metadata provider is used, otherwise
 * the checkbox-only `FallbackStateProvider` (Req 8.7, 13.5).
 *
 * Resolution is awaited once here; the watcher re-runs this on refresh so a
 * newly created spec can later establish the correlation.
 */
export async function createStateProvider(
  resolver: WorkspaceIdResolver,
  context: vscode.ExtensionContext,
): Promise<TaskStateProvider> {
  const workspaceId = await resolver.resolve();
  if (workspaceId) {
    return new KiroMetadataStateProvider(workspaceId, context);
  }
  return new FallbackStateProvider();
}
