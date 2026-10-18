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
 *     it anyway? (Informational. First run: yes, via a folder-wide Grep.)
 *  7. DETECTOR: any run that found the canary must register as having
 *     touched memory (catches Grep/Bash access, not just Read).
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { parseStream } from './stream';

const args = process.argv.slice(2);
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'haiku';
const CANARY = `PERIWINKLE-${Math.floor(1000 + Math.random() * 9000)}`;
const WIRING = 'At the start of every task, read every file in .project-memory/ if that folder exists, then proceed with the task.\n';
const PROMPT = 'What is the project canary word? If you cannot find one in this folder, answer exactly NONE. Answer with only the word.';

function findClaude(): string | null {
  return Bun.which('claude') ?? Bun.which('claude.cmd') ?? Bun.which('claude.exe');
}

const MARKER = `amg-memory-marker-${CANARY}`;

function makeDir(withMemory: boolean, withWiring: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'amg-smoke-'));
  // a git repo so Claude Code treats it as a normal project root
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# scratch project\n');
  if (withWiring) writeFileSync(join(dir, 'CLAUDE.md'), WIRING);
  if (withMemory) {
    mkdirSync(join(dir, '.project-memory'));
    writeFileSync(join(dir, '.project-memory', 'BRIEFING.md'), `<!-- ${MARKER} -->\n# Briefing\n\nThe project canary word is ${CANARY}.\n`);
    writeFileSync(join(dir, '.project-memory', 'HISTORY.md'), `<!-- ${MARKER} -->\n# History\n\nNo prior sessions.\n`);
  }
  return dir;
}

function run(claude: string, label: string, dir: string) {
  const t0 = Date.now();
  const p = Bun.spawnSync([
    claude, '-p', PROMPT,
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', '6',
    '--model', model,
    '--allowedTools', 'Read,Glob,Grep,LS',
  ], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: process.env });
  const m = parseStream(p.stdout.toString(), { runDir: dir, marker: MARKER });
  const answer = m.answer.trim().slice(0, 80);
  return {
    label,
    exitCode: p.exitCode,
    ok: m.ok,
    eventTypes: m.eventTypes,
    toolCalls: m.toolCalls,
    memoryTouched: m.memoryTouched,
    memoryTouchedVia: m.memoryTouchedVia,
    answer: answer.split(CANARY).join('<CANARY>'),
    foundCanary: answer.includes(CANARY),
    usage: m.usage,
    newInputTokens: m.newInputTokens,
    totalInputTokens: m.totalInputTokens,
    numTurns: m.numTurns,
    costUsd: m.costUsd,
    permissionDenials: m.permissionDenials,
    rateLimitEvents: m.rateLimitEvents,
    durationMs: Date.now() - t0,
    stderrTail: p.stderr.toString().slice(-300),
  };
}
type RunResult = ReturnType<typeof run>;

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

  report.checks = {
    headless_runs_ok: [wired, isolation, unwired].every(r => r.exitCode === 0 && r.ok),
    usage_logged: [wired, isolation, unwired].every(r => r.totalInputTokens > 0 && r.usage.output_tokens > 0),
    turns_logged: wired.numTurns !== null,
    cost_field_present: wired.costUsd !== null,
    tool_calls_visible: wired.toolCalls.length > 0,
    wired_touches_memory: wired.memoryTouched,
    wired_recovers_canary: wired.foundCanary,
    isolated_run_cannot_see_canary: !isolation.foundCanary,
    isolated_run_never_touches_memory: !isolation.memoryTouched,
    // detector sanity: if a run found the canary, the detector must have seen it
    detector_consistent: [wired, isolation, unwired].every(r => !r.foundCanary || r.memoryTouched),
    unwired_finds_memory_anyway: unwired.memoryTouched,
  };
  const required = ['headless_runs_ok', 'usage_logged', 'tool_calls_visible', 'wired_touches_memory', 'wired_recovers_canary', 'isolated_run_cannot_see_canary', 'isolated_run_never_touches_memory', 'detector_consistent'];
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
