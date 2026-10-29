#!/usr/bin/env bash
set -euo pipefail

# Re-exec from a temporary copy because this script rewrites the commit that
# contains itself.
if [[ "${CAL_SIGN_REEXEC:-0}" != "1" ]]; then
  script_copy="$(mktemp "${TMPDIR:-/tmp}/cal-sign-and-push.XXXXXX")"
  cp -- "$0" "$script_copy"
  chmod 700 "$script_copy"
  export CAL_SIGN_REEXEC=1
  exec "$script_copy" "$@"
fi

remote="${1:-origin}"
repo="$(git rev-parse --show-toplevel)"
cd "$repo"

branch="$(git symbolic-ref --quiet --short HEAD)"
if [[ -z "$branch" ]]; then
  echo "Refusing to rewrite a detached HEAD." >&2
  exit 1
fi

if [[ ! -t 0 ]]; then
  echo "Run this script in an interactive terminal so Git can unlock the signing key." >&2
  exit 1
fi

git update-index --refresh
if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "Working tree must be clean before signing history." >&2
  exit 1
fi

git remote get-url "$remote" >/dev/null
git fetch "$remote" "$branch"

remote_ref="refs/remotes/${remote}/${branch}"
remote_tip="$(git rev-parse --verify "$remote_ref" 2>/dev/null || true)"
unsigned_tip="$(git rev-parse HEAD)"

backup_dir="$repo/.git/history-backups"
mkdir -p "$backup_dir"
backup="$backup_dir/pre-sign-${branch}-${unsigned_tip}.bundle"
git bundle create "$backup" --all

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/cal-sign-history.XXXXXX")"
cleanup() {
  rm -rf -- "$work_dir"
  rm -f -- "$0"
}
trap cleanup EXIT

before="$work_dir/before.tsv"
after="$work_dir/after.tsv"
manifest="$work_dir/manifest.tsv"
helper="$work_dir/sign-one.sh"

git log --reverse --format='%T%x09%aI%x09%cI%x09%s' >"$before"
cp -- "$before" "$manifest"

if ! awk -F '\t' '
  { key = $1 FS $2 FS $4; seen[key]++ }
  END { for (key in seen) if (seen[key] > 1) exit 1 }
' "$manifest"; then
  echo "History has ambiguous tree/date/subject keys; no commits were rewritten." >&2
  exit 1
fi

cat >"$helper" <<'HELPER'
#!/usr/bin/env bash
set -euo pipefail

tree="$(git show -s --format=%T HEAD)"
author_date="$(git show -s --format=%aI HEAD)"
subject="$(git show -s --format=%s HEAD)"
committer_date="$(awk -F '\t' -v tree="$tree" -v author="$author_date" -v subject="$subject" '
  $1 == tree && $2 == author && $4 == subject { print $3; found = 1; exit }
  END { if (!found) exit 1 }
' "$CAL_SIGN_MANIFEST")"

GIT_COMMITTER_DATE="$committer_date" git commit --amend --no-edit --date="$author_date" -S
HELPER
chmod 700 "$helper"

export CAL_SIGN_MANIFEST="$manifest"
export GPG_TTY="$(tty)"

if ! git -c commit.gpgSign=false rebase --root --exec "$helper"; then
  git rebase --abort >/dev/null 2>&1 || true
  echo "Signing failed; the original history was restored. Backup: $backup" >&2
  exit 1
fi

git log --reverse --format='%T%x09%aI%x09%cI%x09%s' >"$after"
if ! cmp -s "$before" "$after"; then
  echo "Signed history changed a tree, timestamp, or subject. Push cancelled." >&2
  echo "Backup: $backup" >&2
  exit 1
fi

while read -r commit; do
  git verify-commit "$commit" >/dev/null
done < <(git rev-list --reverse HEAD)

if [[ -n "$remote_tip" ]]; then
  git push --force-with-lease="refs/heads/${branch}:${remote_tip}" "$remote" "HEAD:refs/heads/${branch}"
else
  git push --set-upstream "$remote" "HEAD:refs/heads/${branch}"
fi

echo "Signed and pushed $(git rev-list --count HEAD) commits on ${branch}."
echo "Pre-sign backup: $backup"
