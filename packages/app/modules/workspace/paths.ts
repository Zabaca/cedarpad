import { join } from 'node:path'

/**
 * Workspace DB lives in-tree at `<repo>/.cedarpad/db.sqlite`. Per ADR-0005's
 * deferred decision and slice 1's plan: in-tree is commitable for shared
 * threads later, gitignorable for private use, and discoverable.
 */
export function workspaceDbPath(repoPath: string): string {
  return join(repoPath, '.cedarpad', 'db.sqlite')
}

export function workspaceDbDir(repoPath: string): string {
  return join(repoPath, '.cedarpad')
}

export function repoGitignorePath(repoPath: string): string {
  return join(repoPath, '.gitignore')
}
