/**
 * Self-check for the `/session_branch` host path.
 *
 * Builds a throwaway Git repository with two branches, drives the shipped
 * `runBranchRequest` through a minimal stand-in for the Host services it uses,
 * and asserts: branch listing, creating a worktree for a branch with no
 * checkout, entering an existing worktree, and refusing an unknown branch or a
 * directory outside a checkout.
 *
 * Run: node docs/check.mjs
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { runBranchRequest } from '../index.js'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sgb-check-')))
const project = join(root, 'project')
const policy = { mode: 'danger-full-access', workspaceRoot: project }

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Check', '-c', 'user.email=check@example.test', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root },
  })
}

/** Runs an argv without a shell and collects both streams, like the Host provider. */
function spawnCollect(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: spec.env })
  const collect = stream => {
    const chunks = []
    stream.on('data', chunk => { chunks.push(chunk) })
    return () => ({ text: Buffer.concat(chunks).toString('utf8'), lossy: false })
  }
  const stdout = collect(child.stdout)
  const stderr = collect(child.stderr)
  return {
    collected: { stdout: { readFrom: () => stdout() }, stderr: { readFrom: () => stderr() } },
    done: new Promise(resolve => { child.on('close', code => { resolve({ exitCode: code, signal: null }) }) }),
    terminate() { child.kill() },
    waitForExit: async () => {},
  }
}

/** The minimum Host surface `runBranchRequest` uses. */
function hostServices(directory) {
  const state = { cwd: directory }
  const ctx = {
    sandboxPolicy: { resolve: () => policy },
    subprocess: {
      resolveExecutable: async command => execFileSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim(),
      spawn: spawnCollect,
    },
    sandbox: { confine: async command => ({ argv: command }) },
    fs: {
      resolve: async (path, options) => ({ path: path.startsWith('/') ? path : join(options?.cwd ?? state.cwd, path) }),
      processPath: target => target.path,
      lstat: async path => existsSync(path) ? { type: statSync(path).isDirectory() ? 'directory' : 'file' } : undefined,
      stat: async target => existsSync(target.path)
        ? { type: statSync(target.path).isDirectory() ? 'directory' : 'file' }
        : undefined,
      writeText: async (target, content) => {
        writeFileSync(target.path, content)
        return { operation: 'create' }
      },
    },
    workingDirectory: {
      get: () => state.cwd,
      set: async (_agent, path) => { state.cwd = path; return path },
    },
  }
  return { ctx, state }
}

const agent = { session: { id: 'check-session' } }
const signal = new AbortController().signal
const worktreePath = join(project, '.agents/worktrees/feature__one')

let failures = 0
async function check(name, body) {
  try {
    await body()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`)
  }
}

mkdirSync(project, { recursive: true })
git(project, 'init', '--quiet', '--initial-branch=main')
writeFileSync(join(project, 'README.md'), 'check\n')
git(project, 'add', '.')
git(project, 'commit', '--quiet', '-m', 'initial')
git(project, 'branch', 'feature/one')

const { ctx, state } = hostServices(project)

await check('lists local branches with HEAD first', async () => {
  const result = await runBranchRequest(ctx, agent, 'list', signal)
  assert.equal(result.kind, 'success', result.text)
  const payload = JSON.parse(result.text)
  assert.equal(payload.current, 'main')
  assert.deepEqual(payload.branches.map(branch => branch.name), ['main', 'feature/one'])
  assert.equal(payload.branches[0].current, true)
  assert.equal(payload.branches[1].worktree, null)
})

await check('creates a linked worktree for a branch without a checkout', async () => {
  const result = await runBranchRequest(ctx, agent, 'feature/one', signal)
  assert.equal(result.kind, 'success', result.text)
  const payload = JSON.parse(result.text)
  assert.equal(payload.branch, 'feature/one')
  assert.equal(payload.created, true)
  assert.equal(payload.path, worktreePath)
  assert.equal(git(payload.path, 'branch', '--show-current').trim(), 'feature/one')
  // The project checkout keeps its own branch and working tree.
  assert.equal(git(project, 'branch', '--show-current').trim(), 'main')
})

await check('reports the worktree that now holds the branch', async () => {
  const result = await runBranchRequest(ctx, agent, 'list', signal)
  const payload = JSON.parse(result.text)
  const branch = payload.branches.find(entry => entry.name === 'feature/one')
  assert.equal(branch.worktree, worktreePath)
})

await check('enters the existing worktree instead of creating another', async () => {
  state.cwd = project
  const result = await runBranchRequest(ctx, agent, 'feature/one', signal)
  assert.equal(result.kind, 'success', result.text)
  const payload = JSON.parse(result.text)
  assert.equal(payload.created, false)
  assert.equal(payload.path, worktreePath)
})

await check('an unknown branch is refused without moving the session', async () => {
  const before = state.cwd
  const result = await runBranchRequest(ctx, agent, 'no-such-branch', signal)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /no local branch/i)
  assert.equal(state.cwd, before)
})

await check('a directory outside a checkout reports no Git checkout', async () => {
  const plain = join(root, 'plain')
  mkdirSync(plain, { recursive: true })
  const other = hostServices(plain)
  const result = await runBranchRequest(other.ctx, agent, 'list', signal)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /not inside a Git checkout/i)
})

rmSync(root, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
