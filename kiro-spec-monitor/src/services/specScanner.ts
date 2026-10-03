/**
 * SpecScanner — discovers Kiro Specs by locating `tasks.md` files.
 *
 * This service performs the discovery step of the pipeline (sources → services
 * → models → tree). It globs the workspace for `tasks.md` files that live
 * directly under a `.kiro/specs/<name>/` folder and returns one `SpecLocation`
 * per matching spec folder.
 *
 * Design constraints (Req 1):
 * - Discover specs via `vscode.workspace.findFiles` using the spec glob,
 *   excluding `node_modules` (Req 1.1).
 * - Return exactly one entry per spec folder that contains a `tasks.md`
 *   (Req 1.2), in deterministic alphabetical order by spec name.
 * - Tolerate a missing `.kiro` directory or no workspace at all: return `[]`
 *   and never throw (Req 1.3).
 *
 * The matched `tasks.md` must be a DIRECT child of `.kiro/specs/<name>/`
 * (exactly one folder level under `specs`), not a deeply nested path. The glob
 * constrains to a single folder level under `specs`, but we additionally verify
 * the structural shape so a stray `tasks.md` matched by a permissive provider
 * is skipped rather than mis-attributed.
 */

import * as vscode from 'vscode';

/**
 * A located Kiro Spec: its folder name and the URIs of the spec directory and
 * its `tasks.md` file.
 */
export interface SpecLocation {
  /** Spec folder name, e.g. "aimores-map". */
  readonly name: string;
  /** The spec directory, e.g. `.kiro/specs/aimores-map`. */
  readonly specDir: vscode.Uri;
  /** The `tasks.md` file, e.g. `.kiro/specs/aimores-map/tasks.md`. */
  readonly tasksFile: vscode.Uri;
}

/**
 * Locates every spec by finding `tasks.md` files directly under a spec folder.
 */
export interface SpecScanner {
  /**
   * Returns one entry per spec folder that contains a `tasks.md`, in
   * deterministic alphabetical order by name. Never throws; returns `[]` when
   * there is no workspace or no `.kiro/specs` directory.
   */
  findSpecs(): Promise<SpecLocation[]>;
}

/** Glob matching `tasks.md` files that are direct children of a spec folder. */
const SPECS_GLOB = '**/.kiro/specs/*/tasks.md';

/** Excluded from discovery to avoid vendored copies. */
const EXCLUDE_GLOB = '**/node_modules/**';

/**
 * Default `SpecScanner` backed by `vscode.workspace.findFiles`.
 */
export class FindFilesSpecScanner implements SpecScanner {
  async findSpecs(): Promise<SpecLocation[]> {
    let uris: vscode.Uri[];
    try {
      // findFiles only lists; it does not read file contents. If there is no
      // workspace or no matching path it resolves to an empty array. We still
      // guard against any unexpected rejection so findSpecs never throws.
      uris = await vscode.workspace.findFiles(SPECS_GLOB, EXCLUDE_GLOB);
    } catch {
      return [];
    }

    // Deduplicate by spec directory so a single spec folder yields exactly one
    // SpecLocation even if the provider returns a path more than once.
    const byDir = new Map<string, SpecLocation>();

    for (const tasksFile of uris) {
      const location = toSpecLocation(tasksFile);
      if (!location) {
        continue;
      }
      const key = location.specDir.toString();
      if (!byDir.has(key)) {
        byDir.set(key, location);
      }
    }

    return [...byDir.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }
}

/**
 * Converts a matched `tasks.md` URI into a `SpecLocation`, verifying the path
 * is shaped exactly `.../.kiro/specs/<name>/tasks.md`. Returns `undefined` for
 * any path that does not match that structure.
 */
function toSpecLocation(tasksFile: vscode.Uri): SpecLocation | undefined {
  // Split on either path separator; the final segment must be `tasks.md`.
  const segments = tasksFile.path.split(/[\\/]/).filter((s) => s.length > 0);
  const len = segments.length;

  // Need at least: .kiro / specs / <name> / tasks.md
  if (len < 4) {
    return undefined;
  }

  const file = segments[len - 1];
  const specName = segments[len - 2];
  const specsDir = segments[len - 3];
  const kiroDir = segments[len - 4];

  if (
    file.toLowerCase() !== 'tasks.md' ||
    specsDir !== 'specs' ||
    kiroDir !== '.kiro' ||
    specName.length === 0
  ) {
    return undefined;
  }

  const specDir = vscode.Uri.joinPath(tasksFile, '..');

  return {
    name: specName,
    specDir,
    tasksFile,
  };
}
