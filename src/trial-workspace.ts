import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { codexEnvironment } from './codex-trial';

/** A fresh Git repository prevents native tooling from discovering the parent checkout. */
export function prepareTrialWorkspace(source:string,workspace:string){
  if(existsSync(workspace))throw new Error('TRIAL_WORKSPACE_ALREADY_EXISTS');
  cpSync(source,workspace,{recursive:true});
  const env=codexEnvironment(workspace);
  const config=['-c',`safe.directory=${workspace.replace(/\\/g,'/')}`,'-c','core.autocrlf=false','-c','commit.gpgsign=false',
    '-c',`core.hooksPath=${join(workspace,'.git/hooks').replace(/\\/g,'/')}`,'-c','user.name=Trial Fixture','-c','user.email=trial@localhost'];
  for(const args of [['init','--quiet'],['add','--all'],['commit','--quiet','-m','Frozen trial fixture']]){
    const p=Bun.spawnSync(['git',...config,...args],{cwd:workspace,env});
    if(p.exitCode)throw new Error(`TRIAL_GIT_SETUP_FAILED:${p.stderr.toString()}`);
  }
}
