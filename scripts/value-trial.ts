/** Run-09 methodology pilot. All generated work remains under .eval-local/. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tasks, staticNote, onboarding } from '../experiments/value-v1-tasks';
import { command, hash, listFiles, runAgent } from '../src/value-trial';
import { EvalProvider } from '../src/eval-provider';
import { UsageLedger } from '../src/usage-ledger';
import { parseRollout, feedLedger } from '../src/rollout-reader';
import { CrossSessionLedger } from '../src/cross-session-ledger';
import { redactCandidates, type Candidate } from '../src/redaction-gate';
import { callReviewer } from '../src/reviewer-client';
import { BudgetLedger } from '../src/budget-ledger';
import { RecordService } from '../src/records';
import { writeCandidateRecord } from '../src/candidate-writer';
import { projectBriefing } from '../src/project-registry';
import { buildSatisfactionJob, extractUserTurns } from '../src/session-trajectory';
import { classifySatisfaction } from '../src/satisfaction-classifier';
import { detectTransitions } from '../src/satisfaction-transitions';
import { buildTransitionCandidate } from '../src/marker-records';
import { renderHistoryMarkdown } from '../src/history-renderer';

const repo = process.cwd();
const root = resolve('.eval-local/value-v1');
const source = join(root, 'source');
const mode = process.argv[2] ?? 'all';
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const save = (path: string, value: unknown) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
const git = (...args: string[]) => {
  const p = Bun.spawnSync(['git', '-c', `safe.directory=${repo.replace(/\\/g, '/')}`, ...args], { cwd: repo });
  if (p.exitCode) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};
function fingerprint(dir: string) { return hash(JSON.stringify(listFiles(dir).map(p => [p, hash(readFileSync(join(dir, p)))]))); }

async function prepare() {
  if (existsSync(join(root, 'manifest.json'))) {
    if (json(join(root, 'manifest.json')).taskSpecHash !== hash(readFileSync('experiments/value-v1-tasks.ts'))) throw new Error('FROZEN_TASK_SPEC_CHANGED');
    return;
  }
  mkdirSync(source, { recursive: true });
  const archive = join(root, 'source.zip');
  git('archive', '--format=zip', `--output=${archive}`, 'HEAD');
  const extract = Bun.spawnSync(['tar', '-xf', archive, '-C', source]);
  if (extract.exitCode) throw new Error(extract.stderr.toString());
  mkdirSync(join(root, 'judge'), { recursive: true });
  for (const t of tasks) writeFileSync(join(root, 'judge', `${t.id}.test.ts`), t.acceptance);
  const controls = await command(source, ['scripts/test.ts']);
  save(join(root, 'preflight-regressions.json'), controls);
  if (controls.exitCode) throw new Error('SOURCE_REGRESSIONS_NOT_GREEN');
  for (const t of tasks) {
    const red = await command(source, ['test', join(root, 'judge', `${t.id}.test.ts`)], 90000, { TRIAL_WORKSPACE: source });
    save(join(root, 'judge', `${t.id}-before.json`), red);
    if (!red.exitCode || !/expect\(/.test(red.stderr)) throw new Error(`ACCEPTANCE_NOT_A_REAL_RED:${t.id}`);
  }
  const seed = crypto.randomUUID();
  // Hash ordering is deterministic given the recorded random seed.
  const schedule = tasks.flatMap(t => ['baseline', 'note', 'memory'].map(condition => ({ task: t.id, condition, key: hash(seed + t.id + condition) })))
    .sort((a, b) => a.key.localeCompare(b.key));
  save(join(root, 'manifest.json'), {
    version: 1, createdAt: new Date().toISOString(), sourceCommit: git('rev-parse', 'HEAD'), sourceHash: fingerprint(source),
    taskSpecHash: hash(readFileSync('experiments/value-v1-tasks.ts')), harnessHash: hash(readFileSync('src/value-trial.ts')),
    providerHash: hash(readFileSync('src/eval-provider.ts')), runnerHash: hash(readFileSync('scripts/value-trial.ts')),
    model: 'z-ai/glm-5.3', temperature: 0, maxOutputTokens: 4096, maxTurns: 14, capUsd: 5,
    primaryEndpoint: 'total inference dollars per provisionally accepted patch, including failed runs and memory formation',
    practicalThreshold: '15% lower cost versus baseline; no observed acceptance loss; note comparison reported separately',
    seed, schedule, tasks: tasks.map(t => ({ id: t.id, prompt: t.prompt, acceptanceHash: hash(t.acceptance) })),
    noteHash: hash(staticNote), noteProvenance: 'AI-assisted operator-style note from existing repo docs; not a human-maintenance study',
    limitations: ['Three selected defects in one repo, one attempt per condition, not representative or powered.',
      'Custom limited-tool agent, not Codex CLI; Codex CLI is not logged in.',
      'Human effort and longitudinal maintenance are not measured.', 'Automated acceptance is provisional pending review.'],
  });
  console.log('Frozen: three failing defect checks; original regression suite green; nine scheduled runs.');
}

async function train(provider: EvalProvider) {
  if (existsSync(join(root, 'memory.json'))) return json(join(root, 'memory.json'));
  const seeds = [];
  for (let i = 0; i < onboarding.length; i++) {
    const dir = join(root, 'warmup', String(i));
    const resultPath = join(root, 'warmup-artifacts', String(i), 'result.json');
    if (existsSync(resultPath)) {
      const r = json(resultPath);
      seeds.push({ ...r, rollout: readFileSync(join(root, 'warmup-artifacts', String(i), 'rollout.jsonl'), 'utf8') });
      continue;
    }
    if (!existsSync(dir)) cpSync(source, dir, { recursive: true });
    console.log(`Onboarding ${i + 1}/2`);
    const r = await runAgent(provider, dir, join(root, 'warmup-artifacts', String(i)), onboarding[i], '', `warmup-${i}`, true, 7);
    seeds.push(r);
    if (r.status !== 'completed') throw new Error(`ONBOARDING_FAILED:${r.error ?? r.status}`);
  }
  const cross = new CrossSessionLedger(join(root, 'cross-session.json'));
  const candidates: Candidate[] = [];
  for (let i = 0; i < seeds.length; i++) {
    const ledger = new UsageLedger({projectDir:'trial/project',packageScripts:json(join(source,'package.json')).scripts}); feedLedger(ledger, parseRollout(seeds[i].rollout));
    for (const key of ledger.rawKeys()) cross.observe('trial/project', key, `warmup-${i}`,ledger.sourceKeysFor(key));
    for (const c of ledger.promotionCandidates()) candidates.push({ key: c.key, counts: c.counts, sessionFile: `warmup-${i}`, projectDir: 'trial/project' });
  }
  for (const key of cross.newlyCrossing('trial/project')) candidates.push({ key, projectDir: 'trial/project', sessionFile: 'warmup-0,warmup-1', counts: { userRepeats: 0, agentRediscoveries: 0, rawMentions: cross.sessionCount('trial/project', key) } });
  const filtered = redactCandidates([...new Map(candidates.map(c => [c.key, c])).values()]);
  save(join(root, 'candidates.json'), filtered);
  const vendorDir = process.env.GBRAIN_PACKAGE_DIR ?? join(homedir(), '.bun/install/global/node_modules/gbrain');
  const load = (name: string) => import(pathToFileURL(createRequire(join(vendorDir, 'package.json')).resolve(name)).href);
  const { configureGateway } = await load('gbrain/ai/gateway');
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  const { PGLiteEngine } = await load('gbrain/pglite-engine');
  const engine = new PGLiteEngine(); await engine.connect({ database_path: join(root, 'brain.pglite') }); await engine.initSchema();
  const service = new RecordService('codex', engine);
  const reviewerBudget = await BudgetLedger.open(join(root, 'reviewer-budget.db'), { monthlyCapUsd: 5, periodStart: '2026-10-27-trial' });
  const deps = { httpPost: async (_url: string, body: unknown) => ({ ok: true, json: await provider.call('memory-formation', body as Record<string, unknown>) }), budget: reviewerBudget, estimateUsd: () => .25, model: provider.model };
  const outcomes: unknown[] = [];
  try {
    for (const candidate of filtered.passed) {
      const output = await callReviewer(`review-${crypto.randomUUID()}`, candidate, deps);
      outcomes.push({ candidate, output });
      if (output.content !== 'NOT_WORTH_SAVING') await writeCandidateRecord(service, 'codex', candidate, output);
    }
    for (let i = 0; i < seeds.length; i++) {
      const job = buildSatisfactionJob(`warmup-${i}`, extractUserTurns(seeds[i].rollout));
      if (!job) continue;
      const result = await classifySatisfaction(`classify-${crypto.randomUUID()}`, job, deps);
      for (const transition of detectTransitions(result.turns)) {
        const candidate = buildTransitionCandidate({ sessionFile: job.sessionFile, projectDir: job.projectDir, transition, turns: job.turns });
        if (!redactCandidates([candidate]).passed.length) continue;
        const output = await callReviewer(`transition-${crypto.randomUUID()}`, candidate, deps);
        if (output.content !== 'NOT_WORTH_SAVING') await writeCandidateRecord(service, 'codex', candidate, { ...output, memory_kind: 'attempt' });
        outcomes.push({ candidate, output });
      }
    }
    const briefing = await projectBriefing(engine, 'trial/project');
    const context = '# Project memory\n' + briefing.records.filter((r: any) => r.kind !== 'attempt').map((r: any) => `- ${r.content}`).join('\n') + '\n' +
      renderHistoryMarkdown('projects/project', briefing.records.filter((r: any) => r.kind === 'attempt').map((r: any) => ({ ...r, createdAt: '', sessionFile: 'warmup' })));
    const inference = readFileSync(join(root, 'inference.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
    const formationCostUsd = inference.filter(r => r.label.startsWith('warmup') || r.label === 'memory-formation').reduce((sum, r) => sum + (r.actualCostUsd ?? 0), 0);
    const memory = { context, contextHash: hash(context), records: briefing.records, outcomes, formationCostUsd,
      note: 'Includes warm-up sessions, repetition review, and satisfaction classification. No target-task evidence used.' };
    save(join(root, 'memory.json'), memory);
    writeFileSync(join(root, 'BRIEFING.md'), context);
    console.log(`Frozen automatic memory: ${briefing.records.length} records; formation $${formationCostUsd.toFixed(4)}`);
    return memory;
  } finally { await reviewerBudget.close(); await engine.disconnect(); }
}

async function run(provider: EvalProvider) {
  const manifest = json(join(root, 'manifest.json'));
  const memory = json(join(root, 'memory.json'));
  for (const task of tasks) {
    const control = json(join(root, 'positive-controls', task.id, 'control.json'));
    if (control.hidden.exitCode || control.regressions.exitCode) throw new Error('POSITIVE_CONTROL_NOT_GREEN');
  }
  if (fingerprint(source) !== manifest.sourceHash || hash(memory.context) !== memory.contextHash) throw new Error('FROZEN_INPUT_CHANGED');
  for (const item of manifest.schedule) {
    const id = item.key.slice(0, 12), artifacts = join(root, 'runs', id), dir = join(root, 'workspaces', id);
    if (existsSync(join(artifacts, 'judged.json'))) continue;
    // Do not rerun an interrupted or failed agent under the same identity.
    if (existsSync(join(artifacts, 'result.json'))) throw new Error(`UNJUDGED_PRIOR_ATTEMPT:${id}`);
    if (!existsSync(dir)) cpSync(source, dir, { recursive: true });
    if (fingerprint(dir) !== manifest.sourceHash) throw new Error('UNEQUAL_STARTING_SNAPSHOT');
    const task = tasks.find(t => t.id === item.task)!;
    const context = item.condition === 'baseline' ? '' : item.condition === 'note' ? staticNote : memory.context;
    console.log(`Run ${id}: ${item.task} / ${item.condition}`);
    const result = await runAgent(provider, dir, artifacts, task.prompt, context, id);
    const requests = readFileSync(join(root, 'inference.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s)).filter(r => r.label === id);
    // The transport ledger includes billed failures that never returned to the agent.
    result.costUsd = requests.reduce((sum, r) => sum + (r.actualCostUsd ?? 0), 0);
    const accountingComplete = requests.length > 0 && requests.every(r => typeof r.actualCostUsd === 'number');
    const hidden = await command(dir, ['test', join(root, 'judge', `${task.id}.test.ts`)], 90000, { TRIAL_WORKSPACE: dir });
    const regression = await command(dir, ['scripts/test.ts']);
    const newTests = listFiles(dir).filter(p => /^test\/.*\.test\.ts$/.test(p) && !existsSync(join(source, p)));
    const newTestResult = newTests.length ? await command(dir, ['test', ...newTests]) : null;
    const changed = listFiles(dir).filter(p => !existsSync(join(source, p)) || hash(readFileSync(join(dir, p))) !== hash(readFileSync(join(source, p))));
    const patch = changed.map(path => ({ path, before: existsSync(join(source, path)) ? readFileSync(join(source, path), 'utf8') : null, after: readFileSync(join(dir, path), 'utf8') }));
    save(join(artifacts, 'patch.json'), patch);
    const accepted = result.status === 'completed' && hidden.exitCode === 0 && regression.exitCode === 0 && newTests.length > 0 && newTestResult?.exitCode === 0;
    const judged = { id, ...item, result: { ...result, rollout: undefined }, hidden, regression, newTests, newTestResult,
      changed, provisionallyAccepted: accepted, accountingComplete, heldUsd: requests.reduce((s, r) => s + (r.heldUsd ?? 0), 0),
      patchHash: hash(JSON.stringify(patch)), humanReview: 'pending', contextHash: hash(context) };
    save(join(artifacts, 'judged.json'), judged);
    console.log(`  ${accepted ? 'PASS' : 'FAIL'}; $${result.costUsd.toFixed(4)}; ${result.toolCalls} tool calls; ${Math.round(result.elapsedMs / 1000)}s`);
    report();
  }
}

function report() {
  const manifest = json(join(root, 'manifest.json'));
  const memory = existsSync(join(root, 'memory.json')) ? json(join(root, 'memory.json')) : null;
  const rows = manifest.schedule.map((item: any) => {
    const p = join(root, 'runs', item.key.slice(0, 12), 'judged.json'); return existsSync(p) ? json(p) : null;
  }).filter(Boolean);
  const summary = ['baseline', 'note', 'memory'].map(condition => {
    const matching = rows.filter((r: any) => r.condition === condition);
    const executionCostUsd = matching.reduce((s: number, r: any) => s + r.result.costUsd, 0);
    const formationCostUsd = condition === 'memory' ? memory?.formationCostUsd ?? 0 : 0;
    const accepted = matching.filter((r: any) => r.provisionallyAccepted).length;
    const accountingComplete = matching.every((r: any) => r.accountingComplete);
    return { condition, runs: matching.length, accepted, executionCostUsd, formationCostUsd,
      accountingComplete, fullCostPerAcceptedUsd: accepted && accountingComplete ? (executionCostUsd + formationCostUsd) / accepted : null,
      executionCostPerAcceptedUsd: accepted && accountingComplete ? executionCostUsd / accepted : null,
      elapsedSeconds: matching.reduce((s: number, r: any) => s + r.result.elapsedMs / 1000, 0),
      promptTokens: matching.reduce((s: number, r: any) => s + r.result.promptTokens, 0),
      completionTokens: matching.reduce((s: number, r: any) => s + r.result.completionTokens, 0) };
  });
  save(join(root, 'summary.json'), { generatedAt: new Date().toISOString(), completedRuns: rows.length,
    plannedRuns: 9, summary, limitations: manifest.limitations });
  console.log(JSON.stringify(summary));
}

await prepare();
if (mode === 'prepare') process.exit(0);
if (mode === 'report') { report(); process.exit(0); }
const frozen = json(join(root, 'manifest.json'));
for (const [key, path] of Object.entries({ harnessHash: 'src/value-trial.ts', providerHash: 'src/eval-provider.ts', runnerHash: 'scripts/value-trial.ts' })) {
  if (hash(readFileSync(path)) !== frozen[key]) throw new Error(`FROZEN_HARNESS_CHANGED:${path}`);
}
const provider = await EvalProvider.open(root);
try {
  if (mode === 'all' || mode === 'train') await train(provider);
  if (mode === 'all' || mode === 'run') await run(provider);
  console.log(`Remaining trial allowance: $${provider.remaining().toFixed(4)}`);
} finally { await provider.close(); }
