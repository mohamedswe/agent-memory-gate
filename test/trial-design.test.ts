import { test,expect } from 'bun:test';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { balancedTrialSchedule } from '../src/trial-schedule';
import { prepareTrialWorkspace } from '../src/trial-workspace';
import { codexEnvironment } from '../src/codex-trial';
test('every task gets every condition and each condition occupies each position once',()=>{
  const tasks=['a','b','c'],conditions=['baseline','note','memory'];
  const schedule=balancedTrialSchedule(tasks,conditions,'fixed-seed');
  expect(schedule).toHaveLength(9);expect(new Set(schedule.map(r=>r.key)).size).toBe(9);
  for(const task of tasks)expect(schedule.filter(r=>r.task===task).map(r=>r.condition).sort()).toEqual([...conditions].sort());
  for(let position=0;position<3;position++)expect(schedule.filter((_,i)=>i%3===position).map(r=>r.condition).sort()).toEqual([...conditions].sort());
  expect(balancedTrialSchedule(tasks,conditions,'fixed-seed')).toEqual(schedule);
});
test('invalid and duplicate trial designs are rejected before any sessions',()=>{
  expect(()=>balancedTrialSchedule(['a','b'],['x','y','z'],'s')).toThrow();
  expect(()=>balancedTrialSchedule(['a','a','c'],['x','y','z'],'s')).toThrow();
});
test('copied fixtures have their own clean Git roots and preserve source bytes',()=>{
  const root=mkdtempSync(join(tmpdir(),'trial-fixture-')),source=join(root,'source'),workspace=join(root,'workspace');
  mkdirSync(source);writeFileSync(join(source,'file.ts'),'export const value = 1;\r\n');
  try{
    prepareTrialWorkspace(source,workspace);
    expect(readFileSync(join(workspace,'file.ts'))).toEqual(readFileSync(join(source,'file.ts')));
    const env=codexEnvironment(workspace);
    const top=Bun.spawnSync(['git','rev-parse','--show-toplevel'],{cwd:workspace,env});
    expect(top.exitCode).toBe(0);expect(top.stdout.toString().trim().replace(/\\/g,'/')).toBe(workspace.replace(/\\/g,'/'));
    expect(Bun.spawnSync(['git','status','--porcelain'],{cwd:workspace,env}).stdout.toString()).toBe('');
    expect(()=>prepareTrialWorkspace(source,workspace)).toThrow('ALREADY_EXISTS');
  }finally{rmSync(root,{recursive:true});}
});
