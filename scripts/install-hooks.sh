#!/usr/bin/env bash
#
# install-hooks.sh — installs the tracked git hooks into .git/hooks/
#
# The hooks themselves live in scripts/git-hooks/ so they can be
# version-controlled. .git/hooks/ is per-clone and not tracked,
# so we symlink from there to the tracked location. That way:
#   - Editing scripts/git-hooks/pre-commit updates the live hook
#   - Anyone fresh-cloning the repo just runs this script once
#   - The hook source is reviewable in PRs
#
# Usage:
#   bash scripts/install-hooks.sh

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_SRC="$REPO_ROOT/scripts/git-hooks"
HOOKS_DEST="$REPO_ROOT/.git/hooks"

if [ ! -d "$HOOKS_DEST" ]; then
  echo "ERROR: $HOOKS_DEST does not exist. Are you inside a git repo?"
  exit 1
fi

for src_hook in "$HOOKS_SRC"/*; do
  name=$(basename "$src_hook")
  dest="$HOOKS_DEST/$name"

  # If a non-symlink hook already exists, back it up before replacing.
  # (Don't clobber a hook the user may have hand-written.)
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    backup="$dest.backup-$(date +%s)"
    echo "Backing up existing $name → $backup"
    mv "$dest" "$backup"
  fi

  # Remove any existing symlink so we can re-create it.
  if [ -L "$dest" ]; then
    rm "$dest"
  fi

  # Symlink + ensure executable.
  ln -s "$src_hook" "$dest"
  chmod +x "$src_hook"
  echo "Installed: $name"
done

echo ""
echo "Done. Hooks are live."
echo "To skip a hook for a single commit: git commit --no-verify"
