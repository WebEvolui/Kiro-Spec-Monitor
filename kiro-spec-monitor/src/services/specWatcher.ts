/**
 * SpecWatcher — wires the two change sources that drive real-time updates
 * (Req 7) and funnels every event through a single debounce so bursts during
 * active editing or task execution coalesce into one refresh.
 *
 * Two sources are watched:
 *
 *  1. Workspace `tasks.md` files, via a `vscode.FileSystemWatcher` on the glob
 *     `**​/.kiro/specs/**​/tasks.md`. Create/change/delete of a `tasks.md`
 *     covers: checkbox state changes (Req 7.2), a `tasks.md` being created or
 *     changed (Req 7.5), tasks added/removed within a file (Req 7.6), and — via
 *     the create/delete of a spec's `tasks.md` — new specs appearing and removed
 *     specs disappearing (Req 7.1, 7.3, 7.4). On any such event the aggregator
 *     re-scans and re-parses (`aggregator.refresh()`).
 *
 *  2. Kiro's internal, unofficial execution metadata under `~/.kiro`
 *     (`~/.kiro/tasks` and `~/.kiro/spec-sessions`), via node `fs.watch`. This
 *     is the running-state source. On a metadata change the cached state is
 *     dropped (`stateProvider.invalidate()`) and then a refresh is triggered so
 *     running/pending transitions are reflected. These directories are
 *     Kiro-version-specific and may not exist; each watcher is guarded with
 *     try/catch and skipped gracefully (never throws) when absent.
 *
 * All events — from both sources — are DEBOUNCED (~300ms, per the design's
 * "Running detection + live timer" sequence and Performance Considerations) by
 * a single shared `setTimeout` so a flurry of saves/metadata writes collapses
 * into exactly one refresh (Req 7.7). Because a metadata event must invalidate
 * the state cache before the refresh re-reads it, a pending metadata
 * invalidation is remembered and applied when the debounced refresh fires.
 *
 * This service is strictly read-only: it never writes to `tasks.md` or to
 * `~/.kiro`. It implements `vscode.Disposable` so it can be pushed to
 * `context.subscriptions`; `dispose()` tears down the FileSystemWatcher, closes
 * the `fs.watch` watchers, and clears any pending debounce timer.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { SpecAggregator } from './specAggregator';
import type { TaskStateProvider } from './taskStateProvider';

/** Debounce window for coalescing change bursts (design says 300ms, Req 7.7). */
const DEBOUNCE_MS = 300;

export class SpecWatcher implements vscode.Disposable {
  /** FileSystemWatcher on `**​/.kiro/specs/**​/tasks.md` (Req 7.1). */
  private readonly fileWatcher: vscode.FileSystemWatcher;

  /** node `fs.watch` handles on the `~/.kiro` metadata dirs (may be empty). */
  private readonly metaWatchers: fs.FSWatcher[] = [];

  /** The pending debounce timer, or undefined when idle. */
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Whether a metadata event is part of the currently-pending debounce. When
   * true the debounced refresh invalidates the state cache before refreshing
   * so the running state is re-read from `~/.kiro` (Req 7.2 running source).
   */
  private metadataChangePending = false;

  /** Set once `dispose()` runs so a late debounce callback is a no-op. */
  private disposed = false;

  constructor(
    private readonly aggregator: SpecAggregator,
    private readonly stateProvider: TaskStateProvider,
  ) {
    // --- Source 1: workspace tasks.md files (Req 7.1, 7.5) ---
    // The glob catches tasks.md across every spec in every workspace folder.
    // create/delete additionally cover new/removed specs (Req 7.3, 7.4).
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      '**/.kiro/specs/**/tasks.md',
    );
    this.fileWatcher.onDidCreate(() => this.onTasksFileEvent());
    this.fileWatcher.onDidChange(() => this.onTasksFileEvent());
    this.fileWatcher.onDidDelete(() => this.onTasksFileEvent());

    // --- Source 2: Kiro internal metadata under ~/.kiro (Req 7.2) ---
    this.setupMetadataWatchers();
  }

  /**
   * Attempt to watch each `~/.kiro` metadata directory. Each watch is isolated
   * in its own try/catch so a missing directory (common — these are
   * Kiro-version-specific and may not exist) is skipped without throwing. A
   * directory watch is recursive so nested per-workspace/per-spec files
   * (`~/.kiro/tasks/<workspaceId>/<spec>.meta.json`) are observed.
   */
  private setupMetadataWatchers(): void {
    const home = os.homedir();
    const metadataDirs = [
      path.join(home, '.kiro', 'tasks'),
      path.join(home, '.kiro', 'spec-sessions'),
    ];

    for (const dir of metadataDirs) {
      try {
        const watcher = fs.watch(dir, { recursive: true }, () => {
          this.onMetadataEvent();
        });
        // If the directory later disappears, degrade silently rather than
        // letting the watcher's error bubble up.
        watcher.on('error', () => {
          /* ignore: directory removed or became unreadable */
        });
        this.metaWatchers.push(watcher);
      } catch {
        // Directory doesn't exist / can't be watched (e.g. no Kiro metadata
        // yet). Skip gracefully — the completed/pending view still works.
      }
    }
  }

  /** A `tasks.md` was created/changed/deleted → debounce an aggregator refresh. */
  private onTasksFileEvent(): void {
    this.scheduleRefresh();
  }

  /**
   * A `~/.kiro` metadata file changed → remember to invalidate the state cache,
   * then debounce a refresh. The invalidation is deferred to the debounced
   * callback so a burst of metadata writes invalidates/refreshes only once.
   */
  private onMetadataEvent(): void {
    this.metadataChangePending = true;
    this.scheduleRefresh();
  }

  /**
   * Shared debounce: (re)arm a single timer so events from either source that
   * arrive within `DEBOUNCE_MS` collapse into one refresh (Req 7.7).
   */
  private scheduleRefresh(): void {
    if (this.disposed) {
      return;
    }
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.runRefresh();
    }, DEBOUNCE_MS);
  }

  /**
   * Perform the coalesced refresh. If a metadata change was part of the batch,
   * drop the cached state first so running/pending is re-read from `~/.kiro`
   * before the aggregator rebuilds the tree. `aggregator.refresh()` is
   * documented never to throw, but guard anyway so a watcher-driven refresh can
   * never surface an unhandled rejection.
   */
  private async runRefresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.metadataChangePending) {
      this.metadataChangePending = false;
      try {
        this.stateProvider.invalidate();
      } catch {
        // Invalidation must never break the refresh.
      }
    }
    try {
      await this.aggregator.refresh();
    } catch {
      // Defense in depth: never let a background refresh throw.
    }
  }

  /** Tear down both sources and clear any pending debounce timer. */
  dispose(): void {
    this.disposed = true;

    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    this.fileWatcher.dispose();

    for (const watcher of this.metaWatchers) {
      try {
        watcher.close();
      } catch {
        // Already closed / errored — ignore.
      }
    }
    this.metaWatchers.length = 0;
  }
}
