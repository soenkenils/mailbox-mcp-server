import type { RequestHandler } from "express";
import { MailboxOAuthProvider } from "./provider.js";
import { createOAuthRouter } from "./router.js";

export { MailboxOAuthProvider } from "./provider.js";

export interface OAuthSupport {
  provider: MailboxOAuthProvider;
  /** Serves metadata, registration, authorize and token endpoints. */
  authRouter: RequestHandler;
  /** Advertised in the 401 challenge so clients can discover the flow. */
  resourceMetadataUrl: string;
}

/**
 * Builds the OAuth authorization server.
 *
 * This server is both the authorization server and the resource server, so the
 * issuer and the resource are the same public origin. `publicUrl` must be the
 * externally reachable origin, since it is published in discovery metadata and
 * used to build redirects.
 */
export const createOAuthSupport = (
  authToken: string,
  publicUrl: string,
  allowedRedirectHosts?: string[],
): OAuthSupport => {
  const issuerUrl = new URL(publicUrl);
  const provider = new MailboxOAuthProvider(authToken, allowedRedirectHosts);

  const authRouter = createOAuthRouter({
    provider,
    issuerUrl,
    resourceName: "Mailbox MCP Server",
  });

  return {
    provider,
    authRouter,
    resourceMetadataUrl: new URL(
      "/.well-known/oauth-protected-resource",
      issuerUrl,
    ).toString(),
  };
};
