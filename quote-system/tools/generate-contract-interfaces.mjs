#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const JSON_SCHEMA_DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);
const ALLOWED_REQUEST_HEADERS = new Set(["idempotency-key", "if-match"]);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractError";
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new ContractError(message);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableUnique(values) {
  return [...new Set(values)];
}

function sha256(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

export function toPascalCase(value) {
  const pieces = String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const rendered = pieces.map((piece) => piece[0].toUpperCase() + piece.slice(1)).join("");
  const nonEmpty = rendered || "AnonymousSchema";
  return /^[A-Za-z_$]/.test(nonEmpty) ? nonEmpty : `Schema${nonEmpty}`;
}

function escapeComment(value) {
  return String(value).replaceAll("*/", "* /").replaceAll("\r", "").trim();
}

function annotationLines(schema) {
  const annotations = [];
  if (schema.description) annotations.push(escapeComment(schema.description));
  if (schema.format) annotations.push(`@format ${schema.format}`);
  if (schema.pattern) annotations.push(`@pattern ${schema.pattern}`);
  if (schema.minLength !== undefined) annotations.push(`@minLength ${schema.minLength}`);
  if (schema.maxLength !== undefined) annotations.push(`@maxLength ${schema.maxLength}`);
  if (schema.minimum !== undefined) annotations.push(`@minimum ${schema.minimum}`);
  if (schema.maximum !== undefined) annotations.push(`@maximum ${schema.maximum}`);
  if (schema.minItems !== undefined) annotations.push(`@minItems ${schema.minItems}`);
  if (schema.maxItems !== undefined) annotations.push(`@maxItems ${schema.maxItems}`);
  if (schema.uniqueItems === true) annotations.push("@uniqueItems true");
  return annotations;
}

function renderDoc(schema, indent = "") {
  const lines = annotationLines(schema);
  if (lines.length === 0) return [];
  return [
    `${indent}/**`,
    ...lines.map((line) => `${indent} * ${line}`),
    `${indent} */`,
  ];
}

function propertyName(name) {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function localDefinitionName(reference) {
  const prefix = "#/$defs/";
  assert(reference.startsWith(prefix), `external or unsupported JSON Schema reference: ${reference}`);
  const encoded = reference.slice(prefix.length);
  assert(encoded.length > 0 && !encoded.includes("/"), `unsupported nested JSON Schema reference: ${reference}`);
  return encoded.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function resolveJsonPointer(document, reference) {
  assert(reference.startsWith("#/"), `external JSON Schema reference is forbidden: ${reference}`);
  let value = document;
  for (const rawPart of reference.slice(2).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    assert(isObject(value) && Object.hasOwn(value, part), `unresolved JSON Schema reference: ${reference}`);
    value = value[part];
  }
  return value;
}

function walk(value, visit, path = "$") {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, `${path}[${index}]`));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      walk(child, visit, `${path}.${key}`);
    }
  }
}

export function lintJsonSchema(schema) {
  assert(isObject(schema), "JSON Schema root must be an object");
  assert(schema.$schema === JSON_SCHEMA_DRAFT_2020_12, "JSON Schema must use Draft 2020-12");
  assert(typeof schema.$id === "string" && schema.$id.length > 0, "JSON Schema must declare a stable $id");
  assert(isObject(schema.$defs) && Object.keys(schema.$defs).length > 0, "JSON Schema must declare non-empty $defs");
  assert(Array.isArray(schema.oneOf) && schema.oneOf.length > 0, "JSON Schema root must select document kinds with oneOf");

  walk(schema, (node, path) => {
    if (!isObject(node)) return;

    if (Object.hasOwn(node, "$ref")) {
      assert(typeof node.$ref === "string", `${path}.$ref must be a string`);
      resolveJsonPointer(schema, node.$ref);
    }

    if (Object.hasOwn(node, "enum")) {
      assert(Array.isArray(node.enum) && node.enum.length > 0, `${path}.enum must be non-empty`);
      const serialized = node.enum.map((value) => JSON.stringify(value));
      assert(serialized.length === new Set(serialized).size, `${path}.enum contains duplicate values`);
    }

    if (Object.hasOwn(node, "required")) {
      assert(Array.isArray(node.required), `${path}.required must be an array`);
      assert(node.required.length === new Set(node.required).size, `${path}.required contains duplicates`);
      assert(isObject(node.properties), `${path}.required requires an object properties map`);
      for (const name of node.required) {
        assert(Object.hasOwn(node.properties, name), `${path}.required names missing property ${name}`);
      }
    }

    if (node.type === "object" && isObject(node.properties)) {
      assert(node.additionalProperties === false, `${path} must set additionalProperties=false`);
    }

    for (const keyword of ["oneOf", "anyOf", "allOf"]) {
      if (Object.hasOwn(node, keyword)) {
        assert(Array.isArray(node[keyword]) && node[keyword].length > 0, `${path}.${keyword} must be non-empty`);
      }
    }
  });

  const exportedNames = Object.keys(schema.$defs).map(toPascalCase);
  assert(exportedNames.length === new Set(exportedNames).size, "JSON Schema definition names collide after TypeScript normalization");

  const documents = schema.oneOf.map((choice, index) => {
    assert(isObject(choice) && typeof choice.$ref === "string", `$.oneOf[${index}] must be a local $ref`);
    const definition = localDefinitionName(choice.$ref);
    const documentSchema = resolveJsonPointer(schema, choice.$ref);
    assert(isObject(documentSchema), `document definition ${definition} must be an object`);
    assert(documentSchema.type === "object", `document definition ${definition} must have type=object`);
    assert(isObject(documentSchema.properties), `document definition ${definition} must declare properties`);
    assert(typeof documentSchema.properties.schema?.const === "string", `${definition}.schema must be a string const`);
    assert(
      typeof documentSchema.properties.document_type?.const === "string",
      `${definition}.document_type must be a string const`,
    );
    const required = new Set(documentSchema.required ?? []);
    assert(required.has("schema") && required.has("document_type"), `${definition} must require schema and document_type`);
    return {
      definition,
      schema: documentSchema.properties.schema.const,
      documentType: documentSchema.properties.document_type.const,
    };
  });

  const schemaIds = documents.map((document) => document.schema);
  const documentTypes = documents.map((document) => document.documentType);
  assert(schemaIds.length === new Set(schemaIds).size, "document schema discriminators must be unique");
  assert(documentTypes.length === new Set(documentTypes).size, "document_type discriminators must be unique");

  return {
    definitions: Object.keys(schema.$defs),
    documents,
  };
}

function renderLiteral(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return JSON.stringify(value);
  return "unknown";
}

function renderObjectType(schema, level) {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const indent = "  ".repeat(level);
  const childIndent = "  ".repeat(level + 1);
  const lines = ["{"];
  for (const [name, propertySchema] of Object.entries(properties)) {
    lines.push(...renderDoc(propertySchema, childIndent));
    const optional = required.has(name) ? "" : "?";
    lines.push(`${childIndent}readonly ${propertyName(name)}${optional}: ${renderSchemaType(propertySchema, level + 1)};`);
  }
  if (schema.additionalProperties === true) {
    lines.push(`${childIndent}readonly [key: string]: unknown;`);
  } else if (isObject(schema.additionalProperties)) {
    lines.push(
      `${childIndent}readonly [key: string]: ${renderSchemaType(schema.additionalProperties, level + 1)};`,
    );
  }
  lines.push(`${indent}}`);
  return lines.join("\n");
}

function parenthesizeForArray(type) {
  return type.includes(" | ") || type.includes(" & ") ? `(${type})` : type;
}

export function renderSchemaType(schema, level = 0) {
  assert(isObject(schema), "schema node must be an object");
  if (typeof schema.$ref === "string") {
    return toPascalCase(localDefinitionName(schema.$ref));
  }
  if (Object.hasOwn(schema, "const")) {
    return renderLiteral(schema.const);
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map(renderLiteral).join(" | ");
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map((choice) => renderSchemaType(choice, level)).join(" | ");
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map((choice) => renderSchemaType(choice, level)).join(" | ");
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.map((choice) => renderSchemaType(choice, level)).join(" & ");
  }
  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => renderSchemaType({ ...schema, type }, level)).join(" | ");
  }

  switch (schema.type) {
    case "object":
      return renderObjectType(schema, level);
    case "array": {
      const itemType = isObject(schema.items) ? renderSchemaType(schema.items, level) : "unknown";
      return `ReadonlyArray<${parenthesizeForArray(itemType)}>`;
    }
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      if (isObject(schema.properties)) return renderObjectType({ ...schema, type: "object" }, level);
      return "unknown";
  }
}

export function emitPayloadTypes(schema) {
  const summary = lintJsonSchema(schema);
  const lines = [
    "/* eslint-disable */",
    "/**",
    " * GENERATED FILE — DO NOT EDIT.",
    " * Source authority: contracts/commercial-intake.schema.json (JSON Schema Draft 2020-12).",
    " * Runtime validators must still enforce the constraints recorded in JSDoc annotations.",
    " */",
    "",
  ];

  for (const [name, definition] of Object.entries(schema.$defs)) {
    const typeName = toPascalCase(name);
    lines.push(...renderDoc(definition));
    if (definition.type === "object" && isObject(definition.properties)) {
      const body = renderObjectType(definition, 0);
      lines.push(`export interface ${typeName} ${body}`);
    } else {
      lines.push(`export type ${typeName} = ${renderSchemaType(definition)};`);
    }
    lines.push("");
  }

  lines.push("export type CommercialIntakeDocument =");
  summary.documents.forEach((document, index) => {
    const suffix = index === summary.documents.length - 1 ? ";" : "";
    lines.push(`  | ${toPascalCase(document.definition)}${suffix}`);
  });
  lines.push("");
  lines.push("export const commercialIntakeDocumentKinds = {");
  for (const document of summary.documents) {
    lines.push(
      `  ${JSON.stringify(document.documentType)}: ${JSON.stringify(document.schema)},`,
    );
  }
  lines.push("} as const;");
  lines.push("");

  return lines.join("\n");
}

function resolveOpenApiNode(openapi, value) {
  if (!isObject(value) || typeof value.$ref !== "string") return value;
  assert(value.$ref.startsWith("#/"), `external OpenAPI reference is forbidden: ${value.$ref}`);
  return resolveJsonPointer(openapi, value.$ref);
}

function openApiParameters(openapi, pathItem, operation) {
  const combined = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
  return combined.map((parameter) => resolveOpenApiNode(openapi, parameter));
}

function schemaRefs(schema, refs = new Set()) {
  if (Array.isArray(schema)) {
    schema.forEach((item) => schemaRefs(item, refs));
  } else if (isObject(schema)) {
    if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/components/schemas/")) {
      refs.add(schema.$ref.slice("#/components/schemas/".length));
    }
    Object.values(schema).forEach((value) => schemaRefs(value, refs));
  }
  return [...refs].sort();
}

function jsonContentSchema(container) {
  if (!isObject(container?.content)) return undefined;
  return container.content["application/json"]?.schema;
}

function operationRequestSchemas(openapi, operation) {
  if (!operation.requestBody) return [];
  const requestBody = resolveOpenApiNode(openapi, operation.requestBody);
  return schemaRefs(jsonContentSchema(requestBody));
}

function operationResponseSchemas(openapi, operation, successStatuses) {
  const refs = new Set();
  for (const status of successStatuses) {
    const response = resolveOpenApiNode(openapi, operation.responses[status]);
    schemaRefs(jsonContentSchema(response), refs);
  }
  return [...refs].sort();
}

function operationAudience(path) {
  return path.startsWith("/v1/admin/") || path === "/v1/admin" ? "admin" : "public";
}

export function lintOpenApi(openapi) {
  assert(isObject(openapi), "OpenAPI root must be an object");
  assert(typeof openapi.openapi === "string" && /^3\./.test(openapi.openapi), "OpenAPI document must use version 3.x");
  assert(typeof openapi.info?.title === "string" && openapi.info.title.length > 0, "OpenAPI info.title is required");
  assert(isObject(openapi.paths) && Object.keys(openapi.paths).length > 0, "OpenAPI paths must be non-empty");

  const operations = [];
  const operationIds = new Set();

  for (const path of Object.keys(openapi.paths).sort()) {
    assert(path.startsWith("/v1/"), `API path must be explicitly versioned under /v1/: ${path}`);
    assert(!path.includes("?"), `query-string routing is forbidden in API path: ${path}`);
    const pathItem = resolveOpenApiNode(openapi, openapi.paths[path]);
    assert(isObject(pathItem), `OpenAPI path item must be an object: ${path}`);

    for (const method of Object.keys(pathItem).filter((key) => HTTP_METHODS.has(key)).sort()) {
      const operation = pathItem[method];
      assert(isObject(operation), `${method.toUpperCase()} ${path} operation must be an object`);
      assert(
        typeof operation.operationId === "string" && operation.operationId.trim().length > 0,
        `${method.toUpperCase()} ${path} must have operationId`,
      );
      assert(!operationIds.has(operation.operationId), `duplicate OpenAPI operationId: ${operation.operationId}`);
      operationIds.add(operation.operationId);

      const parameters = openApiParameters(openapi, pathItem, operation);
      const headerNames = [];
      const pathParameterNames = new Set();
      for (const parameter of parameters) {
        assert(isObject(parameter), `${operation.operationId} has an invalid parameter`);
        assert(typeof parameter.in === "string", `${operation.operationId} parameter ${parameter.name ?? "?"} lacks in`);
        if (parameter.in === "query") {
          throw new ContractError(`${operation.operationId} uses forbidden query-parameter routing: ${parameter.name}`);
        }
        if (parameter.in === "header") {
          const normalized = String(parameter.name).toLowerCase();
          assert(
            ALLOWED_REQUEST_HEADERS.has(normalized),
            `${operation.operationId} uses unsupported routing/header parameter: ${parameter.name}`,
          );
          assert(parameter.required === true, `${operation.operationId} header ${parameter.name} must be required`);
          headerNames.push(String(parameter.name));
        }
        if (parameter.in === "path") {
          assert(parameter.required === true, `${operation.operationId} path parameter ${parameter.name} must be required`);
          pathParameterNames.add(String(parameter.name));
        }
      }

      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
      assert(
        JSON.stringify(placeholders) === JSON.stringify([...pathParameterNames].sort()),
        `${operation.operationId} path placeholders do not match declared path parameters`,
      );

      const normalizedHeaders = new Set(headerNames.map((name) => name.toLowerCase()));
      if (WRITE_METHODS.has(method)) {
        assert(
          normalizedHeaders.has("idempotency-key"),
          `${operation.operationId} write operation must require Idempotency-Key`,
        );
      }
      if (method === "patch" || method === "put" || method === "delete" || (method === "post" && path.includes("/{"))) {
        assert(normalizedHeaders.has("if-match"), `${operation.operationId} transition/update must require If-Match`);
      }

      if (operation.requestBody) {
        const requestBody = resolveOpenApiNode(openapi, operation.requestBody);
        assert(requestBody.required === true, `${operation.operationId} request body must be required`);
        assert(
          isObject(requestBody.content) && isObject(requestBody.content["application/json"]),
          `${operation.operationId} request body must declare application/json`,
        );
      }

      assert(isObject(operation.responses), `${operation.operationId} must declare responses`);
      const statuses = Object.keys(operation.responses);
      const successStatuses = statuses.filter((status) => /^2\d\d$/.test(status)).sort();
      const errorStatuses = statuses.filter((status) => /^[45]\d\d$/.test(status) || status === "default").sort();
      assert(successStatuses.length > 0, `${operation.operationId} must declare a success response`);
      assert(errorStatuses.length > 0, `${operation.operationId} must declare an error response`);

      operations.push({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path,
        audience: operationAudience(path),
        requiredHeaders: stableUnique(headerNames).sort((a, b) => a.localeCompare(b)),
        requestSchemas: operationRequestSchemas(openapi, operation),
        successResponseSchemas: operationResponseSchemas(openapi, operation, successStatuses),
        successStatuses,
        errorStatuses,
      });
    }
  }

  assert(operations.some((operation) => operation.path === "/v1/pre-interest"), "OpenAPI must expose /v1/pre-interest");
  assert(operations.some((operation) => operation.path === "/v1/admin/quotes"), "OpenAPI must expose /v1/admin/quotes");
  assert(operations.some((operation) => operation.audience === "public"), "OpenAPI must contain public operations");
  assert(operations.some((operation) => operation.audience === "admin"), "OpenAPI must contain admin operations");

  return operations;
}

export function emitApiOperations(openapi) {
  const operations = lintOpenApi(openapi);
  const lines = [
    "/* eslint-disable */",
    "/**",
    " * GENERATED FILE — DO NOT EDIT.",
    " * Source authority: contracts/main.tsp via the @typespec/openapi3 JSON emitter.",
    " * Query-parameter and custom-header routing are intentionally rejected by the generator.",
    " */",
    "",
    'export type ApiAudience = "public" | "admin";',
    'export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "TRACE";',
    "",
    "export interface ApiOperationDescriptor {",
    "  readonly method: HttpMethod;",
    "  readonly path: `/v1/${string}`;",
    "  readonly audience: ApiAudience;",
    "  readonly requiredHeaders: ReadonlyArray<string>;",
    "  readonly requestSchemas: ReadonlyArray<string>;",
    "  readonly successResponseSchemas: ReadonlyArray<string>;",
    "  readonly successStatuses: ReadonlyArray<string>;",
    "  readonly errorStatuses: ReadonlyArray<string>;",
    "}",
    "",
    "export const apiOperations = {",
  ];

  for (const operation of operations) {
    lines.push(`  ${JSON.stringify(operation.operationId)}: {`);
    lines.push(`    method: ${JSON.stringify(operation.method)},`);
    lines.push(`    path: ${JSON.stringify(operation.path)},`);
    lines.push(`    audience: ${JSON.stringify(operation.audience)},`);
    lines.push(`    requiredHeaders: ${JSON.stringify(operation.requiredHeaders)},`);
    lines.push(`    requestSchemas: ${JSON.stringify(operation.requestSchemas)},`);
    lines.push(`    successResponseSchemas: ${JSON.stringify(operation.successResponseSchemas)},`);
    lines.push(`    successStatuses: ${JSON.stringify(operation.successStatuses)},`);
    lines.push(`    errorStatuses: ${JSON.stringify(operation.errorStatuses)},`);
    lines.push("  },");
  }
  lines.push("} as const satisfies Readonly<Record<string, ApiOperationDescriptor>>;");
  lines.push("");
  lines.push("export type ApiOperationId = keyof typeof apiOperations;");
  lines.push("");
  return lines.join("\n");
}

export function buildManifest({ schema, schemaBytes, openapi, openapiBytes }) {
  const schemaSummary = lintJsonSchema(schema);
  const operations = lintOpenApi(openapi);
  return {
    format: "fiducia.contract-generation-manifest.v1",
    jsonSchema: {
      id: schema.$id,
      draft: schema.$schema,
      sha256: sha256(schemaBytes),
      definitions: schemaSummary.definitions,
      documents: schemaSummary.documents,
    },
    openapi: {
      title: openapi.info.title,
      version: openapi.openapi,
      sha256: sha256(openapiBytes),
      operations,
    },
  };
}

async function writeReadonly(path, content) {
  try {
    await chmod(path, 0o644);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(path, content, { encoding: "utf8", mode: 0o444 });
  await chmod(path, 0o444);
}

function parseArguments(argv) {
  const argumentsByName = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    assert(token.startsWith("--"), `unexpected argument: ${token}`);
    if (token === "--check") {
      flags.add(token);
      continue;
    }
    const value = argv[index + 1];
    assert(value && !value.startsWith("--"), `missing value for ${token}`);
    argumentsByName.set(token, value);
    index += 1;
  }
  const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  return {
    schemaPath: resolve(argumentsByName.get("--schema") ?? `${projectRoot}/contracts/commercial-intake.schema.json`),
    openapiPath: resolve(
      argumentsByName.get("--openapi") ?? `${projectRoot}/tsp-output/openapi3/fiducia-commercial-intake.openapi.json`,
    ),
    outputDirectory: resolve(argumentsByName.get("--output-dir") ?? `${projectRoot}/generated`),
    checkOnly: flags.has("--check"),
  };
}

export async function generateArtifacts({ schemaPath, openapiPath, outputDirectory, checkOnly = false }) {
  const [schemaBytes, openapiBytes] = await Promise.all([readFile(schemaPath), readFile(openapiPath)]);
  const schema = JSON.parse(schemaBytes.toString("utf8"));
  const openapi = JSON.parse(openapiBytes.toString("utf8"));

  const payloadTypes = emitPayloadTypes(schema);
  const apiOperations = emitApiOperations(openapi);
  const manifest = `${JSON.stringify(buildManifest({ schema, schemaBytes, openapi, openapiBytes }), null, 2)}\n`;

  assert(payloadTypes.includes("export type CommercialIntakeDocument"), "payload interface generation produced no root union");
  assert(apiOperations.includes("export const apiOperations"), "API operation generation produced no operation map");

  if (!checkOnly) {
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all([
      writeReadonly(resolve(outputDirectory, "payload-types.ts"), payloadTypes),
      writeReadonly(resolve(outputDirectory, "api-operations.ts"), apiOperations),
      writeReadonly(resolve(outputDirectory, "contract-manifest.json"), manifest),
    ]);
  }

  return {
    schemaPath,
    openapiPath,
    outputDirectory,
    files: ["payload-types.ts", "api-operations.ts", "contract-manifest.json"],
    checkOnly,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await generateArtifacts(options);
  const action = result.checkOnly ? "validated" : "generated";
  console.log(
    `${action} Fiducia contract artifacts from ${basename(result.schemaPath)} and ${basename(result.openapiPath)}: ${result.files.join(", ")}`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
