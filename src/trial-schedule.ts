import { createHash } from 'node:crypto';
const rank=(seed:string,key:string)=>createHash('sha256').update(seed+key).digest('hex');

/** Balanced positions within task blocks, randomized reproducibly before inference. */
export function balancedTrialSchedule(tasks:string[],conditions:string[],seed:string){
  if(!conditions.length||tasks.length%conditions.length||new Set(tasks).size!==tasks.length||new Set(conditions).size!==conditions.length)throw new Error('UNBALANCED_OR_DUPLICATE_TRIAL_DESIGN');
  const orderedTasks=[...tasks].sort((a,b)=>rank(seed,'task:'+a).localeCompare(rank(seed,'task:'+b)));
  const orderedConditions=[...conditions].sort((a,b)=>rank(seed,'condition:'+a).localeCompare(rank(seed,'condition:'+b)));
  return orderedTasks.flatMap((task,i)=>conditions.map((_,j)=>{
    const condition=orderedConditions[(i+j)%conditions.length];
    return {task,condition,key:rank(seed,`run:${task}:${condition}`)};
  }));
}
