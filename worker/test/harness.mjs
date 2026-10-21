// Runs the Worker under Node for tests: a minimal D1 shim over node:sqlite with
// every migration applied, a no-op Cache API, and a scriptable fetch stub.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes) } };
  }
}

export class D1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    const dir = path.join(root, "migrations");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      this.db.exec(readFileSync(path.join(dir, file), "utf8"));
    }
  }
  prepare(sql) {
    return new Statement(this.db, sql);
  }
  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(sql, ...params) {
    return this.db.prepare(sql).get(...params) ?? null;
  }
  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }
}

globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

export const ORIGIN = "https://burnfolio.test";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function makeEnv() {
  return { DB: new D1(), OPENROUTER_KEY_SECRET: "test-secret-".padEnd(48, "x"), MAX_DAILY_TOKENS_PER_SOURCE: "100000000000" };
}

let accountCounter = 0;

export function createUser(env, handle) {
  const id = `user-${++accountCounter}`;
  env.DB.db.prepare("INSERT INTO accounts (id, account_number, kind, display_name) VALUES (?, ?, 'user', ?)").run(id, `1000${accountCounter}`.padEnd(12, "0"), handle);
  env.DB.db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(id, `${handle}@example.com`);
  env.DB.db.prepare("INSERT INTO handles (handle, account_id) VALUES (?, ?)").run(handle, id);
  const session = `bf_session_${id}`;
  env.DB.db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(sha256(session), id);
  return { id, handle, cookie: `bf_session=${session}` };
}

export function createOrg(env, handle, owner) {
  const id = `org-${++accountCounter}`;
  env.DB.db.prepare("INSERT INTO accounts (id, account_number, kind, display_name) VALUES (?, ?, 'org', ?)").run(id, `2000${accountCounter}`.padEnd(12, "0"), handle);
  env.DB.db.prepare("INSERT INTO orgs (id) VALUES (?)").run(id);
  env.DB.db.prepare("INSERT INTO handles (handle, account_id) VALUES (?, ?)").run(handle, id);
  env.DB.db.prepare("INSERT INTO memberships (org_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')").run(id, owner.id);
  return { id, handle };
}

export function createMachine(env, user) {
  const id = `machine-${++accountCounter}`;
  const token = `bf_machine_${id}`;
  env.DB.db.prepare("INSERT INTO machines (id, user_id, machine_number, name, token_hash) VALUES (?, ?, ?, ?, ?)").run(id, user.id, `3000${accountCounter}`.padEnd(12, "0"), "laptop", sha256(token));
  return { id, token };
}

export function request(pathname, { method = "GET", body, cookie, token } = {}) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(ORIGIN + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

// Installs a fetch stub. `handler(url, init)` returns { status, body, headers }
// or a Response; every call is recorded in `calls`.
export function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    calls.push({ url, init });
    const out = await handler(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200, headers: { "Content-Type": "application/json", ...(out.headers || {}) } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// Pins `new Date()` / Date.now() to a fixed instant so date-window logic is
// deterministic. SQLite's own 'now' is unaffected.
export function fixNow(iso) {
  const RealDate = globalThis.Date;
  const fixed = new RealDate(iso).getTime();
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed]));
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FixedDate;
  return () => { globalThis.Date = RealDate; };
}
