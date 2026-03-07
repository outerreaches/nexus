export function isSuccessfulApplyDeployResult(result: string | undefined): boolean {
  if (typeof result !== "string") return false;
  const trimmed = result.trimStart();
  return trimmed.startsWith("OK:");
}

