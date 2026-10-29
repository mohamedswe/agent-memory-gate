import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext } from './command-identity';

/** Read-only current-checkout context; offline historical replay supplies a pinned snapshot. */
export function projectCommandContext(projectDir: string): CommandContext {
  if(!projectDir)return {};
  try {
    const p=JSON.parse(readFileSync(join(projectDir,'package.json'),'utf8'));
    if(!p.scripts||typeof p.scripts!=='object'||Array.isArray(p.scripts))return {projectDir};
    return {projectDir,packageScripts:Object.fromEntries(Object.entries(p.scripts).filter(([,value])=>typeof value==='string')) as Record<string,string>};
  } catch {return {projectDir};}
}
