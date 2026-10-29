/** Offline production-path verification. Original Run 09 data is never edited. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { hash } from '../src/value-trial';
const original=resolve('.eval-local/value-codex-v3'), root=resolve('.eval-local/run09-capture-fix');
const project=join(root,'project'), sessions=join(root,'sessions'),queue=join(root,'state','capture-queue.jsonl');
const baseline='experiments/run-09-data/codex-results.json',before=hash(readFileSync(baseline));
mkdirSync(project,{recursive:true});mkdirSync(sessions,{recursive:true});
const packageText=readFileSync('.eval-local/value-v1/source/package.json','utf8');
writeFileSync(join(project,'package.json'),packageText);
const inputHashes=[];
for(let i=0;i<2;i++){
  const text=readFileSync(join(original,'warmup-artifacts',String(i),'rollout.jsonl'),'utf8');
  inputHashes.push({session:`warmup-${i}`,sha256:hash(text)});
  // Map the synthetic trial project identity to a local overlay containing its
  // pinned package.json. Tool calls/messages stay byte-for-byte equivalent.
  const events=text.trim().split('\n').map(s=>JSON.parse(s));
  events.find(e=>e.type==='session_meta').payload.cwd=project;
  writeFileSync(join(sessions,`rollout-warmup-${i}.jsonl`),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
}
function capture(dry=false){
  const p=Bun.spawnSync([process.execPath,resolve('scripts/session-capture.ts'),'--sessions',sessions,'--queue',queue,...(dry?['--dry-run']:[])]);
  if(p.exitCode)throw new Error(p.stderr.toString());return p.stdout.toString();
}
const preview=capture(true), first=capture();
const queuedText=readFileSync(queue,'utf8'), lines=queuedText.trim().split('\n').map(s=>JSON.parse(s));
const candidates=lines.filter(c=>c.crossSession);
if(candidates.length!==5||candidates.some(c=>c.sourceSessions?.length!==2||c.sourceKeys?.length!==2))throw new Error('CAPTURE_REPLAY_FAILED');
const supported=candidates.filter(c=>c.key.includes(JSON.parse(packageText).scripts.test));
if(supported.length!==1)throw new Error('CANONICAL_TEST_PROCEDURE_NOT_CAPTURED');
capture();if(readFileSync(queue,'utf8')!==queuedText)throw new Error('CAPTURE_REPLAY_DUPLICATED_QUEUE');
if(hash(readFileSync(baseline))!==before)throw new Error('ORIGINAL_EXPERIMENT_CHANGED');
const result={generatedAt:new Date().toISOString(),kind:'Offline capture-fix verification, not a task-performance experiment',
  source:'Two original Run 09 onboarding rollouts; metadata project path overlaid onto their pinned package.json only',inputHashes,
  originalLearnedRecords:0,capturedRepeatedActions:candidates.length,sourceSupportedTestProcedureCandidates:supported.length,
  previewPromotions:Number(preview.match(/"crossSessionQueued": (\d+)/)?.[1]??0),duplicateCaptureChangedQueue:false,
  originalResultSha256:before,originalResultUnchanged:true,paidInferenceCalls:0,
  candidates:candidates.map(c=>({key:c.key,counts:c.counts,sourceSessions:c.sourceSessions.map((s:string)=>basename(s)),sourceKeys:c.sourceKeys})),
  limits:['Candidates require review before becoming durable memories.','Four repeated file reads are not automatically useful lessons.','No new claim about downstream development benefit is made.'],
};
mkdirSync('experiments/run-09-data',{recursive:true});
writeFileSync('experiments/run-09-data/capture-fix-replay.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({capturedRepeatedActions:candidates.length,sourceSupportedTestProcedureCandidates:supported.length,originalResultUnchanged:true,paidInferenceCalls:0}));
