import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { deleteCredential, getCredentialStorePath, listCredentials, upsertCredential } from "../secrets/credentials.js";
import crypto from "node:crypto";

function readEnv(name: string): string | null {
  const v = process.env[name];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

function randomPassword(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{}:,.?";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

function randomIdSuffix(len: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export const credentialSet = defineTool({
  name: "credential_set",
  description:
    "Store a username/password credential in the local state vault (prefer env-backed to avoid sending secrets to the LLM).",
  parameters: z
    .object({
      id: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-zA-Z0-9_.-]+$/)
        .describe("Credential id (letters/digits/._-)."),
      username: z.string().max(500).optional().describe("Username/email (plaintext)."),
      password: z.string().max(5000).optional().describe("Password (plaintext). Prefer passwordEnv."),
      usernameEnv: z.string().max(80).optional().describe("Read username from this env var (preferred)."),
      passwordEnv: z.string().max(80).optional().describe("Read password from this env var (preferred)."),
      note: z.string().max(400).optional(),
      overwrite: z.boolean().default(false).describe("If true, replace the entire record; otherwise merge."),
    })
    .superRefine((val, ctx) => {
      const hasAny = Boolean(val.username || val.password || val.usernameEnv || val.passwordEnv || val.note);
      if (!hasAny) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "Provide at least one field to set." });
    }),
  execute: async (args, ctx) => {
    try {
      const username = args.usernameEnv ? readEnv(args.usernameEnv) ?? undefined : args.username;
      const password = args.passwordEnv ? readEnv(args.passwordEnv) ?? undefined : args.password;

      if (args.usernameEnv && username === undefined) return `ERROR: env var ${args.usernameEnv} is not set`;
      if (args.passwordEnv && password === undefined) return `ERROR: env var ${args.passwordEnv} is not set`;

      const res = await upsertCredential({
        stateDir: ctx.stateDir,
        id: args.id,
        username,
        password,
        note: args.note,
        overwrite: args.overwrite,
      });
      return JSON.stringify(
        {
          ok: true,
          id: res.credential.id,
          storePath: getCredentialStorePath(ctx.stateDir),
          hasUsername: Boolean(res.credential.username),
          hasPassword: Boolean(res.credential.password),
          passwordEncrypted: res.passwordEncrypted,
          updatedAt: res.credential.updatedAt,
        },
        null,
        2,
      );
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const credentialGenerate = defineTool({
  name: "credential_generate",
  description:
    "Generate and store a strong password in the local credential vault (password is generated locally and never sent to the LLM).",
  parameters: z.object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .describe("Credential id (letters/digits/._-)."),
    username: z.string().max(500).optional().describe("Optional username/email to store."),
    usernamePrefix: z
      .string()
      .max(32)
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .optional()
      .describe("If provided and username is empty, generates username as `${prefix}-${random}`."),
    passwordLength: z.number().int().min(12).max(64).default(24),
    note: z.string().max(400).optional(),
    overwrite: z.boolean().default(false),
  }),
  execute: async (args, ctx) => {
    try {
      const username =
        args.username?.trim() ||
        (args.usernamePrefix ? `${args.usernamePrefix}-${randomIdSuffix(10)}` : undefined);

      const password = randomPassword(args.passwordLength);

      const res = await upsertCredential({
        stateDir: ctx.stateDir,
        id: args.id,
        username,
        password,
        note: args.note,
        overwrite: args.overwrite,
      });

      return JSON.stringify(
        {
          ok: true,
          id: res.credential.id,
          storePath: getCredentialStorePath(ctx.stateDir),
          hasUsername: Boolean(res.credential.username),
          hasPassword: Boolean(res.credential.password),
          passwordEncrypted: res.passwordEncrypted,
          updatedAt: res.credential.updatedAt,
          note: res.credential.note ?? null,
        },
        null,
        2,
      );
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const credentialList = defineTool({
  name: "credential_list",
  description: "List stored credential ids (does not reveal secrets).",
  parameters: z.object({}),
  execute: async (_args, ctx) => {
    try {
      const items = await listCredentials(ctx.stateDir);
      return JSON.stringify({ storePath: getCredentialStorePath(ctx.stateDir), items });
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const credentialDelete = defineTool({
  name: "credential_delete",
  description: "Delete a stored credential by id.",
  parameters: z.object({
    id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  }),
  execute: async (args, ctx) => {
    try {
      const ok = await deleteCredential({ stateDir: ctx.stateDir, id: args.id });
      return ok ? "OK" : "ERROR: not found";
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});
