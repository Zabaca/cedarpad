import { apiKeyClient } from "@better-auth/api-key/client";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { api } from "./api.js";
import { config } from "./config.js";

/**
 * Better Auth browser client. With no `baseURL` it targets `/api/auth/*`
 * relative to the page origin — which Vite proxies to the API in dev (so the
 * session cookie is same-origin).
 *
 * Better Auth's `organization` plugin is Cedarpad's tenant primitive: we surface
 * it everywhere as the **workspace**. The plugin's client methods are still
 * named `organization.*` internally; the `workspace` facade below is the only
 * place that name appears, so the rest of the app speaks "workspace".
 *
 * In production `config.apiUrl` is the API origin; cross-origin cookies then
 * require CORS + `credentials` + Better Auth `trustedOrigins` on the server.
 */
export const authClient = createAuthClient({
  baseURL: config.apiUrl || undefined,
  plugins: [organizationClient(), apiKeyClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;

/** The active workspace is still Better Auth's active organization. */
export const useActiveWorkspace = authClient.useActiveOrganization;

/** Workspace mutations — thin facade over the organization client. */
export const workspace = {
  create: (input: { name: string; slug: string }) => authClient.organization.create(input),
  /**
   * Switch the active workspace. Membership no longer gates access, but Better
   * Auth's `setActive` still requires it — so we auto-enroll via the API first,
   * letting a user activate any workspace.
   */
  setActive: async (workspaceId: string) => {
    await api.activateWorkspace(workspaceId);
    return authClient.organization.setActive({ organizationId: workspaceId });
  },
  delete: (workspaceId: string) =>
    authClient.organization.delete({ organizationId: workspaceId }),
};

/**
 * Workspace-scoping metadata stored on each API key. Read back server-side by
 * `authMiddleware` (apps/api): `defaultWorkspaceId` is where the key's writes
 * land; `allowedWorkspaces` (when present) restricts what it can read — absent
 * ⇒ access to every accessible workspace, mirroring a human session.
 */
export interface ApiKeyMetadata {
  defaultWorkspaceId?: string;
  allowedWorkspaces?: string[];
}

/**
 * API key creation — a thin facade over Better Auth's `apiKey` client plugin.
 * The creator owns the key; everyone can then see and revoke it through the
 * shared registry endpoints (`api.listApiKeys` / `api.revokeApiKey`).
 */
export const apiKeys = {
  /**
   * Mint a key. The plaintext secret is returned **once**, here — it is never
   * retrievable again. `expiresInDays` null/undefined ⇒ the key never expires
   * (the default for long-lived agent keys).
   */
  create: (input: {
    name: string;
    defaultWorkspaceId: string;
    allowedWorkspaces?: string[];
    expiresInDays?: number | null;
  }) => {
    const metadata: ApiKeyMetadata = { defaultWorkspaceId: input.defaultWorkspaceId };
    if (input.allowedWorkspaces && input.allowedWorkspaces.length > 0) {
      metadata.allowedWorkspaces = input.allowedWorkspaces;
    }
    return authClient.apiKey.create({
      name: input.name,
      metadata,
      ...(input.expiresInDays ? { expiresIn: input.expiresInDays * 24 * 60 * 60 } : {}),
    });
  },
};
