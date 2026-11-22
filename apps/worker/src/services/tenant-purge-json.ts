/** Remove sensitive fields recursively before keeping structured contract or audit data. */
const PRIVATE_JSON_KEY = /(?:name|line[_-]?user[_-]?id|email|phone|memo|note|address|token|secret|url|password|credential|authorization|access[_-]?key|customer[_-]?id|payment[_-]?method[_-]?id)/i;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function redact(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;
  const clean: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, child] of Object.entries(value)) {
    if (!PRIVATE_JSON_KEY.test(key)) clean[key] = redact(child);
  }
  return clean;
}

export function redactRetainedJson(input: string): string {
  return JSON.stringify(redact(JSON.parse(input) as JsonValue));
}
