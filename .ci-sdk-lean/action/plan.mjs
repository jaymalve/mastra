#!/usr/bin/env node
// Works out what the ci-sdk Action caches. No dependencies: it runs straight from the Action's checkout.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock', 'bun.lockb'];
const INSTALL_CONFIG = ['.npmrc', 'pnpm-workspace.yaml', '.pnpmfile.cjs'];
// Caches the tools validate themselves. Not *.tsbuildinfo: restored without dist/, tsc thinks it already emitted and writes nothing.
const TOOL_CACHES = ['.next/cache', 'node_modules/.cache', '.eslintcache'];

const sha = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex').slice(0, 16);
};

export function plan({ root, dirs, tree, job, matrix, os, arch, node, event, runId, home, pnpmStore }) {
  const inside = (dir, path) => (dir ? `${dir}/${path}` : path);
  const read = (f) => (existsSync(join(root, f)) ? readFileSync(join(root, f)) : '');
  const lockfile = LOCKFILES.find((f) => existsSync(join(root, f)));
  const platform = `${os}-${arch}-${node}`;
  // pnpm's global virtual store makes node_modules links into the store. Without the store they'd restore as a broken install.
  const linked = /^\s*enable-?global-?virtual-?store\s*[:=]\s*true/im.test(`${read('pnpm-workspace.yaml')}\n${read('.npmrc')}`);
  // Matrix legs share a job name but test different things, so each one gets its own key.
  const leg = sha(job, matrix);
  return {
    deps_key: lockfile && (!linked || pnpmStore) ? `ci-sdk-deps-${platform}-${sha(read(lockfile), ...INSTALL_CONFIG.map(read))}` : '',
    deps_paths: [...dirs.map((d) => inside(d, 'node_modules')), '!**/node_modules/.cache', `${home}/.cache/ms-playwright`, ...(linked ? [pnpmStore] : [])].join('\n'),
    tools_key: `ci-sdk-tools-${platform}-${leg}-${runId}`,
    tools_restore: `ci-sdk-tools-${platform}-${leg}-`,
    tools_paths: ['.turbo/cache', ...dirs.flatMap((d) => TOOL_CACHES.map((c) => inside(d, c)))].join('\n'),
    // Only code events: a schedule or manual run exists to run again on the same code.
    pass_key: event === 'push' || event === 'pull_request' ? `ci-sdk-passed-${leg}-${node}-${tree}` : '',
    pass_path: `${home}/.ci-sdk/passed`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const env = process.env;
  let pnpmStore;
  try {
    pnpmStore = execFileSync('pnpm', ['store', 'path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {} // no pnpm on this runner
  const out = plan({
    root: process.cwd(),
    dirs: [...new Set(git('ls-files', 'package.json', '**/package.json').split('\n').filter(Boolean).map((f) => (dirname(f) === '.' ? '' : dirname(f))))],
    tree: git('rev-parse', 'HEAD^{tree}'),
    job: env.CI_SDK_JOB ?? '',
    matrix: env.CI_SDK_MATRIX ?? '',
    os: env.RUNNER_OS ?? process.platform,
    arch: env.RUNNER_ARCH ?? process.arch,
    node: process.version,
    event: env.GITHUB_EVENT_NAME ?? '',
    runId: env.GITHUB_RUN_ID ?? '0',
    home: homedir(),
    pnpmStore,
  });
  // The marker only reaches the cache if the job succeeds: actions/cache saves on success.
  mkdirSync(dirname(out.pass_path), { recursive: true });
  writeFileSync(out.pass_path, 'passed\n');
  for (const [k, v] of Object.entries(out)) appendFileSync(env.GITHUB_OUTPUT, `${k}<<CI_SDK_EOF\n${v}\nCI_SDK_EOF\n`);
}
