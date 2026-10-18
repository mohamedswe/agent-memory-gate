/**
 * Task extraction for the replay benchmark.
 *
 * A task = one real upstream commit that changed both source and tests.
 * The agent gets the repo at the commit's PARENT plus a task description
 * (commit message + linked issue). The tests the commit added/changed are
 * HIDDEN: the agent never sees them; the scorer applies them afterwards.
 *
 * Subcommands (run from the agent-memory-gate repo root):
 *
 *   bun harness/tasks.ts extract  --repo <path-to-clone> --since 2026-06-01 [--src llm/] [--tests tests/]
 *       -> harness/data/tasks.jsonl   (chronological, deterministic)
 *
 *   bun harness/tasks.ts issues
 *       -> adds linked GitHub issue titles/bodies to tasks.jsonl
 *          (uses GITHUB_TOKEN if set; unauthenticated works for ~60 issues/hour)
 *
 *   bun harness/tasks.ts validate --repo <path-to-clone> [--limit 40]
 *       -> runs the hidden tests at base (must FAIL) and at the commit (must PASS)
 *          and writes harness/data/tasks.validated.jsonl. Tasks that don't flip
 *          (flaky, platform-specific, or not actually tested) are dropped, with
 *          the reason recorded.
 *
 * Nothing here calls a model.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DATA = join(import.meta.dir, 'data');
const TASKS = join(DATA, 'tasks.jsonl');
const VALIDATED = join(DATA, 'tasks.validated.jsonl');

export interface Task {
  id: string;              // short sha of the upstream commit
  seq: number;             // chronological position
  commit: string;          // full sha (the answer key; never shown to the agent)
  base: string;            // parent sha (what the agent starts from)
  date: string;
  subject: string;
  body: string;
  issues: number[];
  srcFiles: string[];
  testFiles: string[];     // hidden from the agent
  issueText?: { number: number; title: string; body: string }[];
  validation?: { baseFails: boolean; commitPasses: boolean; seconds: number; note?: string };
}

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

function git(repo: string, args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

export function readTasks(path = TASKS): Task[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
function writeTasks(tasks: Task[], path = TASKS) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(path, tasks.map(t => JSON.stringify(t)).join('\n') + '\n');
}

/** Strip trailers and bot noise so the description is the human intent only. */
function cleanBody(body: string): string {
  return body
    .split('\n')
    .filter(l => !/^(Co-authored-by|Signed-off-by|Co-Authored-By|Claude-Session|Generated with):?/i.test(l.trim()))
    .join('\n')
    .trim();
}

function extract() {
  const repo = resolve(arg('repo') ?? '');
  const since = arg('since', '2026-06-01')!;
  const src = arg('src', 'llm/')!;
  const tests = arg('tests', 'tests/')!;
  if (!existsSync(join(repo, '.git'))) throw new Error('--repo must point to a git clone');
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  // first-parent, oldest first: the order upstream actually lived through
  const shas = git(repo, ['log', '--reverse', '--first-parent', '--no-merges', `--since=${since}`, '--format=%H', branch])
    .split('\n').filter(Boolean);
  const out: Task[] = [];
  for (const sha of shas) {
    const files = git(repo, ['show', '--format=', '--name-only', sha]).split('\n').filter(Boolean);
    const srcFiles = files.filter(f => f.startsWith(src) && f.endsWith('.py'));
    const testFiles = files.filter(f => f.startsWith(tests));
    if (!srcFiles.length || !testFiles.some(f => f.endsWith('.py'))) continue;
    const [subject, date, parent] = git(repo, ['show', '-s', '--format=%s%n%cI%n%P', sha]).split('\n');
    if (parent.trim().split(' ').length !== 1) continue; // skip anything with 2 parents
    const body = cleanBody(git(repo, ['show', '-s', '--format=%b', sha]));
    const issues = [...new Set([...`${subject}\n${body}`.matchAll(/#(\d+)/g)].map(m => Number(m[1])))];
    out.push({
      id: sha.slice(0, 7), seq: out.length + 1, commit: sha, base: parent.trim(),
      date, subject: subject.trim(), body, issues, srcFiles, testFiles,
    });
  }
  writeTasks(out);
  console.log(`extracted ${out.length} tasks from ${shas.length} commits since ${since} -> ${TASKS}`);
}

async function issues() {
  const tasks = readTasks();
  const ownerRepo = arg('github', 'simonw/llm')!;
  const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'agent-memory-gate-harness' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const cache = new Map<number, { number: number; title: string; body: string; isPR: boolean } | null>();
  for (const t of tasks) {
    t.issueText = [];
    for (const n of t.issues) {
      if (!cache.has(n)) {
        const r = await fetch(`https://api.github.com/repos/${ownerRepo}/issues/${n}`, { headers });
        if (r.status === 403 || r.status === 429) { console.error('GitHub rate limit hit; set GITHUB_TOKEN and rerun (progress is kept)'); writeTasks(tasks); return; }
        const j: any = r.ok ? await r.json() : null;
        cache.set(n, j ? { number: n, title: j.title ?? '', body: (j.body ?? '').slice(0, 4000), isPR: !!j.pull_request } : null);
      }
      const it = cache.get(n);
      // PR descriptions often describe the fix; keep only real issues as task context
      if (it && !it.isPR) t.issueText.push({ number: it.number, title: it.title, body: it.body });
    }
  }
  writeTasks(tasks);
  console.log(`issue text added for ${tasks.filter(t => t.issueText?.length).length}/${tasks.length} tasks`);
}

/** The text the agent sees. Same for every arm. */
export function taskPrompt(t: Task): string {
  const parts = [`You are working in this repository. Implement the following change.`, '', `## Change`, t.subject];
  if (t.body) parts.push('', t.body);
  for (const i of t.issueText ?? []) parts.push('', `## Issue #${i.number}: ${i.title}`, '', i.body);
  parts.push('', '## Requirements',
    '- Make the change in the source code and add or update tests as you see fit.',
    '- Run the relevant tests to check your work.',
    '- Do not use network services other than installing this project\'s dependencies.',
    '- When finished, reply with a one-paragraph summary of what you changed.');
  return parts.join('\n');
}

function runTests(dir: string, files: string[]): { passed: boolean; seconds: number; tail: string } {
  const t0 = Date.now();
  const py = files.filter(f => f.endsWith('.py') && !f.endsWith('conftest.py'));
  const p = Bun.spawnSync(['uv', 'run', '--quiet', 'pytest', '-q', '-p', 'no:cacheprovider', ...py],
    { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LLM_USER_PATH: join(dir, '.llm-user') } });
  return { passed: p.exitCode === 0, seconds: (Date.now() - t0) / 1000, tail: (p.stdout.toString() + p.stderr.toString()).slice(-400) };
}

function validate() {
  const repo = resolve(arg('repo') ?? '');
  const limit = Number(arg('limit', '1000'));
  const tasks = readTasks().slice(0, limit);
  const done = new Map(readTasks(VALIDATED).map(t => [t.id, t]));
  const work = mkdtempSync(join(tmpdir(), 'amg-validate-'));
  const kept: Task[] = [];
  for (const t of tasks) {
    if (done.has(t.id)) { const d = done.get(t.id)!; if (d.validation?.baseFails && d.validation?.commitPasses) kept.push(d); continue; }
    const wt = join(work, t.id);
    try {
      git(repo, ['worktree', 'add', '--detach', '-f', wt, t.base]);
      // hidden tests on top of the base: must fail
      git(wt, ['checkout', t.commit, '--', ...t.testFiles.filter(f => fileExistsAt(repo, t.commit, f))]);
      const before = runTests(wt, t.testFiles);
      // the real commit: must pass
      git(wt, ['checkout', '-f', t.commit]);
      const after = runTests(wt, t.testFiles);
      t.validation = { baseFails: !before.passed, commitPasses: after.passed, seconds: before.seconds + after.seconds,
        note: !after.passed ? `commit fails: ${after.tail}` : before.passed ? 'hidden tests already pass at base' : undefined };
    } catch (e) {
      t.validation = { baseFails: false, commitPasses: false, seconds: 0, note: String(e).slice(0, 300) };
    } finally {
      try { git(repo, ['worktree', 'remove', '--force', wt]); } catch {}
    }
    done.set(t.id, t);
    writeTasks([...done.values()], VALIDATED);
    const ok = t.validation.baseFails && t.validation.commitPasses;
    if (ok) kept.push(t);
    console.log(`${t.seq.toString().padStart(3)} ${t.id} ${ok ? 'KEEP' : 'drop'} ${t.validation.note ?? ''}`.slice(0, 160));
  }
  rmSync(work, { recursive: true, force: true });
  console.log(`\n${kept.length} usable tasks (of ${tasks.length} checked) -> ${VALIDATED}`);
}

function fileExistsAt(repo: string, sha: string, path: string): boolean {
  return Bun.spawnSync(['git', '-C', repo, 'cat-file', '-e', `${sha}:${path}`]).exitCode === 0;
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'extract') extract();
  else if (cmd === 'issues') await issues();
  else if (cmd === 'validate') validate();
  else console.log('usage: bun harness/tasks.ts extract|issues|validate [options]  (see header comment)');
}
