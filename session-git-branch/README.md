# Session Git branch

Shows which Git branch a Session is working on, and lets you switch to another
branch of the same repository from the New Session row or the composer.

## What it does

- **Composer badge.** A branch glyph and the current branch sit in the composer
  tool row of every Session. Click it to see the checkout's local branches and
  move the Session to another one.
- **New Session row.** A `Branch` control appears in the New Session options, so a
  Session can start on the branch you want instead of the project directory's
  current branch.
- **Existing worktree first.** Choosing a branch moves the Session's working
  directory into the checkout that already holds that branch.
- **New worktree when needed.** When no checkout holds the branch, the plugin adds
  a linked worktree for it under `.agents/worktrees/<branch>` and moves the
  Session there. That pool ignores itself, so the project's `git status` stays
  clean.
- **The project checkout is untouched.** Neither its `HEAD` nor its uncommitted
  files change; the Session simply works somewhere else.
- **Visible state.** The badge shows `Switching to <branch>…` while a move runs,
  keeps the menu open with the reason when a move fails, and reports the branch
  list as partial when part of it lies outside the workspace.

## Reading the branch

The badge reads `HEAD` and the refs from the checkout's Git directory through the
Session's authorized file reads. It runs no command and writes nothing to the
Session log, so the badge costs no conversation history and no model tokens.

When the shared Git directory sits outside the Session workspace, the branch list
is marked partial instead of passing off the packed branches as the whole list.

## Menu placement

The menu opens upward from the composer chip and downward in the New Session row,
flipping when the window leaves it no room. It is positioned inside the control
rather than portalled to `document.body`: the composer owns the stacking context,
and a portal from a plugin bundle would have to re-create the host's menu focus,
dismissal, and elevation behaviour. If the composer ever clips it, that is the
known cost of staying inside the allocated slot.

## Switching the branch: `/session_branch`

Switching is a Host command this bundle installs, so the UI and any other command
caller share one implementation:

| Line | Result |
|---|---|
| `/session_branch` or `/session_branch list` | Local branches, HEAD's branch first, with the checkout that holds each |
| `/session_branch status` | The Session's current branch and directory |
| `/session_branch <branch>` | Move the Session into that branch's checkout, creating one if needed |

A command line is logged as a `command/run` / `command/done` pair, so a switch
appears in the conversation as a command row. Branch names must be local
branches; the plugin never fetches, creates, renames, or deletes branches, and it
never merges or removes worktrees.

## Requirements and limits

- The Session's directory must be inside a Git checkout. Outside one the control
  is not shown at all, because there is no branch to report or choose.
- Git must be on `PATH` for switching, because creating a worktree runs `git
  worktree add` under the Session's sandbox policy. Under a `read-only` policy the
  add fails and the menu shows the Git error.
- A branch checked out in a locked worktree, or one Git refuses for another
  reason, reports the Git error and leaves the Session where it was.
- Branches are listed up to a bounded depth and count; a filter appears once a
  repository has many of them. When the shared Git directory lies outside the
  workspace, only packed branches can be read and the menu says so.
- Turning the bundle off removes the control and the command. Worktrees it created
  stay on disk under `.agents/worktrees`, and branches are never deleted.

## Development

Two self-checks run against throwaway Git repositories:

```sh
node docs/check.mjs         # Host: list, create worktree, enter existing, refuse unknown, no checkout
node docs/check-client.mjs  # Client: HEAD, packed and loose refs, worktree, no checkout, detached,
                            #         dictionaries, and the 4-argument command contract
```

The client check mounts the real controls through a small React harness, so it
also asserts what the user sees: the badge names the current branch, the New
Session seat carries the `Branch` prefix, and a non-repository directory renders
nothing. It mirrors the Host command executor's argument contract, including its
required cancellation signal, so a call that drops the signal fails the check
instead of failing silently in the browser.
