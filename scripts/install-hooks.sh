#!/usr/bin/env bash
# hooks are not cloned; run after every fresh clone/worktree (release-wheel law 2026-09-30).
set -e
top="$(git rev-parse --show-toplevel)"
cp "$top/scripts/git-hooks/pre-push" "$top/.git/hooks/pre-push"
chmod +x "$top/.git/hooks/pre-push"
echo "release-guard installed @ $top"
