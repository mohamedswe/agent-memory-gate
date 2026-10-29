import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EvalProvider } from '../src/eval-provider';
const auth = { token: 'synthetic-test-only', base: 'https://example.invalid' };
test('inference reserves before transport, reconciles actual cost, and refuses at cap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-cap-')); let calls = 0;
  const p = await EvalProvider.open(root, .25, { auth, post: (async()=>{calls++; return new Response(JSON.stringify({choices:[{message:{content:'ok'}}], usage:{cost:.01}}));}) as typeof fetch });
  try {
    await p.call('fixture', {messages:[]}); expect(p.remaining()).toBe(.24);
    await expect(p.call('fixture', {messages:[]})).rejects.toThrow('BUDGET_EXHAUSTED'); expect(calls).toBe(1);
    expect(readFileSync(join(root,'inference.jsonl'),'utf8')).not.toContain(auth.token);
  } finally { await p.close(); rmSync(root,{recursive:true}); }
});
test('missing accounting holds reservation and halts subsequent transport', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-hold-')); let calls = 0;
  const p = await EvalProvider.open(root, 1, { auth, post: (async()=>{calls++; return new Response(JSON.stringify({choices:[{message:{content:'ok'}}]}));}) as typeof fetch });
  try {
    await expect(p.call('fixture', {messages:[]})).rejects.toThrow('MISSING_COST'); expect(p.remaining()).toBe(.75);
    await expect(p.call('fixture', {messages:[]})).rejects.toThrow('HALTED'); expect(calls).toBe(1);
  } finally { await p.close(); rmSync(root,{recursive:true}); }
});
test('ambiguous failure stays held and known HTTP failure still records billed cost', async () => {
  for (const ambiguous of [true,false]) {
    const root=mkdtempSync(join(tmpdir(),'provider-error-'));
    const p=await EvalProvider.open(root,1,{auth,post:(async()=>{if(ambiguous)throw new Error('network');return new Response(JSON.stringify({usage:{cost:.02}}),{status:503});}) as typeof fetch});
    try {
      await expect(p.call('fixture',{messages:[]})).rejects.toThrow(); expect(p.remaining()).toBe(ambiguous ? .75 : .98);
      const audit=JSON.parse(readFileSync(join(root,'inference.jsonl'),'utf8').trim());
      expect(ambiguous ? audit.heldUsd : audit.actualCostUsd).toBe(ambiguous ? .25 : .02);
    } finally {await p.close();rmSync(root,{recursive:true});}
  }
});
