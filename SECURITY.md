# Security

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting: the **Security** tab of this repository,
then **Report a vulnerability**. Please don't open a public issue or pull request for a vulnerability. No email
address is published for reports.

Say what you found, how to reproduce it, and what it lets someone do. Please give us a reasonable time to fix it
before you write about it.

## What is covered

The code in this repository, at `main` and at the latest release, and the hosted product at app.cedarpad.com that
runs it. Third-party code (tldraw, Better Auth, the Claude Agent SDK and the other dependencies) is not: report a
problem in those to their own projects.

## What cedarpad lets others do

A workspace's chat agent has no shell and no filesystem tools: it changes things only through the canvas and
component tools, and its process is not handed the storage or platform secrets. A guest (someone who opens a share
link) is limited to the capabilities that link grants. A component the agent writes is JavaScript that runs in the
browser of everyone who views it, bounded to its canvas. [`packages/canvas/CONTEXT.md`](packages/canvas/CONTEXT.md)
is the reference for who may do what.
