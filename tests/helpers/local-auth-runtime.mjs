import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

export async function localAuthRuntime() {
  const directory = await mkdtemp(join(tmpdir(), 'rag-chef-local-auth-'));
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0001_friendly_titania.sql', '0009_local_browser_sessions.sql']) database.exec(await readFile(new URL(`../../drizzle/${migration}`, import.meta.url), 'utf8'));
  const sources = ['household', 'catalog-auth', 'local-auth', 'local-server-config', 'chef-schema', 'kitchen-types', 'kitchen-store', 'kitchen-validation', 'quantities'];
  for (const name of sources) {
    const source = await readFile(new URL(`../../app/lib/${name}.ts`, import.meta.url), 'utf8');
    await writeFile(join(directory, `${name}.mjs`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"(?:@\/app\/lib\/|\.\/)([\w-]+)"/g, '"./$1.mjs"'));
  }
  await writeFile(join(directory, 'auth.mjs'), 'export function validateHostedConfiguration() {} export async function getAuth() { return { api: { getSession: async () => null } }; }');
  let beforeStatement;
  const binding = {
    prepare(sql) {
      let values = [];
      const prepared = {
        bind(...args) { values = args; return prepared; },
        async first() { beforeStatement?.(sql); return database.prepare(sql).get(...values) ?? null; },
        async all() { beforeStatement?.(sql); return { success: true, results: database.prepare(sql).all(...values), meta: {} }; },
        async run() { beforeStatement?.(sql); const result = database.prepare(sql).run(...values); return { success: true, results: [], meta: { changes: Number(result.changes) } }; },
      };
      return prepared;
    },
    async batch(statements) { database.exec('BEGIN'); try { const result = []; for (const statement of statements) result.push(await statement.all()); database.exec('COMMIT'); return result; } catch (error) { database.exec('ROLLBACK'); throw error; } },
  };
  return {
    database, binding, beforeStatement(callback) { beforeStatement = callback; },
    household: await import(pathToFileURL(join(directory, 'household.mjs'))),
    catalog: await import(pathToFileURL(join(directory, 'catalog-auth.mjs'))),
    auth: await import(pathToFileURL(join(directory, 'local-auth.mjs'))),
    store: await import(pathToFileURL(join(directory, 'kitchen-store.mjs'))),
    types: await import(pathToFileURL(join(directory, 'kitchen-types.mjs'))),
    async close() { database.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
