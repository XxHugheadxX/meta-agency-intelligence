import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tokenManager } from "../auth/token-manager.js";
import { getCurrentFbUserId } from "../auth/token-store.js";
import {
  deleteToken as repoDeleteToken,
  listTokens as repoListTokens,
  saveToken as repoSaveToken,
  setDefaultToken as repoSetDefault,
} from "../store/meta-token-repo.js";
import { validateToken as validateMetaToken } from "../auth/meta-oauth.js";
import { logger } from "../utils/logger.js";
import { READ, TOKEN, DELETE, WRITE_WARNING } from "./_register.js";

export function registerTokenTools(server: McpServer): void {
  server.registerTool(
    "ads_list_tokens",
    {
      description:
        "List Meta tokens registered for the current authenticated user (or the legacy global pool when running stdio / API key). Never exposes raw token values.",
      inputSchema: {},
      annotations: { ...READ },
    },
    async () => {
      const fbUserId = getCurrentFbUserId();

      if (fbUserId) {
        const tokens = await repoListTokens(fbUserId);
        if (tokens.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No tokens registered. Connect via /authorize → 'Sign in with Meta', or register a System User token from the consent UI / ads_register_token.",
              },
            ],
          };
        }
        const lines = tokens.map((t) => {
          const flag = t.isDefault ? " [ACTIVE]" : "";
          const expiry =
            t.kind === "system_user"
              ? "no-expiry"
              : t.expiresAt
                ? `expires ${new Date(t.expiresAt * 1000).toISOString()}`
                : "—";
          return `• ${t.name} (${t.kind}, ${expiry})${flag}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Tokens for user ${fbUserId} (${tokens.length}):\n\n${lines.join("\n")}`,
            },
            {
              type: "text",
              text: JSON.stringify({ fbUserId, tokens }, null, 2),
            },
          ],
        };
      }

      const { active, available } = tokenManager.listTokens();
      if (available.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No tokens registered. Set META_TOKENS or META_ACCESS_TOKEN environment variable, or use ads_register_token.",
            },
          ],
        };
      }
      const lines = available.map(
        (name) => `• ${name}${name === active ? " [ACTIVE]" : ""}`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Registered tokens (${available.length}):\n\n${lines.join("\n")}`,
          },
          {
            type: "text",
            text: JSON.stringify({ active, available }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "ads_set_active_token",
    {
      description: `${WRITE_WARNING}Switch the active Meta API token for the current user (or the legacy global pool when running stdio / API key).`,
      inputSchema: {
        bm_name: z
          .string()
          .min(1)
          .describe("Name of the registered token / Business Manager to activate"),
      },
      annotations: { ...TOKEN },
    },
    async ({ bm_name }) => {
      const fbUserId = getCurrentFbUserId();

      if (fbUserId) {
        const ok = await repoSetDefault(fbUserId, bm_name);
        if (!ok) {
          const tokens = await repoListTokens(fbUserId);
          return {
            content: [
              {
                type: "text",
                text: `Token "${bm_name}" not found. Available: ${tokens.map((t) => t.name).join(", ") || "none"}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Active token switched to "${bm_name}".`,
            },
          ],
        };
      }

      const success = tokenManager.setActiveToken(bm_name);
      if (!success) {
        const { available } = tokenManager.listTokens();
        return {
          content: [
            {
              type: "text",
              text: `Token "${bm_name}" not found. Available: ${available.join(", ") || "none"}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Active token switched to "${bm_name}".`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "ads_register_token",
    {
      description: `${WRITE_WARNING}Register a Meta access token (typically a System User token that does not expire) for the current authenticated user. Validates the token via GET /me before registering. In stdio / API-key mode, falls back to the in-memory legacy registry.`,
      inputSchema: {
        bm_name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9_-]+$/)
          .describe("Friendly name (a-z, A-Z, 0-9, _, -)"),
        access_token: z
          .string()
          .min(10)
          .describe("Meta API access token to register"),
      },
      annotations: { ...TOKEN },
    },
    async ({ bm_name, access_token }) => {
      logger.info(
        { tokenName: bm_name, event: "legacy_token_registration_requested" },
        "Validating token before registration",
      );
      const validation = await validateMetaToken(access_token);
      if (!validation.valid || !validation.profile) {
        logger.warn(
          { tokenName: bm_name, error: validation.error },
          "Token validation failed",
        );
        return {
          content: [
            {
              type: "text",
              text: `Token validation failed: ${validation.error}\n\nThe token was NOT registered.`,
            },
          ],
          isError: true,
        };
      }

      const fbUserId = getCurrentFbUserId();

      if (fbUserId) {
        await repoSaveToken({
          fbUserId,
          name: bm_name,
          accessToken: access_token,
          kind: "system_user",
          expiresAt: null,
          metaUserId: validation.profile.id,
          metaUserName: validation.profile.name,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `System User token "${bm_name}" registered for user ${fbUserId}.\n` +
                `Validated as: ${validation.profile.name ?? validation.profile.id}\n` +
                "Token accepted and stored server-side.",
            },
          ],
        };
      }

      tokenManager.registerToken(bm_name, access_token);
      return {
        content: [
          {
            type: "text",
            text:
              `Token "${bm_name}" registered (legacy in-memory pool).\n` +
              `Validated as: ${validation.profile.name ?? validation.profile.id}\n` +
              "Token accepted and stored server-side.",
          },
        ],
      };
    },
  );

  server.registerTool(
    "ads_delete_token",
    {
      description: `${WRITE_WARNING}Delete a Meta token registered for the current authenticated user. No-op for the legacy in-memory pool.`,
      inputSchema: {
        bm_name: z.string().min(1).max(64).describe("Name of the token to delete"),
      },
      annotations: { ...DELETE },
    },
    async ({ bm_name }) => {
      const fbUserId = getCurrentFbUserId();
      if (!fbUserId) {
        return {
          content: [
            {
              type: "text",
              text: "Per-user token deletion requires Meta OAuth login. The legacy in-memory pool does not support deletion.",
            },
          ],
          isError: true,
        };
      }
      const ok = await repoDeleteToken(fbUserId, bm_name);
      if (!ok) {
        return {
          content: [
            { type: "text", text: `Token "${bm_name}" not found for user ${fbUserId}.` },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: "text", text: `Token "${bm_name}" deleted for user ${fbUserId}.` },
        ],
      };
    },
  );
}
