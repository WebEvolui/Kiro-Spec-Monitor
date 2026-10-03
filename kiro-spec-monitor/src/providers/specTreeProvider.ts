/**
 * SpecTreeProvider — the native `TreeDataProvider` that renders the spec/task
 * tree in the "KIRO SPEC MONITOR" view and performs *targeted* refreshes so the
 * live elapsed timer repaints a single running row without reparsing files or
 * collapsing the tree (design "Timer update strategy").
 *
 * Design mapping:
 * - `TreeNode` is the discriminated union from the design: a `spec` node wraps a
 *   `Spec`, a `task` node wraps a `Task` plus its owning `specName`.
 * - `getChildren` walks the aggregator's ordered spec snapshot → each spec's
 *   top-level tasks → each task's children, preserving the parsed hierarchy
 *   (Req 3.3).
 * - `getTreeItem` composes a non-empty label + description + tooltip (Req 5.7)
 *   using ONLY `ThemeIcon`s (Req 5.2): completed → `check`, running →
 *   `sync~spin`, pending → `circle-outline` (Req 5.3–5.5); a complete spec →
 *   `pass-filled` (Req 5.6). A running task's description is the live elapsed
 *   time (Req 9.1, 9.2, 10.2); non-running tasks carry no elapsed (Req 9.3).
 * - `getParent` is required for `TreeView.reveal()` (design): a top-level task's
 *   parent is its spec node, a nested task's parent is its parent task node, and
 *   a spec node has no parent.
 * - `onTick(keys)` fires a TARGETED `onDidChangeTreeData(node)` per running
 *   taskKey so VS Code re-requests only `getTreeItem` for that node — no full
 *   refresh, so expansion state and selection are preserved and there is no
 *   flicker (Req 10.7, 10.8). A `taskKey → TreeNode` cache built during
 *   `getChildren` lets `onTick` resolve nodes without reparsing.
 *
 * User-facing strings are produced through `vscode.l10n.t(...)` with literal
 * English defaults. The language resolver (task 15.2) will route these through
 * the resolved bundle; keeping every string behind `l10n.t` here means that
 * task does not have to touch this file.
 */

import * as vscode from 'vscode';

import type { Spec } from '../models/Spec';
import type { Task } from '../models/Task';
import type { SpecAggregator } from '../services/specAggregator';
import { isSpecComplete } from '../services/specAggregator';
import { formatElapsed, type TaskRuntimeService } from '../services/taskRuntimeService';

/**
 * A node in the tree: either a spec root or a task (at any depth).
 *
 * `task` nodes carry `specName` so navigation/elapsed lookup can key the task
 * to its owning spec without walking back up the tree.
 */
export type TreeNode =
  | { kind: 'spec'; spec: Spec }
  | { kind: 'task'; specName: string; task: Task };

/** `${specName}::${taskId}` — the stable per-task key shared with the runtime. */
function taskKeyFor(specName: string, taskId: string): string {
  return `${specName}::${taskId}`;
}

/** Clamp an arbitrary number into an integer percentage in `[0, 100]`. */
function toPercent(progress: number): number {
  const pct = Math.round((Number.isFinite(progress) ? progress : 0) * 100);
  if (pct < 0) {
    return 0;
  }
  if (pct > 100) {
    return 100;
  }
  return pct;
}

/**
 * Render a lightweight textual progress bar for an integer percentage in
 * [0, 100]. Uses filled/empty block glyphs so it renders in the native tree
 * without a WebView and reads correctly in light and dark themes.
 *
 * @param pct integer percentage (already clamped to [0, 100])
 * @param width number of segments in the bar (default 10)
 */
function progressBar(pct: number, width = 10): string {
  const clamped = pct < 0 ? 0 : pct > 100 ? 100 : pct;
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export class SpecTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | void> =
    this.onDidChangeTreeDataEmitter.event;

  /**
   * Cache from `${specName}::${taskId}` → the exact `TreeNode` instance last
   * handed to VS Code. Built incrementally during `getChildren` so `onTick` can
   * resolve a running task's node and fire a targeted refresh without reparsing
   * the tree. The same node instance is reused where possible so VS Code's
   * element identity (and thus expansion/selection) stays stable.
   */
  private readonly nodeCache = new Map<string, TreeNode>();

  /** Cache from spec name → its spec `TreeNode`, kept in sync with the snapshot. */
  private readonly specNodeCache = new Map<string, TreeNode>();

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly aggregator: SpecAggregator,
    private readonly runtime: TaskRuntimeService,
  ) {
    // A new spec snapshot means the tree structure may have changed (specs
    // added/removed, tasks added/removed, checkbox state changed): rebuild via a
    // full refresh. The per-tick elapsed updates stay targeted (see onTick).
    this.disposables.push(
      this.aggregator.onDidChangeSpecs(() => this.refreshAll()),
    );
  }

  // --- TreeDataProvider ----------------------------------------------------

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      // Root level: the aggregator's already-ordered specs. Rebuild the spec
      // node cache from scratch so stale specs do not linger.
      this.specNodeCache.clear();
      const specs = this.aggregator.getSpecs();
      return specs.map((spec) => {
        const specNode: TreeNode = { kind: 'spec', spec };
        this.specNodeCache.set(spec.name, specNode);
        return specNode;
      });
    }

    if (node.kind === 'spec') {
      // A spec's children are its top-level tasks.
      return node.spec.tasks.map((task) =>
        this.taskNodeFor(node.spec.name, task),
      );
    }

    // A task's children are its nested tasks (genuine checkbox lines only).
    return (node.task.children ?? []).map((child) =>
      this.taskNodeFor(node.specName, child),
    );
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return node.kind === 'spec'
      ? this.specTreeItem(node.spec)
      : this.taskTreeItem(node.specName, node.task);
  }

  getParent(node: TreeNode): TreeNode | undefined {
    if (node.kind === 'spec') {
      // Spec nodes are roots.
      return undefined;
    }

    const spec = this.aggregator
      .getSpecs()
      .find((s) => s.name === node.specName);
    if (!spec) {
      return undefined;
    }

    // Find the parent task by searching the spec's tree for a task whose
    // children include this node's task. A top-level task has the spec as its
    // parent; a nested task has its containing task.
    const parentTask = this.findParentTask(spec.tasks, node.task);
    if (parentTask) {
      return this.taskNodeFor(node.specName, parentTask);
    }
    return this.specNodeCache.get(node.specName) ?? { kind: 'spec', spec };
  }

  // --- refresh API ---------------------------------------------------------

  /** Fire a TARGETED change for a single node (used by `onTick`). */
  refreshElement(node: TreeNode): void {
    this.onDidChangeTreeDataEmitter.fire(node);
  }

  /** Fire a FULL change: VS Code re-requests the whole tree from the roots. */
  refreshAll(): void {
    // Drop caches so stale task nodes from a previous snapshot are not reused.
    this.nodeCache.clear();
    this.specNodeCache.clear();
    this.onDidChangeTreeDataEmitter.fire();
  }

  /**
   * Handle a runtime tick: for each running `taskKey` (`${specName}::${taskId}`),
   * resolve the cached task node and fire a TARGETED refresh so VS Code recomputes
   * ONLY that row's `getTreeItem` (its elapsed description). No full refresh is
   * performed, so expansion state and selection are preserved and the tree does
   * not flicker (Req 10.7, 10.8).
   *
   * Keys with no cached node (e.g. the owning spec has not been expanded yet, so
   * the task node was never materialized) are skipped: there is nothing visible
   * to repaint, and the node will render with correct elapsed the moment it is
   * first requested.
   */
  onTick(keys: ReadonlyArray<string>): void {
    for (const key of keys) {
      const node = this.nodeCache.get(key);
      if (node) {
        this.onDidChangeTreeDataEmitter.fire(node);
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.onDidChangeTreeDataEmitter.dispose();
    this.nodeCache.clear();
    this.specNodeCache.clear();
  }

  // --- internals -----------------------------------------------------------

  /**
   * Return the cached task node for `(specName, task)` if present (preserving
   * element identity so expansion/selection survive refreshes), else create,
   * cache, and return a new one.
   */
  private taskNodeFor(specName: string, task: Task): TreeNode {
    const key = taskKeyFor(specName, task.id);
    const existing = this.nodeCache.get(key);
    // Reuse the cached node only when it still wraps the current task value, so
    // a status/line change from a new snapshot is reflected. Reference equality
    // is enough because the aggregator produces fresh Task values per refresh.
    if (existing && existing.kind === 'task' && existing.task === task) {
      return existing;
    }
    const node: TreeNode = { kind: 'task', specName, task };
    this.nodeCache.set(key, node);
    return node;
  }

  /** Depth-first search for the task whose `children` contains `target`. */
  private findParentTask(
    roots: ReadonlyArray<Task>,
    target: Task,
  ): Task | undefined {
    for (const root of roots) {
      const children = root.children ?? [];
      if (children.includes(target)) {
        return root;
      }
      const found = this.findParentTask(children, target);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /** Build the `TreeItem` for a spec node. */
  private specTreeItem(spec: Spec): vscode.TreeItem {
    const item = new vscode.TreeItem(
      spec.name,
      spec.tasks.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.contextValue = 'kiroSpecMonitor.spec';
    item.description = this.specBadge(spec);
    item.iconPath = isSpecComplete(spec)
      ? new vscode.ThemeIcon('pass-filled')
      : new vscode.ThemeIcon('book');
    item.tooltip = this.specTooltip(spec);
    item.resourceUri = vscode.Uri.file(spec.tasksFile);
    return item;
  }

  /**
   * Spec-level badge (Req 5.8, 5.9, 9.3, 9.4):
   * - running: `🔄 {runningCount} running • {completed}/{total} tasks`
   * - otherwise: `{completed}/{total} • {pct}%`
   * - no counted tasks (`total === 0`): `0/0 • 0%`
   */
  private specBadge(spec: Spec): string {
    const sep = vscode.l10n.t(' • ');
    const pct = spec.total > 0 ? toPercent(spec.progress) : 0;
    const bar = progressBar(pct);
    const count = vscode.l10n.t('{0}/{1}', spec.completed, spec.total);
    const percent = vscode.l10n.t('{0}%', pct);
    const barChunk = `${bar} ${percent}`;

    if (spec.runningCount > 0) {
      const running = vscode.l10n.t('🔄 {0} running', spec.runningCount);
      return `${running}${sep}${barChunk}${sep}${count}`;
    }

    return `${barChunk}${sep}${count}`;
  }

  /** Human-readable tooltip summarizing a spec's progress (Req 5.7). */
  private specTooltip(spec: Spec): string {
    const pct = spec.total > 0 ? toPercent(spec.progress) : 0;
    const lines: string[] = [
      vscode.l10n.t(
        '{0} of {1} tasks completed ({2}%)',
        spec.completed,
        spec.total,
        pct,
      ),
    ];
    if (spec.runningCount > 0) {
      lines.push(vscode.l10n.t('{0} task(s) running', spec.runningCount));
    } else if (isSpecComplete(spec)) {
      lines.push(vscode.l10n.t('All tasks completed'));
    }
    return lines.join('\n');
  }

  /** Build the `TreeItem` for a task node. */
  private taskTreeItem(specName: string, task: Task): vscode.TreeItem {
    const hasChildren = (task.children ?? []).length > 0;
    const item = new vscode.TreeItem(
      // Label is always non-empty (Req 5.7): the parser guarantees a non-empty
      // id/title, but fall back defensively to a space so VS Code never gets "".
      task.title && task.title.length > 0 ? task.title : ' ',
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    const isRunning = task.status === 'running';

    // Icon via ThemeIcon ONLY (Req 5.2): completed → check, running →
    // sync~spin, pending (and any other V1 state) → circle-outline.
    item.iconPath = this.taskIcon(task.status);

    if (isRunning) {
      // Running: description is the LIVE elapsed time (Req 9.1, 10.2). Prefer
      // the runtime's elapsed (the single source of truth); fall back to the
      // task's own startedAt if the runtime has not reconciled yet.
      const elapsedMs =
        this.runtime.getElapsed(specName, task.id) ??
        (task.startedAt !== undefined ? Date.now() - task.startedAt : 0);
      const elapsed = formatElapsed(elapsedMs);
      const indicator = vscode.l10n.t('🔄 Running');
      // Compose the running indicator + elapsed as the row description so the
      // running highlight is visible alongside the live timer (Req 9.1, 9.2).
      item.description = `${indicator} • ${elapsed}`;
      // A contextValue distinct from non-running tasks lets the view style the
      // running row differently (running highlight — Req 9.2).
      item.contextValue = 'kiroSpecMonitor.task.running';
    } else {
      // Non-running tasks carry NO elapsed description (Req 9.3).
      item.contextValue = 'kiroSpecMonitor.task';
    }

    item.tooltip = this.taskTooltip(specName, task);

    // Clicking a task navigates to its line in tasks.md. The handler is task 13;
    // here we only bind the command id and pass the node as the argument.
    item.command = {
      command: 'kiroSpecMonitor.revealTask',
      title: vscode.l10n.t('Reveal Task'),
      arguments: [{ kind: 'task', specName, task } satisfies TreeNode],
    };

    return item;
  }

  /** Map an abstract task status to its `ThemeIcon` (Req 5.3–5.5). */
  private taskIcon(status: Task['status']): vscode.ThemeIcon {
    switch (status) {
      case 'completed':
        return new vscode.ThemeIcon('check');
      case 'running':
        return new vscode.ThemeIcon('sync~spin');
      default:
        // pending (and any V2 state not rendered in V1) → neutral circle.
        return new vscode.ThemeIcon('circle-outline');
    }
  }

  /** Build a task tooltip reflecting its state (Req 5.7). */
  private taskTooltip(specName: string, task: Task): string {
    switch (task.status) {
      case 'running': {
        const elapsedMs =
          this.runtime.getElapsed(specName, task.id) ??
          (task.startedAt !== undefined ? Date.now() - task.startedAt : 0);
        return vscode.l10n.t('Running for {0}', formatElapsed(elapsedMs));
      }
      case 'completed':
        return vscode.l10n.t('Completed');
      default:
        return vscode.l10n.t('Pending');
    }
  }
}
