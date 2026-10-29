/** Reapply exported patches to a clean commit and rerun functional acceptance, offline. */
import { readFileSync,writeFileSync,mkdirSync,mkdtempSync,existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tasks } from '../experiments/value-v1-tasks';
import { scopedPath,command,hash } from '../src/value-trial';
const data=resolve(process.argv[2]??'experiments/run-10-data');
const results=JSON.parse(readFileSync(join(data,'codex-results.json'),'utf8'));
const manifest=JSON.parse(readFileSync(join(data,'codex-manifest.json'),'utf8'));
if(!/^[0-9a-f]{40}$/.test(manifest.sourceCommit))throw new Error('INVALID_SOURCE_COMMIT');
if(results.status!=='complete'||results.rows.length!==9||manifest.schedule.length!==9||new Set(results.rows.map((r:any)=>r.id)).size!==9)throw new Error('INCOMPLETE_OR_DUPLICATE_RUNS');
mkdirSync('.eval-local',{recursive:true});const root=mkdtempSync(resolve('.eval-local','patch-recheck-'));
const archive=join(root,'source.zip');
const git=Bun.spawnSync(['git','-c',`safe.directory=${process.cwd().replace(/\\/g,'/')}`,'archive','--format=zip',`--output=${archive}`,manifest.sourceCommit]);
if(git.exitCode)throw new Error('SOURCE_ARCHIVE_FAILED');
mkdirSync(join(root,'judge'));
const checks=[];
for(const row of results.rows){
  if(!/^[0-9a-f]{12}$/.test(row.id))throw new Error('INVALID_RUN_ID');
  if(!manifest.schedule.some((s:any)=>s.key.slice(0,12)===row.id&&s.task===row.task&&s.condition===row.condition))throw new Error('RUN_SCHEDULE_MISMATCH');
  const workspace=join(root,row.id);mkdirSync(workspace);
  const extraction=Bun.spawnSync(['tar','-xf',archive,'-C',workspace]);if(extraction.exitCode)throw new Error('SOURCE_EXTRACTION_FAILED');
  const patch=JSON.parse(readFileSync(join(data,'patches',row.id+'.json'),'utf8'));
  if(hash(JSON.stringify(patch))!==row.patchHash)throw new Error('PATCH_HASH_MISMATCH');
  for(const change of patch){
    if(!/^(src|test)\/.*\.ts$/.test(change.path))throw new Error('PATCH_PATH_NOT_ALLOWED');
    const target=scopedPath(workspace,change.path);
    const before=existsSync(target)?readFileSync(target,'utf8'):null;
    if(before!==change.before)throw new Error('PATCH_BASE_MISMATCH');
    mkdirSync(resolve(target,'..'),{recursive:true});writeFileSync(target,change.after);
  }
  const task=tasks.find(t=>t.id===row.task)!;
  if(!task||hash(task.acceptance)!==manifest.tasks.find((t:any)=>t.id===row.task)?.acceptanceHash)throw new Error('ACCEPTANCE_DEFINITION_MISMATCH');
  const judge=join(root,'judge',row.task+'.test.ts');writeFileSync(judge,task.acceptance);
  const check=await command(workspace,['test',judge],90000,{TRIAL_WORKSPACE:workspace});
  const pass=Number(check.stderr.match(/\n\s*(\d+) pass\b/)?.[1]??0),fail=Number(check.stderr.match(/\n\s*(\d+) fail\b/)?.[1]??0);
  const passed=check.exitCode===0&&pass>0&&pass===row.hidden.pass&&fail===0;
  checks.push({id:row.id,task:row.task,condition:row.condition,exitCode:check.exitCode,pass,fail,passed,patchHash:row.patchHash});
  writeFileSync(join(root,row.id+'.json'),JSON.stringify(check,null,2));
}
const report={generatedAt:new Date().toISOString(),sourceCommit:manifest.sourceCommit,offline:true,inferenceCalls:0,
  reapplied:checks.length,allAcceptanceChecksPassed:checks.length===9&&checks.every(c=>c.passed),checks,
  scope:'Fresh patch reapplication and hidden functional acceptance. Full original-suite results remain in the experiment validation logs; not rerun here.'};
writeFileSync(join(data,'patch-recheck.json'),JSON.stringify(report,null,2)+'\n');
if(!report.allAcceptanceChecksPassed)throw new Error('EXPORTED_PATCH_RECHECK_FAILED');
console.log(JSON.stringify({reapplied:checks.length,allAcceptanceChecksPassed:true,inferenceCalls:0}));
