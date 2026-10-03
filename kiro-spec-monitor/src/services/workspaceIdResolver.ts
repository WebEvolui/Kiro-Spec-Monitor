/**
 * WorkspaceIdResolver — correlates the open workspace with Kiro's opaque
 * `<workspaceId>` used under `~/.kiro/spec-sessions` and `~/.kiro/tasks`.
 *
 * The `<workspaceId>` (e.g. `6878d2513779f033`) is opaque and derived by Kiro
 * from the workspace path via an undocumented hashing scheme we must not depend
 * on. Instead we correlate structurally: each `~/.kiro/spec-sessions/<id>.json`
 * maps our spec folder names to chat session ids, so the file whose keys best
 * overlap the spec folders we actually scanned identifies the workspace.
 *
 * This service is STRICTLY READ-ONLY — it only reads directories and files and
 * never writes. It never throws on missing files/dirs or malformed JSON: in any
 * degenerate case it returns `undefined`, which routes the extension to the
 * `FallbackStateProvider` (completed/pending only, no running state).
 *
 * Resolution is re-attempted on every call (no permanent caching) so a newly
 * created spec can establish the correlation on a later refresh.
 *
 * Imports `vscode` (for the open workspace folder) and node `fs`/`os`/`path`.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface WorkspaceIdResolver {
  /**
   * Best-effort resolution of the current workspace's Kiro `workspaceId`.
   * Returns `undefined` when no confident correlation exists (=> fallback).
   */
  resolve(): Promise<string | undefined>;
}

/**
 * Default resolver. Accepts the extension context (matching the design's
 * `new WorkspaceIdResolver(context)` wiring) for parity with the other
 * services; resolution itself reads the workspace root live from
 * `vscode.workspace.workspaceFolders` so it tracks the actually-open folder on
 * each call. The context is intentionally not retained — V1 resolution needs
 * no persisted/global state, and keeping the parameter preserves the wiring
 * contract for future providers.
 */
export class WorkspaceIdResolver implements WorkspaceIdResolver {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_context?: vscode.ExtensionContext) {}

  async resolve(): Promise<string | undefined> {
    try {
      const workspaceRoot = this.getWorkspaceRoot();
      if (!workspaceRoot) {
        return undefined;
      }

      // 1) Spec folder names under <workspaceRoot>/.kiro/specs/.
      const specNames = this.readSpecNames(workspaceRoot);
      if (specNames.size === 0) {
        return undefined;
      }

      // 2) Candidate session files: ~/.kiro/spec-sessions/*.json.
      const sessionsDir = path.join(os.homedir(), '.kiro', 'spec-sessions');
      const candidates = this.listJsonFiles(sessionsDir);
      if (candidates.length === 0) {
        return undefined;
      }

      // 3) Score each candidate by how many of OUR spec names its keys cover.
      let bestId: string | undefined;
      let bestScore = 0;

      for (const fileName of candidates) {
        const id = fileName.slice(0, -'.json'.length);
        const map = this.parseJsonObject(path.join(sessionsDir, fileName));
        if (!map) {
          // Skip files that fail to read/parse or aren't an object map.
          continue;
        }

        let score = 0;
        for (const key of Object.keys(map)) {
          if (specNames.has(key)) {
            score++;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestId = id;
        }
      }

      // 4) Require at least one spec-name overlap to accept a correlation.
      return bestScore >= 1 ? bestId : undefined;
    } catch {
      // Defense in depth: never throw out of resolve().
      return undefined;
    }
  }

  /** First open workspace folder's fsPath, or `undefined` if none is open. */
  private getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    return folders[0].uri.fsPath;
  }

  /**
   * Spec folder names directly under `<workspaceRoot>/.kiro/specs/`.
   * Returns an empty set (never throws) when the directory is missing.
   */
  private readSpecNames(workspaceRoot: string): Set<string> {
    const specsDir = path.join(workspaceRoot, '.kiro', 'specs');
    const names = new Set<string>();
    try {
      const entries = fs.readdirSync(specsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          names.add(entry.name);
        }
      }
    } catch {
      // Missing .kiro/specs (or unreadable) => no spec names.
    }
    return names;
  }

  /**
   * Names of `*.json` files directly under `dir`.
   * Returns an empty array (never throws) when the directory is missing.
   */
  private listJsonFiles(dir: string): string[] {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Read and JSON-parse `filePath`, returning the parsed value only when it is
   * a plain object (the `specName -> sessionId` map). Returns `undefined` on any
   * read/parse error or non-object JSON, so callers can simply skip it.
   */
  private parseJsonObject(filePath: string): Record<string, unknown> | undefined {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}
