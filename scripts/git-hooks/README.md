# Git hooks

Tracked git hooks for this repo. The hook source lives here so it's
version-controlled and reviewable; the live hooks symlink from
`.git/hooks/` to this directory.

## Install

```bash
bash scripts/install-hooks.sh
```

Run once after cloning the repo. Symlinks the hooks into
`.git/hooks/` and makes them executable.

## Hooks

### `pre-commit`

Auto-regenerates email previews when the underlying email templates
change. Maps `lib/*-email.js` files to the preview generator scripts
that render them, runs only the affected scripts, re-stages the
regenerated preview files.

Behaviour:
- No-op when the commit doesn't touch any email lib files
- Runs only the preview scripts whose source files are in the commit
- Silently skips gitignored preview directories
- Aborts the commit if a preview script fails (so broken templates
  can't slip through)

To skip the hook for a single commit (e.g. emergency rollback):

```bash
git commit --no-verify
```

## Adding a new email module

If you add a new `lib/*-email.js` file with a corresponding
preview script, add a `case` clause in `pre-commit` mapping the
filename to the script. The hook prints a `note:` line at commit
time when it sees an unmapped email file change, as a reminder.
