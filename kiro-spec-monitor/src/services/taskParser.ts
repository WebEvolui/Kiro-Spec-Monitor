/**
 * Pure, deterministic parser that converts `tasks.md` text into a `Task[]` tree.
 *
 * This module performs NO I/O and MUST NOT import `vscode`. It is the primary
 * unit/property-test target of the extension. The algorithm is a single
 * forward pass over the lines of the markdown, using an indentation stack to
 * reconstruct the parent/child nesting (see design "Parser algorithm").
 *
 * Totality & determinism (design Properties 1 and 6): `parse` never throws and
 * always returns an array; the same input text always yields a structurally
 * identical tree, independent of external state, clock, disk, or execution
 * order.
 */

import type { Task } from '../models/Task';

/**
 * Contract for the pure task parser. The UI and aggregator depend only on this
 * interface, never on the concrete implementation details.
 */
export interface TaskParser {
  /** Pure. Deterministic. Same input text always yields the same `Task[]` tree. */
  parse(markdown: string): Task[];
}

/**
 * A TASK line: optional indent, a list marker (`-` or `*`), a checkbox
 * (`[ ]`, `[x]`, or `[X]`), then the task body text. The body is captured
 * non-greedily with trailing whitespace stripped so `body` is the trimmed,
 * prefix-free checkbox text (Req 2.13).
 */
const TASK_RE =
  /^(?<indent>[ \t]*)[-*]\s+\[(?<check>[ xX])\]\s+(?<body>.+?)\s*$/;

/**
 * Optional leading dotted number inside the body, e.g. `12.2.1 Title` or
 * `3 Title`. Supports 1–5 dotted segments (Req 2.4). The capture is only used
 * to populate `number`; a body without a leading number is still a valid task
 * (Req 2.7).
 */
const NUMBER_RE = /^(?<num>\d+(?:\.\d+)*)\s+(?<rest>.*)$/;

/**
 * A requirements annotation line: `*Requirements: 6.3, 6.4*` (also the
 * underscore variant `_Requirements: ..._`). Attached to the nearest preceding
 * task without creating a node (Req 2.8).
 */
const REQ_RE = /^[ \t]*[*_]Requirements:\s*(?<reqs>[0-9.,\s]+)[*_]\s*$/i;

/**
 * A DETAIL bullet: a list item that is NOT a checkbox (a plain `- text` /
 * `* text`). These are task details/prose and MUST NOT become tasks
 * (Req 2.9, 3.4). Kept for documentation/clarity; the algorithm relies on
 * `TASK_RE` failing to match these rather than testing `DETAIL_RE` directly.
 */
export const DETAIL_RE = /^[ \t]*[-*]\s+(?!\[[ xX]\])\S.*$/;

export { TASK_RE, NUMBER_RE, REQ_RE };

/**
 * Normalize the leading whitespace of a checkbox line to a comparable column
 * width. A tab counts as 2 columns (Req 2.6) and a space as 1 column; since
 * each nesting level is "one tab or 2 spaces" (Req 2.3), the resulting width
 * divided by 2 would be the nominal level — but the stack-based algorithm only
 * needs a monotonic, comparable width, so we compare raw expanded widths.
 *
 * @param indent the raw leading whitespace captured by `TASK_RE`
 * @returns the expanded column width (tabs = 2 columns each, spaces = 1 each)
 */
function expandedWidth(indent: string): number {
  let width = 0;
  for (const ch of indent) {
    width += ch === '\t' ? 2 : 1;
  }
  return width;
}

/**
 * Split a `Requirements:` capture into trimmed, non-empty requirement numbers.
 * e.g. "6.3, 6.4 " → ["6.3", "6.4"].
 */
function splitRequirements(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Internal mutable node used while building the tree. */
interface MutableTask {
  id: string;
  title: string;
  status: Task['status'];
  completed: boolean;
  number?: string;
  line: number;
  level: number;
  requirements: string[];
  children: MutableTask[];
}

/** A stack frame tracking an open ancestor and its indentation width. */
interface StackEntry {
  task: MutableTask;
  indentWidth: number;
}

/**
 * Concrete, pure implementation of {@link TaskParser}.
 *
 * The parse is a single forward pass: each line is classified as a task line,
 * a requirements line, or ignorable (detail bullet, prose, blank, malformed).
 * Task lines are pushed/popped on an indentation stack to build the tree;
 * requirements lines attach to the most recently created task. Every path is
 * total — malformed input is skipped, never thrown on (Req 2.11).
 */
export class DefaultTaskParser implements TaskParser {
  parse(markdown: string): Task[] {
    // Guard against non-string input to keep the function total even if a
    // caller violates the type contract.
    if (typeof markdown !== 'string' || markdown.length === 0) {
      return [];
    }

    // Split on CRLF or LF so Windows and Unix line endings both yield the same
    // 0-based line indices (Req 2.1, 2.12).
    const lines = markdown.split(/\r\n|\r|\n/);

    const roots: MutableTask[] = [];
    const stack: StackEntry[] = [];
    let current: MutableTask | null = null;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];

      const taskMatch = TASK_RE.exec(line);
      if (taskMatch && taskMatch.groups) {
        const indentWidth = expandedWidth(taskMatch.groups.indent ?? '');
        const body = (taskMatch.groups.body ?? '').trim();

        // Skip lines whose stripped id is empty — do not create a node
        // (Req 2.14). Such a line also must not attach requirements, so we
        // leave `current` unchanged.
        if (body.length === 0) {
          continue;
        }

        const completed = (taskMatch.groups.check ?? '').toLowerCase() === 'x';

        const numberMatch = NUMBER_RE.exec(body);
        const number = numberMatch?.groups?.num;

        const task: MutableTask = {
          id: body,
          title: body,
          // Status is always 'pending' at parse time; the aggregator resolves
          // the real completed/running/pending state later.
          status: 'pending',
          completed,
          number,
          line: lineIndex,
          level: 0,
          requirements: [],
          children: [],
        };

        // Pop ancestors that are at the same or deeper indentation so the top
        // of the stack becomes this task's parent. A larger indentation jump is
        // handled naturally: whatever shallower frame remains on top is the
        // nearest valid parent (Req 3.5).
        while (
          stack.length > 0 &&
          stack[stack.length - 1].indentWidth >= indentWidth
        ) {
          stack.pop();
        }

        if (stack.length === 0) {
          task.level = 0;
          roots.push(task);
        } else {
          const parent = stack[stack.length - 1].task;
          // child.level === parent.level + 1 (Req 3.1, 3.2).
          task.level = parent.level + 1;
          parent.children.push(task);
        }

        stack.push({ task, indentWidth });
        current = task;
        continue;
      }

      const reqMatch = REQ_RE.exec(line);
      if (reqMatch && reqMatch.groups && current !== null) {
        // Attach to the nearest preceding task without creating a node
        // (Req 2.8). Append so multiple requirements lines accumulate.
        current.requirements.push(...splitRequirements(reqMatch.groups.reqs ?? ''));
        continue;
      }

      // Detail bullets, blank lines, multiline description continuation, and
      // complementary prose are ignored for tree structure (Req 2.9, 2.10).
      // Malformed lines are likewise skipped without throwing (Req 2.11).
    }

    return finalize(roots);
  }
}

/**
 * Convert the mutable build tree into frozen `Task` values. `requirements` is
 * normalized to `undefined` when empty so the model stays clean, matching the
 * optional field semantics in the design.
 */
function finalize(nodes: MutableTask[]): Task[] {
  return nodes.map((node): Task => {
    const children = finalize(node.children);
    const task: Task = {
      id: node.id,
      title: node.title,
      status: node.status,
      completed: node.completed,
      number: node.number,
      line: node.line,
      level: node.level,
      requirements: node.requirements.length > 0 ? node.requirements : undefined,
      children,
    };
    return task;
  });
}

/** Convenience singleton for callers that just need to parse text. */
export const taskParser: TaskParser = new DefaultTaskParser();
