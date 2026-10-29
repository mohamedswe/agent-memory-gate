import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { UsageLedger } from '../src/usage-ledger';
import { CrossSessionLedger } from '../src/cross-session-ledger';
import { captureSession } from '../src/session-capture';
import { redactCandidates } from '../src/redaction-gate';
import { parseRollout } from '../src/rollout-reader';

const context = { projectDir: 'C:/project', packageScripts: { test: 'bun scripts/test.ts' } };
const wrapped = (body: string) => `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '${body}'`;
function ledger(commands: string[], options: any = context) {
  const l = new UsageLedger(options);
  for (const cmd of commands) l.recordToolCall('exec_command', { cmd });
  return l;
}
test('declared Bun alias and direct invocation become one repeated action with original provenance', () => {
  const l = ledger(['bun scripts/test.ts', 'bun run test']);
  const candidates = l.promotionCandidates();
  expect(candidates).toHaveLength(1); expect(candidates[0].counts.agentRediscoveries).toBe(2);
  expect(candidates[0].key).toContain('bun scripts/test.ts');
  expect(candidates[0].sourceKeys).toHaveLength(2);
});
test('batched and separate PowerShell reads match without manufacturing repeats inside one call', () => {
  const l = ledger([wrapped('Get-Content README.md; Get-Content package.json; Get-Content README.md')]);
  expect(l.promotionCandidates()).toHaveLength(0);
  l.recordToolCall('exec_command', { cmd: 'Get-Content -LiteralPath README.md' });
  l.recordToolCall('exec_command', { cmd: 'Get-Content -Path package.json' });
  expect(l.promotionCandidates()).toHaveLength(2);
  expect(l.promotionCandidates().every(c=>c.counts.agentRediscoveries===2)).toBe(true);
});
test('package aliases require known scripts and cannot erase lifecycle hooks or changed script targets', () => {
  for(const options of [{}, {packageScripts:{test:'bun other.ts'}}, {packageScripts:{test:'bun scripts/test.ts',pretest:'bun prepare.ts'}}, {packageScripts:{test:'bun scripts/test.ts',posttest:'bun report.ts'}}]) {
    expect(ledger(['bun scripts/test.ts','bun run test'], options).promotionCandidates()).toHaveLength(0);
  }
});
test('flags, environments, different directories, pipelines, conditionals and unknown shell syntax stay distinct', () => {
  const variants = ['bun run test --watch','bun scripts/test.ts --watch','MODE=test bun scripts/test.ts','bun scripts/test.ts | cat', 'bun scripts/test.ts && echo ok','Get-Content README.md -Tail 1','Get-Content *.md','Get-Content -LiteralPath "*.md"'];
  for(const variant of variants) {
    expect(ledger(['bun scripts/test.ts',variant]).promotionCandidates()).toHaveLength(0);
  }
  const l=new UsageLedger(context);
  l.recordToolCall('exec_command',{cmd:'bun run test',workdir:'C:/project'});
  l.recordToolCall('exec_command',{cmd:'bun run test',workdir:'C:/project/other'});
  expect(l.promotionCandidates()).toHaveLength(0);
});
test('unknown commands preserve meaningful quoted whitespace rather than collapsing it', () => {
  expect(ledger(["echo 'a  b'", "echo 'a b'"]).promotionCandidates()).toHaveLength(0);
});
test('project script metadata is snapshotted so mutation cannot change identities mid-session', () => {
  const scripts={test:'bun scripts/test.ts'}; const l=new UsageLedger({packageScripts:scripts});
  l.recordToolCall('exec_command',{cmd:'bun run test'});scripts.test='bun changed.ts';
  l.recordToolCall('exec_command',{cmd:'bun scripts/test.ts'});
  expect(l.promotionCandidates()).toHaveLength(1);
});
test('secrets in original calls cannot disappear behind a harmless normalized fragment', () => {
  const l=ledger(['Get-Content README.md; Get-Content credentials/token.txt','Get-Content README.md']);
  const candidates=l.promotionCandidates().map(c=>({key:c.key,sourceKeys:c.sourceKeys,projectDir:'C:/project',sessionFile:'fixture',counts:c.counts}));
  expect(candidates.length).toBeGreaterThan(0);
  expect(redactCandidates(candidates).passed).toHaveLength(0);
});
test('ID-less real rollout items retain messages, tool calls, and outputs without duplicate call wrappers', () => {
  const msg={type:'message',role:'user',content:'Inspect tests'};
  const call={type:'function_call',call_id:'call',name:'exec_command',arguments:JSON.stringify({cmd:'bun scripts/test.ts'})};
  const output={type:'function_call_output',call_id:'call',output:'123 pass'};
  const r=parseRollout([msg,msg,call,call,output,output].map(payload=>JSON.stringify({type:'response_item',payload})).join('\n'));
  expect(r.events.map(e=>e.kind)).toEqual(['user_message','user_message','tool_call','tool_output']);
});
test('live capture loads project scripts and recognizes aliases in ID-less rollouts', () => {
  const root=mkdtempSync(join(tmpdir(),'action-capture-'));
  try {
    writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{test:'bun scripts/test.ts'}}));
    const file=join(root,'rollout-actions.jsonl');
    writeFileSync(file,[{type:'session_meta',payload:{id:'s',cwd:root}},...['bun scripts/test.ts','bun run test'].map((cmd,i)=>({type:'response_item',payload:{type:'function_call',call_id:String(i),name:'exec_command',arguments:JSON.stringify({cmd})}}))].map(e=>JSON.stringify(e)).join('\n'));
    const r=captureSession(file);expect(r.queued).toHaveLength(1);expect(r.queued[0].sourceKeys).toHaveLength(2);
  } finally {rmSync(root,{recursive:true});}
});
test('cross-session promotion retains both original calls, session identities and project isolation across restart', () => {
  const root=mkdtempSync(join(tmpdir(),'action-cross-'));
  try {
    const path=join(root,'ledger.json');let cross=new CrossSessionLedger(path);
    const a=ledger(['bun scripts/test.ts']),b=ledger(['bun run test']);
    for(const key of a.rawKeys())cross.observe('project',key,'first',a.sourceKeysFor(key));
    for(const key of b.rawKeys())cross.observe('other-project',key,'elsewhere',b.sourceKeysFor(key));
    expect(cross.newlyCrossing('project')).toHaveLength(0);
    cross=new CrossSessionLedger(path);
    for(const key of b.rawKeys())cross.observe('project',key,'second',b.sourceKeysFor(key));
    const [key]=cross.newlyCrossing('project');expect(key).toBeDefined();
    expect(cross.sourcesFor('project',key).map(s=>s.sessionFile).sort()).toEqual(['first','second']);
    expect(cross.sourcesFor('project',key).flatMap(s=>s.sourceKeys)).toHaveLength(2);
    cross.markPromoted('project',key);expect(new CrossSessionLedger(path).newlyCrossing('project')).toEqual([]);
  } finally {rmSync(root,{recursive:true});}
});
test('the actual capture CLI previews five promotions without writes, then queues them once with provenance', () => {
  const root=mkdtempSync(join(tmpdir(),'capture-cli-'));
  try {
    const project=join(root,'project'),sessions=join(root,'sessions'),queue=join(root,'state','queue.jsonl');
    mkdirSync(project);mkdirSync(sessions);
    writeFileSync(join(project,'package.json'),JSON.stringify({scripts:{test:'bun scripts/test.ts'}}));
    const commands=[['Get-Content README.md; Get-Content package.json; Get-Content scripts/test.ts; Get-Content test/usage-ledger.test.ts','bun scripts/test.ts'],
      ['Get-Content -LiteralPath README.md','Get-Content -LiteralPath package.json','Get-Content -LiteralPath scripts/test.ts','Get-Content -LiteralPath test/usage-ledger.test.ts','bun run test']];
    commands.forEach((calls,i)=>writeFileSync(join(sessions,`rollout-${i}.jsonl`),[
      {type:'session_meta',payload:{id:`s${i}`,cwd:project}},
      ...calls.map((cmd,j)=>({type:'response_item',payload:{type:'function_call',call_id:`${i}-${j}`,name:'exec_command',arguments:JSON.stringify({cmd:wrapped(cmd)})}})),
    ].map(e=>JSON.stringify(e)).join('\n')));
    const invoke=(dry=false)=>{
      const p=Bun.spawnSync([process.execPath,resolve('scripts/session-capture.ts'),'--sessions',sessions,'--queue',queue,...(dry?['--dry-run']:[])]);
      expect(p.exitCode).toBe(0);return p.stdout.toString();
    };
    expect(invoke(true)).toContain('"crossSessionQueued": 5');expect(existsSync(join(root,'state'))).toBe(false);
    expect(invoke()).toContain('"crossSessionQueued": 5');
    const before=readFileSync(queue,'utf8'),queued=before.trim().split('\n').map(s=>JSON.parse(s));
    expect(queued).toHaveLength(5);
    expect(queued.every(c=>c.crossSession&&c.sourceSessions.length===2&&c.sourceKeys.length===2)).toBe(true);
    expect(invoke()).toContain('"crossSessionQueued": 0');expect(readFileSync(queue,'utf8')).toBe(before);
  } finally {rmSync(root,{recursive:true});}
});
test('quotes, content modes, unknown arguments and shell state cannot be erased during normalization', () => {
  for(const commands of [
    ['Get-Content "a;b.md"','Get-Content a.md; Get-Content b.md'],
    ['Get-Content README.md','Get-Content README.md -Raw'],
    ['Get-Content README.md','Set-Location other; Get-Content README.md'],
    ['Get-Content README.md','Get-Content "$env:FILE"'],
    ['bun scripts/test.ts','bun run test; Write-Output done'],
    [wrapped('bun scripts/test.ts'),'powershell.exe -NoProfile -Command "bun scripts/test.ts"'],
  ])expect(ledger(commands).promotionCandidates()).toHaveLength(0);
  const l=new UsageLedger(context);l.recordToolCall('exec_command',{cmd:'bun scripts/test.ts'});
  l.recordToolCall('exec_command',{cmd:'bun run test',env:{MODE:'different'}});
  expect(l.promotionCandidates()).toHaveLength(0);
});
test('preserving ID-less messages does not promote repeated system-injected instructions', () => {
  const l=new UsageLedger();
  l.recordUserMention('<environment_context>shared scaffold</environment_context>');
  l.recordUserMention('<environment_context>shared scaffold</environment_context>');
  expect(l.rawKeys()).toEqual([]);expect(l.promotionCandidates()).toEqual([]);
});
