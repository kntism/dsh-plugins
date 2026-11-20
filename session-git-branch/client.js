window.__ModuleLoader__.load({
  id: '@local/session-git-branch',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'sessionGitBranch'
    const MAX_HEAD_BYTES = 4096
    const MAX_REFS_BYTES = 262144
    const MAX_REF_DEPTH = 4
    const MAX_ROWS = 80
    const FILTER_FROM = 8

    const CSS = `
.sgb-root { display: inline-flex; position: relative; min-width: 0; }
.sgb-trigger {
  display: inline-flex; align-items: center; gap: 4px; max-width: 220px; min-width: 0;
  padding: 3px 6px; border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; white-space: nowrap;
}
.sgb-trigger:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sgb-trigger:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.sgb-trigger[disabled] { opacity: .55; cursor: default; background: transparent; }
.sgb-trigger[data-error] { color: var(--dsw-alias-state-error-primary); }
.sgb-prefix { color: var(--dsw-alias-label-secondary); opacity: .8; }
.sgb-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.sgb-menu {
  position: absolute; z-index: 80; display: flex; flex-direction: column; gap: 1px;
  width: 260px; max-width: calc(100vw - 24px); max-height: 320px; overflow: auto;
  padding: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-overlay);
}
.sgb-menu[data-below] { top: calc(100% + 6px); left: 0; }
.sgb-menu[data-above] { bottom: calc(100% + 6px); left: 0; }
.sgb-filter {
  margin: 2px 2px 4px; padding: 4px 6px; border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; line-height: 16px;
}
.sgb-filter:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; }
.sgb-item {
  display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box;
  padding: 5px 8px; border: 0; border-radius: 5px; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px;
  text-align: left; cursor: pointer;
}
.sgb-item:hover { background: var(--dsw-alias-bg-layer-2); }
.sgb-item[aria-selected="true"] { color: var(--dsw-alias-brand-primary); }
.sgb-item[disabled] { opacity: .5; cursor: default; }
.sgb-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sgb-check { flex: none; width: 12px; text-align: center; }
.sgb-note { padding: 4px 8px 6px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 15px; }
.sgb-error { padding: 4px 8px 6px; color: var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 15px; }
`

    /** Copy in both interface languages; the locale service picks the chain. */
    const DICTIONARIES = {
      en: {
        title: 'Git branch',
        heroTitle: 'Choose starting Git branch',
        heroPrefix: 'Branch',
        current: 'Working on {branch}. Choose another working directory',
        switching: 'Switching to {branch}…',
        detached: 'HEAD is detached',
        loading: 'Reading branches…',
        readFailed: 'Could not read the branch list',
        empty: 'No local branches',
        failed: 'Could not switch: {message}',
        missing: 'This build does not provide /session_branch',
        retry: 'Try again',
        partial: 'Branches outside the workspace are not listed',
        scope: 'Moves this session to that branch\u2019s working directory, creating a linked worktree when needed. The project checkout is not changed.',
        filter: 'Filter branches',
        created: 'Created a worktree for {branch}',
      },
      zh: {
        title: 'Git 分支',
        heroTitle: '选择新会话的 Git 分支',
        heroPrefix: '分支',
        current: '当前在 {branch}，点击切换工作目录',
        switching: '正在切换到 {branch}…',
        detached: 'HEAD 已分离',
        loading: '正在读取分支…',
        readFailed: '无法读取分支列表',
        empty: '没有本地分支',
        failed: '切换失败：{message}',
        missing: '当前版本未提供 /session_branch 命令',
        retry: '重试',
        partial: '工作区外的分支未列出',
        scope: '会把本会话切到该分支的检出目录，必要时新建 linked worktree；不改动项目本身的检出。',
        filter: '筛选分支',
        created: '已为 {branch} 新建 worktree',
      },
    }

    /** Branch glyph: one commit joined to another, at host icon weight. */
    function BranchGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round', style: { flex: 'none' },
      },
      h('circle', { cx: 4.5, cy: 3.5, r: 1.6 }),
      h('circle', { cx: 4.5, cy: 12.5, r: 1.6 }),
      h('circle', { cx: 11.5, cy: 6, r: 1.6 }),
      h('path', { d: 'M4.5 5.1v5.8' }),
      h('path', { d: 'M11.5 7.6c0 2.3-2.6 2.3-4.6 2.9' }),
      )
    }

    function unreadable() {
      const error = new Error('unreadable')
      error.unreadable = true
      return error
    }

    /** Read one file through the authorized workspace read; null when it has no bytes. */
    async function readText(remote, sessionId, path, limit, signal) {
      const result = await remote.workspaceFiles.readBytes(
        sessionId, path, { range: { offset: 0, length: limit } }, signal)
      if (!result.ok) return null
      return new TextDecoder().decode(new Uint8Array(result.value.data))
    }

    /** One directory's direct children; null when the listing is refused. */
    async function listEntries(remote, sessionId, path, signal) {
      const result = await remote.workspaceFiles.list(sessionId, path, signal)
      if (!result.ok) return null
      return result.value.entries
    }

    function joinPath(base, name) {
      return base.endsWith('/') ? base + name : base + '/' + name
    }

    function dirname(path) {
      const cut = path.lastIndexOf('/')
      return cut <= 0 ? '/' : path.slice(0, cut)
    }

    function resolvePath(base, path) {
      if (path.startsWith('/')) return path
      const parts = base.split('/').filter(part => part.length > 0)
      for (const part of path.split('/')) {
        if (part === '' || part === '.') continue
        if (part === '..') parts.pop()
        else parts.push(part)
      }
      return '/' + parts.join('/')
    }

    /**
     * The checkout's Git directories. The main checkout keeps everything under
     * `.git`; a linked worktree stores a `gitdir:` pointer there and a
     * `commondir` file naming the shared directory that holds the refs.
     */
    async function gitDirectories(remote, sessionId, cwd, signal) {
      const dotGit = joinPath(cwd, '.git')
      const head = await readText(remote, sessionId, joinPath(dotGit, 'HEAD'), MAX_HEAD_BYTES, signal)
      signal.throwIfAborted()
      if (head !== null) return { gitDir: dotGit, commonDir: dotGit }
      const pointer = await readText(remote, sessionId, dotGit, MAX_HEAD_BYTES, signal)
      if (pointer === null) return null
      const match = /^gitdir:\s*(.+)$/m.exec(pointer)
      if (match === null) return null
      const gitDir = resolvePath(dirname(dotGit), match[1].trim())
      const common = await readText(remote, sessionId, joinPath(gitDir, 'commondir'), MAX_HEAD_BYTES, signal)
      return { gitDir, commonDir: common === null ? gitDir : resolvePath(gitDir, common.trim()) }
    }

    /** The branch HEAD names, or null while HEAD is detached. */
    async function headBranch(remote, sessionId, gitDir, signal) {
      const head = await readText(remote, sessionId, joinPath(gitDir, 'HEAD'), MAX_HEAD_BYTES, signal)
      if (head === null) throw unreadable()
      const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head.trim())
      return match === null ? null : match[1]
    }

    /** Branch names Git packed into `packed-refs` after a `gc`. */
    async function packedBranches(remote, sessionId, commonDir, signal) {
      const packed = await readText(remote, sessionId, joinPath(commonDir, 'packed-refs'), MAX_REFS_BYTES, signal)
      if (packed === null) return []
      const names = []
      for (const line of packed.split('\n')) {
        const match = /^[0-9a-f]{40,64} refs\/heads\/(.+)$/.exec(line.trim())
        if (match !== null) names.push(match[1])
      }
      return names
    }

    /**
     * Loose branch names under `refs/heads`, walked to a bounded depth.
     *
     * A linked worktree's shared Git directory can sit outside the Session's
     * workspace, and the workspace listing refuses such a directory. The walk
     * then reports `partial` instead of passing off the packed branches as the
     * complete list.
     */
    async function looseBranches(remote, sessionId, directory, prefix, depth, signal) {
      if (depth > MAX_REF_DEPTH) return { names: [], partial: false }
      const entries = await listEntries(remote, sessionId, directory, signal)
      if (entries === null) return { names: [], partial: true }
      const names = []
      let partial = false
      for (const entry of entries) {
        signal.throwIfAborted()
        const name = prefix === '' ? entry.name : prefix + '/' + entry.name
        if (entry.type === 'directory') {
          const deeper = await looseBranches(remote, sessionId, joinPath(directory, entry.name), name, depth + 1, signal)
          names.push(...deeper.names)
          partial = partial || deeper.partial
        } else if (entry.type === 'file' && !entry.name.endsWith('.lock')) {
          names.push(name)
        }
      }
      return { names, partial }
    }

    /**
     * The checkout's local branches and its HEAD branch.
     * @returns `{ current, branches, partial }`, or null outside a checkout.
     */
    async function readBranches(remote, sessionId, cwd, signal) {
      const directories = await gitDirectories(remote, sessionId, cwd, signal)
      if (directories === null) return null
      const current = await headBranch(remote, sessionId, directories.gitDir, signal)
      const [packed, loose] = await Promise.all([
        packedBranches(remote, sessionId, directories.commonDir, signal),
        looseBranches(remote, sessionId, joinPath(directories.commonDir, 'refs/heads'), '', 0, signal),
      ])
      const merged = [...new Set([...packed, ...loose.names])].sort((left, right) => left.localeCompare(right))
      return {
        current,
        partial: loose.partial,
        branches: current === null ? merged : [current, ...merged.filter(name => name !== current)],
      }
    }

    function format(text, params) {
      return text.replace(/\{(\w+)\}/g, (match, name) => (params !== undefined && params[name] !== undefined ? String(params[name]) : match))
    }

    /**
     * Ask the Host to move this Session into `branch`'s checkout.
     *
     * One place owns the wire call, so the UI and the package's check exercise
     * the same argument list. The Host command executor requires the request's
     * cancellation signal as its fourth argument.
     * @param remote - Client Remote face carrying `commands.execute`.
     * @param sessionId - Session whose directory moves.
     * @param branch - local branch name.
     * @param signal - cancellation of this request.
     * @returns `{ ok: true, created }` or `{ ok: false, message }`.
     */
    async function switchBranch(remote, sessionId, branch, signal) {
      const result = await remote.commands.execute(sessionId, `/session_branch ${branch}`, [], signal)
      if (!result.ok) return { ok: false, message: result.error.message }
      if (result.value === undefined) return { ok: false, missingCommand: true }
      if (result.value.result.kind === 'error') return { ok: false, message: result.value.result.text }
      let created = false
      let path
      try {
        const payload = JSON.parse(result.value.result.text ?? '{}')
        created = payload.created === true
        if (typeof payload.path === 'string' && payload.path.length > 0) path = payload.path
      } catch { created = false }
      return { ok: true, created, path }
    }

    /**
     * The branch control for one Session: its current branch, then a switch menu.
     * @param props - remote faces, the Session projection hook, slot variant, and copy.
     */
    function BranchControl(props) {
      const { remote, useProjection, sessionId, hero, useLocaleId, t } = props
      // Subscribe this component to the active language without re-registering the slot.
      const localeId = useLocaleId()
      const translate = (key, params) => {
        const text = t(key)
        return params === undefined ? text : format(text, params)
      }
      const directory = useProjection('workingDirectory')
      const [state, setState] = React.useState({ current: null, branches: [], status: 'idle', partial: false })
      const [open, setOpen] = React.useState(false)
      const [pending, setPending] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [flip, setFlip] = React.useState(false)
      const trigger = React.useRef(null)
      const alive = React.useRef(true)
      const switching = React.useRef(null)
      // Every read carries a sequence number: a read that started earlier must not
      // overwrite the result of a newer one, whichever settles last.
      const readSequence = React.useRef(0)

      React.useEffect(() => () => {
        alive.current = false
        // Unmounting must cancel a switch in flight, not leave the request open.
        if (switching.current !== null) switching.current.abort(new Error('this branch control was removed'))
      }, [])

      /**
       * Read one checkout's branch and publish it, unless a newer read replaced it.
       * @param signal - cancellation of this read.
       * @param target - checkout to read; defaults to the Session's directory.
       */
      const load = React.useCallback(async (signal, target = directory) => {
        if (target === null || target === undefined) return
        const sequence = ++readSequence.current
        const current = () => alive.current && !signal.aborted && sequence === readSequence.current
        try {
          const read = await readBranches(remote, sessionId, target, signal)
          if (!current()) return
          if (read === null) setState({ current: null, branches: [], status: 'no-git', partial: false })
          else {
            setState({ current: read.current, branches: read.branches, status: 'ready', partial: read.partial })
            // A successful read supersedes any read failure still on screen.
            setFailure(null)
          }
        } catch (error) {
          if (!current()) return
          setState({ current: null, branches: [], status: 'error', partial: false })
          setFailure(translate('readFailed'))
        }
      }, [directory, remote, sessionId, localeId])

      React.useEffect(() => {
        const controller = new AbortController()
        void load(controller.signal)
        return () => { controller.abort() }
      }, [load])

      // The menu is absolutely positioned inside this control, because the composer
      // owns the stacking and portal mechanics. When the space above the trigger is
      // tight the menu opens downward instead.
      React.useEffect(() => {
        if (!open) return undefined
        const measure = () => {
          const rect = trigger.current?.getBoundingClientRect()
          if (rect === undefined) return
          setFlip(hero === true || rect.top < 340)
        }
        measure()
        window.addEventListener('resize', measure)
        return () => { window.removeEventListener('resize', measure) }
      }, [open, hero])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointer = event => {
          if (trigger.current !== null && !trigger.current.contains(event.target)) {
            const menu = document.getElementById(`sgb-menu-${sessionId}`)
            if (menu === null || !menu.contains(event.target)) setOpen(false)
          }
        }
        const onKey = event => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', onPointer, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onPointer, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open, sessionId])

      const choose = async name => {
        if (name === state.current || pending !== null) return
        setFailure(null)
        setNotice(null)
        setPending(name)
        const controller = new AbortController()
        switching.current = controller
        try {
          const outcome = await switchBranch(remote, sessionId, name, controller.signal)
          if (!alive.current) return
          if (!outcome.ok) {
            // Keep the menu open so the failure is visible where the choice was made.
            setFailure(outcome.missingCommand === true
              ? translate('missing')
              : translate('failed', { message: outcome.message }))
            return
          }
          setOpen(false)
          setQuery('')
          // Drop every read still in flight: each describes the checkout this
          // Session just left and must not paint the old branch back.
          readSequence.current += 1
          setState(previous => ({ ...previous, current: name, status: 'ready' }))
          if (outcome.created) setNotice(translate('created', { branch: name }))
          // Confirm against the checkout the command reports, never the one we
          // started from: a switch moves the Session's directory and leaves the
          // original checkout's HEAD alone, so re-reading that directory would
          // always answer "still on the old branch".
          if (outcome.path !== undefined) await load(new AbortController().signal, outcome.path)
        } catch (error) {
          if (alive.current && !controller.signal.aborted) {
            setFailure(translate('failed', { message: String(error) }))
          }
        } finally {
          if (switching.current === controller) switching.current = null
          if (alive.current) setPending(null)
        }
      }

      if (directory === null || directory === undefined) return null
      // Outside a Git checkout there is no branch to show or choose.
      if (state.status === 'no-git') return null

      const ready = state.status === 'ready'
      const busy = pending !== null
      const broken = state.status === 'error' || failure !== null
      const shown = busy
        ? translate('switching', { branch: pending })
        : ready ? state.current ?? translate('detached') : broken ? translate('readFailed') : translate('loading')
      const tooltip = busy
        ? translate('switching', { branch: pending })
        : ready
          ? state.current === null ? translate('detached') : translate('current', { branch: state.current })
          : broken ? failure ?? translate('readFailed') : translate('loading')
      // A failure the user has not dismissed outranks the branch description in
      // the hover text, so a collapsed menu still explains what went wrong.
      const hint = failure ?? notice ?? tooltip
      const label = hero === true ? translate('heroTitle') : translate('title')

      const visible = query === ''
        ? state.branches
        : state.branches.filter(name => name.toLowerCase().includes(query.toLowerCase()))
      const rows = []
      if (state.partial) rows.push(h('div', { key: 'partial', className: 'sgb-note' }, translate('partial')))
      if (ready && state.branches.length > 0) {
        rows.push(h('div', { key: 'scope', className: 'sgb-note' }, translate('scope')))
      }
      if (state.branches.length >= FILTER_FROM) {
        rows.push(h('input', {
          key: 'filter',
          className: 'sgb-filter',
          type: 'search',
          value: query,
          'aria-label': translate('filter'),
          placeholder: translate('filter'),
          onChange: event => { setQuery(event.currentTarget.value) },
        }))
      }
      if (failure !== null) rows.push(h('div', { key: 'failure', className: 'sgb-error', role: 'alert' }, failure))
      if (!ready) {
        // A failed read must not keep claiming that it is still reading.
        rows.push(h('div', { key: 'note', className: 'sgb-note' }, broken ? translate('readFailed') : translate('loading')))
        rows.push(h('button', {
          key: 'retry',
          type: 'button',
          className: 'sgb-item',
          onClick: () => { void load(new AbortController().signal) },
        }, h('span', { className: 'sgb-item-name' }, translate('retry'))))
      } else if (visible.length === 0) {
        rows.push(h('div', { key: 'empty', className: 'sgb-note' }, translate('empty')))
      } else {
        for (const name of visible.slice(0, MAX_ROWS)) {
          rows.push(h('button', {
            key: name,
            type: 'button',
            role: 'option',
            className: 'sgb-item',
            'aria-selected': name === state.current ? 'true' : 'false',
            disabled: busy,
            title: name,
            onClick: () => { void choose(name) },
          },
          h('span', { className: 'sgb-check' }, name === state.current ? '\u2713' : ''),
          h('span', { className: 'sgb-item-name' }, name),
          ))
        }
      }

      return h('div', { className: 'sgb-root' },
        // Styles ride the component tree so unmounting removes them; the Host
        // forbids a plugin writing DOM outside its own component.
        h('style', null, CSS),
        h('button', {
          type: 'button',
          ref: trigger,
          className: 'sgb-trigger',
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          'aria-busy': busy,
          'aria-label': hint,
          title: hint,
          ...(broken ? { 'data-error': '' } : {}),
          onClick: () => {
            if (open) { setOpen(false); return }
            setOpen(true)
          },
        },
        h(BranchGlyph),
        hero === true ? h('span', { className: 'sgb-prefix' }, translate('heroPrefix')) : null,
        h('span', { className: 'sgb-name' }, shown),
        ),
        open
          ? h('div', {
            id: `sgb-menu-${sessionId}`,
            className: 'sgb-menu',
            role: 'listbox',
            'aria-label': label,
            ...(flip ? { 'data-below': '' } : { 'data-above': '' }),
          }, rows)
          : null,
      )
    }

    return {
      // Exposed for docs/check-client.mjs, which drives the real reader against
      // on-disk checkouts; nothing in the Host reads this member.
      __readBranchesForCheck: readBranches,
      __switchBranchForCheck: switchBranch,
      __branchControlForCheck: BranchControl,
      __dictionaries: DICTIONARIES,
      inject: ['slots', 'remote', 'remote.workspaceFiles', 'remote.commands', 'locale'],
      apply(ctx) {
        const remote = ctx.remote
        const locale = ctx.locale
        // The host locale service owns language resolution, caching, and fallback;
        // the plugin only supplies dictionaries.
        ctx.effect(() => locale.register(NS, DICTIONARIES), 'session-git-branch: dictionaries')
        const t = locale.bind(NS)

        /** Subscribe one mounted control to the active language. */
        function useLocaleId() {
          const [id, setId] = React.useState(() => locale.getLocale().active)
          React.useEffect(() => locale.subscribe(() => {
            const next = locale.getLocale().active
            setId(previous => (previous === next ? previous : next))
          }), [])
          return id
        }

        const seat = (slot, order, hero) => ctx.slots.inject(slot, () => ctx.slots.register(
          { name: slot, id: 'session-git-branch', order },
          props => h(BranchControl, {
            remote,
            useProjection: props.useProjection,
            sessionId: props.sessionId,
            hero,
            useLocaleId,
            t,
          }),
        ))

        // New Session row: the branch this Session starts on.
        seat('conversation.hero.options', 5, true)
        // Every Session: the branch of the working directory.
        seat('conversation.input.left', 5, false)
      },
    }
  },
})
