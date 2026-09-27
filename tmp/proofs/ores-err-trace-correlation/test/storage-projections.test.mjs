import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const generator = join(repoRoot, 'scripts', 'generate-storage-projections.mjs');

function baseIr(overrides = {}) {
  return {
    schema: 'ores.typespec-json-schema-validator.contract-ir/v1',
    status: 'passed',
    admissible: true,
    irId: 'storage-projection-regression-ir',
    admission: { receipt: { runId: 'storage-projection-regression-run' } },
    declarations: [
      {
        name: 'Ores.ErrTrace.ErrorEvent',
        assertionSchema: {
          type: 'object',
          properties: {
            service: { type: 'string' },
            error_list: { type: 'array', items: { type: 'string' } },
            trace_id: { type: 'string' },
            parent_trace_id: { type: 'string' },
            otel_trace_id: { type: 'string' },
            otel_span_id: { type: 'string' },
            routine_id: { type: 'string' },
          },
          required: ['service'],
        },
      },
      {
        name: 'Ores.ErrTrace.FingerprintEnvelope',
        assertionSchema: {
          type: 'object',
          properties: {
            policy: { $ref: '#/$defs/FingerprintPolicy' },
            fingerprint: { type: 'string' },
            service: { type: 'string' },
          },
          required: ['policy', 'fingerprint', 'service'],
        },
      },
      {
        name: 'Ores.ErrTrace.DedupeRecordResult',
        assertionSchema: {
          type: 'object',
          properties: {
            occurrence_count: { type: 'integer' },
            first_seen_at: { type: 'string' },
            last_seen_at: { type: 'string' },
          },
          required: ['occurrence_count', 'first_seen_at', 'last_seen_at'],
        },
      },
    ],
    ...overrides,
  };
}

function runGenerator(irPath, outDir, extra = []) {
  return spawnSync(
    process.execPath,
    [
      generator,
      `--contract-ir=${irPath}`,
      `--out=${outDir}`,
      ...extra,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env },
    },
  );
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ores-err-trace-storage-'));
  const irPath = join(root, 'contract-ir.json');
  const outDir = join(root, 'generated');
  await writeFile(irPath, JSON.stringify(baseIr(), null, 2) + '\n', 'utf8');
  return { root, irPath, outDir };
}

test('storage projections preserve contract scalar types and optionality', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));

  const result = runGenerator(f.irPath, f.outDir);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const sql = await readFile(join(f.outDir, 'postgres', '001_ores_err_trace.sql'), 'utf8');
  const diesel = await readFile(join(f.outDir, 'diesel', 'schema.rs'), 'utf8');
  const seaorm = await readFile(join(f.outDir, 'seaorm', 'entities.rs'), 'utf8');
  const manifest = JSON.parse(await readFile(join(f.outDir, 'projection-manifest.json'), 'utf8'));

  const eventColumns = Object.fromEntries(
    manifest.tables.ores_err_trace_events.map((column) => [column.name, column]),
  );

  assert.equal(eventColumns.trace_id.sqlType, 'text');
  assert.equal(eventColumns.parent_trace_id.sqlType, 'text');
  assert.equal(eventColumns.otel_trace_id.sqlType, 'text');
  assert.equal(eventColumns.otel_span_id.sqlType, 'text');
  assert.equal(eventColumns.routine_id.sqlType, 'text');
  assert.equal(eventColumns.error_list.sqlType, 'jsonb');
  assert.equal(eventColumns.error_list.required, false);

  assert.match(sql, /"trace_id" text(?:,|\n)/);
  assert.match(sql, /"parent_trace_id" text(?:,|\n)/);
  assert.match(sql, /"otel_trace_id" text(?:,|\n)/);
  assert.match(sql, /"otel_span_id" text(?:,|\n)/);
  assert.match(sql, /"routine_id" text(?:,|\n)/);
  assert.match(sql, /"error_list" jsonb(?:,|\n)/);
  assert.doesNotMatch(sql, /"error_list" jsonb not null/);
  assert.match(sql, /create index if not exists ores_err_trace_events_otel_trace_idx on public\.ores_err_trace_events\(otel_trace_id\) where otel_trace_id is not null;/);

  assert.match(diesel, /error_list -> Nullable<Jsonb>,/);
  assert.match(diesel, /trace_id -> Nullable<Text>,/);
  assert.match(diesel, /parent_trace_id -> Nullable<Text>,/);
  assert.match(diesel, /otel_trace_id -> Nullable<Text>,/);
  assert.match(diesel, /otel_span_id -> Nullable<Text>,/);
  assert.match(diesel, /routine_id -> Nullable<Text>,/);

  assert.match(seaorm, /pub error_list: Option<Json>,/);
  assert.match(seaorm, /pub trace_id: Option<String>,/);
  assert.match(seaorm, /pub parent_trace_id: Option<String>,/);
  assert.match(seaorm, /pub otel_trace_id: Option<String>,/);
  assert.match(seaorm, /pub otel_span_id: Option<String>,/);
  assert.match(seaorm, /pub routine_id: Option<String>,/);
});

test('Supabase fail-closed policy is guarded on generic PostgreSQL', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));

  const result = runGenerator(f.irPath, f.outDir);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const sql = await readFile(join(f.outDir, 'postgres', '001_ores_err_trace.sql'), 'utf8');
  const blockStart = sql.indexOf('do $ores$');
  const revoke = sql.indexOf('revoke all on table public.ores_err_trace_fingerprints');
  const blockEnd = sql.indexOf('end $ores$;');

  assert.ok(blockStart >= 0, 'missing guarded PostgreSQL DO block');
  assert.ok(revoke > blockStart, 'Supabase revoke escaped its guard block');
  assert.ok(blockEnd > revoke, 'Supabase revoke is not contained by the guard block');
  assert.match(sql, /rolname = 'anon'/);
  assert.match(sql, /rolname = 'authenticated'/);
});

test('projection manifest hashes bind all emitted artifacts', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));

  const result = runGenerator(f.irPath, f.outDir);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const manifest = JSON.parse(await readFile(join(f.outDir, 'projection-manifest.json'), 'utf8'));
  const outputs = {
    postgres: join(f.outDir, 'postgres', '001_ores_err_trace.sql'),
    diesel: join(f.outDir, 'diesel', 'schema.rs'),
    seaorm: join(f.outDir, 'seaorm', 'entities.rs'),
  };

  assert.equal(manifest.contractIrId, 'storage-projection-regression-ir');
  assert.equal(manifest.parityReceiptRunId, 'storage-projection-regression-run');

  for (const [name, path] of Object.entries(outputs)) {
    const bytes = await readFile(path);
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, manifest.outputs[name], `${name} digest drift`);
  }
});

test('--check is deterministic and detects stale generated output', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));

  let result = runGenerator(f.irPath, f.outDir);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  result = runGenerator(f.irPath, f.outDir, ['--check']);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const sqlPath = join(f.outDir, 'postgres', '001_ores_err_trace.sql');
  await writeFile(sqlPath, (await readFile(sqlPath, 'utf8')) + '\n-- stale mutation\n', 'utf8');

  result = runGenerator(f.irPath, f.outDir, ['--check']);
  assert.notEqual(result.status, 0, 'stale generated SQL was accepted');
  assert.match(result.stderr, /stale generated projection: postgres\/001_ores_err_trace\.sql/);
});

test('generator refuses non-admissible Contract IR', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ores-err-trace-storage-refusal-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const irPath = join(root, 'contract-ir.json');
  const outDir = join(root, 'generated');
  await mkdir(outDir, { recursive: true });
  await writeFile(
    irPath,
    JSON.stringify(baseIr({ admissible: false, status: 'stopped_for_evaluation' }), null, 2) + '\n',
    'utf8',
  );

  const result = runGenerator(irPath, outDir);
  assert.notEqual(result.status, 0, 'non-admissible Contract IR was accepted');
  assert.match(result.stderr, /Contract IR is not parity-admissible/);
});
