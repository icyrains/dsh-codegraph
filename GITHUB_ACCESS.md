# GitHub access for this repo

Repo: `github.com/jiangzhenguo/dsh-codegraph` (branch `main`, published).

## How cross-session sessions operate GitHub

A GitHub personal access token is stored in the DSH shared credentials document:

```text
$DSH_HOME/.credentials.yaml   →   key GITHUB_TOKEN
```

`$DSH_HOME` is `~/.dsh` by default. The value authenticates as the `jiangzhenguo`
account with `admin`/`push` on this repo. Any DSH session can read it (it is just a
file in the user's home, like the other API keys in that document) and use it like:

```bash
export GH_TOKEN="$(python3 -c 'import yaml,os;print(yaml.safe_load(open(os.path.expanduser("~/.dsh/.credentials.yaml")))["GITHUB_TOKEN"])')"
gh api user --jq .login               # verify
```

SSH is also configured (`~/.ssh/id_rsa` registered to `jiangzhenguo`), so plain
`git push` over `git@github.com:...` works without a token.

## Scope caveat

This PAT cannot write repository **topics** (fine-grained PATs need a separate
`Metadata: write` permission; this one has it read-only). The `dsh-plugin` and
`code-graph` topics are already set, so that is only relevant if you need to change
topics later.

## Do not commit tokens

Never commit the raw token. It lives only in `~/.dsh/.credentials.yaml` (0600) and
as a `GH_TOKEN` environment variable at use time. The GitHub Actions workflows read
secrets via `secrets.GH_TOKEN` / `${{ secrets }}`, never from the repo.
