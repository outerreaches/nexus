import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { DataSource } from "./types.js";

export type NeedsParamsResponse = {
  status: "NEEDS_PARAMS";
  sourceId: string;
  message: string;
  paramsSchema: unknown;
  usageNote: string | null;
  validationErrors: string[];
};

/**
 * Validate source params against the source's paramsSchema.
 * Returns a structured NEEDS_PARAMS response if validation fails,
 * allowing the agent to self-correct in one follow-up call.
 */
export function validateSourceParams(
  source: DataSource,
  params: unknown,
): { ok: true; params: unknown } | { ok: false; response: NeedsParamsResponse } {
  if (!source.paramsSchema) {
    return { ok: true, params };
  }

  const result = source.paramsSchema.safeParse(params);
  if (result.success) {
    return { ok: true, params: result.data };
  }

  const errors = result.error.issues.map(
    (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
  );

  return {
    ok: false,
    response: {
      status: "NEEDS_PARAMS",
      sourceId: source.id,
      message: `Source '${source.id}' requires additional parameters. See paramsSchema and usageNote below.`,
      paramsSchema: zodToJsonSchema(source.paramsSchema, { target: "jsonSchema7" }),
      usageNote: source.usageNote ?? null,
      validationErrors: errors,
    },
  };
}
