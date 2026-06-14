#!/usr/bin/env bash
# publish.sh — create a PRIVATE GitHub repo for this project and push it.
#
#   Run from the repo root in Git Bash:   bash publish.sh
#   Optional custom name:                 bash publish.sh my-repo-name
#
# It uses the GitHub credential already cached on this machine (Git Credential
# Manager). Your token is read into a shell variable and used only in the API
# request header — it is never printed. Nothing here leaves your machine except
# the normal `git push` to your own private repo, which YOU are running.
set -u
REPO="${1:-skynet-harness}"

# 1. pull the cached github.com credential (username + token) without echoing the token
CRED=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null)
GUSER=$(printf '%s\n' "$CRED" | sed -n 's/^username=//p' | head -1)
TOK=$(printf '%s\n' "$CRED" | sed -n 's/^password=//p' | head -1)
if [ -z "${GUSER}" ] || [ -z "${TOK}" ]; then
  echo "No cached GitHub credential found."
  echo "Fix: run  'gh auth login'  (gh is installed) OR create the repo at https://github.com/new"
  echo "      then: git remote add origin https://github.com/<you>/$REPO.git && git push -u origin --all"
  exit 1
fi
echo "GitHub account : $GUSER"
echo "Creating repo  : $REPO (private)"

# 2. create the private repo via the GitHub API (token only in the header)
CODE=$(curl -s -o /tmp/ghpub.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.github+json" \
  https://api.github.com/user/repos \
  -d "{\"name\":\"$REPO\",\"private\":true,\"description\":\"SKYNET — gamified AI-agent harness desktop app (BYOK via OpenRouter)\"}")
if [ "$CODE" != "201" ] && [ "$CODE" != "422" ]; then
  echo "Repo create failed (HTTP $CODE):"; cat /tmp/ghpub.json; rm -f /tmp/ghpub.json; exit 1
fi
[ "$CODE" = "422" ] && echo "(a repo named '$REPO' already exists on your account — pushing into it)"
rm -f /tmp/ghpub.json

# 3. wire the remote and push every branch (the cached credential authenticates the push)
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$GUSER/$REPO.git"
git push -u origin --all

echo ""
echo "Done →  https://github.com/$GUSER/$REPO"
