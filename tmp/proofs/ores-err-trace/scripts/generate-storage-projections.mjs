#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const i = arg.indexOf('=');
  if (i > 0) args.set(arg.slice(0, i), arg.slice(i + 1));
  else args.set(arg, true);
}

const irPath = resolve(String(args.get('--contract-ir') || '.typespec-json-schema-validator/contract-ir.json'));
const outDir = resolve(String(args.get('--out') || 'generated/storage'));
const check = args.has('--check');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const q = (value) => `"${String(value).replaceAll('"', '""')}"`;

function fail(message) {
  throw new Error(`ores-err-trace storage projection: ${message}`);
}

const irRaw = await readFile(irPath, 'utf8');
const ir = JSON.parse(irRaw);
if (ir.schema !== 'ores.typespec-json-schema-validator.contract-ir/v1') fail('unsupported Contract IR schema');
if (ir.status !== 'passed' || ir.admissible !== true) fail('Contract IR is not parity-admissible');
if (!Array.isArray(ir.declarations)) fail('Contract IR declarations are missing');

function declarationName(d) {
  return d?.name || d?.qualifiedName || d?.identity || d?.typeSpec?.qualifiedName || d?.typeSpec?.name || d?.id || '';
}
function findDecl(suffix) {
  const found = ir.declarations.find((d) => String(declarationName(d)).endsWith(suffix));
  if (!found?.assertionSchema || found.assertionSchema.type !== 'object') fail(`missing ${suffix} declaration`);
  return found;
}

const errorEvent = findDecl('ErrorEvent');
const envelope = findDecl('FingerprintEnvelope');
const dedupe = findDecl('DedupeRecordResult');

function deref(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.$ref?.endsWith('/FingerprintPolicy') || schema.$ref === '#/$defs/FingerprintPolicy') {
    return { type: 'string', enum: ['v1', 'dd-next-compat-v2'] };
  }
  return schema;
}

function sqlType(name, schema) {
  schema = deref(schema);
  if (name === 'id' || name.endsWith('_id')) return 'uuid';
  if (name.endsWith('_at')) return 'timestamptz';
  if (schema?.type === 'integer') return 'bigint';
  if (schema?.type === 'boolean') return 'boolean';
  if (schema?.type === 'array' || schema?.type === 'object') return 'jsonb';
  return 'text';
}
function dieselType(name, schema) {
  return ({ uuid: 'Uuid', timestamptz: 'Timestamptz', bigint: 'BigInt', boolean: 'Bool', jsonb: 'Jsonb', text: 'Text' })[sqlType(name, schema)];
}
function seaType(name, schema) {
  return ({ uuid: 'Uuid', timestamptz: 'DateTimeWithTime', bigint: 'BigInt', boolean: 'Boolean', jsonb: 'Json', text: 'Text' })[sqlType(name, schema)];
}

const eventRequired = new Set(errorEvent.assertionSchema.required || []);
const eventProps = errorEvent.assertionSchema.properties || {};
const envelopeRequired = new Set(envelope.assertionSchema.required || []);
const envelopeProps = envelope.assertionSchema.properties || {};
const dedupeProps = dedupe.assertionSchema.properties || {};

const eventColumns = [
  ['id', { type: 'string' }, true],
  ['policy', envelopeProps.policy || { type: 'string' }, envelopeRequired.has('policy')],
  ['fingerprint', envelopeProps.fingerprint || { type: 'string' }, envelopeRequired.has('fingerprint')],
  ...Object.entries(eventProps).map(([name, schema]) => [name, schema, eventRequired.has(name)]),
  ['occurred_at', { type: 'string' }, true],
];
const fingerprintColumns = [
  ['id', { type: 'string' }, true],
  ['policy', envelopeProps.policy || { type: 'string' }, true],
  ['fingerprint', envelopeProps.fingerprint || { type: 'string' }, true],
  ['service', envelopeProps.service || { type: 'string' }, true],
  ['occurrence_count', dedupeProps.occurrence_count || { type: 'integer' }, true],
  ['first_seen_at', dedupeProps.first_seen_at || { type: 'string' }, true],
  ['last_seen_at', dedupeProps.last_seen_at || { type: 'string' }, true],
];

const unique = (cols) => {
  const seen = new Set();
  return cols.filter(([name]) => !seen.has(name) && seen.add(name));
};
const events = unique(eventColumns);
const fingerprints = unique(fingerprintColumns);

function sqlColumn([name, schema, required]) {
  const type = sqlType(name, schema);
  const parts = [`  ${q(name)} ${type}`];
  if (name === 'id') parts.push('primary key default gen_random_uuid()');
  else if (name === 'occurred_at' || name === 'first_seen_at' || name === 'last_seen_at') parts.push('not null default now()');
  else if (name === 'occurrence_count') parts.push('not null default 1');
  else if (schema?.type === 'array') parts.push(`not null default '[]'::jsonb`);
  else if (required) parts.push('not null');
  if (name === 'policy') parts.push("check (policy in ('v1','dd-next-compat-v2'))");
  if (name === 'fingerprint') parts.push("check (fingerprint ~ '^[0-9a-f]{64}$|^dd-next-compat-v2:[0-9a-f]{64}$')");
  if (name === 'service') parts.push("check (length(service) between 1 and 256)");
  return parts.join(' ');
}

const sql = `-- GENERATED. DO NOT EDIT.\n-- Source: parity-admissible TypeSpec + JSON Schema Contract IR from ORESoftware/ores-err-trace.\n-- contract_ir_id=${ir.irId}\n\ncreate extension if not exists pgcrypto;\n\ncreate table if not exists public.ores_err_trace_fingerprints (\n${fingerprints.map(sqlColumn).join(',\n')},\n  unique (policy, fingerprint, service)\n);\n\ncreate table if not exists public.ores_err_trace_events (\n${events.map(sqlColumn).join(',\n')},\n  foreign key (policy, fingerprint, service) references public.ores_err_trace_fingerprints(policy, fingerprint, service) on update cascade on delete restrict\n);\n\ncreate index if not exists ores_err_trace_events_service_time_idx on public.ores_err_trace_events(service, occurred_at desc);\ncreate index if not exists ores_err_trace_events_trace_idx on public.ores_err_trace_events(trace_id) where trace_id is not null;\ncreate index if not exists ores_err_trace_events_repo_idx on public.ores_err_trace_events(repository, occurred_at desc) where repository is not null;\n\ndo $ores$\nbegin\n  if exists (select 1 from pg_roles where rolname = 'anon')\n     and exists (select 1 from pg_roles where rolname = 'authenticated') then\n    alter table public.ores_err_trace_fingerprints enable row level security;\n    alter table public.ores_err_trace_events enable row level security;\n    revoke all on table public.ores_err_trace_fingerprints from anon, authenticated;\n    revoke all on table public.ores_err_trace_events from anon, authenticated;\n  end if;\nend $ores$;\n\ncomment on table public.ores_err_trace_events is 'Generated from ORESoftware/ores-err-trace parity-admitted contracts; direct client access is denied by default.';\ncomment on table public.ores_err_trace_fingerprints is 'Generated dedupe projection for ORESoftware/ores-err-trace.';\n`;

function dieselTable(name, cols) {
  const lines = cols.map(([col, schema, required]) => {
    let t = dieselType(col, schema);
    if (!required && col !== 'id' && !col.endsWith('_at') && schema?.type !== 'array') t = `Nullable<${t}>`;
    return `        ${col} -> ${t},`;
  });
  return `diesel::table! {\n    ${name} (id) {\n${lines.join('\n')}\n    }\n}`;
}
const diesel = `// GENERATED. DO NOT EDIT. contract_ir_id=${ir.irId}\n${dieselTable('ores_err_trace_fingerprints', fingerprints)}\n\n${dieselTable('ores_err_trace_events', events)}\n\n// The database relation is composite: (policy, fingerprint, service).\n// Diesel joinable! models a single-column foreign key, so generation intentionally\n// does not emit a lossy joinable! declaration. Consumers join explicitly on all\n// three columns or use a generated query helper in their ORM layer.\ndiesel::allow_tables_to_appear_in_same_query!(ores_err_trace_events, ores_err_trace_fingerprints);\n`;

function seaField([name, schema, required]) {
  let ty = ({ Uuid: 'Uuid', DateTimeWithTime: 'DateTimeWithTime', BigInt: 'i64', Boolean: 'bool', Json: 'Json', Text: 'String' })[seaType(name, schema)];
  if (!required && name !== 'id' && !name.endsWith('_at') && schema?.type !== 'array') ty = `Option<${ty}>`;
  const attrs = name === 'id' ? '#[sea_orm(primary_key, auto_increment = false)]\n    ' : '';
  return `    ${attrs}pub ${name}: ${ty},`;
}
function seaEntity(moduleName, tableName, cols) {
  return `pub mod ${moduleName} {\n    use sea_orm::entity::prelude::*;\n    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]\n    #[sea_orm(table_name = "${tableName}")]\n    pub struct Model {\n${cols.map(seaField).join('\n')}\n    }\n    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]\n    pub enum Relation {}\n    impl ActiveModelBehavior for ActiveModel {}\n}\n`;
}
const seaorm = `// GENERATED. DO NOT EDIT. contract_ir_id=${ir.irId}\n${seaEntity('ores_err_trace_fingerprints', 'ores_err_trace_fingerprints', fingerprints)}\n${seaEntity('ores_err_trace_events', 'ores_err_trace_events', events)}\n`;

const manifest = JSON.stringify({
  schema: 'ores.err-trace.storage-projection/v1',
  contractIrSchema: ir.schema,
  contractIrId: ir.irId,
  parityReceiptRunId: ir?.admission?.receipt?.runId || null,
  generator: { name: 'ores-err-trace/generate-storage-projections.mjs', version: 1 },
  tables: {
    ores_err_trace_fingerprints: fingerprints.map(([name, schema, required]) => ({ name, sqlType: sqlType(name, schema), required })),
    ores_err_trace_events: events.map(([name, schema, required]) => ({ name, sqlType: sqlType(name, schema), required })),
  },
  outputs: {
    postgres: sha256(sql),
    diesel: sha256(diesel),
    seaorm: sha256(seaorm),
  },
}, null, 2) + '\n';

const outputs = new Map([
  ['postgres/001_ores_err_trace.sql', sql],
  ['diesel/schema.rs', diesel],
  ['seaorm/entities.rs', seaorm],
  ['projection-manifest.json', manifest],
]);

for (const [relative, content] of outputs) {
  const path = join(outDir, relative);
  if (check) {
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current !== content) fail(`stale generated projection: ${relative}`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
}

console.log(check ? 'storage projections are current' : `wrote ${outputs.size} storage projection artifacts to ${outDir}`);
