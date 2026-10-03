import * as vscode from 'vscode';

import { WorkspaceIdResolver } from './services/workspaceIdResolver';
import { createStateProvider } from './services/taskStateProvider';
import { TaskRuntimeServiceImpl } from './services/taskRuntimeService';
import { FindFilesSpecScanner } from './services/specScanner';
import { DefaultTaskParser } from './services/taskParser';
import { DefaultSpecAggregator } from './services/specAggregator';
import { SpecWatcher } from './services/specWatcher';
import { SpecTreeProvider } from './providers/specTreeProvider';
import {
  refresh,
  openTasksFile,
  revealTask,
  collapseAll,
  openSpecFolder,
} from './commands';

/** The id of the tree view contributed in package.json. */
const VIEW_ID = 'kiroSpecMonitor.view';

/**
 * Entry point of the Kiro Spec Monitor extension.
 *
 * Task 12.2: wire the real data pipeline into the view.
 *
 *   resolver → stateProvider → runtime → aggregator → treeProvider → view
 *
 * `activate` is async because `createStateProvider` resolves the (optional)
 * Kiro `workspaceId` asynchronously to pick the Kiro-metadata provider vs the
 * checkbox fallback. VS Code supports an activate that returns a Promise, so the
 * registration still completes and all disposables are pushed before the first
 * `aggregator.refresh()`.
 *
 * Task 13.2: all five commands are registered here, each delegating to its
 * handler in `src/commands/index.ts` (the aggregator is passed where the handler
 * needs it). The task `TreeItem` already binds `kiroSpecMonitor.revealTask` with
 * a `{ kind: 'task', specName, task }` node (task 12.1), so a task click now
 * invokes the registered `revealTask` handler.
 *
 * Task 14.2: the `SpecWatcher` (file + ~/.kiro metadata watching, task 14.1) is
 * constructed with the aggregator + state provider and pushed to
 * `context.subscriptions`, so its `dispose()` tears down the FileSystemWatcher,
 * the `fs.watch` handles, and the debounce timer on `deactivate` (Req 7.1).
 *
 * Task 16.1: finalize wiring and disposal.
 *
 *  - A dedicated "Kiro Spec Monitor" output channel is created and registered
 *    for diagnostics (Req 13.6). It replaces noisy notifications: activation and
 *    any activation failure are logged here instead of thrown out of `activate`.
 *
 *  - Disposal is complete and verified. Every disposable is pushed to
 *    `context.subscriptions` so VS Code disposes them on `deactivate`:
 *      • `view`          — the TreeView.
 *      • `runtime`       — `dispose()` clears the single 1s `setInterval` (Req
 *                          10.9) and disposes the tick emitter.
 *      • `aggregator`    — unsubscribes its state/runtime listeners.
 *      • `treeProvider`  — disposes its `onDidChangeTreeData` emitter.
 *      • `watcher`       — `dispose()` tears down the FileSystemWatcher, closes
 *                          the `fs.watch` handles, and clears the debounce timer
 *                          (Req 7.1).
 *      • `tickSubscription`, the five command registrations, and the output
 *        channel.
 *    `deactivate` therefore needs no manual teardown.
 *
 *  - READ-ONLY GUARANTEE (Req 8.8, 14.1, 14.2, 14.3): nothing wired here ever
 *    writes to a workspace `tasks.md` or to anything under `~/.kiro`. Those
 *    paths are opened/parsed/watched READ-ONLY. The ONLY persistence the
 *    extension performs is to its own `context.workspaceState` (the runtime's
 *    `startedAt`/`executionId`, Req 10.5) — explicitly allowed. No write call to
 *    `tasks.md` or `~/.kiro` exists on any code path, and none is added here.
 *
 *  - Robustness: the whole activation body is wrapped so a failure in
 *    `createStateProvider` or the initial `aggregator.refresh()` is logged to the
 *    output channel rather than thrown out of `activate`, and the view/commands
 *    are registered BEFORE the initial refresh so they always exist even if that
 *    first refresh fails.
 *
 *  - i18n (pt/en, Req 15): left as-is. Runtime strings route through
 *    `vscode.l10n` and declarative titles through `package.nls*.json`, both
 *    resolved automatically from the editor language — no wiring change needed.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Dedicated diagnostics channel (Req 13.6). Registered first so it is
  // available to log any failure in the rest of activation, and disposed with
  // the extension via context.subscriptions.
  const output = vscode.window.createOutputChannel('Kiro Spec Monitor');
  context.subscriptions.push(output);

  try {
    // 1. Resolve the opaque Kiro workspaceId (may be undefined → fallback state).
    const resolver = new WorkspaceIdResolver(context);

    // 2. Pick the concrete state provider (Kiro-metadata vs checkbox fallback).
    //    READ-ONLY: reads workspace spec names and ~/.kiro/spec-sessions only.
    const stateProvider = await createStateProvider(resolver, context);

    // 3. The timer core: owns per-task elapsed and the single 1s tick interval.
    //    Persists only to context.workspaceState (allowed); never to ~/.kiro.
    const runtime = new TaskRuntimeServiceImpl(context.workspaceState);

    // 4. Compose scanner + parser + state + runtime into ordered Spec[].
    //    READ-ONLY: the scanner globs and the parser reads tasks.md text only.
    const aggregator = new DefaultSpecAggregator(
      new FindFilesSpecScanner(),
      new DefaultTaskParser(),
      stateProvider,
      runtime,
    );

    // 5. The tree renderer. It subscribes itself to aggregator.onDidChangeSpecs
    //    (full refresh on structural changes) in its constructor.
    const treeProvider = new SpecTreeProvider(aggregator, runtime);

    // 6. Real-time updates (Req 7.1): watch workspace tasks.md files and the
    //    ~/.kiro metadata dirs, debouncing bursts into a single aggregator
    //    refresh (and state-cache invalidation for metadata changes). The
    //    watcher needs both the aggregator (to refresh) and the state provider
    //    (to invalidate). Constructed before the initial refresh so no future
    //    event is missed; it only reacts to events that occur after
    //    construction. READ-ONLY: it observes file events, never writes.
    const watcher = new SpecWatcher(aggregator, stateProvider);

    // Register the Activity Bar view (Req 5.1).
    const view = vscode.window.createTreeView(VIEW_ID, {
      treeDataProvider: treeProvider,
      showCollapseAll: true,
    });

    // Per-second ticks drive TARGETED repaints of only the running rows so the
    // live elapsed timer updates without a full tree refresh (Req 10.8).
    const tickSubscription = runtime.onTick((keys) => treeProvider.onTick(keys));

    // Register all five commands, delegating to the handlers in src/commands.
    // The aggregator is threaded through to the handlers that need it. There is
    // exactly ONE registration of `kiroSpecMonitor.refresh` (Req 12.1, 12.2).
    const refreshCommand = vscode.commands.registerCommand(
      'kiroSpecMonitor.refresh',
      () => refresh(aggregator),
    );
    const openTasksFileCommand = vscode.commands.registerCommand(
      'kiroSpecMonitor.openTasksFile',
      (arg) => openTasksFile(arg, aggregator),
    );
    // Clicking a task invokes this with the `{ kind: 'task', specName, task }`
    // TreeNode bound by the task TreeItem (task 12.1) — the shape `revealTask`
    // expects (Req 6.1).
    const revealTaskCommand = vscode.commands.registerCommand(
      'kiroSpecMonitor.revealTask',
      (node) => revealTask(node, aggregator),
    );
    const collapseAllCommand = vscode.commands.registerCommand(
      'kiroSpecMonitor.collapseAll',
      () => collapseAll(),
    );
    const openSpecFolderCommand = vscode.commands.registerCommand(
      'kiroSpecMonitor.openSpecFolder',
      (arg) => openSpecFolder(arg, aggregator),
    );

    // Register EVERY disposable BEFORE the initial refresh so the view and
    // commands exist even if that first refresh fails (robustness, Req 1.4).
    context.subscriptions.push(
      view,
      runtime,
      aggregator,
      treeProvider,
      watcher,
      tickSubscription,
      refreshCommand,
      openTasksFileCommand,
      revealTaskCommand,
      openSpecFolderCommand,
      collapseAllCommand,
    );

    output.appendLine('Kiro Spec Monitor activated.');

    // Initial population of the view. A failure here must not tear down the
    // already-registered view/commands — log it and leave the empty view in
    // place (the file/metadata watchers will refresh on the next change).
    try {
      await aggregator.refresh();
    } catch (err) {
      output.appendLine(`Initial refresh failed: ${describeError(err)}`);
    }
  } catch (err) {
    // Any failure constructing the pipeline (e.g. createStateProvider) is logged
    // to the diagnostics channel rather than thrown out of activate, so the
    // extension host does not surface a crash notification.
    output.appendLine(`Activation failed: ${describeError(err)}`);
  }
}

export function deactivate(): void {
  // Nothing to clean up here: every disposable (output channel, view, runtime
  // interval, aggregator, treeProvider, watcher, tick subscription, commands)
  // is registered in context.subscriptions and disposed by VS Code on
  // deactivate. The runtime's 1s interval is cleared by runtime.dispose() and
  // the watchers are torn down by watcher.dispose().
}

/** Render an unknown thrown value as a diagnostic string for the output channel. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  return String(err);
}
