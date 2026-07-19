// Converters from the plain JSON Schema objects in schemas.js into the
// vendor-specific shapes each AI provider's structured-output API expects.
// Pure functions — no fetch, no env — so they're unit tested directly.

// Gemini's REST `responseSchema` is an OpenAPI subset with UPPERCASE type
// enums (STRING/NUMBER/OBJECT/ARRAY/BOOLEAN) and no `additionalProperties`.
export function toGeminiSchema(schema) {
	if (schema == null || typeof schema !== 'object') return schema;
	const out = {};
	if (schema.type) out.type = String(schema.type).toUpperCase();
	if (schema.description) out.description = schema.description;
	if (schema.enum) out.enum = schema.enum;
	if (schema.properties) {
		out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]));
	}
	if (schema.items) out.items = toGeminiSchema(schema.items);
	if (schema.required) out.required = schema.required;
	return out;
}

// OpenAI's strict `json_schema` response format requires every object node to
// carry `additionalProperties: false` and a `required` array listing
// literally every key in `properties` (no optional fields allowed).
export function toOpenAiStrictSchema(schema) {
	if (schema == null || typeof schema !== 'object') return schema;
	const out = { ...schema };
	if (schema.properties) {
		out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toOpenAiStrictSchema(value)]));
		out.required = Object.keys(schema.properties);
		out.additionalProperties = false;
	}
	if (schema.items) out.items = toOpenAiStrictSchema(schema.items);
	return out;
}

// Groq's JSON-object mode enforces no schema at all, so instead we render a
// placeholder-value skeleton of the shape (e.g. {"prompt":"string"}) to embed
// in the prompt as a concrete example for the model to match.
export function schemaToExampleShape(schema) {
	if (schema == null || typeof schema !== 'object') return 'any';
	if (schema.type === 'object') {
		return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, schemaToExampleShape(value)]));
	}
	if (schema.type === 'array') return [schemaToExampleShape(schema.items || {})];
	return schema.type || 'any';
}
