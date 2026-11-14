// A small JSON Schema check, for the arguments a pipeline gives a tool and
// the answers Claude gives a pipeline. It covers the plain parts of a schema
// (type, properties, required, additionalProperties: false, items, enum,
// const). Where a schema uses anything it doesn't know how to judge
// (oneOf, anyOf, allOf, not, $ref, if), that part is left unchecked: a
// check that might be wrong must not stop a call that might be right.

const COMBINATORS = ["oneOf", "anyOf", "allOf", "not", "$ref", "if", "$dynamicRef"];
const MAX_DEPTH = 40;
/** Items of a long array are checked up to here. */
const MAX_ITEMS = 200;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** `string`, `array`, `null`, ...: what JSON Schema calls a value's type. */
export function typeOf(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/** A value in a few characters, for a message. */
export function preview(v: unknown, max = 60): string {
  let s: string;
  try {
    s = typeof v === "string" ? JSON.stringify(v) : (JSON.stringify(v) ?? String(v));
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const fits = (type: string, wanted: string) =>
  type === wanted || (wanted === "number" && type === "integer");

export interface CheckOptions {
  /** Values for which this is true are not checked (a reference whose value isn't known yet). */
  unknown?: (v: unknown) => boolean;
}

/**
 * The ways `value` doesn't fit `schema`, each as `<where>: <what>`; empty
 * when it fits or the schema can't be judged.
 */
export function check(
  value: unknown,
  schema: unknown,
  where = "value",
  opts: CheckOptions = {},
  depth = 0,
): string[] {
  if (!isObject(schema) || depth > MAX_DEPTH) return [];
  if (COMBINATORS.some((k) => k in schema)) return [];
  if (opts.unknown?.(value)) return [];
  const problems: string[] = [];
  const type = typeOf(value);

  const wanted =
    typeof schema.type === "string"
      ? [schema.type]
      : Array.isArray(schema.type)
        ? schema.type.filter((t): t is string => typeof t === "string")
        : [];
  if (wanted.length && !wanted.some((w) => fits(type, w))) {
    return [`${where}: expected ${wanted.join(" or ")}, got ${type} (${preview(value)})`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => same(e, value))) {
    const options = preview(schema.enum, 120);
    return [`${where}: ${preview(value)} isn't one of ${options}`];
  }
  if ("const" in schema && !same(schema.const, value)) {
    return [`${where}: must be ${preview(schema.const)}`];
  }

  if (isObject(value)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof name === "string" && !Object.hasOwn(value, name)) {
        problems.push(`${where}: "${name}" is required`);
      }
    }
    for (const [name, v] of Object.entries(value)) {
      if (Object.hasOwn(props, name)) {
        problems.push(...check(v, props[name], `${where}.${name}`, opts, depth + 1));
      } else if (schema.additionalProperties === false && !isObject(schema.patternProperties)) {
        const known = Object.keys(props);
        problems.push(
          `${where}: no argument named "${name}"${known.length ? ` (it takes ${known.join(", ")})` : ""}`,
        );
      } else if (isObject(schema.additionalProperties)) {
        problems.push(
          ...check(v, schema.additionalProperties, `${where}.${name}`, opts, depth + 1),
        );
      }
    }
  } else if (Array.isArray(value) && isObject(schema.items)) {
    for (let i = 0; i < Math.min(value.length, MAX_ITEMS); i++) {
      problems.push(...check(value[i], schema.items, `${where}[${i}]`, opts, depth + 1));
      if (problems.length > 20) break;
    }
  }
  return problems;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The names and types of a tool's arguments in one line: `path: string, depth?: number`. */
export function signature(inputSchema: unknown): string {
  if (!isObject(inputSchema) || !isObject(inputSchema.properties)) return "";
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
  return Object.entries(inputSchema.properties)
    .map(([name, s]) => {
      const t = isObject(s)
        ? Array.isArray(s.enum)
          ? s.enum.map((e) => JSON.stringify(e)).join("|")
          : typeof s.type === "string"
            ? s.type
            : Array.isArray(s.type)
              ? s.type.join("|")
              : "any"
        : "any";
      return `${name}${required.has(name) ? "" : "?"}: ${t}`;
    })
    .join(", ");
}
