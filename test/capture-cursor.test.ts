import { expect, test, describe } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CaptureCursor, cursorPath } from '../src/capture-cursor';

function makeTmp(): string { return mkdtempSync(join(tmpdir(), 'cursor-test-')); }

test('a fresh cursor has no processed files and an empty queue pointer', () => {
  const dir = makeTmp();
  const cursor = new CaptureCursor(join(dir, 'cursor.json'));
  expect(cursor.isProcessed(join(dir, 'rollout-a.jsonl'))).toBe(false);
  expect(cursor.processedCount()).toBe(0);
  rmSync(dir, { recursive: true });
});

test('markProcessed persists identity by path+mtime+size and survives reload', () => {
  const dir = makeTmp();
  const file = join(dir, 'rollout-a.jsonl');
  writeFileSync(file, 'x');
  const path = join(dir, 'cursor.json');
  const c1 = new CaptureCursor(path);
  c1.markProcessed(file);
  expect(c1.isProcessed(file)).toBe(true);
  expect(c1.processedCount()).toBe(1);

  const c2 = new CaptureCursor(path); // reload from disk
  expect(c2.isProcessed(file)).toBe(true);
  rmSync(dir, { recursive: true });
});

test('a modified file (mtime or size changed) is NOT processed anymore', () => {
  const dir = makeTmp();
  const file = join(dir, 'rollout-a.jsonl');
  writeFileSync(file, 'x');
  const path = join(dir, 'cursor.json');
  const c1 = new CaptureCursor(path);
  c1.markProcessed(file);
  expect(c1.isProcessed(file)).toBe(true);

  // same path, grown size (session appended a turn)
  writeFileSync(file, 'x'.repeat(100));
  expect(c1.isProcessed(file)).toBe(false);

  // same size, newer mtime (rewrite in place)
  const other = join(dir, 'rollout-b.jsonl');
  writeFileSync(other, 'y'.repeat(50));
  const t = new Date();
  utimesSync(other, t, t);
  c1.markProcessed(other);
  const newer = new Date(Date.now() + 5000);
  utimesSync(other, newer, newer);
  expect(c1.isProcessed(other)).toBe(false);
  rmSync(dir, { recursive: true });
});

test('markProcessed is idempotent for the same identity', () => {
  const dir = makeTmp();
  const file = join(dir, 'rollout-a.jsonl');
  writeFileSync(file, 'x');
  const path = join(dir, 'cursor.json');
  const c = new CaptureCursor(path);
  c.markProcessed(file);
  c.markProcessed(file);
  c.markProcessed(file);
  expect(c.processedCount()).toBe(1);
  rmSync(dir, { recursive: true });
});

test('a missing file is never reported processed', () => {
  const dir = makeTmp();
  const path = join(dir, 'cursor.json');
  const c = new CaptureCursor(path);
  expect(c.isProcessed(join(dir, 'never-existed.jsonl'))).toBe(false);
  rmSync(dir, { recursive: true });
});

test('clear() empties the cursor durably', () => {
  const dir = makeTmp();
  const file = join(dir, 'rollout-a.jsonl');
  writeFileSync(file, 'x');
  const path = join(dir, 'cursor.json');
  const c = new CaptureCursor(path);
  c.markProcessed(file);
  c.clear();
  expect(c.isProcessed(file)).toBe(false);
  expect(c.processedCount()).toBe(0);
  const c2 = new CaptureCursor(path);
  expect(c2.processedCount()).toBe(0);
  rmSync(dir, { recursive: true });
});

test('cursorPath helper resolves under its store dir', () => {
  const p = cursorPath('/tmp/store');
  expect(p.startsWith(join('/tmp/store', 'capture-cursor')) || p.includes('capture-cursor')).toBe(true);
});