/**
 * i18n — UI language resolution for the Kiro Spec Monitor extension.
 *
 * The extension supports exactly two UI languages: Portuguese and English
 * (Req 15.5). Actual runtime string localization is delivered by VS Code's
 * standard `vscode.l10n` mechanism together with the shipped bundles
 * (`l10n/bundle.l10n.json` for English, `l10n/bundle.l10n.pt.json` for
 * Portuguese) and the declarative `package.nls.json` / `package.nls.pt.json`
 * files. VS Code loads the bundle matching the editor display language
 * automatically via the `"l10n"` manifest field — the extension does not swap
 * bundles at runtime.
 *
 * `resolveLanguage` is the explicit, PURE, testable realization of the
 * pt/en-with-English-default rule the extension guarantees (design Property 19;
 * Req 15.1–15.4). It takes no dependency on `vscode` so it can be unit-tested
 * directly (task 15.3). `currentLanguage` is the thin runtime helper that feeds
 * it `vscode.env.language`.
 */

import * as vscode from 'vscode';

/** The two UI languages the extension supports (Req 15.5). */
export type UiLanguage = 'pt' | 'en';

/**
 * Resolve the UI language from an editor language tag using a case-insensitive
 * prefix match (design Property 19; Req 15.1–15.4):
 *
 * - starts with `pt` (any variant, e.g. `pt`, `pt-br`) → `'pt'` (Req 15.2)
 * - starts with `en` (any variant, e.g. `en`, `en-US`) → `'en'` (Req 15.3)
 * - anything else, undefined, or empty                 → `'en'` (default; Req 15.4)
 *
 * Pure: no `vscode` dependency, no side effects.
 *
 * @param editorLanguage The editor display language tag (typically
 *   `vscode.env.language`), or `undefined` when unknown.
 */
export function resolveLanguage(editorLanguage: string | undefined): UiLanguage {
  const normalized = (editorLanguage ?? '').trim().toLowerCase();
  if (normalized.startsWith('pt')) {
    return 'pt';
  }
  // Both the explicit `en*` case and every other value (including empty/
  // undefined and unsupported languages) fall back to English (Req 15.3, 15.4).
  return 'en';
}

/**
 * Runtime helper: resolve the UI language from the current editor display
 * language (`vscode.env.language`). This is the only `vscode`-dependent entry
 * point; the extension reads it once at activation (see the design's
 * Localization section). Keep the pure {@link resolveLanguage} separate so
 * tests do not need a `vscode` runtime.
 */
export function currentLanguage(): UiLanguage {
  return resolveLanguage(vscode.env.language);
}
