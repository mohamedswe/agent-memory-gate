/** Genuine defects selected before generating any trial memories or responses. */
const header = `import { test, expect } from 'bun:test';
import { pathToFileURL } from 'node:url';
const load = (name: string) => import(pathToFileURL(process.env.TRIAL_WORKSPACE + '/src/' + name + '.ts').href);
`;
export const tasks = [
  {
    id: 'strict-verdict-set',
    prompt: 'Fix satisfaction classification accepting verdicts for turn indices that were not requested. It must accept exactly one verdict for each supplied turn and reject additional, missing, duplicate, fractional, or invalid-state verdicts. Keep valid output ordered by the supplied turns and preserve budget accounting. Add regression tests and run appropriate existing tests. Do not modify existing tests or the canonical launcher.',
    acceptance: header + `
const { classifySatisfaction } = await load('satisfaction-classifier');
async function invoke(verdicts: unknown[], turns = [{index: 2,id:'a',text:'inspect it'},{index: 5,id:'b',text:'good'}]) {
  let reserve = 0, reconcile = 0;
  const result = classifySatisfaction('test', {job:'satisfaction-trajectory',sessionFile:'fixture',projectDir:'trial',branch:null,turns}, {
    httpPost: async () => ({ok:true,json:{choices:[{message:{content:JSON.stringify({verdicts})}}],usage:{cost:.01}}}),
    budget: {reserve:()=>{reserve++;return {reserved:true}},reconcile:()=>{reconcile++},remainingUsd:()=>1},estimateUsd:()=>.02
  });
  return {result, counters:()=>({reserve,reconcile})};
}
const good = [{index:5,state:'pleased'},{index:2,state:'neutral'}];
test('valid non-contiguous turns retain requested order and reconcile once', async()=>{
  const x=await invoke(good); expect((await x.result).turns.map((v:any)=>v.index)).toEqual([2,5]); expect(x.counters()).toEqual({reserve:1,reconcile:1});
});
test('foreign verdict rejected and cost still reconciled', async()=>{
  const x=await invoke([...good,{index:999,state:'neutral'}]); await expect(x.result).rejects.toThrow(); expect(x.counters()).toEqual({reserve:1,reconcile:1});
});
test('missing duplicate fractional and invalid-state verdicts rejected', async()=>{
  for(const bad of [[good[0]],[...good,good[0]],[...good,{index:1.5,state:'neutral'}],[{index:2,state:'fake'},good[0]]]) {const x=await invoke(bad); await expect(x.result).rejects.toThrow();}
});
test('empty requested turn set rejects foreign output',async()=>{const x=await invoke([{index:0,state:'neutral'}],[]);await expect(x.result).rejects.toThrow();});
`,
  },
  {
    id: 'neutral-recovery',
    prompt: 'Fix satisfaction transition tracking when neutral messages occur between displeasure and explicit satisfaction. A displeased -> neutral -> pleased sequence must close the original failure as one recovery, from the first displeased turn to the pleased turn; it must not also create a milestone or unresolved failure for that run. Preserve ordinary milestones, regressions, terminal unresolved failures, and separate later displeased runs. Add regression tests and run appropriate existing tests. Do not modify existing tests or the canonical launcher.',
    acceptance: header + `
const { detectTransitions } = await load('satisfaction-transitions');
const seq=(states:string[])=>states.map((state,index)=>({index,state}));
test('neutral gap recovery closes original failure only',()=>{expect(detectTransitions(seq(['displeased','neutral','neutral','pleased']))).toEqual([{kind:'recovery',fromIndex:0,toIndex:3}]);});
test('first failure survives later neutral/displeased turns until recovered',()=>{expect(detectTransitions(seq(['neutral','displeased','neutral','displeased','neutral','pleased']))).toEqual([{kind:'recovery',fromIndex:1,toIndex:5}]);});
test('normal milestones survive',()=>{expect(detectTransitions(seq(['neutral','pleased']))).toEqual([{kind:'milestone',fromIndex:0,toIndex:1}]);});
test('terminal neutral does not imply resolution',()=>{expect(detectTransitions(seq(['displeased','neutral']))).toEqual([{kind:'unresolved',fromIndex:0,toIndex:1}]);});
test('subsequent failures retain separate provenance',()=>{expect(detectTransitions(seq(['displeased','neutral','pleased','displeased','neutral','pleased']))).toEqual([{kind:'recovery',fromIndex:0,toIndex:2},{kind:'regression',fromIndex:2,toIndex:3},{kind:'recovery',fromIndex:3,toIndex:5}]);});
test('empty and pleased-first input remain valid',()=>{expect(detectTransitions([])).toEqual([]);expect(detectTransitions(seq(['pleased']))).toEqual([]);});
`,
  },
  {
    id: 'idless-rollout',
    prompt: 'Fix rollout parsing when response_item payloads omit id. Distinct messages without IDs must be retained rather than collapsing under an empty-string ID. Tool calls and outputs without IDs should use call_id for deduplication, with distinct identities for a call and its output. Preserve deduplication of explicit item IDs and tolerance of partial trailing JSON. Add regression tests and run appropriate existing tests. Do not modify existing tests or the canonical launcher.',
    acceptance: header + `
const {parseRollout}=await load('rollout-reader');
const line=(payload:any)=>JSON.stringify({type:'response_item',payload});
const msg=(text:string)=>({type:'message',role:'user',content:[{type:'input_text',text}]});
test('unidentified messages including identical text remain distinct',()=>{const r=parseRollout([line(msg('first')),line(msg('same')),line(msg('same'))].join('\\n'));expect(r.events.map((e:any)=>e.text)).toEqual(['first','same','same']);});
test('call/output pairs survive and duplicate wrappers dedupe',()=>{
 const call={type:'function_call',call_id:'c1',name:'exec_command',arguments:'{"cmd":"bun test"}'};
 const out={type:'function_call_output',call_id:'c1',output:'passed'};
 const r=parseRollout([line(call),line(call),line(out),line(out)].join('\\n'));expect(r.events.map((e:any)=>e.kind)).toEqual(['tool_call','tool_output']);
});
test('different call ids do not collapse',()=>{const r=parseRollout(['a','b'].map(call_id=>line({type:'function_call',call_id,name:'exec_command',arguments:'{}'})).join('\\n'));expect(r.events).toHaveLength(2);});
test('explicit IDs still dedupe and partial trailing JSON tolerated',()=>{const p={...msg('x'),id:'m1'};expect(parseRollout(line(p)+'\\n'+line(p)+'\\n{"partial"').events).toHaveLength(1);});
`,
  },
];

export const staticNote = `# Project working note
This is a Bun TypeScript project. The canonical regression command is bun scripts/test.ts; the launcher lists suites explicitly, so add new suites to its list when integrating a change. For focused checks use bun test test/<name>.test.ts. Tests use bun:test and local module imports. Tests involving GBrain use GBRAIN_PACKAGE_DIR, defaulting to the global Bun installation. Keep tests offline and use temporary storage. Paid model review has injected transport dependencies and must not be called in unit tests. Reviewer output is proposed/tentative; verification requires execution evidence. Current user instructions override this note.`;

export const onboarding = [
  'Onboard to this repository without changing files. Inspect README.md, package.json, scripts/test.ts and test/usage-ledger.test.ts. Run the canonical unit suite once. Report the test command, test authoring conventions, and how to avoid paid inference in tests. Use only those files and the test runner; do not inspect other source modules.',
  'Prepare a concise contributor handoff without changing files. Inspect README.md, package.json, scripts/test.ts and test/usage-ledger.test.ts. Verify the canonical suite once and explain how focused tests differ from the full suite and which dependencies it needs. Use only those files and the test runner; do not inspect other source modules.',
];
