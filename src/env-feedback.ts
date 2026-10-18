/**
 * Environment-feedback arcs — the deterministic replacement for the
 * satisfaction lane when there is no user in the loop (headless runs).
 *
 * The signal is the same idea: evidence that a mistake was paid for and
 * then fixed. Instead of a user going displeased -> pleased, a COMMAND goes
 * failed -> succeeded. No model is involved anywhere in this file.
 *
 * Arc kinds:
 *   invocation  F fails, then a DIFFERENT command of the same family succeeds
 *               with no file edits in between. The lesson is "run G, not F"
 *               (e.g. `pytest` -> `uv run pytest`). Highest value.
 *   tooling     F fails with a non-assertion error (import error, missing
 *               module, cog/lint/type check failure, crash) and the same
 *               family succeeds after edits.
 *   unresolved  a family fails and never succeeds before the session ends.
 *   red-green   test assertions fail, code is edited, tests pass. This is the
 *               normal development loop, NOT a lesson: recorded for analysis,
 *               never rendered into memory.
 *
 * Each arc carries a cross-session key `${family} :: ${signature}` so the
 * repetition gate can promote arcs that recur across sessions.
 */
import { containsSecret } from './redaction-gate';

export type ToolEvent =
  | { kind: 'command'; index: number; command: string; ok: boolean; output: string }
  | { kind: 'edit'; index: number; file: string };

export type ArcKind = 'invocation' | 'tooling' | 'unresolved' | 'red-green';

export interface Arc {
  kind: ArcKind;
  family: string;
  failedCommand: string;
  fixedCommand: string | null;
  signature: string;
  editedFiles: string[];
  fromIndex: number;
  toIndex: number | null;
  key: string;
}

const MULTI_WORD: Record<string, number> = {
  uv: 3, uvx: 2, poetry: 3, pipenv: 3, pdm: 3, hatch: 3, npx: 2, bunx: 2,
  npm: 3, pnpm: 3, yarn: 2, bun: 2, just: 2, make: 2, cargo: 2, go: 2, git: 2, docker: 2,
};

/** The last shell segment, minus env assignments and `cd`. */
function mainSegment(command: string): string {
  const segs = command.split(/&&|\|\||;|\n/).map(s => s.trim()).filter(Boolean);
  const real = segs.filter(s => !/^(cd|pushd|set|export|source|\.)\b/.test(s));
  return (real.length ? real[real.length - 1] : segs[segs.length - 1] ?? '').trim();
}

/** Program + meaningful subcommand words: "uv run pytest tests/x.py -q" -> "uv run pytest". */
export function commandFamily(command: string): string {
  let toks = mainSegment(command).split(/\s+/).filter(Boolean);
  while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks = toks.slice(1);
  if (!toks.length) return '';
  const prog = toks[0].replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (/^python(\d(\.\d+)?)?$/.test(prog) && toks[1] === '-m' && toks[2]) return `python -m ${toks[2]}`;
  const n = MULTI_WORD[prog] ?? 1;
  const words = [prog];
  for (const t of toks.slice(1)) {
    if (words.length >= n) break;
    if (t.startsWith('-') || /[\\/.]/.test(t)) break;
    words.push(t);
  }
  return words.join(' ');
}

/** Python-ish family equivalence: `pytest`, `python -m pytest`, `uv run pytest` are one family. */
export function familyRoot(family: string): string {
  const w = family.split(' ');
  if (w[0] === 'python' && w[1] === '-m') return w[2];
  if (['uv', 'poetry', 'pipenv', 'pdm', 'hatch'].includes(w[0]) && w[1] === 'run' && w[2]) return w[2];
  if (['uvx', 'npx', 'bunx'].includes(w[0]) && w[1]) return w[1];
  return family;
}

const ASSERTION = /AssertionError|\bassert\b|FAILED .*::|^E\s+assert|expected .* (to|but)|\d+ failed/im;
const ERROR_LINE = /(ModuleNotFoundError|ImportError|No module named|command not found|is not recognized|not found|SyntaxError|NameError|AttributeError|TypeError|Error:|error:|Exception|Traceback|cog: |would reformat|Found \d+ error)/;

/** A short, path/number-free error signature for cross-session matching. */
export function errorSignature(output: string): string {
  const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const hit = lines.find(l => ERROR_LINE.test(l) && !/^(Traceback|File ")/.test(l)) ?? lines.find(l => ERROR_LINE.test(l)) ?? lines[lines.length - 1] ?? '';
  return hit
    .replace(/[A-Za-z]:[\\/][^\s'"]+|\/[^\s'"]+/g, '<path>')
    .replace(/0x[0-9a-f]+|\b\d+(\.\d+)?\b/gi, '<n>')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

export function isAssertionFailure(output: string): boolean {
  return ASSERTION.test(output) && !/ModuleNotFoundError|ImportError|No module named|SyntaxError|collection error|ERROR collecting/i.test(output);
}

export function detectArcs(events: ToolEvent[]): Arc[] {
  const arcs: Arc[] = [];
  const open = new Map<string, { ev: Extract<ToolEvent, { kind: 'command' }>; edits: string[] }>();
  for (const ev of events) {
    if (ev.kind === 'edit') {
      for (const o of open.values()) if (!o.edits.includes(ev.file)) o.edits.push(ev.file);
      continue;
    }
    const root = familyRoot(commandFamily(ev.command));
    if (!root) continue;
    const pending = open.get(root);
    if (!ev.ok) {
      if (!pending) open.set(root, { ev, edits: [] }); // keep the FIRST failure of the run
      continue;
    }
    if (!pending) continue;
    open.delete(root);
    const f = pending.ev;
    const sig = errorSignature(f.output);
    const sameCommand = f.command.trim() === ev.command.trim();
    let kind: ArcKind;
    if (!sameCommand && pending.edits.length === 0) kind = 'invocation';
    else if (isAssertionFailure(f.output)) kind = 'red-green';
    else kind = 'tooling';
    arcs.push({
      kind, family: root, failedCommand: f.command.trim(), fixedCommand: ev.command.trim(),
      signature: sig, editedFiles: pending.edits, fromIndex: f.index, toIndex: ev.index,
      key: `${root} :: ${kind === 'invocation' ? 'invocation' : sig}`,
    });
  }
  for (const [root, { ev, edits }] of open) {
    const sig = errorSignature(ev.output);
    arcs.push({ kind: 'unresolved', family: root, failedCommand: ev.command.trim(), fixedCommand: null,
      signature: sig, editedFiles: edits, fromIndex: ev.index, toIndex: null, key: `${root} :: ${sig}` });
  }
  return arcs.sort((a, b) => a.fromIndex - b.fromIndex);
}

const short = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** One HISTORY line per memorable arc; red-green and secret-bearing arcs are never rendered. */
export function renderArc(a: Arc): string | null {
  if (a.kind === 'red-green') return null;
  if (containsSecret(`${a.failedCommand} ${a.fixedCommand ?? ''} ${a.signature}`)) return null;
  const files = a.editedFiles.length ? ` after editing ${a.editedFiles.slice(0, 3).map(f => `\`${f}\``).join(', ')}` : '';
  switch (a.kind) {
    case 'invocation':
      return `\`${short(a.failedCommand)}\` failed (${short(a.signature, 90)}); \`${short(a.fixedCommand!)}\` worked instead.`;
    case 'tooling':
      return `\`${short(a.failedCommand)}\` failed with \`${short(a.signature, 90)}\`; fixed${files}, then \`${short(a.fixedCommand!)}\` passed.`;
    case 'unresolved':
      return `\`${short(a.failedCommand)}\` failed with \`${short(a.signature, 90)}\` and was never fixed in that session.`;
  }
}
