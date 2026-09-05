import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ContractError,
  emitApiOperations,
  emitPayloadTypes,
  generateArtifacts,
  lintJsonSchema,
  lintOpenApi,
  toPascalCase,
} from "./generate-contract-interfaces.mjs";

function schemaFixture() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://example.invalid/widget.schema.json",
    oneOf: [{ $ref: "#/$defs/widget" }],
    $defs: {
      opaqueId: {
        type: "string",
        pattern: "^[A-Za-z0-9_-]{16,128}$",
      },
      widget: {
        type: "object",
        required: ["schema", "document_type", "widget_id", "display_name"],
        properties: {
          schema: { const: "example.widget.v1" },
          document_type: { const: "widget" },
          widget_id: { $ref: "#/$defs/opaqueId" },
          display_name: { type: "string", minLength: 1, maxLength: 100 },
          labels: { type: "array", uniqueItems: true, items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
  };
}

function openApiFixture() {
  const errors = {
    "400": { description: "Bad request" },
  };
  return {
    openapi: "3.0.0",
    info: { title: "Widget API", version: "1.0.0" },
    paths: {
      "/v1/pre-interest": {
        post: {
          operationId: "PreInterestOperations_create",
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PreInterestRequest" },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PreInterestReceipt" },
                },
              },
            },
            ...errors,
          },
        },
      },
      "/v1/admin/quotes": {
        post: {
          operationId: "AdminQuoteOperations_createVersion",
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/QuoteDocument" },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/QuoteDocument" },
                },
              },
            },
            ...errors,
          },
        },
      },
      "/v1/applications/{applicationId}": {
        patch: {
          operationId: "ApplicationOperations_update",
          parameters: [
            {
              name: "applicationId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "If-Match",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "Idempotency-Key",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ApplicationPatch" },
              },
            },
          },
          responses: {
            "200": {
              description: "Updated",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ApplicationDocument" },
                },
              },
            },
            ...errors,
          },
        },
      },
    },
    components: {
      schemas: {
        PreInterestRequest: { type: "object" },
        PreInterestReceipt: { type: "object" },
        QuoteDocument: { type: "object" },
        ApplicationPatch: { type: "object" },
        ApplicationDocument: { type: "object" },
      },
    },
  };
}

test("normalizes definition names deterministically", () => {
  assert.equal(toPascalCase("preInterest"), "PreInterest");
  assert.equal(toPascalCase("contract-acceptance"), "ContractAcceptance");
  assert.equal(toPascalCase("api_operation"), "ApiOperation");
  assert.equal(toPascalCase("3fa-policy"), "Schema3faPolicy");
});

test("validates Draft 2020-12 discriminators and emits annotated wire interfaces", () => {
  const schema = schemaFixture();
  const summary = lintJsonSchema(schema);
  assert.deepEqual(summary.documents, [
    { definition: "widget", schema: "example.widget.v1", documentType: "widget" },
  ]);

  const output = emitPayloadTypes(schema);
  assert.match(output, /export interface Widget \{/);
  assert.match(output, /readonly widget_id: OpaqueId;/);
  assert.match(output, /readonly labels\?: ReadonlyArray<string>;/);
  assert.match(output, /@minLength 1/);
  assert.match(output, /export type CommercialIntakeDocument =\n  \| Widget;/);
});

test("rejects unresolved references and open object payloads", () => {
  const unresolved = schemaFixture();
  unresolved.$defs.widget.properties.widget_id = { $ref: "#/$defs/missing" };
  assert.throws(() => lintJsonSchema(unresolved), ContractError);

  const openObject = schemaFixture();
  delete openObject.$defs.widget.additionalProperties;
  assert.throws(() => lintJsonSchema(openObject), /additionalProperties=false/);
});

test("lints TypeSpec-generated OpenAPI and emits operation declarations", () => {
  const openapi = openApiFixture();
  const operations = lintOpenApi(openapi);
  assert.equal(operations.length, 3);
  assert.equal(operations.find((item) => item.path === "/v1/admin/quotes").audience, "admin");

  const output = emitApiOperations(openapi);
  assert.match(output, /PreInterestOperations_create/);
  assert.match(output, /requestSchemas: \["PreInterestRequest"\]/);
  assert.match(output, /requiredHeaders: \["Idempotency-Key"\]/);
});

test("rejects routing through query parameters or arbitrary headers", () => {
  const queryRouting = openApiFixture();
  queryRouting.paths["/v1/pre-interest"].post.parameters.push({
    name: "region",
    in: "query",
    required: false,
    schema: { type: "string" },
  });
  assert.throws(() => lintOpenApi(queryRouting), /query-parameter routing/);

  const headerRouting = openApiFixture();
  headerRouting.paths["/v1/pre-interest"].post.parameters.push({
    name: "X-Route-To",
    in: "header",
    required: true,
    schema: { type: "string" },
  });
  assert.throws(() => lintOpenApi(headerRouting), /unsupported routing\/header parameter/);
});

test("rejects writes without idempotency and updates without preconditions", () => {
  const missingIdempotency = openApiFixture();
  missingIdempotency.paths["/v1/pre-interest"].post.parameters = [];
  assert.throws(() => lintOpenApi(missingIdempotency), /must require Idempotency-Key/);

  const missingIfMatch = openApiFixture();
  missingIfMatch.paths["/v1/applications/{applicationId}"].patch.parameters =
    missingIfMatch.paths["/v1/applications/{applicationId}"].patch.parameters.filter(
      (parameter) => parameter.name !== "If-Match",
    );
  assert.throws(() => lintOpenApi(missingIfMatch), /must require If-Match/);
});

test("writes deterministic read-only artifacts and supports validation-only mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fiducia-contract-generation-"));
  const schemaPath = join(directory, "schema.json");
  const openapiPath = join(directory, "openapi.json");
  const outputDirectory = join(directory, "generated");
  await writeFile(schemaPath, `${JSON.stringify(schemaFixture(), null, 2)}\n`);
  await writeFile(openapiPath, `${JSON.stringify(openApiFixture(), null, 2)}\n`);

  await generateArtifacts({ schemaPath, openapiPath, outputDirectory });
  const payload = await readFile(join(outputDirectory, "payload-types.ts"), "utf8");
  const manifest = JSON.parse(await readFile(join(outputDirectory, "contract-manifest.json"), "utf8"));
  const mode = (await stat(join(outputDirectory, "payload-types.ts"))).mode & 0o777;

  assert.match(payload, /GENERATED FILE — DO NOT EDIT/);
  assert.equal(manifest.format, "fiducia.contract-generation-manifest.v1");
  assert.equal(mode, 0o444);

  const checkDirectory = join(directory, "check-only");
  await generateArtifacts({ schemaPath, openapiPath, outputDirectory: checkDirectory, checkOnly: true });
  await assert.rejects(() => stat(checkDirectory), /ENOENT/);
});
