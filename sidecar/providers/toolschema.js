/* sidecar/providers/toolschema.js — make a tool's JSON Schema safe for a strict provider wire.

   WHY THIS EXISTS: built-in StarNet tools hand-write small, tame schemas, but an MCP connector's
   `inputSchema` is authored by a third-party server. The official MCP TypeScript SDK builds schemas
   with zod-to-json-schema, so a real connector routinely ships `$schema`, `additionalProperties`,
   `$ref`/`$defs`, `anyOf` null-unions and `default` — all of which flow through mcp/translate.js and
   tools/registry.js `wireFormat()` verbatim. Gemini's functionDeclarations accepts only an
   OpenAPI-3.0 Schema subset and answers an unknown field with a 400 on EVERY turn, so one connector
   could take out every Gemini run. Anthropic is lenient about extra keywords but rejects a
   null-union at the root of `input_schema`.

   Two exports, one shared normalizer:
     normalize(schema)  -> repair hostile-but-standard shapes; keeps every other keyword.
                           Semantics-preserving for a well-formed schema. Used on the Anthropic wire.
     forGemini(schema)  -> normalize(), then prune to Gemini's documented Schema field set.

   Both are PURE and never mutate the input — a registry tool def is shared across runs and providers,
   so mutating it would corrupt the next request on a different adapter.

   Repairs performed by normalize():
     - local `$ref` (#/$defs/…, #/definitions/…, #/components/schemas/…) inlined from the root doc
     - nullable unions collapsed: {anyOf:[X,{type:'null'}]} -> X + nullable:true   (the Pydantic/zod shape)
     - `oneOf` -> `anyOf`; single-member `allOf` inlined
     - array `type` (["string","null"]) -> one string type + nullable
     - `const: X` -> `enum: [X]`
     - `required` filtered to names that actually exist in `properties`
   Cycles and runaway depth resolve to a permissive string node rather than throwing — a malformed
   schema must degrade the ONE tool, never wedge the run. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.providers = root.SK.providers || {}).toolschema = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // https://ai.google.dev/api/caching#Schema — the complete documented field set. Anything else
  // ("$schema", "additionalProperties", "$ref", "oneOf", "allOf", "const", "patternProperties",
  // "exclusiveMinimum", "multipleOf", "uniqueItems", "not", "if"/"then", "$defs", …) is an
  // "Unknown name" 400 from generativelanguage.googleapis.com.
  // `default` is documented but was a LATE addition to the subset, and a Gemini profile may carry a
  // custom baseUrl (proxy / older endpoint), so it is deliberately NOT on this list — the field is
  // advisory, never affects validation, and dropping it costs the model nothing a description can't say.
  const GEMINI_FIELDS = ['type', 'format', 'title', 'description', 'nullable', 'enum', 'items',
    'properties', 'required', 'propertyOrdering', 'example', 'anyOf',
    'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength',
    'minProperties', 'maxProperties', 'pattern'];

  const MAX_DEPTH = 24;                 // runaway/cyclic guard; real tool schemas nest <6
  const PERMISSIVE = { type: 'string' };  // what an unresolvable node degrades to

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /* Walk a local JSON-Pointer ("#/$defs/Foo") from the root document. Returns undefined for a
     remote/absolute ref — we never fetch, so a remote $ref degrades instead of hanging a run. */
  function pointerLookup(rootDoc, ref) {
    const s = String(ref || '');
    if (s.charAt(0) !== '#') return undefined;
    const parts = s.slice(1).split('/').filter(Boolean);
    let node = rootDoc;
    for (const raw of parts) {
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');   // RFC 6901 unescaping
      if (!isPlainObject(node) || !(key in node)) return undefined;
      node = node[key];
    }
    return isPlainObject(node) ? node : undefined;
  }

  /* Collapse a union down to a single branch when the union exists only to allow null — by far the
     most common MCP/Pydantic shape ({"anyOf":[{"type":"string"},{"type":"null"}]}). A genuine
     multi-type union is left alone as `anyOf`, which Gemini does support. */
  function collapseNullUnion(list) {
    const branches = list.filter(isPlainObject);
    const nonNull = branches.filter(b => b.type !== 'null');
    if (nonNull.length === branches.length) return { branches: branches, nullable: false };
    return { branches: nonNull, nullable: true };
  }

  function walk(node, rootDoc, depth, refPath) {
    if (depth > MAX_DEPTH) return Object.assign({}, PERMISSIVE);
    if (!isPlainObject(node)) return Object.assign({}, PERMISSIVE);   // e.g. additionalProperties:"object"

    // ---- $ref: inline from the root document, guarding against a self-referential chain ----------
    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (refPath.indexOf(ref) >= 0) return Object.assign({}, PERMISSIVE);   // cycle
      const target = pointerLookup(rootDoc, ref);
      if (!target) {
        const rest = Object.assign({}, node); delete rest.$ref;
        return Object.keys(rest).length ? walk(rest, rootDoc, depth + 1, refPath) : Object.assign({}, PERMISSIVE);
      }
      // Sibling keywords next to $ref (the `{"$ref":…, "default":null}` shape strict validators
      // reject) are merged onto the resolved target, with the target's own fields winning.
      const merged = Object.assign({}, node, target); delete merged.$ref;
      return walk(merged, rootDoc, depth + 1, refPath.concat([ref]));
    }

    const out = {};
    let nullable = node.nullable === true;

    for (const key of Object.keys(node)) {
      const val = node[key];
      switch (key) {
        case '$defs': case 'definitions':
          break;                                  // inlined at every use site; the bag itself is not a schema
        case 'nullable':
          break;                                  // folded in below so a union can also set it
        case 'const':
          out.enum = [val];                       // Gemini has no `const`; a 1-member enum is exact
          if (out.type === undefined && val !== null) out.type = typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string';
          break;
        case 'type':
          if (Array.isArray(val)) {               // ["string","null"] -> string + nullable
            const types = val.map(String).filter(t => t !== 'null');
            if (types.length !== val.length) nullable = true;
            out.type = types.length ? types[0] : 'string';
          } else if (val === 'null') {
            out.type = 'string'; nullable = true;
          } else if (val !== undefined) {
            out.type = val;
          }
          break;
        case 'properties': {
          if (!isPlainObject(val)) break;
          const props = {};
          for (const p of Object.keys(val)) props[p] = walk(val[p], rootDoc, depth + 1, refPath);
          out.properties = props;
          break;
        }
        case 'items':
          out.items = Array.isArray(val)
            ? walk(val[0], rootDoc, depth + 1, refPath)   // tuple typing has no Gemini equivalent
            : walk(val, rootDoc, depth + 1, refPath);
          break;
        case 'anyOf': case 'oneOf': {
          if (!Array.isArray(val) || !val.length) break;
          const c = collapseNullUnion(val);
          if (c.nullable) nullable = true;
          if (c.branches.length === 1) {                 // the nullable-optional case: inline the branch
            const only = walk(c.branches[0], rootDoc, depth + 1, refPath);
            for (const k of Object.keys(only)) if (out[k] === undefined) out[k] = only[k];
          } else if (c.branches.length) {
            out.anyOf = c.branches.map(b => walk(b, rootDoc, depth + 1, refPath));
          }
          break;
        }
        case 'allOf': {
          if (!Array.isArray(val) || !val.length) break;
          const merged = {};                              // shallow intersection is the honest approximation
          for (const m of val) if (isPlainObject(m)) Object.assign(merged, walk(m, rootDoc, depth + 1, refPath));
          for (const k of Object.keys(merged)) if (out[k] === undefined) out[k] = merged[k];
          break;
        }
        case 'additionalProperties':
          if (isPlainObject(val)) out.additionalProperties = walk(val, rootDoc, depth + 1, refPath);
          else if (val !== undefined) out.additionalProperties = val;   // normalize() keeps it; forGemini prunes it
          break;
        default:
          out[key] = val;
      }
    }

    if (nullable) out.nullable = true;
    // `required` naming a property that does not exist is an invalid schema some backends reject.
    if (Array.isArray(out.required)) {
      const known = isPlainObject(out.properties) ? out.properties : null;
      const kept = out.required.map(String).filter(r => !known || Object.prototype.hasOwnProperty.call(known, r));
      if (kept.length) out.required = kept; else delete out.required;
    }
    return out;
  }

  /* Repair hostile-but-standard constructs; every other keyword survives. */
  function normalize(schema) {
    if (!isPlainObject(schema)) return { type: 'object', properties: {} };
    return walk(schema, schema, 0, []);
  }

  function prune(node, depth) {
    if (!isPlainObject(node) || depth > MAX_DEPTH) return node;
    const out = {};
    for (const key of GEMINI_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      const val = node[key];
      if (key === 'properties' && isPlainObject(val)) {
        const props = {};
        for (const p of Object.keys(val)) props[p] = prune(val[p], depth + 1);
        out.properties = props;
      } else if (key === 'items') {
        out.items = prune(val, depth + 1);
      } else if (key === 'anyOf' && Array.isArray(val)) {
        out.anyOf = val.map(b => prune(b, depth + 1));
      } else {
        out[key] = val;
      }
    }
    return out;
  }

  /* normalize() + drop every field Gemini's Schema does not define. */
  function forGemini(schema) {
    const norm = normalize(schema);
    const out = prune(norm, 0);
    if (out.type === undefined && out.anyOf === undefined) out.type = 'object';
    return out;
  }

  /* Gemini rejects an OBJECT parameter schema whose `properties` is absent or empty
     ("should be non-empty for OBJECT type"), so a no-argument tool must omit `parameters`
     altogether rather than send `{type:'object',properties:{}}`. Both bridge-core's no-arg
     tools and plenty of MCP servers expose exactly that shape. */
  function isEmptyObjectSchema(schema) {
    if (!isPlainObject(schema)) return true;
    if (schema.type !== undefined && schema.type !== 'object') return false;
    if (Array.isArray(schema.anyOf) && schema.anyOf.length) return false;
    return !isPlainObject(schema.properties) || Object.keys(schema.properties).length === 0;
  }

  return { normalize, forGemini, isEmptyObjectSchema, _internals: { pointerLookup, collapseNullUnion, prune, GEMINI_FIELDS } };
});
