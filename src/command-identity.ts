/** Conservative action identity, not a general shell parser. Never executes input. */
export interface CommandContext {
  projectDir?: string;
  /** A caller-supplied package snapshot. Never infer aliases from their names. */
  packageScripts?: Readonly<Record<string, string>>;
}
const shellTools = new Set(['exec_command', 'shell_command', 'tools.exec_command', 'functions.exec_command']);
const timing = new Set(['yield_time_ms', 'max_output_tokens', 'timeout_ms', 'timeout']);

/** Tokenize simple shell literals; retain quoted whitespace and statement boundaries. */
function words(text: string): string[][] | null {
  const statements: string[][] = [], current: string[] = [];
  let token = '', active = false, quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") { token += "'"; i++; }
        else quote = '';
      } else {
        // Interpolation and escaped shell programs need the original exact identity.
        if (quote === '"' && /[$`]/.test(c)) return null;
        token += c;
      }
      continue;
    }
    if (/[$`&|<>()[\]{}#]/.test(c)) return null;
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (c === ';' || c === '\n' || c === '\r') {
      if (active) { current.push(token); token = ''; active = false; }
      if (current.length) statements.push(current.splice(0));
      continue;
    }
    if (/\s/.test(c)) {
      if (active) { current.push(token); token = ''; active = false; }
    } else { token += c; active = true; }
  }
  if (quote) return null;
  if (active) current.push(token);
  if (current.length) statements.push(current);
  return statements.length && statements.length <= 32 ? statements : null;
}
function directory(value: string): string {
  // Preserve case: Windows can enable case-sensitive directories too.
  return value.replace(/\\/g,'/').replace(/\/+$/,'');
}
function literalPath(value: string, windows: boolean): string | null {
  if (!value || /[$`*?\[\]{};|&<>#\r\n]/.test(value) || value.startsWith('-')) return null;
  let path=windows?value.replace(/\\/g,'/'):value;
  if(path.split('/').includes('..'))return null;
  while(path.startsWith('./'))path=path.slice(2);
  return path || null;
}

/** null means preserve the whole original call, including its flags and environment. */
export function commandActionKeys(tool: string, args: Record<string, unknown>, context: CommandContext): string[] | null {
  if (!shellTools.has(tool)) return null;
  const field = typeof args.cmd === 'string' ? 'cmd' : typeof args.command === 'string' ? 'command' : null;
  if (!field || (args.cmd !== undefined && args.command !== undefined)) return null;
  for (const [key,value] of Object.entries(args)) {
    if (key===field || key==='workdir' || key==='cwd') continue;
    if (!timing.has(key) || typeof value!=='number' || !Number.isFinite(value)) return null;
  }
  if(args.workdir!==undefined&&args.cwd!==undefined)return null;
  const cwd=args.workdir??args.cwd;
  if(cwd!==undefined&&typeof cwd!=='string')return null;
  const atRoot=cwd===undefined||cwd==='.'||(context.projectDir!==undefined&&directory(cwd as string)===directory(context.projectDir));
  const scope=atRoot?undefined:cwd as string;
  const text=args[field] as string;
  if(text.length>8192)return null;
  let parsed=words(text);
  let windows=Boolean(context.projectDir&&/^[a-z]:[/\\]/i.test(context.projectDir));
  if(!parsed)return null;
  // Native Codex includes a PowerShell executable wrapper. Only a literal
  // -Command invocation can be unwrapped. Startup flags can change environment.
  if(parsed.length===1){
    const tokens=parsed[0], executable=tokens[0].replace(/\\/g,'/').split('/').pop()!.toLowerCase();
    if(['powershell','powershell.exe','pwsh','pwsh.exe'].includes(executable)){
      const command=tokens.findIndex(t=>t.toLowerCase()==='-command');
      if(command!==1||tokens.length!==command+2)return null;
      windows ||= executable.endsWith('.exe');
      parsed=words(tokens[command+1]);if(!parsed)return null;
    }
  }
  const actions:string[]=[];
  for(const tokens of parsed){
    let command:string|null=null;
    if(tokens[0].toLowerCase()==='get-content'){
      const pathIndex=tokens.length===3&&['-literalpath','-path'].includes(tokens[1].toLowerCase())?2:tokens.length===2?1:-1;
      if(pathIndex<0)return null;
      const path=literalPath(tokens[pathIndex],windows);if(!path)return null;
      command=`Get-Content -LiteralPath ${JSON.stringify(path)}`;
    }else if(tokens[0]==='bun'){
      let invocation=tokens;
      if(tokens.length===3&&tokens[1]==='run'&&atRoot){
        const name=tokens[2],scripts=context.packageScripts;
        if(!scripts||!Object.hasOwn(scripts,name)||Object.hasOwn(scripts,`pre${name}`)||Object.hasOwn(scripts,`post${name}`))return null;
        const expansion=words(scripts[name]);
        if(!expansion||expansion.length!==1)return null;
        invocation=expansion[0];
      }
      if(invocation.length!==2||invocation[0]!=='bun'||!/[.](?:[cm]?[jt]s|[jt]sx)$/.test(invocation[1]))return null;
      // A script with the same name as a filename can alter Bun resolution.
      if(context.packageScripts&&Object.hasOwn(context.packageScripts,invocation[1]))return null;
      const path=literalPath(invocation[1],windows);if(!path)return null;
      command=`bun ${/^[\w./-]+$/.test(path)?path:JSON.stringify(path)}`;
    }else return null;
    actions.push(`tool:exec_command:action-v1=${JSON.stringify({command,...(scope?{workdir:scope}:{})})}`);
  }
  // One batched tool invocation is one observation per action, never two repeats.
  return [...new Set(actions)];
}
