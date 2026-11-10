# Issue tracker: GitHub

GitHub issues on `Zabaca/cedarpad` are for **public reports and outside contributions**: a bug someone found, a
feature request, a discussion before a pull request. **Zabaca's own planning and tickets are tracked outside this
repository, in Fredrin**, and do not become GitHub issues (see `CLAUDE.md`). Use the `gh` CLI for the GitHub side; it
infers the repository from `git remote -v` inside a clone.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for a multi-line body.
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`, with `--label` and `--state`
  filters as needed.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove a label**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close**: `gh issue close <number> --comment "..."`.

## When a skill says "publish to the issue tracker"

For Zabaca's own work, publish to Fredrin, not here: a spec is the goal's plan there, and the work cut from it is tickets
under that goal. Create a GitHub issue only when the thing is a public report or a discussion with outside contributors;
then the work cut from it is further issues that link to it (`Part of #<spec>`).

## When a skill says "fetch the relevant ticket"

For a GitHub issue (a public report), run `gh issue view <number> --comments`. For Zabaca's own ticket, read it in Fredrin.

## Pull requests

A pull request is not a work item: do not treat an inbound one as a request to triage. "Ship" or "finish" means open a
pull request and stop; a maintainer merges it (squash). GitHub shares one number space across issues and pull requests,
so a bare `#42` may be either: resolve it with `gh pr view 42`, and fall back to `gh issue view 42`.

## Security reports

Never file a vulnerability as an issue. It goes through private vulnerability reporting (see `SECURITY.md`).

## This repository is public

Everything in an issue, a pull request, a commit message or a committed file is published. None of these goes in:
credentials and how they are set up, personal email addresses, the home paths and hostnames of anyone's machines, links
to private sessions or tools, and customer or client names. Use made-up values in examples.
