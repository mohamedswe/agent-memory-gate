/**
 * Phase 1 smoke test: can the harness drive Claude Code headlessly, measure it,
 * and keep runs isolated from each other?
 *
 * Run from the repo root:   bun harness/smoke.ts
 * Optional:                 bun harness/smoke.ts --model haiku
 *
 * It makes 3 short `claude -p` calls (a few cents of plan usage at most) in
 * throwaway temp folders and writes harness/smoke-report.json. The report
 * contains only structure (event types, field names, pass/fail), never your
 * prompts' surroundings, file contents or account details, so it is safe to
 * paste back.
 *
 * Checks:
 *  1. `claude` is on PATH and runs headlessly.
 *  2. stream-json output includes a final result with token usage, turn count
 *     and cost fields the harness can log (instead of trusting the agent).
 *  3. Tool calls are visible, so we can prove whether memory files were read.
 *  4. WIRED: a run whose folder has .project-memory/ + the standard CLAUDE.md
 *     wiring reads the memory and recovers a canary word.
 *  5. ISOLATION: a run in a fresh folder WITHOUT memory cannot recover the
 *     canary (no leak through Claude Code's own memory or settings).
 *  6. UNWIRED: memory present but no CLAUDE.md pointer — does the agent find
 *     it anyway? (Informational: tells us how much wiring matters.)
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'haiku';
const CANARY = `PERIWINKLE-${Math.floor(1000 + Math.random() * 9000)}`;
const WIRING = 'At the start of every task, read every file in .project-memory/ if that folder exists, then proceed with the task.\n';
const PROMPT = 'What is the project canary word? If you cannot find one in this folder, answer exactly NONE. Answer with only the word.';

function findClaude(): string | null {
  return Bun.which('claude') ?? Bun.which('claude.cmd') ?? Bun.which('claude.exe');
}

interface RunResult {
  label: string;
  exitCode: number | null;
  eventTypes: Record<string, number>;
  toolCalls: { name: string; target: string }[];
  readMemory: boolean;
  answer: string;
  foundCanary: boolean;
  resultFields: string[];
  usageFields: string[];
  usage: Record<string, number>;
  numTurns: number | null;
  costField: string | null;
  durationMs: number;
  stderrTail: string;
}

function makeDir(withMemory: boolean, withWiring: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'amg-smoke-'));
  // a git repo so Claude Code treats it as a normal project root
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# scratch project\n');
  if (withWiring) writeFileSync(join(dir, 'CLAUDE.md'), WIRING);
  if (withMemory) {
    mkdirSync(join(dir, '.project-memory'));
    writeFileSync(join(dir, '.project-memory', 'BRIEFING.md'), `# Briefing\n\nThe project canary word is ${CANARY}.\n`);
    writeFileSync(join(dir, '.project-memory', 'HISTORY.md'), '# History\n\nNo prior sessions.\n');
  }
  return dir;
}

function run(claude: string, label: string, dir: string): RunResult {
  const t0 = Date.now();
  const p = Bun.spawnSync([
    claude, '-p', PROMPT,
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', '6',
    '--model', model,
    '--allowedTools', 'Read,Glob,Grep,LS',
  ], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: process.env });
  const out = p.stdout.toString();
  const eventTypes: Record<string, number> = {};
  const toolCalls: { name: string; target: string }[] = [];
  let result: any = null;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    const t = `${ev.type ?? '?'}${ev.subtype ? ':' + ev.subtype : ''}`;
    eventTypes[t] = (eventTypes[t] ?? 0) + 1;
    const content = ev?.message?.content;
    if (ev.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'tool_use') {
          const inp = c.input ?? {};
          const target = String(inp.file_path ?? inp.path ?? inp.pattern ?? '').replace(dir, '<run-dir>');
          toolCalls.push({ name: String(c.name), target });
        }
      }
    }
    if (ev.type === 'result') result = ev;
  }
  const answer = String(result?.result ?? '').trim().slice(0, 80);
  const usage = (result?.usage ?? {}) as Record<string, unknown>;
  const numeric: Record<string, number> = {};
  for (const [k, v] of Object.entries(usage)) if (typeof v === 'number') numeric[k] = v;
  return {
    label,
    exitCode: p.exitCode,
    eventTypes,
    toolCalls,
    readMemory: toolCalls.some(t => t.target.includes('.project-memory')),
    answer: answer.replace(CANARY, '<CANARY>'),
    foundCanary: answer.includes(CANARY),
    resultFields: result ? Object.keys(result).sort() : [],
    usageFields: Object.keys(usage).sort(),
    usage: numeric,
    numTurns: typeof result?.num_turns === 'number' ? result.num_turns : null,
    costField: result ? (Object.keys(result).find(k => k.includes('cost')) ?? null) : null,
    durationMs: Date.now() - t0,
    stderrTail: p.stderr.toString().slice(-300),
  };
}

const claude = findClaude();
const report: any = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  model,
  claudeFound: !!claude,
  userLevelClaudeMdExists: existsSync(join(homedir(), '.claude', 'CLAUDE.md')),
};
if (!claude) {
  report.verdict = 'FAIL: `claude` not found on PATH. Install Claude Code and log in, then rerun.';
} else {
  report.claudeVersion = Bun.spawnSync([claude, '--version']).stdout.toString().trim();
  const dirs = { wired: makeDir(true, true), isolation: makeDir(false, true), unwired: makeDir(true, false) };
  const wired = run(claude, 'wired', dirs.wired);
  const isolation = run(claude, 'isolation', dirs.isolation);
  const unwired = run(claude, 'unwired', dirs.unwired);
  for (const d of Object.values(dirs)) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  report.runs = [wired, isolation, unwired];

  const hasUsage = (r: RunResult) => ['input_tokens', 'output_tokens'].every(f => r.usageFields.includes(f));
  report.checks = {
    headless_runs_ok: [wired, isolation, unwired].every(r => r.exitCode === 0 && r.resultFields.length > 0),
    usage_logged: [wired, isolation, unwired].every(hasUsage),
    cache_fields_logged: wired.usageFields.some(f => f.includes('cache')),
    turns_logged: wired.numTurns !== null,
    cost_field_present: wired.costField !== null,
    tool_calls_visible: wired.toolCalls.length > 0,
    wired_reads_memory: wired.readMemory,
    wired_recovers_canary: wired.foundCanary,
    isolated_run_cannot_see_canary: !isolation.foundCanary,
    unwired_reads_memory_anyway: unwired.readMemory,
  };
  const required = ['headless_runs_ok', 'usage_logged', 'tool_calls_visible', 'wired_reads_memory', 'wired_recovers_canary', 'isolated_run_cannot_see_canary'];
  const failed = required.filter(k => !report.checks[k]);
  report.verdict = failed.length === 0 ? 'PASS: harness can drive, measure and isolate Claude Code.' : `FAIL: ${failed.join(', ')}`;
  if (report.userLevelClaudeMdExists) {
    report.warning = 'You have a user-level ~/.claude/CLAUDE.md. It is loaded into every run in every arm. Its content is not in this report; check it contains nothing project-specific before real runs.';
  }
}
const outPath = join(import.meta.dir, 'smoke-report.json');
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(report.verdict);
if (report.warning) console.log('WARNING:', report.warning);
console.log(`Report: ${outPath}`);
