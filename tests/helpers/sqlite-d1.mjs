import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";

/** Real migrated SQL with D1-shaped results and atomic, interleavable batches. */
export async function createSqliteD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const migrations = new URL("../../drizzle/", import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
    db.exec(await readFile(new URL(name, migrations), "utf8"));
  }
  const queries = [];
  let beforeExecute, beforeBatch;
  function statement(sql, values = []) {
    const execute = (first = false) => {
      const query = { sql, values }; queries.push(query); beforeExecute?.(query);
      const prepared = db.prepare(sql);
      if (first) return prepared.get(...values) ?? null;
      const results = prepared.all(...values);
      return { success: true, results, meta: { changes: db.prepare("SELECT changes() AS n").get().n } };
    };
    return {
      bind(...args) {
        if (args.length > 100) throw new Error("D1 limits statements to 100 bound parameters");
        return statement(sql, args);
      },
      async first() { await Promise.resolve(); return execute(true); },
      async all() { await Promise.resolve(); return execute(); },
      async run() { await Promise.resolve(); return execute(); },
      execute,
    };
  }
  const binding = {
    prepare: statement,
    async batch(statements) {
      await Promise.resolve();
      beforeBatch?.();
      db.exec("BEGIN");
      try {
        // No await between statements: another request may run before or after
        // this transaction, never inside it as a nested SQLite transaction.
        const result = statements.map(statement => statement.execute());
        db.exec("COMMIT"); return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    async exec(sql) { db.exec(sql); return { count: 1, duration: 0 }; },
  };
  return { db, binding, queries, intercept(fn) { beforeExecute = fn; }, interceptBatch(fn) { beforeBatch = fn; }, close() { db.close(); } };
}
