/**
 * Self-check for the client half's branch reader.
 *
 * The client half is a browser bundle, so this check evaluates `client.js`
 * under a minimal `window.__ModuleLoader__` shim and drives the reader against
 * real on-disk checkouts: a main checkout whose branches mix packed and loose
 * refs, a linked worktree whose shared Git directory sits outside the
 * workspace, and a directory that is not a checkout at all.
 *
 * Run: node docs/check-client.mjs
 */

import { execFileSync } from 'node:child_process'
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const React = {
  // Build a real element record, so the tree can be inspected after mounting.
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) },
  }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useRef: value => ({ current: value }),
}

let plugin = null
// The control registers window and document listeners while a menu is open;
// this harness never dispatches those events, so it only needs the registration
// points to exist.
globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  __ModuleLoader__: {
    load: ({ factory }) => {
      plugin = factory((specifier) => {
        if (specifier === 'react') return React
        throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
      })
    },
  },
}
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
}
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'))
assert.ok(plugin !== null, 'client.js registered no factory')
assert.equal(typeof plugin.apply, 'function', 'client.js exports no apply')
assert.equal(typeof plugin.__readBranchesForCheck, 'function', 'client.js exports no reader')
assert.equal(typeof plugin.__switchBranchForCheck, 'function', 'client.js exports no switcher')
const readBranches = plugin.__readBranchesForCheck
const switchBranch = plugin.__switchBranchForCheck

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sgb-client-check-')))
const project = join(root, 'project')
const worktree = join(project, '.agents/worktrees/feature')

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Check', '-c', 'user.email=check@example.test', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root },
  })
}

/**
 * The workspace read stand-in. It reproduces the real service's one relevant
 * limit: a directory outside the Session's workspace cannot be listed, while
 * a file read resolves the path as given.
 */
function workspaceFiles(workspaceRoot) {
  const reads = []
  return {
    reads,
    readBytes: async (_sessionId, path) => {
      reads.push(path)
      try {
        return { ok: true, value: { data: new TextEncoder().encode(readFileSync(path, 'utf8')) } }
      } catch {
        return { ok: false, error: { code: 'workspace-file/not-found', message: 'missing' } }
      }
    },
    list: async (_sessionId, path) => {
      reads.push(path)
      if (!path.startsWith(workspaceRoot) && path !== workspaceRoot) {
        return { ok: false, error: { code: 'workspace-file/outside-workspace', message: 'outside' } }
      }
      try {
        const entries = readdirSync(path, { withFileTypes: true }).map(entry => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        }))
        return { ok: true, value: { path, entries, truncated: false } }
      } catch {
        return { ok: false, error: { code: 'workspace-file/not-found', message: 'missing' } }
      }
    },
  }
}

/** The two seats the plugin must claim, captured from its own registration. */
function captureSeats() {
  const seats = new Map()
  const registered = new Map()
  const remote = { workspaceFiles: {}, commands: { execute: async () => ({ ok: true, value: undefined }) } }
  plugin.apply({
    // Cordis runs an effect callback immediately and keeps what it returns as cleanup.
    effect: callback => { const disposer = callback(); return () => { if (typeof disposer === 'function') disposer() } },
    slots: {
      inject: (slot, callback) => { callback(); return () => {} },
      register: (options, component) => { seats.set(options.name, component); return () => {} },
    },
    // The plugin keeps this object, so tests fill in `workspaceFiles` once the
    // real checkout exists.
    remote,
    locale: {
      getLocale: () => ({ active: 'en' }),
      subscribe: () => () => {},
      register: (ns, dicts) => { registered.set(ns, dicts); return () => {} },
      bind: ns => (key, params) => {
        const dicts = registered.get(ns) ?? {}
        const table = dicts.en ?? {}
        const text = table[key] ?? key
        if (params === undefined) return text
        return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
      },
    },
  })
  return { seats, registered, remote }
}

/**
 * A Remote stand-in that mimics the real command executor's contract: it reads
 * `signal` and refuses a call that omits it, exactly as the Host schema does.
 */
function commandRecorder(respond) {
  const calls = []
  return {
    calls,
    remote: {
      commands: {
        execute: async (...args) => {
          calls.push(args)
          const [sessionId, line, attachments, signal] = args
          if (typeof sessionId !== 'string' || typeof line !== 'string') {
            throw new TypeError('execute needs a session id and a command line')
          }
          if (!Array.isArray(attachments)) throw new TypeError('execute needs the attachment list')
          if (signal === undefined || signal === null || typeof signal.aborted !== 'boolean') {
            throw new TypeError('execute needs the request cancellation signal')
          }
          return respond(line, signal)
        },
      },
    },
  }
}

/** Flatten a React element tree into its text, for render assertions. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node.props !== undefined) return textOf(node.props.children)
  return ''
}

/** Collect every element of `type` in a tree. */
function elementsOf(node, type, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, type, found)
    return found
  }
  if (node.type === type) found.push(node)
  if (node.props !== undefined) elementsOf(node.props.children, type, found)
  return found
}

/**
 * A minimal React harness: just enough hooks to mount the real component,
 * let its effects run, and re-render when state changes. It is intentionally
 * small — it is not a React implementation, only a way to read the tree the
 * component produces.
 */
function mount(Component, props) {
  const hooks = []
  let index = 0
  let tree = null
  let dirty = false
  let unmounted = false
  const pending = []

  const schedule = () => { dirty = true }

  function useState(initial) {
    const slot = index
    if (hooks[slot] === undefined) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial }
    const state = hooks[slot]
    const set = next => {
      const value = typeof next === 'function' ? next(state.value) : next
      if (Object.is(value, state.value)) return
      state.value = value
      schedule()
    }
    index += 1
    return [state.value, set]
  }

  function useEffect(effect, deps) {
    const slot = index
    index += 1
    const previous = hooks[slot]
    const changed = previous === undefined || deps === undefined
      || deps.length !== (previous.deps?.length ?? -1)
      || deps.some((value, at) => !Object.is(value, previous.deps[at]))
    if (!changed) return
    if (previous?.cleanup !== undefined) pending.push({ kind: 'cleanup', fn: previous.cleanup })
    hooks[slot] = { deps, cleanup: previous?.cleanup }
    pending.push({ kind: 'effect', fn: effect, slot })
  }

  function useRef(initial) {
    const slot = index
    if (hooks[slot] === undefined) hooks[slot] = { current: initial }
    index += 1
    return hooks[slot]
  }

  // Identity only changes when a dependency changes, as React does. A fresh
  // function every render would re-run every effect that depends on one.
  function useCallback(fn, deps) {
    const slot = index
    const previous = hooks[slot]
    const same = previous !== undefined && deps !== undefined && previous.deps !== undefined
      && deps.length === previous.deps.length
      && deps.every((value, at) => Object.is(value, previous.deps[at]))
    index += 1
    if (same) return previous.fn
    hooks[slot] = { fn, deps }
    return fn
  }

  function render() {
    index = 0
    // The bundle calls hooks through the React object it was handed, so the
    // harness installs its own implementations for the duration of a render.
    const saved = { useState: React.useState, useEffect: React.useEffect, useRef: React.useRef, useCallback: React.useCallback }
    React.useState = useState
    React.useEffect = useEffect
    React.useRef = useRef
    React.useCallback = useCallback
    try {
      tree = Component(props)
      // The registered entry is a thin wrapper around the real control; expand
      // function-typed elements so assertions read the rendered tree.
      let guard = 0
      while (tree !== null && typeof tree === 'object' && typeof tree.type === 'function') {
        index = 0
        tree = tree.type(tree.props)
        guard += 1
        if (guard > 10) throw new Error('component elements nest too deeply to expand')
      }
    } finally {
      Object.assign(React, saved)
    }
    dirty = false
  }

  const flush = async () => {
    for (let turn = 0; turn < 20; turn += 1) {
      while (pending.length > 0) {
        const work = pending.shift()
        if (work.kind === 'cleanup') work.fn?.()
        else {
          const cleanup = work.fn()
          const hook = hooks[work.slot]
          if (hook !== undefined) hook.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        }
      }
      await new Promise(resolve => setTimeout(resolve, 0))
      if (!dirty) return
      render()
    }
  }

  render()
  return {
    get tree() { return tree },
    flush,
    unmount() { unmounted = true; for (const hook of hooks) hook?.cleanup?.() },
    get unmounted() { return unmounted },
  }
}

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

const { seats, registered, remote } = captureSeats()

mkdirSync(project, { recursive: true })
git(project, 'init', '--quiet', '--initial-branch=main')
writeFileSync(join(project, 'README.md'), 'check\n')
git(project, 'add', '.')
git(project, 'commit', '--quiet', '-m', 'initial')
git(project, 'branch', 'feature/packed')
git(project, 'pack-refs', '--all')
// One branch stays loose after packing, so the reader must merge both sources.
git(project, 'update-ref', 'refs/heads/feature/loose', git(project, 'rev-parse', 'main').trim())
git(project, 'worktree', 'add', '--quiet', '-b', 'feature/worktree', worktree, 'main')

const files = workspaceFiles(project)
// The component keeps the Remote object it was given at apply time, so the real
// reader must be reachable through it.
remote.workspaceFiles = files
const signal = new AbortController().signal

await check('claims the composer seat and the New Session seat', async () => {
  assert.ok(seats.has('conversation.input.left'), 'the composer seat was not registered')
  assert.ok(seats.has('conversation.hero.options'), 'the New Session seat was not registered')
})

await check('registers its copy for both interface languages', async () => {
  const dicts = registered.get('sessionGitBranch')
  assert.ok(dicts !== undefined, 'no dictionary namespace was registered')
  for (const id of ['en', 'zh']) {
    assert.ok(dicts[id] !== undefined, `no ${id} dictionary`)
    for (const key of ['title', 'heroTitle', 'switching', 'failed', 'scope', 'partial']) {
      assert.equal(typeof dicts[id][key], 'string', `${id} is missing ${key}`)
    }
  }
})

await check('reads HEAD and merges packed with loose branches of the main checkout', async () => {
  files.reads.length = 0
  const read = await readBranches({ workspaceFiles: files }, 'check-session', project, signal)
  assert.ok(read !== null, 'the main checkout was reported as no checkout')
  assert.equal(read.current, 'main')
  assert.deepEqual(read.branches, ['main', 'feature/loose', 'feature/packed', 'feature/worktree'])
  assert.equal(read.partial, false)
})

await check('reads the branch of a linked worktree through its commondir', async () => {
  const read = await readBranches({ workspaceFiles: files }, 'check-session', worktree, signal)
  assert.ok(read !== null, 'the linked worktree was reported as no checkout')
  assert.equal(read.current, 'feature/worktree')
  // Its shared Git directory is inside this project, so nothing is withheld.
  assert.equal(read.partial, false)
  assert.ok(read.branches.includes('feature/loose'), `missing loose branch: ${read.branches.join(', ')}`)
})

await check('reports a shared Git directory outside the workspace as partial', async () => {
  const detached = join(root, 'elsewhere')
  mkdirSync(detached, { recursive: true })
  git(detached, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(detached, 'README.md'), 'elsewhere\n')
  git(detached, 'add', '.')
  git(detached, 'commit', '--quiet', '-m', 'initial')
  git(detached, 'branch', 'feature/packed')
  git(detached, 'pack-refs', '--all')
  git(detached, 'update-ref', 'refs/heads/feature/loose', git(detached, 'rev-parse', 'main').trim())
  // Read as if the Session worked inside a nested directory of another project.
  const scope = workspaceFiles(project)
  const read = await readBranches({ workspaceFiles: scope }, 'check-session', detached, signal)
  assert.equal(read.current, 'main')
  assert.equal(read.partial, true, 'a refused refs listing was reported as complete')
  // Only the packed branch could be read; the loose one is honestly withheld.
  assert.deepEqual(read.branches, ['main', 'feature/packed'])
})

await check('a directory outside any checkout reports no checkout', async () => {
  const plain = join(root, 'plain')
  mkdirSync(plain, { recursive: true })
  const read = await readBranches({ workspaceFiles: workspaceFiles(plain) }, 'check-session', plain, signal)
  assert.equal(read, null)
})

await check('a detached HEAD reports no current branch', async () => {
  const head = git(project, 'rev-parse', 'main').trim()
  git(project, 'checkout', '--quiet', '--detach', head)
  const read = await readBranches({ workspaceFiles: files }, 'check-session', project, signal)
  assert.equal(read.current, null)
  assert.ok(read.branches.includes('main'))
  git(project, 'checkout', '--quiet', 'main')
})

await check('switches through the 4-argument command contract and reports a created worktree', async () => {
  const recorder = commandRecorder(() => ({
    ok: true,
    value: {
      commandId: 'cmd-1',
      result: { kind: 'success', text: JSON.stringify({ action: 'enter', branch: 'feature/packed', path: '/tmp/x', created: true }) },
    },
  }))
  const controller = new AbortController()
  const outcome = await switchBranch(recorder.remote, 'check-session', 'feature/packed', controller.signal)
  assert.deepEqual(outcome, { ok: true, created: true, path: '/tmp/x' })
  assert.equal(recorder.calls.length, 1)
  const [sessionId, line, attachments, signalArg] = recorder.calls[0]
  assert.equal(sessionId, 'check-session')
  assert.equal(line, '/session_branch feature/packed')
  assert.deepEqual(attachments, [])
  assert.equal(signalArg, controller.signal, 'the request signal was not forwarded')
})

await check('surfaces a Host failure and a missing command distinctly', async () => {
  const failed = commandRecorder(() => ({ ok: false, error: { code: 'gateway/bad-request', message: 'no local branch named x' } }))
  const first = await switchBranch(failed.remote, 'check-session', 'x', new AbortController().signal)
  assert.deepEqual(first, { ok: false, message: 'no local branch named x' })

  const missing = commandRecorder(() => ({ ok: true, value: undefined }))
  const second = await switchBranch(missing.remote, 'check-session', 'x', new AbortController().signal)
  assert.deepEqual(second, { ok: false, missingCommand: true })

  const errored = commandRecorder(() => ({
    ok: true,
    value: { commandId: 'cmd-2', result: { kind: 'error', text: 'git worktree add failed' } },
  }))
  const third = await switchBranch(errored.remote, 'check-session', 'x', new AbortController().signal)
  assert.deepEqual(third, { ok: false, message: 'git worktree add failed' })
})

await check('a call without a signal is rejected, so the UI cannot silently drop it', async () => {
  const recorder = commandRecorder(() => ({ ok: true, value: undefined }))
  await assert.rejects(
    () => recorder.remote.commands.execute('check-session', '/session_branch main', []),
    /cancellation signal/,
  )
})

await check('renders the current branch in the composer seat', async () => {
  const Control = seats.get('conversation.input.left')
  assert.equal(typeof Control, 'function', 'the composer seat registered no component')
  // The registered component is a wrapper; mount it and read the tree.
  const harness = mount(Control, {
    sessionId: 'check-session',
    useProjection: key => (key === 'workingDirectory' ? project : undefined),
  })
  await harness.flush()
  const tree = harness.tree
  assert.ok(tree !== null, 'the control rendered nothing inside a Git checkout')
  const text = textOf(tree)
  // The badge must name the branch, not a placeholder.
  assert.ok(text.includes('main'), `branch name missing from the badge: ${JSON.stringify(text)}`)
  const buttons = elementsOf(tree, 'button')
  assert.ok(buttons.length >= 1, 'no trigger button rendered')
  const trigger = buttons[0]
  assert.equal(trigger.props['aria-haspopup'], 'listbox')
  assert.equal(trigger.props['aria-expanded'], false)
  assert.ok(String(trigger.props.title).includes('main'), 'the trigger title does not name the branch')
  harness.unmount()
})

await check('renders nothing outside a Git checkout', async () => {
  const Control = seats.get('conversation.input.left')
  const plain = join(root, 'plain-render')
  mkdirSync(plain, { recursive: true })
  const harness = mount(Control, {
    sessionId: 'check-session',
    useProjection: key => (key === 'workingDirectory' ? plain : undefined),
  })
  await harness.flush()
  assert.equal(harness.tree, null, 'a non-repository directory rendered a branch control')
  harness.unmount()
})

await check('after a switch the badge keeps the new branch and the old checkout is not re-read', async () => {
  const Control = seats.get('conversation.input.left')
  const reads = []
  const scopedFiles = {
    readBytes: (sessionId, path, ...rest) => { reads.push(path); return files.readBytes(sessionId, path, ...rest) },
    list: (sessionId, path, ...rest) => { reads.push(path); return files.list(sessionId, path, ...rest) },
  }
  const recorder = commandRecorder(() => ({
    ok: true,
    value: {
      commandId: 'cmd-switch',
      result: {
        kind: 'success',
        text: JSON.stringify({ action: 'enter', branch: 'feature/worktree', path: worktree, created: false }),
      },
    },
  }))
  const savedFiles = remote.workspaceFiles
  const savedCommands = remote.commands
  remote.workspaceFiles = scopedFiles
  remote.commands = recorder.remote.commands
  // The Session's directory moves on the Host, so the projection follows here.
  let directory = project
  const harness = mount(Control, {
    sessionId: 'check-session',
    useProjection: key => (key === 'workingDirectory' ? directory : undefined),
  })
  const settle = async () => { for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0)) }
  try {
    await harness.flush()
    const trigger = elementsOf(harness.tree, 'button')[0]
    assert.ok(trigger !== undefined, 'the control rendered no trigger to open the menu')
    trigger.props.onClick()
    await harness.flush()
    const option = elementsOf(harness.tree, 'button')
      .find(button => button.props.role === 'option' && button.props.title === 'feature/worktree')
    assert.ok(option !== undefined, 'the menu did not offer the worktree branch')
    reads.length = 0
    option.props.onClick()
    await settle()
    directory = worktree
    for (let turn = 0; turn < 3; turn += 1) {
      await settle()
      await harness.flush()
    }
    const text = textOf(harness.tree)
    assert.ok(text.includes('feature/worktree'), `the badge did not show the new branch: ${JSON.stringify(text)}`)
    // The plugin moves the directory and leaves the original checkout's HEAD
    // alone, so reading that HEAD again could only report the branch just left.
    // A linked worktree shares packed-refs and refs/heads with it, so HEAD is the
    // one file that tells the two checkouts apart.
    const leftHead = join(project, '.git/HEAD')
    const stale = reads.filter(path => path === leftHead)
    assert.deepEqual(stale, [], `the control re-read the left checkout's HEAD ${stale.length} time(s)`)
  } finally {
    remote.workspaceFiles = savedFiles
    remote.commands = savedCommands
    harness.unmount()
  }
})

await check('the New Session seat labels the control as a starting branch', async () => {
  const Hero = seats.get('conversation.hero.options')
  const harness = mount(Hero, {
    sessionId: 'check-session',
    useProjection: key => (key === 'workingDirectory' ? project : undefined),
  })
  await harness.flush()
  const text = textOf(harness.tree)
  assert.ok(text.includes('Branch'), `the New Session control has no Branch prefix: ${JSON.stringify(text)}`)
  assert.ok(text.includes('main'), 'the New Session control does not name the branch')
  harness.unmount()
})

rmSync(root, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall client checks passed')
}
