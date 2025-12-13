export function configToJsonString(config: unknown) {
  if (config === undefined || config === null) return "{\n  \n}";
  try {
    return JSON.stringify(config, null, 2);
  } catch {
    return "{\n  \n}";
  }
}

export function parseConfigJsonObject(raw: string): { value: Record<string, unknown> | null; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, error: "Config JSON is required" };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { value: null, error: "Config must be a JSON object (not an array)" };
    }
    return { value: parsed as Record<string, unknown>, error: null };
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : "Invalid JSON" };
  }
}

export function slugError(slugRaw: string) {
  const slug = slugRaw.trim();
  if (!slug) return "Slug is required";
  if (slug.length > 64) return "Slug is too long";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    return "Use lowercase letters/numbers, _ or - (e.g. cardiofitness)";
  }
  return null;
}

