/**
 * Command handler functions for the "KIRO SPEC MONITOR" view.
 *
 * These are the pure-ish handler implementations; wiring them to
 * `vscode.commands.registerCommand` happens in `extension.ts` (task 13.2). Each
 * handler takes its dependencies (the aggregator, etc.) as explicit parameters
 * or is a thin wrapper so registration can bind them without this module
 * importing the extension entry point.
 *
 * Design mapping:
 * - `revealTask(node)` — open the spec's `tasks.md`, place the cursor on the
 *   task's 0-based line, and center it (design "Example Usage"). Missing/
 *   unreadable file → abort, preserve editor state, show an error (Req 6.4).
 *   Out-of-range line → clamp into `[0, lineCount-1]` WITHOUT error (Req 6.5).
 * - `openTasksFile(nodeOrSpec, aggregator)` — open the selected spec's
 *   `tasks.md`. No resolvable spec → "No spec selected." and leave the view
 *   unchanged (Req 12.3). Missing file → "not found" and leave unchanged.
 * - `collapseAll()` — delegate to the built-in tree collapse command (Req 12.5).
 * - `openSpecFolder(nodeOrSpec)` — reveal the spec folder in the OS file
 *   manager (Req 12.6). Missing folder → message.
 * - `refresh(aggregator)` — delegate to `aggregator.refresh()` (Req 12.2).
 *
 * User-facing strings go through `vscode.l10n.t(...)` with English defaults so
 * the language resolver (task 15.2) routes them through the resolved bundle.
 */

import * as vscode from 'vscode';

import type { Spec } from '../models/Spec';
import type { Task } from '../models/Task';
import type { SpecAggregator } from '../services/specAggregator';
import type { TreeNode } from '../providers/specTreeProvider';

/**
 * The built-in command id VS Code registers for a `showCollapseAll` tree view.
 * The pattern is `workbench.actions.treeView.<viewId>.collapseAll`; our view id
 * is `kiroSpecMonitor.view` (see `package.json` contributions).
 */
export const COLLAPSE_ALL_COMMAND_ID =
  'workbench.actions.treeView.kiroSpecMonitor.view.collapseAll';

/**
 * Clamp a 0-based line index into a document with `lineCount` lines.
 *
 * Pure helper (unit-tested in task 13.3). Returns a line in `[0, lineCount-1]`:
 * - `line < 0` → `0` (open at the first line);
 * - `line > lastLine` → `lastLine` (`lineCount - 1`);
 * - a degenerate `lineCount <= 0` → `0` (a document always has at least one
 *   line in practice; this keeps the helper total).
 *
 * No error is raised for out-of-range input — the caller still navigates to a
 * valid line (Req 6.5).
 */
export function clampLine(line: number, lineCount: number): number {
  const lastLine = lineCount - 1;
  if (!Number.isFinite(line) || line < 0) {
    return 0;
  }
  if (lastLine < 0) {
    return 0;
  }
  if (line > lastLine) {
    return lastLine;
  }
  // Normalize any fractional input down to a whole line index.
  return Math.floor(line);
}

/**
 * Narrow an argument that may be a `TreeNode`, a bare `Spec`, or `undefined`
 * into a `Spec` using the aggregator's current snapshot.
 *
 * Commands can be invoked from the tree (passing a `TreeNode`), from the
 * command palette (passing nothing), or programmatically (passing a `Spec`).
 * Returns `undefined` when no spec can be resolved.
 */
function resolveSpec(
  arg: TreeNode | Spec | undefined,
  aggregator: SpecAggregator,
): Spec | undefined {
  if (arg && typeof arg === 'object' && 'kind' in arg) {
    // It's a TreeNode.
    if (arg.kind === 'spec') {
      return arg.spec;
    }
    // A task node: resolve its owning spec by name from the snapshot.
    return aggregator.getSpecs().find((s) => s.name === arg.specName);
  }

  if (arg && typeof arg === 'object' && 'tasksFile' in arg) {
    // It's already a Spec.
    return arg as Spec;
  }

  // No argument (e.g. palette invocation): fall back to the single spec when
  // there is exactly one, otherwise there is nothing unambiguous to open.
  const specs = aggregator.getSpecs();
  return specs.length === 1 ? specs[0] : undefined;
}

/** Narrow a `revealTask` argument into its `{ specName, task }` payload. */
function asTaskNode(
  arg: TreeNode | { specName: string; task: Task } | undefined,
): { specName: string; task: Task } | undefined {
  if (!arg || typeof arg !== 'object') {
    return undefined;
  }
  if ('kind' in arg) {
    return arg.kind === 'task'
      ? { specName: arg.specName, task: arg.task }
      : undefined;
  }
  if ('task' in arg && 'specName' in arg) {
    return arg;
  }
  return undefined;
}

/**
 * Open the task's `tasks.md`, move the cursor to its 0-based line, and center
 * the line in the viewport (Req 6.1, 6.2, 6.3).
 *
 * The spec's `tasksFile` fsPath is read directly from the task node, so this
 * works without the aggregator. If the file is missing/unreadable, navigation
 * is aborted, the current editor state is preserved (nothing is opened), and an
 * error message is shown (Req 6.4). An out-of-range `line` is clamped to a
 * valid line WITHOUT raising an error (Req 6.5).
 */
export async function revealTask(
  node: TreeNode | { specName: string; task: Task } | undefined,
  aggregator?: SpecAggregator,
): Promise<void> {
  const taskNode = asTaskNode(node);
  if (!taskNode) {
    vscode.window.showErrorMessage(vscode.l10n.t('No task selected.'));
    return;
  }

  // Resolve the tasks.md path: prefer the owning spec from the snapshot (so a
  // moved/renamed file is picked up), else fall back to nothing.
  const spec = aggregator
    ?.getSpecs()
    .find((s) => s.name === taskNode.specName);
  const tasksFile = spec?.tasksFile;
  if (!tasksFile) {
    vscode.window.showErrorMessage(
      vscode.l10n.t('tasks.md not found or could not be read for this spec.'),
    );
    return;
  }

  const uri = vscode.Uri.file(tasksFile);

  // Open the document first. If it cannot be read, abort BEFORE touching the
  // active editor so the user's current editor state is preserved (Req 6.4).
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    vscode.window.showErrorMessage(
      vscode.l10n.t('tasks.md not found or could not be read for this spec.'),
    );
    return;
  }

  const targetLine = clampLine(taskNode.task.line, doc.lineCount);
  const editor = await vscode.window.showTextDocument(doc);
  const pos = new vscode.Position(targetLine, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenter,
  );
}

/**
 * Open the selected spec's `tasks.md` in an editor (Req 12.3).
 *
 * No resolvable spec → show "No spec selected." and leave the view unchanged
 * (Req 12.3, 12.10). The file/folder not existing → show "not found" and leave
 * the view unchanged (Req 12.11).
 */
export async function openTasksFile(
  nodeOrSpec: TreeNode | Spec | undefined,
  aggregator: SpecAggregator,
): Promise<void> {
  const spec = resolveSpec(nodeOrSpec, aggregator);
  if (!spec) {
    vscode.window.showInformationMessage(vscode.l10n.t('No spec selected.'));
    return;
  }

  const uri = vscode.Uri.file(spec.tasksFile);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  } catch {
    // Missing/unreadable file: leave the view unchanged, just notify (Req 12.11).
    vscode.window.showErrorMessage(
      vscode.l10n.t('tasks.md not found or could not be read for this spec.'),
    );
  }
}

/**
 * Collapse every node in the view.
 *
 * Thin wrapper over the built-in collapse command VS Code provides for a
 * `showCollapseAll` tree view (Req 12.5).
 */
export async function collapseAll(): Promise<void> {
  await vscode.commands.executeCommand(COLLAPSE_ALL_COMMAND_ID);
}

/**
 * Reveal the spec's folder in the OS file manager (Req 12.6).
 *
 * No resolvable spec → "No spec selected."; the folder not existing → "Spec
 * folder not found." (Req 12.11). Both leave the view unchanged.
 */
export async function openSpecFolder(
  nodeOrSpec: TreeNode | Spec | undefined,
  aggregator: SpecAggregator,
): Promise<void> {
  const spec = resolveSpec(nodeOrSpec, aggregator);
  if (!spec) {
    vscode.window.showInformationMessage(vscode.l10n.t('No spec selected.'));
    return;
  }

  const uri = vscode.Uri.file(spec.path);

  // Confirm the folder exists before asking the OS to reveal it, so a stale
  // snapshot reference surfaces a clear message instead of a silent no-op.
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (!(stat.type & vscode.FileType.Directory)) {
      vscode.window.showErrorMessage(
        vscode.l10n.t('Spec folder not found.'),
      );
      return;
    }
  } catch {
    vscode.window.showErrorMessage(vscode.l10n.t('Spec folder not found.'));
    return;
  }

  await vscode.commands.executeCommand('revealFileInOS', uri);
}

/**
 * Re-scan and refresh the spec snapshot (Req 12.2).
 *
 * `extension.ts` may also wire `refresh` to `aggregator.refresh()` directly;
 * this handler is provided for consistency. Registration should bind ONE of
 * them (no duplicate registration).
 */
export async function refresh(aggregator: SpecAggregator): Promise<void> {
  try {
    await aggregator.refresh();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(
      vscode.l10n.t('Failed to refresh specs: {0}', detail),
    );
  }
}
