# Implementation Plan: Kiro Spec Monitor

## Overview

This plan builds the Kiro Spec Monitor VS Code / Kiro extension incrementally, following the design's layered module structure (sources → services → models → `TreeDataProvider` → commands). All source code lives under `kiro-spec-monitor/`.

The build order front-loads the pure, highly testable core — the `TaskParser` and progress calculation — because these are the primary unit/property-test targets (Req 13.7). Each task builds on the previous ones and ends by wiring new work into the running extension; nothing is left orphaned. Property-based tests (fast-check) and unit tests (vitest) map to the design's Correctness Properties 1–19.

The design is expressed in TypeScript; implementation language is TypeScript. The recommended test runner is **vitest** with **fast-check** for property-based tests, and an optional `@vscode/test-electron` smoke test for the thin `vscode`-dependent glue.

## Tasks

- [x] 1. Project scaffolding and empty activatable extension
  - [x] 1.1 Initialize npm project and TypeScript build under `kiro-spec-monitor/`
    - Create `kiro-spec-monitor/package.json` with dev deps only (`typescript`, `@types/vscode`, `@types/node`, `vitest`, `fast-check`, `@vscode/test-electron`, `esbuild` or rely on `tsc`); no runtime deps (Req 13.2)
    - Create `kiro-spec-monitor/tsconfig.json` targeting the VS Code extension baseline; set `engines.vscode` conservatively
    - Add npm scripts: `compile` (tsc/esbuild), `test` (vitest run), `test:watch`
    - Configure the directory layout: `src/models/`, `src/services/`, `src/providers/`, `src/commands/`, `src/extension.ts`, `l10n/`, `tests/`
    - _Requirements: 13.1, 13.2, 13.6_
  - [x] 1.2 Author the extension manifest contributions in `package.json`
    - Declare an Activity Bar `viewsContainers` entry titled "KIRO SPEC MONITOR" and a tree `view` with id `kiroSpecMonitor.view`
    - Declare commands: `kiroSpecMonitor.refresh`, `kiroSpecMonitor.openTasksFile`, `kiroSpecMonitor.revealTask`, `kiroSpecMonitor.collapseAll`, `kiroSpecMonitor.openSpecFolder`
    - Declare `menus` (view/title toolbar: Refresh, Open tasks.md, Collapse All) and the Command Palette entry "Kiro Spec Monitor: Refresh Specs"
    - Set `activationEvents`/`contributes` so the view activates the extension; use a community-origin name/description (not official Kiro/AWS) (Req 13.4)
    - Reference `package.nls.json` keys for all declarative titles (localization wired in task 14)
    - _Requirements: 5.1, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 13.4_
  - [x] 1.3 Implement minimal `src/extension.ts` that activates and registers an empty TreeView
    - `activate` creates a placeholder `TreeDataProvider` returning no children and registers `kiroSpecMonitor.view` with `showCollapseAll: true`
    - Register a no-op `refresh` command and push disposables to `context.subscriptions`; implement `deactivate`
    - Verify the extension compiles and the empty view renders without error (Req 1.4)
    - _Requirements: 1.4, 13.1_

- [x] 2. Data models
  - [x] 2.1 Implement `src/models/Task.ts` and `src/models/Spec.ts`
    - Define `TaskStatus` union (`completed | running | pending` + V2 points `failed | paused | blocked | skipped`), `Task`, and `Spec` interfaces exactly per the design
    - Encode validation rules as documented invariants: `id` non-empty and prefix-free; child `level` strictly greater than parent; `completed === true ⇒ status !== 'running'`; `children` are only real tasks
    - Keep models pure (no I/O, no `vscode` import)
    - _Requirements: 2.12, 2.13, 3.1, 3.2, 14.3_

- [x] 3. TaskParser (pure, primary unit under test)
  - [x] 3.1 Implement `src/services/taskParser.ts`
    - Implement the `TaskParser` interface with a single forward-pass, stack-based nesting algorithm from the design
    - Define `TASK_RE`, `NUMBER_RE`, `REQ_RE`, `DETAIL_RE`; normalize indentation via `expandedWidth` (tab = 2 spaces per Req 2.6; each level = tab or 2 spaces per Req 2.3)
    - Support ≥5 nesting levels; numbering `1`/`12.1`/`12.2.1` (1–5 segments); unnumbered tasks leave `number` undefined
    - Map `[x]`/`[X]` → completed, `[ ]` → not completed; record 0-based `line`; set `id`/`title` to the trimmed, prefix-free checkbox body
    - Attach `*Requirements: ...*` / `_Requirements: ..._` numbers to the nearest preceding task without creating a node; skip detail bullets, prose, and malformed lines without throwing
    - Skip lines whose stripped id is empty; preserve duplicate-id tasks as distinct nodes in occurrence order
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 2.14, 2.15, 3.4_

- [ ] 4. TaskParser tests (primary test target)
  - [ ]* 4.1 Write unit tests for `taskParser` covering Req 2 edge cases
    - Cases: top-level + multi-level (≥5) subtasks; numbering `1`/`12.1`/`12.2.1`; unnumbered; `[x]`/`[X]`/`[ ]`; tab vs space vs mixed indent; multiline descriptions and prose between tasks; `*Requirements: ...*` attachment; detail bullets excluded; empty file; CRLF vs LF; empty/duplicate ids
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.13, 2.14, 2.15, 13.7_
  - [ ]* 4.2 Write property-based test — total parsing & determinism
    - **Property 1: Parser — total parsing** (never throws, always returns an array)
    - **Property 6: Parser — determinism** (`parse(m) ≡ parse(m)`)
    - **Validates: Requirements 2.1, 2.10**
  - [ ]* 4.3 Write property-based test — clean task id
    - **Property 2: Parser — clean task id** (`id` prefix-free and equals trimmed checkbox body)
    - **Validates: Requirements 2.12**
  - [ ]* 4.4 Write property-based test — child level increment
    - **Property 3: Parser — child level increment** (`c.level = p.level + 1`, child more deeply indented)
    - **Validates: Requirements 3.1, 3.2, 2.5**
  - [ ]* 4.5 Write property-based test — detail bullets never become tasks
    - **Property 4: Parser — detail bullets never become tasks**
    - **Validates: Requirements 2.8, 3.4**
  - [ ]* 4.6 Write property-based test — checkbox completion mapping & requirements attachment
    - **Property 5: Parser — checkbox completion mapping**
    - **Property 7: Parser — requirements attachment**
    - **Validates: Requirements 2.4, 2.7**

- [x] 5. SpecScanner
  - [x] 5.1 Implement `src/services/specScanner.ts`
    - Implement `SpecScanner`/`SpecLocation`; glob `**/.kiro/specs/*/tasks.md` within workspace folders using `findFiles`, excluding `node_modules`
    - Return one `SpecLocation` per spec folder containing a `tasks.md`, in deterministic alphabetical order by name; skip folders without `tasks.md`
    - Tolerate a missing `.kiro` directory (return `[]`, never throw); skip unreadable `tasks.md` entries
    - _Requirements: 1.1, 1.2, 1.3_
  - [ ]* 5.2 Write unit tests for `specScanner`
    - Test alphabetical determinism, missing `.kiro` → `[]`, folder without `tasks.md` skipped
    - _Requirements: 1.1, 1.2, 1.3_

- [x] 6. Progress calculation and SpecAggregator skeleton
  - [x] 6.1 Implement `computeProgress` and ordering helper in `src/services/specAggregator.ts`
    - Implement leaf-only `computeProgress(roots)` → `{ total, completed, progress, runningCount }`; parents that only group children contribute 0; `progress = 0` when `total === 0`
    - Clamp `0 ≤ completed ≤ total` and `progress ∈ [0,1]`; mark a spec complete iff `total > 0 && completed === total`
    - Add a skeleton `SpecAggregator` (scanner + parser only for now; state provider wired later) exposing `getSpecs()`, `refresh()`, `onDidChangeSpecs`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - [ ]* 6.2 Write property-based tests for progress calculation
    - **Property 8: Progress — bounds** / **Property 9: Progress — no division by zero** / **Property 10: Progress — leaves only counted** / **Property 11: Progress — completion**
    - **Validates: Requirements 4.1, 4.2, 4.4, 4.5, 4.6**

- [x] 7. WorkspaceIdResolver
  - [x] 7.1 Implement `src/services/workspaceIdResolver.ts`
    - Implement `resolve()` per the design: read spec folder names under the workspace `.kiro/specs/`, list `~/.kiro/spec-sessions/*.json`, parse each (skip on parse error), score by spec-name overlap, return the best id when overlap ≥ 1 else `undefined`
    - Re-resolvable each refresh; never throws on missing files
    - _Requirements: 8.1_
  - [ ]* 7.2 Write unit tests for `workspaceIdResolver`
    - Test overlap scoring, zero-overlap → `undefined`, malformed session JSON skipped
    - _Requirements: 8.1_

- [x] 8. TaskStateProvider abstraction and concrete providers
  - [x] 8.1 Implement `src/services/taskStateProvider.ts` abstraction + `FallbackStateProvider`
    - Define `TaskStatus`, `TaskStateInfo`, `TaskStateProvider` (`getStates`, `onDidChangeState`, `invalidate`)
    - Implement `FallbackStateProvider`: `[x]` → completed, `[ ]` → pending; never emits `running`
    - Add a `createStateProvider(resolver, context)` factory selecting Kiro-meta vs fallback based on resolved `workspaceId`
    - _Requirements: 8.7, 13.5_
  - [x] 8.2 Implement `KiroMetadataStateProvider` with `inferStatus`
    - Read `~/.kiro/tasks/<workspaceId>/<spec>.meta.json` (correlated via `~/.kiro/spec-sessions`), READ-ONLY; never write metadata or `tasks.md`
    - Implement `inferStatus(task, metaEntry)`: completed checkbox → completed; no meta/history → pending; present final executionStatus → pending (surface `rawExecutionStatus`); unchecked + history + no final status → running with `startedAt` from latest timestamp
    - Never infer running from next-pending-task, bare `[ ]`, recently-modified file, or open file
    - Catch all read/parse errors and degrade the whole spec to checkbox-only state
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.8, 13.5_
  - [ ]* 8.3 Write property-based tests for state providers
    - **Property 12: completed is never running** / **Property 13: running inference source** / **Property 14: graceful degradation**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.5, 8.6, 8.7, 13.5**

- [x] 9. TaskRuntimeService (timer core)
  - [x] 9.1 Implement `src/services/taskRuntimeService.ts`
    - Implement `reconcile(running)`, `getElapsed`, `onTick`, `dispose` and the `formatElapsed` helper (`Ns` / `Mm SSs` / `Hh MMm`)
    - Maintain an independent per-task `startedAt` keyed by `${specName}::${taskId}`; set it once per execution; run exactly one `setInterval(1s)` active iff the running set is non-empty; clear a task's timer immediately when it stops
    - Persist `{ taskKey, startedAt, executionId }` to `context.workspaceState`; reuse persisted `startedAt` only when the current `executionId` matches, else adopt `sourceStartedAt` or `Date.now()`
    - Compute elapsed as `Date.now() - startedAt` without reparsing `tasks.md`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.9, 13.3_
  - [ ]* 9.2 Write property-based tests for the runtime service
    - **Property 15: interval activity** / **Property 16: elapsed arithmetic** / **Property 17: startedAt reuse**
    - **Validates: Requirements 10.4, 10.5, 10.6, 10.8, 13.3**

- [x] 10. SpecAggregator full wiring and ordering
  - [x] 10.1 Complete `SpecAggregator.refresh()` and `orderSpecs`
    - Compose scanner + parser + state provider + runtime: scan, parse, resolve states, apply states to tasks, compute progress per spec, reconcile the runtime running set, fire `onDidChangeSpecs` exactly once; never throw (degrade a single spec to fallback)
    - Implement `orderSpecs`: stable grouping into (1) running, (2) incomplete (incl. zero-total), (3) complete; preserve the scanner's alphabetical order within each group
    - _Requirements: 4.3, 8.7, 11.1, 11.2, 11.3, 11.4_
  - [ ]* 10.2 Write property-based test for ordering
    - **Property 18: Ordering — stable grouped order**
    - **Validates: Requirements 11.1, 11.2**

- [x] 11. Checkpoint — core services verified
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. SpecTreeProvider rendering
  - [x] 12.1 Implement `src/providers/specTreeProvider.ts`
    - Implement `TreeDataProvider<TreeNode>` with `spec`/`task` nodes, `getTreeItem`, `getChildren`, `getParent` (for `reveal`), `refreshElement` (targeted), `refreshAll`
    - Use only `ThemeIcon`s: completed → `check`, running → `sync~spin`, pending → `circle-outline`, complete spec → `pass-filled`; compose non-empty label + description + tooltip
    - Render the hierarchy preserving parent/child structure; show the spec-level badge/percentage `X/Y` + integer `0–100%` (0% and 0/0 when no counted tasks)
    - On `onTick(keys)`, fire targeted `onDidChangeTreeData(node)` per running key so only `getTreeItem` recomputes `description = formatElapsed(...)`; apply the running highlight/🔄 indicator and remove it when a task stops; no full refresh
    - _Requirements: 3.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 9.1, 9.2, 9.3, 9.4, 9.5, 10.2, 10.8_
  - [x] 12.2 Wire the tree provider and runtime ticks into `extension.ts`
    - Replace the placeholder provider with `SpecTreeProvider` fed by the aggregator; subscribe `runtime.onTick(keys => treeProvider.onTick(keys))`; trigger an initial `aggregator.refresh()`
    - _Requirements: 5.1, 9.1, 10.8_

- [x] 13. Commands
  - [x] 13.1 Implement `src/commands/` handlers
    - `refresh` (calls `aggregator.refresh`), `openTasksFile`, `revealTask` (open the spec's `tasks.md`, set cursor to the 0-based `line`, reveal/center within 1s)
    - `revealTask` error handling: if the file is missing/unreadable, abort navigation, preserve editor state, show an error message; if `line < 0` or `> lastLine`, clamp to a valid line (or line 0) without error
    - `collapseAll` (delegates to the built-in tree collapse command), `openSpecFolder`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 12.3, 12.4, 12.5, 12.6_
  - [x] 13.2 Register commands in `extension.ts` and bind task-click to `revealTask`
    - Register all five commands and push disposables; ensure the toolbar/Command Palette contributions from task 1.2 resolve to these handlers; bind each task `TreeItem` command to `revealTask`
    - _Requirements: 6.1, 12.1, 12.2_
  - [ ]* 13.3 Write unit tests for `revealTask` line-clamping logic
    - Test out-of-range line clamp and missing-file abort behavior (pure/clampable portions)
    - _Requirements: 6.4, 6.5_

- [x] 14. SpecWatcher (real-time updates)
  - [x] 14.1 Implement `src/services/specWatcher.ts`
    - Register a `FileSystemWatcher` on `.kiro/specs/**/tasks.md` and an `fs.watch` on the `~/.kiro` metadata paths; debounce events (~300–500ms)
    - On tasks.md create/change/delete → trigger `aggregator.refresh()` (new specs appear, removed specs disappear, checkbox/task changes reflected); on metadata change → `stateProvider.invalidate()` then refresh
    - Implement `dispose()` to tear down watchers and pending timers
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - [x] 14.2 Wire `SpecWatcher` into `extension.ts`
    - Construct the watcher with aggregator + state provider and push it to `context.subscriptions`
    - _Requirements: 7.1_

- [x] 15. Localization (English + Portuguese only)
  - [x] 15.1 Add declarative NLS bundles and runtime l10n bundles
    - Create `package.nls.json` (English) and `package.nls.pt.json` (Portuguese) for command titles and declarative contributions
    - Create `l10n/bundle.l10n.json` (English) and `l10n/bundle.l10n.pt.json` (Portuguese) for runtime strings (labels, descriptions, tooltips, messages); route runtime strings through `vscode.l10n`
    - _Requirements: 15.2, 15.3, 15.5, 15.6_
  - [x] 15.2 Implement language resolution from `vscode.env.language`
    - Resolve prefix `pt*` → Portuguese, `en*` → English, anything else → English default; read once at activation
    - Apply the resolved bundle to all user-facing strings produced by the tree provider, commands, and messages
    - _Requirements: 15.1, 15.2, 15.3, 15.4_
  - [ ]* 15.3 Write unit test for language selection
    - **Property 19: Localization — language selection** (`pt*` → pt, `en*`/other → en default)
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4**

- [x] 16. Final wiring and build verification
  - [x] 16.1 Finalize `extension.ts` wiring and disposal
    - Construct resolver → state provider → runtime → aggregator → tree provider → watcher → commands exactly as the design's example; ensure every disposable is registered and `deactivate` cleans up (runtime interval, watchers)
    - Confirm no code path writes to `tasks.md` or `~/.kiro`; add the "Kiro Spec Monitor" output channel for diagnostics
    - _Requirements: 8.8, 13.3, 13.6, 14.1, 14.2, 14.3_
  - [x] 16.2 Run the full build/compile and test suite
    - Run `npm run compile` and `vitest run`; fix any compile/test failures so the extension builds cleanly
    - _Requirements: 13.1, 13.7_
  - [ ]* 16.3 Add a light `@vscode/test-electron` smoke test
    - Activate against a fixture workspace with sample specs; assert the tree renders expected spec/task nodes and `revealTask` opens the right file at the right line; assert no write operations are registered against `tasks.md`/`~/.kiro`
    - _Requirements: 5.1, 6.2, 8.8_

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP, but the `TaskParser` tests (4.1–4.6) are the primary quality gate per Req 13.7.
- Each task references specific requirement sub-clauses for traceability; property-based test tasks name the exact design Correctness Property they validate.
- Checkpoints ensure incremental validation; the parser/progress/state/runtime/ordering/localization properties map to design Properties 1–19.
- The extension is strictly read-only outside its own `workspaceState`; no task writes to `tasks.md` or `~/.kiro`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1"] },
    { "id": 2, "tasks": ["3.1", "5.1", "7.1"] },
    { "id": 3, "tasks": ["4.1", "4.2", "4.3", "4.4", "4.5", "4.6", "5.2", "6.1", "7.2", "8.1"] },
    { "id": 4, "tasks": ["6.2", "8.2", "9.1"] },
    { "id": 5, "tasks": ["8.3", "9.2", "10.1"] },
    { "id": 6, "tasks": ["10.2", "12.1"] },
    { "id": 7, "tasks": ["12.2", "13.1"] },
    { "id": 8, "tasks": ["13.2", "13.3", "14.1"] },
    { "id": 9, "tasks": ["14.2", "15.1"] },
    { "id": 10, "tasks": ["15.2", "15.3"] },
    { "id": 11, "tasks": ["16.1"] },
    { "id": 12, "tasks": ["16.2", "16.3"] }
  ]
}
```
