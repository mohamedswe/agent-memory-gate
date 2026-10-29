/** Compact audit export. Raw source/transcripts remain in ignored local artifacts. */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, basename, relative, isAbsolute } from 'node:path';
import { hash } from '../src/value-trial';
const option=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const root=resolve(option('--trial')??'.eval-local/value-codex-v3');
const target=resolve(option('--dest')??(option('--trial')?`experiments/${basename(root)}-data`:'experiments/run-09-data'));
for(const [base,path] of [[resolve('.eval-local'),root],[resolve('experiments'),target]]){const rel=relative(base,path);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('EXPORT_PATH_OUTSIDE_TRIAL_WORKSPACE');}
const json=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const m=json(join(root,'manifest.json')),summary=json(join(root,'summary.json')),memory=json(join(root,'memory.json'));
const count=(text:string,kind:string)=>Number(text.match(new RegExp(`\\n\\s*(\\d+) ${kind}\\b`))?.[1]??0);
const rows=m.schedule.flatMap((entry:any)=>{
  const id=entry.key.slice(0,12),dir=join(root,'runs',id),p=join(dir,'judged.json');if(!existsSync(p))return [];
  const r=json(p),patch=json(join(dir,'patch.json'));
  if(hash(JSON.stringify(patch))!==r.patchHash)throw new Error('PATCH_ARTIFACT_CHANGED');
  const events=readFileSync(join(dir,'events.jsonl'),'utf8').trim().split('\n').flatMap(s=>{try{return [JSON.parse(s)];}catch{return [];}});
  const commands=events.filter(e=>e.type==='item.completed'&&e.item?.type==='command_execution');
  return [{id,task:entry.task,condition:entry.condition,status:r.result.status,provisionallyAccepted:r.provisionallyAccepted,
    usage:r.result.metrics.usage,accounting:r.result.metrics.accounting,elapsedMs:r.result.elapsedMs,
    executedShellCommands:commands.length,fileChangeEvents:events.filter(e=>e.type==='item.completed'&&e.item?.type==='file_change').length,
    hidden:{exitCode:r.hidden.exitCode,pass:count(r.hidden.stderr,'pass'),fail:count(r.hidden.stderr,'fail')},
    regressions:{exitCode:r.regressions.exitCode,pass:count(r.regressions.stderr,'pass'),fail:count(r.regressions.stderr,'fail')},
    addedRegressionTests:r.newTests,addedTestsPassed:r.addedTests?.exitCode===0,changed:r.changed,deleted:r.deleted,
    forbiddenChanges:r.forbiddenChanges,patchHash:r.patchHash,contextHash:r.contextHash,
    parentGitMetadataObserved:commands.some(e=>/git\s+status/.test(e.item.command)&&/\.\.\/\.\.\/\.\.\//.test(e.item.aggregated_output??'')),
    independentHumanReview:'not performed',actualCostUsd:null}];
});
const diagnostics=(m.version>=5?[]:['value-codex-v1','value-codex-v2']).flatMap(name=>{
  const p=resolve('.eval-local',name,'sessions.jsonl');if(!existsSync(p))return [];
  return readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(s=>({cohort:name,...JSON.parse(s)}));
});
const result={generatedAt:new Date().toISOString(),status:rows.length===9?'complete':'in_progress',
  model:m.model,effort:m.effort,billing:m.billing,actualCostUsd:null,completedRuns:rows.length,plannedRuns:9,
  memoryFormation:{learnedRecords:memory.records.length,reviewedCandidates:memory.outcomes.length,
    primaryTokens:memory.formationTokens,totalTokens:memory.formationTotalTokens,
    newReviewTokens:memory.newFormationTokens??null,reusedOnboardingTokens:memory.reusedOnboardingTokens??0,
    manipulationCheck:memory.validation?.ready?'PASSED_SOURCE_SUPPORTED_PROCEDURE':memory.records.length?'nonempty_memory':'FAILED_NO_LEARNED_RECORDS',
    readiness:memory.validation??null,records:memory.records,
    reviewOutcomes:memory.outcomes.map((o:any)=>({key:o.candidate.key,sourceSessions:o.candidate.sourceSessions??[],output:o.output})),
    trainingReplay:m.trainingReplay??null},
  summary:summary.summary,rows,
  setupDiagnostics:{sessions:diagnostics.length,primaryTokens:diagnostics.reduce((s,r)=>s+(r.usage?.uncached??0)+(r.usage?.output??0),0),
    totalTokens:diagnostics.reduce((s,r)=>s+(r.usage?.total??0),0),note:'Earlier permission diagnostics, excluded from valid formation and measured runs; generic connectivity probes and developer setup effort are not included.'},
  interpretation:{causalMemoryBenefitEstablished:false,
    reasons:[...(memory.records.length?[]:['The memory condition contains no learned records, so it cannot establish a learned-guidance benefit.']),
      'Only one attempt per condition across three selected defects; model and cache variability are uncontrolled.',
      ...(rows.some((r:any)=>r.parentGitMetadataObserved)?['Some git status commands exposed parent-checkout filenames; isolated Git roots are required for a stronger follow-up.']:[]),
      ...(m.version>=5?['Compared with Run 09, Git isolation and condition ordering also changed; cross-cohort deltas do not isolate normalization alone.']:[]),
      'Automated test acceptance is provisional and is not independent human review.'],
    commandMetric:'Executed shell commands; it is not a count of every native tool invocation.',
    dollarMetric:'Unavailable under the ChatGPT/Codex plan; tokens are not billed-credit estimates.'},
};
for(const row of rows){
  const raw=json(join(root,'runs',row.id,'judged.json'));
  const accepted=raw.result.status==='completed'&&raw.hidden.exitCode===0&&raw.regressions.exitCode===0&&raw.newTests.length>0&&raw.addedTests?.exitCode===0&&!raw.forbiddenChanges.length&&!raw.deleted.length&&!raw.changed.some((p:string)=>p.startsWith('test/')&&existsSync(join('.eval-local/value-v1/source',p)));
  if(accepted!==row.provisionallyAccepted)throw new Error('ACCEPTANCE_ROLLUP_MISMATCH');
}
for(const group of result.summary){
  const matching=rows.filter((r:any)=>r.condition===group.condition);
  const tokens=matching.length?matching.reduce((s:number,r:any)=>s+r.usage.uncached+r.usage.output,0):null;
  if(group.runs!==matching.length||group.accepted!==matching.filter((r:any)=>r.provisionallyAccepted).length||group.executionTokens!==tokens)throw new Error('SUMMARY_ROLLUP_MISMATCH');
}
const originalHarnessVerified=Object.entries(m.harnessHashes).every(([p,h])=>{
  const archived=join(root,'harness-snapshot',p);return existsSync(archived)&&hash(readFileSync(archived))===h;
});
Object.assign(result,{originalHarnessVerified,acceptanceFilesVerified:m.tasks.every((t:any)=>hash(readFileSync(join('.eval-local/value-v1/judge',t.id+'.test.ts')))===t.acceptanceHash),
  postTrialHardening:m.version>=5?'Git-root isolation and discovery ceilings were applied before all measured runs.':'After completion, the runner clears inherited Git-root variables and sets a parent-directory discovery ceiling. A real nested-Git regression test verifies the fix. This change is not retroactively applied to measured results.'});
const baseline=result.summary.find((r:any)=>r.condition==='baseline'),treatment=result.summary.find((r:any)=>r.condition==='memory');
Object.assign(result,{descriptiveComparison:rows.length===9&&baseline?.tokensPerAccepted&&treatment?.tokensPerAccepted?{
  fullTokensChangeFraction:treatment.tokensPerAccepted/baseline.tokensPerAccepted-1,
  executionOnlyChangeFraction:(treatment.executionTokens/treatment.accepted)/(baseline.executionTokens/baseline.accepted)-1,
  practicalThresholdMet:treatment.tokensPerAccepted<=baseline.tokensPerAccepted*.85&&treatment.accepted>=baseline.accepted,
  note:'Descriptive, one attempt per task-condition; not a statistical or general productivity claim.'}:null});
mkdirSync(target,{recursive:true});
if(m.version>=5){
  const scrub=(value:any):any=>typeof value==='string'?value.replaceAll(process.cwd(),'<repo>').replaceAll(process.cwd().replace(/\\/g,'/'),'<repo>'):Array.isArray(value)?value.map(scrub):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,scrub(v)])):value;
  mkdirSync(join(target,'patches'),{recursive:true});mkdirSync(join(target,'validation'),{recursive:true});
  for(const row of rows){
    const dir=join(root,'runs',row.id),raw=json(join(dir,'judged.json'));
    // Relative source/test paths and original code bytes are retained for offline reapplication.
    cpPatch(join(dir,'patch.json'),join(target,'patches',row.id+'.json'));
    writeFileSync(join(target,'validation',row.id+'.json'),JSON.stringify(scrub({hidden:raw.hidden,regressions:raw.regressions,addedTests:raw.addedTests}),null,2)+'\n');
  }
}
writeFileSync(join(target,'codex-manifest.json'),JSON.stringify(m,null,2)+'\n');
writeFileSync(join(target,'codex-results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,runs:rows.length,memoryRecords:memory.records.length,summary:result.summary}));

function cpPatch(from:string,to:string){writeFileSync(to,readFileSync(from));}
