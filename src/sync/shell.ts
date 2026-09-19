import { execFile } from 'node:child_process';

import type { PluginInput } from '@opencode-ai/plugin';

type Shell = PluginInput['$'];

/** Generous ceiling: `git diff HEAD` / `ls-tree` on a large sync repo can exceed Node's 1 MiB default. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Split a tagged-template invocation into an argv array.
 *
 * Whitespace in the *literal* portions separates arguments; interpolated values never
 * split, so `${owner}/${name}`, `origin/${branch}`, `HEAD...${ref}` and
 * `--max-count=${n}` each collapse into a single argv entry. Array values expand to
 * one entry per element.
 */
export function buildArgv(strings: TemplateStringsArray | string[], values: unknown[]): string[] {
  const argv: string[] = [];
  let current = '';
  let started = false;

  const flush = (): void => {
    if (started) {
      argv.push(current);
      current = '';
      started = false;
    }
  };

  for (let i = 0; i < strings.length; i += 1) {
    for (const char of strings[i] ?? '') {
      if (/\s/u.test(char)) {
        flush();
        continue;
      }
      current += char;
      started = true;
    }

    if (i < values.length) {
      const value = values[i];
      if (Array.isArray(value)) {
        for (const entry of value) {
          flush();
          argv.push(String(entry));
        }
        continue;
      }
      current += String(value);
      started = true;
    }
  }

  flush();
  return argv;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function run(argv: string[]): Promise<ExecResult> {
  const [command, ...args] = argv;
  if (!command) {
    return Promise.reject(new Error('Empty shell command.'));
  }

  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === 'number' ? error.code : 1;
          const detail = String(stderr || stdout || error.message).trim();
          const failure = new Error(`Command failed (exit ${code}): ${argv.join(' ')}${detail ? `\n${detail}` : ''}`);
          reject(failure);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 });
      }
    );
  });
}

/**
 * Minimal stand-in for Bun's `$` covering the surface this plugin uses:
 * awaiting the template, `.quiet()`, and `.quiet().text()`.
 *
 * Commands are executed via `execFile` with an explicit argv — no shell is spawned,
 * so interpolated values cannot be reinterpreted as shell syntax.
 */
class NodeShellPromise implements PromiseLike<ExecResult> {
  private readonly argv: string[];
  private pending: Promise<ExecResult> | null = null;

  constructor(argv: string[]) {
    this.argv = argv;
  }

  private exec(): Promise<ExecResult> {
    if (!this.pending) {
      this.pending = run(this.argv);
    }
    return this.pending;
  }

  /** Output is never inherited by this implementation; present for API compatibility. */
  quiet(): this {
    return this;
  }

  nothrow(): this {
    return this;
  }

  async text(): Promise<string> {
    const result = await this.exec();
    return result.stdout;
  }

  then<TResult1 = ExecResult, TResult2 = never>(
    onfulfilled?: ((value: ExecResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<ExecResult | TResult> {
    return this.exec().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<ExecResult> {
    return this.exec().finally(onfinally);
  }
}

/**
 * Build a Bun-`$`-compatible shell backed by `node:child_process`.
 *
 * Used when the host does not supply a callable `$` in the plugin context, so that
 * shell-dependent sync operations keep working instead of failing with
 * "$ is not a function".
 */
export function createNodeShell(): Shell {
  const shell = (strings: TemplateStringsArray, ...values: unknown[]): NodeShellPromise =>
    new NodeShellPromise(buildArgv(strings, values));
  return shell as unknown as Shell;
}

/** Return `candidate` when it is usable as a shell, otherwise a Node-backed fallback. */
export function ensureShell(candidate: unknown): { shell: Shell; fallback: boolean } {
  if (typeof candidate === 'function') {
    return { shell: candidate as Shell, fallback: false };
  }
  return { shell: createNodeShell(), fallback: true };
}
