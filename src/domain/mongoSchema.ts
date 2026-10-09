import { z } from "zod";

type Json = Record<string, unknown>;

const TYPE_TO_BSON: Record<string, string> = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "bool",
  object: "object",
  array: "array",
  null: "null",
};

// Converts Zod's JSON Schema output into MongoDB's $jsonSchema dialect.
export function toMongoJsonSchema(schema: z.ZodType): Json {
  const js = z.toJSONSchema(schema, {
    unrepresentable: "any",
    override: (ctx) => {
      if (ctx.zodSchema._zod.def.type === "date") ctx.jsonSchema["x-bson"] = "date";
    },
  }) as Json;
  delete js.$schema;
  return allowId(convert(js));
}

function convert(node: unknown): Json {
  if (!node || typeof node !== "object") return {};
  const src = node as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(src)) {
    switch (key) {
      case "x-bson":
        out.bsonType = value;
        break;
      case "type":
        out.bsonType = Array.isArray(value)
          ? value.map((t) => TYPE_TO_BSON[t as string] ?? t)
          : (TYPE_TO_BSON[value as string] ?? value);
        break;
      case "const":
        out.enum = [value];
        break;
      case "properties":
        out.properties = Object.fromEntries(
          Object.entries(value as Json).map(([k, v]) => [k, convert(v)]),
        );
        break;
      case "items":
        out.items = convert(value);
        break;
      case "anyOf":
      case "oneOf":
      case "allOf":
        out[key] = (value as unknown[]).map(convert);
        break;
      case "additionalProperties":
        out.additionalProperties = typeof value === "boolean" ? value : convert(value);
        break;
      // MongoDB uses draft-4 semantics: exclusive bounds are booleans paired with minimum/maximum.
      case "exclusiveMinimum":
        out.minimum = value;
        out.exclusiveMinimum = true;
        break;
      case "exclusiveMaximum":
        out.maximum = value;
        out.exclusiveMaximum = true;
        break;
      case "required":
      case "enum":
      case "minimum":
      case "maximum":
      case "minLength":
      case "maxLength":
      case "pattern":
      case "minItems":
      case "maxItems":
      case "description":
        out[key] = value;
        break;
      default:
        // Keywords MongoDB does not support (format, $defs, ...) are dropped.
        break;
    }
  }
  return out;
}

// Documents always carry _id; allow it at the root of each object branch.
function allowId(root: Json): Json {
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(root[key])) {
      root[key] = (root[key] as Json[]).map(allowId);
      return root;
    }
  }
  if (root.bsonType === "object" && root.properties) {
    const props = root.properties as Json;
    if (!props._id) props._id = {};
  }
  return root;
}
