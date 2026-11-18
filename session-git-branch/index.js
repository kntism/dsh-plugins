/**
 * Host half: list the local Git branches of the Session's checkout and move the
 * Session into the worktree of an existing branch.
 *
 * The operation is exposed as the `/session_branch` command, so the plugin UI and
 * any other command caller share one implementation with one failure path.
 */

import { join } from 'node:path'

export const name = 'session-git-branch'
export const inject = [
  'commands',
  'workingDirectory',
  'fs',
  'subprocess',
  'sandbox',
  'sandboxPolicy',
]

const MAX_BRANCHES = 80
const MAX_OUTPUT = 1_048_576
const TIMEOUT_MS = 30_000
const GRACE_MS = 1_000
const WORKTREE_POOL = '.agents/worktrees'

/** Git must not read selectors from the environment that spawned the Harness. */
const GIT_ENV = {
  ...Object.fromEntries([
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
    'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
    'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
  ].map(key => [key, undefined])),
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  LC_ALL: 'C',
}

const GIT_PREFIX = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
const NOT_A_CHECKOUT = /not a git repository|must be run in a work tree/i

function firstLine(text) {
  return text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0) ?? 'no diagnostic'
}

function firstValue(text) {
  return text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0) ?? ''
}

/**
 * Run one Git command under the Session's sandbox policy.
 * @param ctx - Host context carrying `subprocess`, `sandbox`, and `sandboxPolicy`.
 * @param policy - resolved sandbox policy of the calling Session.
 * @param cwd - directory the command runs in.
 * @param args - Git arguments, subcommand first.
 * @param signal - cancellation.
 * @param allowedExitCodes - exit codes that are not failures.
 * @returns captured standard output and exit code.
 */
async function git(ctx, policy, cwd, args, signal, allowedExitCodes = [0]) {
  const timer = new AbortController()
  const abort = () => { timer.abort(new Error('git timed out')) }
  const handle = setTimeout(abort, TIMEOUT_MS)
  const stop = () => { if (signal.aborted) abort() }
  signal.addEventListener('abort', stop, { once: true })
  const lifetime = AbortSignal.any([signal, timer.signal])
  try {
    const program = await ctx.subprocess.resolveExecutable('git', undefined, lifetime)
    const command = [program, ...GIT_PREFIX, ...args]
    const argv = policy.mode === 'danger-full-access'
      ? command
      : (await ctx.sandbox.confine(command, { ...policy, mode: policy.mode }, lifetime)).argv
    lifetime.throwIfAborted()
    const child = ctx.subprocess.spawn({
      argv,
      cwd,
      env: GIT_ENV,
      signal: lifetime,
      graceMs: GRACE_MS,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_OUTPUT },
        stderr: { maxBytes: MAX_OUTPUT },
      },
    })
    try {
      const outcome = await child.done
      lifetime.throwIfAborted()
      const stdout = child.collected.stdout.readFrom(0)
      const stderr = child.collected.stderr.readFrom(0)
      if (outcome.exitCode === null || !allowedExitCodes.includes(outcome.exitCode)) {
        throw new Error(`git ${args[0]} failed (${outcome.signal ?? outcome.exitCode}): ${firstLine(stderr.text)}`)
      }
      if (stdout.lossy) throw new Error(`git ${args[0]} printed more than ${MAX_OUTPUT} bytes`)
      return { stdout: stdout.text, stderr: stderr.text, exitCode: outcome.exitCode }
    } finally {
      child.terminate()
      await child.waitForExit()
    }
  } finally {
    clearTimeout(handle)
    signal.removeEventListener('abort', stop)
  }
}

/** Locate the checkout, its shared Git directory, and the branch HEAD names. */
async function inspect(ctx, session, directory, signal) {
  const policy = ctx.sandboxPolicy.resolve({ session })
  const run = (cwd, args, codes) => git(ctx, policy, cwd, args, signal, codes)
  const top = await run(directory, ['rev-parse', '--show-toplevel'], [0, 128])
  if (top.exitCode !== 0) {
    if (NOT_A_CHECKOUT.test(top.stderr)) return null
    throw new Error(`git rev-parse failed: ${firstLine(top.stderr)}`)
  }
  const root = ctx.fs.processPath(await ctx.fs.resolve(firstValue(top.stdout), { cwd: directory, signal }))
  const head = await run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])
  return {
    policy,
    repositoryRoot: root,
    current: head.exitCode === 0 ? firstValue(head.stdout) : null,
  }
}

/** Local branches, HEAD's branch first, then most recently committed first. */
async function localBranches(repo, signal, ctx) {
  const listed = await git(ctx, repo.policy, repo.repositoryRoot, [
    'for-each-ref', '--sort=-committerdate', `--count=${MAX_BRANCHES}`,
    '--format=%(refname:lstrip=2)', 'refs/heads/',
  ], signal)
  const names = listed.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const ordered = repo.current === null ? [] : [repo.current]
  const seen = new Set(ordered)
  for (const branch of names) {
    if (seen.has(branch)) continue
    seen.add(branch)
    ordered.push(branch)
    if (ordered.length >= MAX_BRANCHES) break
  }
  return ordered
}

/** Checkouts of the repository that hold a branch, as `branch -> path`. */
async function branchCheckouts(repo, signal, ctx) {
  const listed = await git(ctx, repo.policy, repo.repositoryRoot, ['worktree', 'list', '--porcelain'], signal)
  const checkouts = new Map()
  let path = null
  let branch = null
  const commit = () => {
    if (path !== null && branch !== null) checkouts.set(branch, path)
    path = null
    branch = null
  }
  for (const raw of listed.stdout.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line.startsWith('worktree ')) {
      commit()
      path = line.slice('worktree '.length)
    } else if (line.startsWith('branch refs/heads/')) {
      branch = line.slice('branch refs/heads/'.length)
    } else if (line === '' || line === 'bare' || line === 'detached') {
      if (line !== '') { path = null; branch = null }
    }
  }
  commit()
  return checkouts
}

/** Replace path separators so a branch name can name one directory. */
function poolName(branch) {
  return branch.replaceAll('/', '__')
}

/** Create `path` and its parents through the confined subprocess world. */
async function makeDirectory(ctx, policy, cwd, path, signal) {
  const program = await ctx.subprocess.resolveExecutable('mkdir', undefined, signal)
  const command = [program, '-p', '--', path]
  const argv = policy.mode === 'danger-full-access'
    ? command
    : (await ctx.sandbox.confine(command, { ...policy, mode: policy.mode }, signal)).argv
  const child = ctx.subprocess.spawn({
    argv,
    cwd,
    signal,
    graceMs: GRACE_MS,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4_096 }, stderr: { maxBytes: 4_096 } },
  })
  try {
    const outcome = await child.done
    if (outcome.exitCode !== 0) throw new Error(`mkdir failed: ${firstLine(child.collected.stderr.readFrom(0).text)}`)
  } finally {
    child.terminate()
    await child.waitForExit()
  }
}

/** Keep a newly created worktree pool out of the repository's own status. */
async function ignorePool(ctx, policy, cwd, pool, signal) {
  const target = await ctx.fs.resolve(join(pool, '.gitignore'), { signal })
  if (await ctx.fs.stat(target, signal) !== undefined) return
  await ctx.fs.writeText(target, '*\n', { kind: 'createIfAbsent' }, signal, policy)
}

/** Add an existing branch to a new linked worktree and return its path. */
async function addWorktree(ctx, repo, branch, signal) {
  const pool = join(repo.repositoryRoot, WORKTREE_POOL)
  await makeDirectory(ctx, repo.policy, repo.repositoryRoot, pool, signal)
  await ignorePool(ctx, repo.policy, repo.repositoryRoot, pool, signal)
  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = join(pool, suffix === 0 ? poolName(branch) : `${poolName(branch)}-${suffix}`)
    if (await ctx.fs.lstat(candidate, undefined, signal) !== undefined) continue
    await git(ctx, repo.policy, repo.repositoryRoot, ['worktree', 'add', '--', candidate, branch], signal)
    return ctx.fs.processPath(await ctx.fs.resolve(candidate, { signal }))
  }
  throw new Error(`could not allocate a worktree directory for ${branch}`)
}

/** Move the Session into the checkout that holds `branch`, creating one when needed. */
async function enterBranch(ctx, agent, branch, signal) {
  const directory = ctx.workingDirectory.get(agent.session)
  const repo = await inspect(ctx, agent.session, directory, signal)
  if (repo === null) return { kind: 'error', text: 'the current directory is not inside a Git checkout' }
  const valid = await git(ctx, repo.policy, repo.repositoryRoot, ['check-ref-format', '--branch', branch], signal, [0, 1])
  if (valid.exitCode !== 0) return { kind: 'error', text: `not a valid branch name: ${branch}` }
  const exists = await git(ctx, repo.policy, repo.repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], signal, [0, 1])
  if (exists.exitCode !== 0) return { kind: 'error', text: `no local branch named ${branch}` }
  if (repo.current === branch) {
    return { kind: 'success', text: JSON.stringify({ action: 'enter', branch, path: directory, created: false }) }
  }
  const checkouts = await branchCheckouts(repo, signal, ctx)
  const known = checkouts.get(branch)
  if (known !== undefined) {
    const path = await ctx.workingDirectory.set(agent, known, signal)
    return { kind: 'success', text: JSON.stringify({ action: 'enter', branch, path, created: false }) }
  }
  const path = await addWorktree(ctx, repo, branch, signal)
  const entered = await ctx.workingDirectory.set(agent, path, signal)
  return { kind: 'success', text: JSON.stringify({ action: 'enter', branch, path: entered, created: true }) }
}

/** List branches for the Session's checkout, with the checkout that holds each. */
async function listBranches(ctx, agent, signal) {
  const directory = ctx.workingDirectory.get(agent.session)
  const repo = await inspect(ctx, agent.session, directory, signal)
  if (repo === null) return { kind: 'error', text: 'the current directory is not inside a Git checkout' }
  const [branches, checkouts] = await Promise.all([
    localBranches(repo, signal, ctx),
    branchCheckouts(repo, signal, ctx),
  ])
  return {
    kind: 'success',
    text: JSON.stringify({
      action: 'list',
      current: repo.current,
      cwd: directory,
      repositoryRoot: repo.repositoryRoot,
      branches: branches.map(branch => ({
        name: branch,
        current: branch === repo.current,
        worktree: checkouts.get(branch) ?? null,
      })),
    }),
  }
}

/** Report the Session's current branch without listing every branch. */
async function reportStatus(ctx, agent, signal) {
  const directory = ctx.workingDirectory.get(agent.session)
  const repo = await inspect(ctx, agent.session, directory, signal)
  if (repo === null) return { kind: 'error', text: 'the current directory is not inside a Git checkout' }
  return {
    kind: 'success',
    text: JSON.stringify({
      action: 'status',
      current: repo.current,
      cwd: directory,
      repositoryRoot: repo.repositoryRoot,
    }),
  }
}

/**
 * Answer one `/session_branch` request. The command handler and the package's
 * own check both call this, so the check exercises the shipped code path.
 * @param ctx - Host context carrying the Git and directory services.
 * @param agent - Session whose directory and branch are read and changed.
 * @param request - `list`, `status`, or a local branch name.
 * @param signal - cancellation of every command and read.
 * @returns a command result whose success text is JSON.
 */
export async function runBranchRequest(ctx, agent, request, signal) {
  try {
    if (request === '' || request === 'list') return await listBranches(ctx, agent, signal)
    if (request === 'status') return await reportStatus(ctx, agent, signal)
    return await enterBranch(ctx, agent, request, signal)
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** Register the `/session_branch` command. */
export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    name: 'session_branch',
    description: 'List the local Git branches, or move this session into an existing branch worktree',
    input: { hint: '[list|status|<branch>]' },
    handler: ({ agent, rawInput, signal }) => runBranchRequest(ctx, agent, rawInput.trim(), signal),
  }), 'session-git-branch: /session_branch command')
}
