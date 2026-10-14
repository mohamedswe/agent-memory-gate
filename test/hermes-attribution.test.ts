import { expect, test } from 'bun:test';
import { resolveSessionProject } from '../src/hermes-attribution';

const MAP = {
  '20261011_182709': 'C:/Users/dev/Development/Local/dual-brain-memory',
  '20261007_072542': 'C:/Users/dev/Development/Local/dual-brain-memory',
  '20260901_174558': 'C:/Users/dev/Development/GitHub/emara-release',
};

test('an explicit session-id prefix match resolves the project', () => {
  expect(resolveSessionProject(MAP, 'hermes:20261011_182709_feaab5', null))
    .toBe('C:/Users/dev/Development/Local/dual-brain-memory');
  expect(resolveSessionProject(MAP, 'hermes:20260901_174558_310006', null))
    .toBe('C:/Users/dev/Development/GitHub/emara-release');
});

test('a cwd always wins over the map (real workspace identity beats curated data)', () => {
  expect(resolveSessionProject(MAP, 'hermes:20261011_182709_feaab5', 'C:/some/other/project'))
    .toBe('C:/some/other/project');
});

test('unmapped sessions with no cwd resolve to null — honest unknown, never guessed', () => {
  expect(resolveSessionProject(MAP, 'hermes:20261010_213219_e5ff6f', null)).toBeNull();
  expect(resolveSessionProject({}, 'hermes:whatever', null)).toBeNull();
});

test('a null/empty map behaves like no map', () => {
  expect(resolveSessionProject(null, 'hermes:20261011_182709_feaab5', null)).toBeNull();
  expect(resolveSessionProject({}, 'hermes:20261011_182709_feaab5', null)).toBeNull();
});

test('session ids are matched by longest prefix to avoid collisions', () => {
  const map = {
    '20261011_18': 'C:/a',
    '20261011_1827': 'C:/b',
  };
  expect(resolveSessionProject(map, 'hermes:20261011_182709_feaab5', null)).toBe('C:/b');
  expect(resolveSessionProject(map, 'hermes:20261011_185000_zzz', null)).toBe('C:/a');
});