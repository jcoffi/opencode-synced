import { describe, expect, it } from 'vitest';

import { buildArgv, createNodeShell, ensureShell } from './shell.js';

function argvOf(strings: TemplateStringsArray, ...values: unknown[]): string[] {
  return buildArgv(strings, values);
}

describe('buildArgv', () => {
  it('splits a plain command on whitespace', () => {
    expect(argvOf`git status --porcelain`).toEqual(['git', 'status', '--porcelain']);
  });

  it('keeps an interpolated value as a single argument', () => {
    const repoDir = '/home/user/My Sync Repo';
    expect(argvOf`git -C ${repoDir} status --porcelain`).toEqual([
      'git',
      '-C',
      '/home/user/My Sync Repo',
      'status',
      '--porcelain',
    ]);
  });

  it('joins values separated only by a literal slash', () => {
    const owner = 'jcoffi';
    const name = 'my-opencode-config';
    expect(argvOf`gh repo create ${owner}/${name} --private`).toEqual([
      'gh',
      'repo',
      'create',
      'jcoffi/my-opencode-config',
      '--private',
    ]);
  });

  it('joins a literal prefix to a value', () => {
    const branch = 'main';
    expect(argvOf`git show-ref --verify refs/heads/${branch}`).toEqual([
      'git',
      'show-ref',
      '--verify',
      'refs/heads/main',
    ]);
  });

  it('joins a literal suffix to a value', () => {
    const branch = 'main';
    expect(argvOf`git rev-list origin/${branch}..HEAD`).toEqual([
      'git',
      'rev-list',
      'origin/main..HEAD',
    ]);
  });

  it('joins a triple-dot range', () => {
    const remoteRef = 'origin/main';
    expect(argvOf`git rev-list --left-right --count HEAD...${remoteRef}`).toEqual([
      'git',
      'rev-list',
      '--left-right',
      '--count',
      'HEAD...origin/main',
    ]);
  });

  it('joins a flag to an interpolated number', () => {
    expect(argvOf`git rev-list --max-count=${20 + 1} HEAD`).toEqual([
      'git',
      'rev-list',
      '--max-count=21',
      'HEAD',
    ]);
  });

  it('preserves a multi-word commit message as one argument', () => {
    const message = 'Sync opencode config (2026-09-19)';
    expect(argvOf`git commit -m ${message}`).toEqual([
      'git',
      'commit',
      '-m',
      'Sync opencode config (2026-09-19)',
    ]);
  });

  it('expands array values to one argument each', () => {
    expect(argvOf`git add ${['a.txt', 'b.txt']}`).toEqual(['git', 'add', 'a.txt', 'b.txt']);
  });

  it('collapses redundant whitespace in the literal portions', () => {
    expect(argvOf`git   status`).toEqual(['git', 'status']);
  });
});

interface TemplateShell {
  (strings: TemplateStringsArray, ...values: unknown[]): {
    quiet(): { text(): Promise<string> } & PromiseLike<unknown>;
  };
}

describe('createNodeShell', () => {
  const $ = createNodeShell() as unknown as TemplateShell;

  it('returns stdout from .quiet().text()', async () => {
    const script = 'process.stdout.write("hello world")';
    const out = await $`${process.execPath} -e ${script}`.quiet().text();
    expect(out).toBe('hello world');
  });

  it('resolves when awaited without .text()', async () => {
    const script = 'process.exit(0)';
    await expect($`${process.execPath} -e ${script}`.quiet()).resolves.toBeDefined();
  });

  it('rejects on a non-zero exit and reports the command', async () => {
    const script = 'process.stderr.write("boom"); process.exit(3)';
    await expect($`${process.execPath} -e ${script}`.quiet().text()).rejects.toThrow(
      /Command failed \(exit 3\)/u
    );
  });

  it('surfaces stderr detail in the error message', async () => {
    const script = 'process.stderr.write("specific failure detail"); process.exit(1)';
    await expect($`${process.execPath} -e ${script}`.quiet().text()).rejects.toThrow(
      /specific failure detail/u
    );
  });

  it('does not interpret shell metacharacters in interpolated values', async () => {
    const script = 'process.stdout.write(process.argv[1] ?? "")';
    const payload = '; rm -rf /tmp/should-not-run';
    const out = await $`${process.execPath} -e ${script} ${payload}`.quiet().text();
    expect(out).toBe(payload);
  });
});

describe('ensureShell', () => {
  it('passes through a callable shell unchanged', () => {
    const candidate = (): void => undefined;
    const { shell, fallback } = ensureShell(candidate);
    expect(shell).toBe(candidate);
    expect(fallback).toBe(false);
  });

  it('falls back when the host supplies no shell', () => {
    const { shell, fallback } = ensureShell(undefined);
    expect(typeof shell).toBe('function');
    expect(fallback).toBe(true);
  });

  it('falls back when the host supplies a non-callable value', () => {
    const { shell, fallback } = ensureShell({ not: 'callable' });
    expect(typeof shell).toBe('function');
    expect(fallback).toBe(true);
  });
});
