/** Native Codex plan sessions. No API credentials, external gateway, or dollar estimates. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseEvalMetrics } from './eval-metrics';

export const CODEX_MODEL = 'gpt-6.1-sol';
export const CODEX_EFFORT = 'high';
export function codexEnvironment(workspace: string, inherited: Record<string,string|undefined> = process.env) {
  const env={...inherited};
  // Neither ambient billing overrides nor inherited Git roots may affect a trial.
  for(const key of Object.keys(env)) if(/^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|CODEX_ACCESS_TOKEN|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CEILING_DIRECTORIES)$/i.test(key)) delete env[key];
  // Git does not treat the current directory itself as a search ceiling.
  env.GIT_CEILING_DIRECTORIES=dirname(workspace);
  return env;
}
export function codexArgs(workspace: string, finalPath: string, readonly = false, schema?: string) {
  return ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json',
    ...(readonly ? ['--sandbox', 'read-only', '-c', 'approval_policy="never"'] : ['--approve-for-me']), '--cd', workspace,
    '-c', 'forced_login_method="chatgpt"',
    '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
    '-c', 'features.multi_agent=false', '-c', 'features.memories=false',
    '-c', 'features.apps=false', '-c', 'features.plugins=false',
    '-c', `model_reasoning_effort="${CODEX_EFFORT}"`, '-m', CODEX_MODEL,
    '--output-last-message', finalPath, ...(schema ? ['--output-schema', schema] : []), '-'];
}
export interface CodexResult {
  status: 'completed' | 'failed' | 'timeout'; exitCode: number | null; elapsedMs: number;
  final: string; metrics: ReturnType<typeof parseEvalMetrics>; actualCostUsd: null;
}
export async function codexSession(workspace: string, artifacts: string, prompt: string,
  options: { readonly?: boolean; timeoutMs?: number; schema?: string; executable?: string } = {}): Promise<CodexResult> {
  mkdirSync(artifacts, { recursive: true });
  const finalPath = join(artifacts, 'final.txt');
  const args = codexArgs(workspace, finalPath, options.readonly, options.schema);
  writeFileSync(join(artifacts, 'prompt.txt'), prompt);
  writeFileSync(join(artifacts, 'invocation.json'), JSON.stringify({ args, model: CODEX_MODEL, effort: CODEX_EFFORT, billing: 'chatgpt-plan', actualCostUsd: null }, null, 2));
  // Clear any ambient API-key overrides so this never silently switches billing.
  const env = codexEnvironment(workspace);
  const started = Date.now();
  const proc = Bun.spawn([options.executable ?? Bun.which('codex') ?? 'codex', ...args], {
    cwd: workspace, env, stdin: new Blob([prompt]), stdout: 'pipe', stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, options.timeoutMs ?? 300000);
  let stdout: string, stderr: string, exitCode: number;
  try { [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); }
  finally { clearTimeout(timer); }
  writeFileSync(join(artifacts, 'events.jsonl'), stdout);
  writeFileSync(join(artifacts, 'stderr.log'), stderr);
  const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const completed = events.some(e => e.type === 'turn.completed');
  const result: CodexResult = { status: timedOut ? 'timeout' : !exitCode && completed ? 'completed' : 'failed',
    exitCode, elapsedMs: Date.now() - started, final: existsSync(finalPath) ? readFileSync(finalPath, 'utf8') : '',
    metrics: parseEvalMetrics(stdout), actualCostUsd: null };
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

/** Adapt observed CLI command events to the existing deterministic capture format. */
export function codexEventsToRollout(jsonl: string, prompt: string, session: string): string {
  const out: unknown[] = [{ type: 'session_meta', payload: { id: session, cwd: 'trial/project' } },
    { type: 'response_item', payload: { id: `${session}-user`, type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }];
  let i = 0;
  const seen = new Set<string>();
  for (const line of jsonl.split('\n')) {
    let d: any; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'item.completed' || d.item?.type !== 'command_execution') continue;
    if (d.item.id && seen.has(d.item.id)) continue;
    if (d.item.id) seen.add(d.item.id);
    const callId = `${session}-call-${i++}`;
    out.push({ type: 'response_item', payload: { id: `${callId}-in`, call_id: callId, type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: d.item.command }) } });
    out.push({ type: 'response_item', payload: { id: `${callId}-out`, call_id: callId, type: 'function_call_output', output: d.item.aggregated_output ?? '' } });
  }
  return out.map(r => JSON.stringify(r)).join('\n') + '\n';
}

export function recordPlanSession(root: string, label: string, result: CodexResult) {
  appendFileSync(join(root, 'sessions.jsonl'), JSON.stringify({ label, status: result.status,
    usage: result.metrics.usage, accounting: result.metrics.accounting, elapsedMs: result.elapsedMs,
    actualCostUsd: null, billing: 'chatgpt-plan' }) + '\n');
}
