import { expect, test } from 'bun:test';
import { commandFamily, familyRoot, detectArcs, errorSignature, renderArc, type ToolEvent } from '../src/env-feedback';
import { toolEventsFromClaudeCode, commandFailed } from '../src/claude-code-reader';

let i = 0;
const cmd = (command: string, ok: boolean, output = ''): ToolEvent => ({ kind: 'command', index: i++, command, ok, output });
const edit = (file: string): ToolEvent => ({ kind: 'edit', index: i++, file });

test('command family keeps program + subcommand, drops args, env and cd', () => {
  expect(commandFamily('uv run pytest tests/test_x.py -q')).toBe('uv run pytest');
  expect(commandFamily('cd repo && FOO=1 python -m pytest -x')).toBe('python -m pytest');
  expect(commandFamily('pytest tests/')).toBe('pytest');
  expect(commandFamily('C:\\venv\\Scripts\\pytest.exe -q')).toBe('pytest');
  expect(commandFamily('cog --check docs/*.md')).toBe('cog');
  expect(familyRoot('uv run pytest')).toBe('pytest');
  expect(familyRoot('python -m pytest')).toBe('pytest');
});

test('invocation arc: different command of the same family works with no edits', () => {
  const arcs = detectArcs([
    cmd('pytest tests/test_a.py', false, "ModuleNotFoundError: No module named 'llm'"),
    cmd('uv run pytest tests/test_a.py', true, '3 passed'),
  ]);
  expect(arcs).toHaveLength(1);
  expect(arcs[0].kind).toBe('invocation');
  expect(arcs[0].key).toBe('pytest :: invocation');
  expect(renderArc(arcs[0])).toContain('`uv run pytest tests/test_a.py` worked instead');
});

test('red-green (normal TDD loop) is detected but never rendered', () => {
  const arcs = detectArcs([
    cmd('uv run pytest tests/test_a.py', false, 'E   assert 1 == 2\nFAILED tests/test_a.py::test_x - AssertionError\n1 failed'),
    edit('llm/models.py'),
    cmd('uv run pytest tests/test_a.py', true, '1 passed'),
  ]);
  expect(arcs[0].kind).toBe('red-green');
  expect(renderArc(arcs[0])).toBeNull();
});

test('tooling arc: non-assertion error fixed by an edit', () => {
  const arcs = detectArcs([
    cmd('uv run cog --check README.md', false, 'cog: README.md(12): Output has been edited! Delete old checksum'),
    edit('README.md'),
    cmd('uv run cog --check README.md', true, ''),
  ]);
  expect(arcs[0].kind).toBe('tooling');
  expect(arcs[0].editedFiles).toEqual(['README.md']);
  expect(renderArc(arcs[0])).toContain('fixed after editing `README.md`');
});

test('import error during collection is tooling, not red-green', () => {
  const arcs = detectArcs([
    cmd('uv run pytest', false, 'ERROR collecting tests/test_a.py\nImportError: cannot import name Foo\n1 error'),
    edit('llm/__init__.py'),
    cmd('uv run pytest', true, '10 passed'),
  ]);
  expect(arcs[0].kind).toBe('tooling');
});

test('unresolved failure is reported once per family, from the first failure', () => {
  const arcs = detectArcs([
    cmd('uv run mypy llm', false, 'llm/x.py:3: error: Incompatible types\nFound 1 error'),
    edit('llm/x.py'),
    cmd('uv run mypy llm', false, 'Found 2 errors'),
  ]);
  expect(arcs).toHaveLength(1);
  expect(arcs[0].kind).toBe('unresolved');
  expect(renderArc(arcs[0])).toContain('never fixed');
});

test('signatures are path- and number-free so they match across sessions', () => {
  const a = errorSignature('  File "C:\\Users\\me\\x.py", line 3\nModuleNotFoundError: No module named \'llm\' at /tmp/a/b 42');
  const b = errorSignature('ModuleNotFoundError: No module named \'llm\' at /var/other 7');
  expect(a).toBe(b);
});

test('secret-bearing arcs are never rendered', () => {
  const arcs = detectArcs([
    cmd('curl -H "Authorization: Bearer abcdefghijklmnop1234" x', false, 'error: 401'),
    cmd('curl -H "Authorization: Bearer abcdefghijklmnop1234" y', true, 'ok'),
  ]);
  expect(renderArc(arcs[0])).toBeNull();
});

test('claude code stream-json -> tool events, with failure detection', () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'pytest' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'Exit code 1\nNo module named llm' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Edit', input: { file_path: 'C:\\work\\run\\llm\\x.py' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'uv run pytest' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text: '5 passed' }] }] } },
  ].map(x => JSON.stringify(x)).join('\n');
  const ev = toolEventsFromClaudeCode(lines, 'C:\\work\\run');
  expect(ev.map(e => e.kind)).toEqual(['command', 'edit', 'command']);
  expect((ev[0] as any).ok).toBe(false);
  expect((ev[1] as any).file).toBe('llm/x.py');
  expect((ev[2] as any).ok).toBe(true);
  expect(detectArcs(ev)[0].kind).toBe('tooling');
});

test('exit code parsing', () => {
  expect(commandFailed(undefined, 'Exit code 2')).toBe(true);
  expect(commandFailed(undefined, 'exited with code 0')).toBe(false);
  expect(commandFailed(false, 'all good')).toBe(false);
});
