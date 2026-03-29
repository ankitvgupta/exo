# GitHub CLI (`gh`) Usage

How to interact with the GitHub API from this repo. There are two environments to handle.

## Environments

### Local (Mac)
`gh` is pre-installed and authenticated via `gh auth login`. Git remotes point directly at `github.com`. Everything works out of the box:
```bash
gh pr list
gh issue list
gh api repos/{owner}/{repo}/pulls
```

### Claude Code on Web
Three differences from local:

1. **`gh` is not pre-installed.** Install the latest version:
   ```bash
   GH_VERSION=$(curl -s https://api.github.com/repos/cli/cli/releases/latest | grep -oP '"tag_name":\s*"v\K[^"]+')
   curl -sL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" -o /tmp/gh.tar.gz \
     && tar -xzf /tmp/gh.tar.gz -C /tmp \
     && cp /tmp/gh_${GH_VERSION}_linux_amd64/bin/gh /usr/local/bin/gh
   ```

2. **Auth uses `GITHUB_TOKEN` env var**, which is already set. `gh` picks it up automatically — no `gh auth login` needed.

3. **Git remotes use a proxy URL** (e.g. `http://local_proxy@127.0.0.1:PORT/git/owner/repo`), not `github.com`. This means `gh` can't auto-detect the repo. **Always pass `--repo owner/repo`** for subcommands that need it (pr, issue, release, etc.), or use `gh api` with explicit paths.

## Detecting the environment

Check if `gh` is on PATH. If not, you're on the web — install it per above. After that, detect the remote format to decide whether `--repo` is needed:
```bash
git remote get-url origin
```
- Contains `github.com` → local, no `--repo` needed
- Contains `127.0.0.1` or doesn't contain `github.com` → web, use `--repo owner/repo`

Extract `owner/repo` from the proxy URL by taking the last two path segments: e.g. `http://...127.0.0.1:PORT/git/owner/repo` → `owner/repo`.

## Common operations

All examples below use `--repo {owner}/{repo}` for web compatibility. On local you can omit it.

```bash
# List open PRs
gh pr list --state open --repo {owner}/{repo}

# PR detail with JSON fields
gh pr view 42 --repo {owner}/{repo} --json title,body,reviews,comments

# List PR review comments (useful for code review workflows)
gh api repos/{owner}/{repo}/pulls/42/comments

# Create a PR
gh pr create --title "title" --body "body" --repo {owner}/{repo}

# Check CI status
gh pr checks 42 --repo {owner}/{repo}

# Comment on a PR
gh pr comment 42 --body "comment text" --repo {owner}/{repo}

# List issues
gh issue list --state open --repo {owner}/{repo}

# Arbitrary API calls
gh api repos/{owner}/{repo}/actions/runs --jq '.workflow_runs[:5] | .[].conclusion'
```
