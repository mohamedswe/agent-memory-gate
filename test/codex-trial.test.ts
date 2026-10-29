import { expect, test } from 'bun:test';
import { codexArgs, codexEventsToRollout, codexEnvironment } from '../src/codex-trial';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRollout, feedLedger } from '../src/rollout-reader';
import { UsageLedger } from '../src/usage-ledger';
test('native trial pins ChatGPT billing, model, isolation and noninteractive permissions', () => {
  const args = codexArgs('workspace', 'final');
  expect(args).toContain('forced_login_method="chatgpt"'); expect(args).toContain('--ignore-user-config');
  expect(args).toContain('project_doc_max_bytes=0'); expect(args).toContain('--ephemeral');
  expect(args).toContain('--approve-for-me'); expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  expect(codexArgs('w','f',true)).toContain('read-only');
});
test('only completed native commands enter the existing capture pipeline', () => {
  const command = { id: 'a', type: 'command_execution', command: 'bun scripts/test.ts', aggregated_output: '123 pass' };
  const data = [{ type: 'item.started', item: command }, { type: 'item.completed', item: command }, { type: 'item.completed', item: command },
    { type: 'item.completed', item: { ...command, id: 'b' } }, { type: 'item.completed', item: { type: 'agent_message', text: 'claim' } }].map(e=>JSON.stringify(e)).join('\n');
  const rollout = parseRollout(codexEventsToRollout(data, 'Onboard only.', 'seed'));
  expect(rollout.events.filter(e=>e.kind==='tool_call')).toHaveLength(2);
  const ledger=new UsageLedger(); feedLedger(ledger,rollout);
  expect(ledger.promotionCandidates()).toHaveLength(1);
  expect(ledger.promotionCandidates()[0].key).toContain('bun scripts/test.ts');
});
test('trial Git commands cannot discover a parent checkout or inherit API billing', () => {
  const root=mkdtempSync(join(tmpdir(),'codex-ceiling-')), child=join(root,'workspace');
  mkdirSync(child);
  try {
    expect(Bun.spawnSync(['git','init','--quiet',root]).exitCode).toBe(0);
    const ordinary=Bun.spawnSync(['git','rev-parse','--show-toplevel'],{cwd:child});
    expect(ordinary.exitCode).toBe(0);
    const env=codexEnvironment(child,{...process.env,OPENAI_API_KEY:'synthetic',CODEX_API_KEY:'synthetic',GIT_DIR:join(root,'.git')});
    expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.CODEX_API_KEY).toBeUndefined();expect(env.GIT_DIR).toBeUndefined();
    expect(Bun.spawnSync(['git','rev-parse','--show-toplevel'],{cwd:child,env}).exitCode).not.toBe(0);
    expect(Bun.spawnSync(['git','init','--quiet',child],{env}).exitCode).toBe(0);
    expect(Bun.spawnSync(['git','rev-parse','--show-toplevel'],{cwd:child,env}).exitCode).toBe(0);
  } finally { rmSync(root,{recursive:true}); }
});
