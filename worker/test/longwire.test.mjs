import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, createUser, createOrg, createMachine, request, stubFetch, fixNow, sha256 } from "./harness.mjs";

const worker = (await import("../index.js")).default;

const MGMT_KEY = "lw_mk_a5nwagTESTKEY0123456789";

let cleanups = [];
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  cleanups = [];
});

function useNow(iso) {
  cleanups.push(fixNow(iso));
}

// A fake longwire management API. `usage(params)` returns the data rows for a
// usage request; override `keyResponse`, `usageError` or `modelError` to
// simulate failures.
function fakeLongwire(overrides = {}) {
  const opts = {
    keyResponse: { status: 200, body: { id: "k1", name: "burnfolio", prefix: "lw_mk_a5nwag…", is_management_key: true, created_at: "2026-02-01T00:00:00Z", account: { id: "a1", username: "raghav" } } },
    usage: (params) => params.get("group_by") === "model"
      ? [
          { date: "2026-10-01", model: "qwen3-coder", requests: 42, errors: 0, prompt_tokens: 81234, completion_tokens: 9120, total_tokens: 90354 },
          { date: "2026-10-01", model: "Qwen/Qwen3-8B", requests: 3, errors: 1, prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
          { date: "2026-10-01", model: "qwen/qwen3-8b ", requests: 1, errors: 0, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          { date: "2026-10-02", model: "gemma4:e4b", requests: 7, errors: 0, prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 },
        ]
      : [
          { date: "2026-10-01", requests: 46, errors: 1, prompt_tokens: 82244, completion_tokens: 9325, total_tokens: 91569 },
          { date: "2026-10-02", requests: 7, errors: 0, prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 },
        ],
    usageError: null,
    modelError: null,
    ...overrides,
  };
  const stub = stubFetch((url, init) => {
    assert.equal(url.origin, "https://longwire.ai");
    assert.equal(init.headers.Authorization, `Bearer ${MGMT_KEY}`);
    if (url.pathname === "/v1/management/key") return opts.keyResponse;
    if (url.pathname === "/v1/management/usage") {
      const grouped = url.searchParams.get("group_by") === "model";
      const error = grouped ? opts.modelError || opts.usageError : opts.usageError;
      if (error) return error;
      return { status: 200, body: { view: "consumed", start: url.searchParams.get("start"), end: url.searchParams.get("end"), tz: "UTC", group_by: grouped ? ["model"] : [], data: opts.usage(url.searchParams), totals: {} } };
    }
    return { status: 404, body: { error: { message: "not found", type: "invalid_request_error" } } };
  });
  cleanups.push(stub.restore);
  stub.opts = opts;
  stub.usageCalls = () => stub.calls.filter((c) => c.url.pathname === "/v1/management/usage");
  return stub;
}

async function connect(env, user, body, prefix = "/api/longwire/connections") {
  const res = await worker.fetch(request(prefix, { method: "POST", cookie: user.cookie, body }), env);
  return { status: res.status, data: await res.json() };
}

async function runCron(env) {
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
}

test("rejects inference keys before calling longwire", async () => {
  const env = makeEnv();
  const user = createUser(env, "alice");
  const lw = fakeLongwire();
  const { status, data } = await connect(env, user, { key: "lw_sk_inferencekey123" });
  assert.equal(status, 400);
  assert.equal(data.error, "longwire_inference_key");
  assert.match(data.message, /inference key/);
  assert.match(data.message, /management key/);
  assert.equal(lw.calls.length, 0);
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM longwire_connections").n, 0);
});

test("rejects keys that aren't longwire management keys", async () => {
  const env = makeEnv();
  const user = createUser(env, "alice");
  const lw = fakeLongwire();
  for (const key of ["", "sk-or-v1-abc", "lw_mk_ has spaces"]) {
    const { status, data } = await connect(env, user, { key });
    assert.equal(status, 400);
    assert.equal(data.error, "invalid_longwire_key");
  }
  assert.equal(lw.calls.length, 0);
});

test("validates the key with /v1/management/key and refuses rejected keys", async () => {
  const env = makeEnv();
  const user = createUser(env, "alice");
  const lw = fakeLongwire({ keyResponse: { status: 401, body: { error: { message: "API key revoked", type: "invalid_request_error" } } } });
  const { status, data } = await connect(env, user, { key: MGMT_KEY });
  assert.equal(status, 400);
  assert.equal(data.error, "longwire_key_rejected");
  assert.match(data.message, /revoked/);
  assert.deepEqual(lw.calls.map((c) => c.url.pathname), ["/v1/management/key"]);
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM longwire_connections").n, 0);
});

test("refuses keys longwire doesn't report as management keys", async () => {
  const env = makeEnv();
  const user = createUser(env, "alice");
  fakeLongwire({ keyResponse: { status: 200, body: { id: "k1", name: "x", is_management_key: false } } });
  const { status, data } = await connect(env, user, { key: MGMT_KEY });
  assert.equal(status, 400);
  assert.equal(data.error, "longwire_management_key_required");

  fakeLongwire({ keyResponse: { status: 403, body: { error: { message: "inference keys can't use the management API", type: "invalid_request_error" } } } });
  const second = await connect(env, user, { key: MGMT_KEY });
  assert.equal(second.status, 400);
  assert.equal(second.data.error, "longwire_management_key_required");
});

test("connect stores the key encrypted, labels it, and backfills day + model usage", async () => {
  useNow("2026-10-21T12:00:00Z");
  const env = makeEnv();
  const user = createUser(env, "alice");
  const lw = fakeLongwire();
  const { status, data } = await connect(env, user, { key: MGMT_KEY });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.connection.label, "burnfolio");
  assert.equal(data.connection.status, "active");

  const conn = env.DB.get("SELECT * FROM longwire_connections");
  assert.equal(conn.account_id, user.id);
  assert.equal(conn.longwire_key_hash, sha256(MGMT_KEY));
  assert.ok(!conn.key_ciphertext.includes("lw_mk_"));
  assert.ok(conn.last_sync_at);

  // One window (2026-01-01..today), once for day totals, once by model; always UTC + consumed.
  const usage = lw.usageCalls().map((c) => Object.fromEntries(c.url.searchParams));
  assert.deepEqual(usage, [
    { start: "2026-01-01", end: "2026-10-21", tz: "UTC", view: "consumed" },
    { start: "2026-01-01", end: "2026-10-21", tz: "UTC", view: "consumed", group_by: "model" },
  ]);

  const days = env.DB.all("SELECT date_utc, records, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, source FROM longwire_daily_usage ORDER BY date_utc");
  assert.deepEqual(days.map((d) => ({ ...d })), [
    { date_utc: "2026-10-01", records: 46, input_tokens: 82244, output_tokens: 9325, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, total_tokens: 91569, source: "server" },
    { date_utc: "2026-10-02", records: 7, input_tokens: 500, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, total_tokens: 550, source: "server" },
  ]);

  // Model names are trimmed/lowercased; collisions after normalization are summed.
  const models = env.DB.all("SELECT date_utc, model, records, input_tokens, output_tokens, total_tokens FROM longwire_daily_model_usage ORDER BY date_utc, model");
  assert.deepEqual(models.map((m) => ({ ...m })), [
    { date_utc: "2026-10-01", model: "qwen/qwen3-8b", records: 4, input_tokens: 1010, output_tokens: 205, total_tokens: 1215 },
    { date_utc: "2026-10-01", model: "qwen3-coder", records: 42, input_tokens: 81234, output_tokens: 9120, total_tokens: 90354 },
    { date_utc: "2026-10-02", model: "gemma4:e4b", records: 7, input_tokens: 500, output_tokens: 50, total_tokens: 550 },
  ]);

  // Counts toward global totals (computed on read through router_daily_usage).
  const global = await (await worker.fetch(request("/api/global/stats"), env)).json();
  assert.equal(global.total_tokens, 91569 + 550);

  // The Router badge counts longwire usage.
  assert.ok(env.DB.get("SELECT 1 AS ok FROM account_badges WHERE account_id = ? AND badge_key = 'router'", user.id));
});

test("a custom name wins over the key's name and raw keys are never used as labels", async () => {
  useNow("2026-10-21T12:00:00Z");
  const env = makeEnv();
  const user = createUser(env, "alice");
  fakeLongwire();
  const named = await connect(env, user, { key: MGMT_KEY, name: "home lab" });
  assert.equal(named.data.connection.label, "home lab");

  const env2 = makeEnv();
  const user2 = createUser(env2, "bob");
  fakeLongwire({ keyResponse: { status: 200, body: { name: "lw_mk_a5nwag…", is_management_key: true } } });
  const raw = await connect(env2, user2, { key: MGMT_KEY, name: "lw_mk_paste" });
  assert.equal(raw.data.connection.label, "longwire");
});

test("full sync walks 366-day windows from 2026-01-01", async () => {
  useNow("2028-03-01T08:00:00Z");
  const env = makeEnv();
  const user = createUser(env, "alice");
  const lw = fakeLongwire({ usage: () => [] });
  const { status } = await connect(env, user, { key: MGMT_KEY });
  assert.equal(status, 200);
  const windows = lw.usageCalls()
    .filter((c) => !c.url.searchParams.has("group_by"))
    .map((c) => [c.url.searchParams.get("start"), c.url.searchParams.get("end")]);
  assert.deepEqual(windows, [
    ["2026-01-01", "2027-01-01"],
    ["2027-01-02", "2028-01-02"],
    ["2028-01-03", "2028-03-01"],
  ]);
  assert.equal(lw.usageCalls().filter((c) => c.url.searchParams.get("group_by") === "model").length, 3);
});

test("incremental sync re-fetches 7 days before last_sync_at", async () => {
  useNow("2026-10-21T12:00:00Z");
  const env = makeEnv();
  const user = createUser(env, "alice");
  const lw = fakeLongwire();
  await connect(env, user, { key: MGMT_KEY });
  const conn = env.DB.get("SELECT id FROM longwire_connections");
  env.DB.db.prepare("UPDATE longwire_connections SET last_sync_at = '2026-10-20T09:00:00.000Z'").run();
  lw.calls.length = 0;
  const res = await worker.fetch(request(`/api/longwire/connections/${conn.id}/sync`, { method: "POST", cookie: user.cookie }), env);
  assert.equal(res.status, 200);
  const starts = lw.usageCalls().map((c) => [c.url.searchParams.get("start"), c.url.searchParams.get("end")]);
  assert.deepEqual(starts, [["2026-10-13", "2026-10-21"], ["2026-10-13", "2026-10-21"]]);
});

test("a per-model failure doesn't fail the day totals", async () => {
  useNow("2026-10-21T12:00:00Z");
  const env = makeEnv();
  const user = createUser(env, "alice");
  fakeLongwire({ modelError: { status: 500, body: { error: { message: "boom", type: "server_error" } } } });
  const { status, data } = await connect(env, user, { key: MGMT_KEY });
  assert.equal(status, 200);
  assert.equal(data.connection.status, "active");
  assert.equal(data.connection.sync.models_synced, false);
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM longwire_daily_usage").n, 2);
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM longwire_daily_model_usage").n, 0);
  const conn = env.DB.get("SELECT status, last_sync_at, last_error FROM longwire_connections");
  assert.equal(conn.status, "active");
  // last_sync_at stays unset so the next run re-covers the window for models.
  assert.equal(conn.last_sync_at, null);
  assert.match(conn.last_error, /per-model breakdown failed/);
});

test("401 during sync parks the connection until the user acts", async () => {
  useNow("2026-10-21T12:00:00Z");
  const env = makeEnv();
  const user = createUser(env, "alice");
  const lw = fakeLongwire();
  await connect(env, user, { key: MGMT_KEY });
  const conn = env.DB.get("SELECT id FROM longwire_connections");

  lw.opts.usageError = { status: 401, body: { error: { message: "API key expired", type: "invalid_request_error" } } };
  const res = await worker.fetch(request(`/api/longwire/connections/${conn.id}/sync`, { method: "POST", cookie: user.cookie }), env);
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.equal(data.error, "longwire_key_rejected");
  let row = env.DB.get("SELECT status, needs_reconnect, last_error FROM longwire_connections");
  assert.equal(row.status, "error");
  assert.equal(row.needs_reconnect, 1);
  assert.match(row.last_error, /revoked or expired/);
  assert.match(row.last_error, /API key expired/);

  // The cron doesn't retry it, even once it's due.
  env.DB.db.prepare("UPDATE longwire_connections SET last_sync_at = '2020-01-01T00:00:00.000Z'").run();
  lw.calls.length = 0;
  await runCron(env);
  assert.equal(lw.calls.length, 0);

  // Reconnecting the same key clears the flag.
  lw.opts.usageError = null;
  const again = await connect(env, user, { key: MGMT_KEY });
  assert.equal(again.status, 200);
  row = env.DB.get("SELECT status, needs_reconnect, last_error FROM longwire_connections");
  assert.deepEqual({ ...row }, { status: "active", needs_reconnect: 0, last_error: null });
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM longwire_connections").n, 1);
});

test("403s explain IP locks, suspensions and wrong key types", async () => {
  useNow("2026-10-21T12:00:00Z");
  const cases = [
    ["Request IP 1.2.3.4 is not allowed for this key", "longwire_ip_not_allowed", /IP-locked/],
    ["Account suspended", "longwire_account_suspended", /suspended/],
    ["Inference keys (lw_sk_) can't call the management API", "longwire_management_key_required", /management key/],
  ];
  for (const [message, code, pattern] of cases) {
    const env = makeEnv();
    const user = createUser(env, "alice");
    const lw = fakeLongwire();
    await connect(env, user, { key: MGMT_KEY });
    const conn = env.DB.get("SELECT id FROM longwire_connections");
    lw.opts.usageError = { status: 403, body: { error: { message, type: "invalid_request_error" } } };
    const res = await worker.fetch(request(`/api/longwire/connections/${conn.id}/sync`, { method: "POST", cookie: user.cookie }), env);
    const data = await res.json();
    assert.equal(data.error, code, message);
    const row = env.DB.get("SELECT status, needs_reconnect, last_error FROM longwire_connections");
    assert.equal(row.status, "error");
    assert.equal(row.needs_reconnect, 1);
    assert.match(row.last_error, pattern);
  }
});

test("429 backs off without parking the connection", async () => {
  useNow("2026-10-21T12:00:00Z");
  const env = makeEnv();
  const user = createUser(env, "alice");
  const lw = fakeLongwire();
  await connect(env, user, { key: MGMT_KEY });
  env.DB.db.prepare("UPDATE longwire_connections SET last_sync_at = '2020-01-01T00:00:00.000Z'").run();

  lw.opts.usageError = { status: 429, body: { error: { message: "Rate limit exceeded", type: "invalid_request_error" } }, headers: { "Retry-After": "1800" } };
  lw.calls.length = 0;
  await runCron(env);
  assert.equal(lw.usageCalls().length, 1);
  const row = env.DB.get("SELECT status, needs_reconnect, next_attempt_at, last_error, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1700 seconds') AS soon FROM longwire_connections");
  assert.equal(row.status, "error");
  assert.equal(row.needs_reconnect, 0);
  assert.ok(row.next_attempt_at > row.soon, `${row.next_attempt_at} should be ~30 minutes out`);
  assert.match(row.last_error, /rate limiting/);

  // Still backing off: the next cron run skips it.
  lw.calls.length = 0;
  await runCron(env);
  assert.equal(lw.calls.length, 0);

  // Once the backoff passes, the cron picks it up again and clears the error.
  lw.opts.usageError = null;
  env.DB.db.prepare("UPDATE longwire_connections SET next_attempt_at = '2020-01-01T00:00:00.000Z'").run();
  await runCron(env);
  assert.equal(lw.usageCalls().length, 2);
  assert.equal(env.DB.get("SELECT status FROM longwire_connections").status, "active");
});

test("org connections, permissions, export and delete", async () => {
  useNow("2026-10-21T12:00:00Z");
  const env = makeEnv();
  const owner = createUser(env, "alice");
  const outsider = createUser(env, "mallory");
  const org = createOrg(env, "acme", owner);
  fakeLongwire();

  const denied = await connect(env, outsider, { key: MGMT_KEY }, `/api/orgs/${org.handle}/longwire/connections`);
  assert.equal(denied.status, 403);

  const ok = await connect(env, owner, { key: MGMT_KEY }, `/api/orgs/${org.handle}/longwire/connections`);
  assert.equal(ok.status, 200);
  const conn = env.DB.get("SELECT id, account_id FROM longwire_connections");
  assert.equal(conn.account_id, org.id);

  // Org graph and source breakdown include longwire.
  const stats = await (await worker.fetch(request(`/api/profiles/${org.handle}/stats`), env)).json();
  assert.equal(stats.total_tokens, 91569 + 550);

  const del = await worker.fetch(request(`/api/orgs/${org.handle}/longwire/connections/${conn.id}`, { method: "DELETE", cookie: outsider.cookie }), env);
  assert.equal(del.status, 403);
  const sync = await worker.fetch(request(`/api/longwire/connections/${conn.id}/sync`, { method: "POST", cookie: outsider.cookie }), env);
  assert.equal(sync.status, 403);

  // Personal connection for the export/delete checks.
  await connect(env, owner, { key: MGMT_KEY });
  const exported = await (await worker.fetch(request("/api/me/export.json", { cookie: owner.cookie }), env)).json();
  assert.equal(exported.longwire_daily_usage.length, 2);
  assert.equal(exported.longwire_daily_model_usage.length, 3);
  assert.equal(exported.longwire_connections.length, 2);
  assert.ok(!JSON.stringify(exported).includes(MGMT_KEY));
  assert.ok(!("key_ciphertext" in exported.longwire_connections[0]));

  const csv = await (await worker.fetch(request("/api/me/usage-breakdown.csv", { cookie: owner.cookie }), env)).text();
  assert.match(csv, /longwire,qwen3-coder/);

  const removed = await worker.fetch(request(`/api/orgs/${org.handle}/longwire/connections/${conn.id}`, { method: "DELETE", cookie: owner.cookie }), env);
  assert.equal(removed.status, 200);
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM longwire_connections WHERE account_id = ?", org.id).n, 0);
});

test("account deletion removes longwire rows", async () => {
  useNow("2026-10-21T12:00:00Z");
  const env = makeEnv();
  const user = createUser(env, "alice");
  fakeLongwire();
  await connect(env, user, { key: MGMT_KEY });
  const res = await worker.fetch(request("/api/me/delete", { method: "POST", cookie: user.cookie, body: { confirm: "alice" } }), env);
  assert.equal(res.status, 200);
  for (const table of ["longwire_connections", "longwire_daily_usage", "longwire_daily_model_usage"]) {
    assert.equal(env.DB.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 0, table);
  }
  const global = await (await worker.fetch(request("/api/global/stats"), env)).json();
  assert.equal(global.total_tokens, 0);
});

test("pyro can upload longwire usage it read locally", async () => {
  useNow("2026-10-21T12:00:00Z");
  const env = makeEnv();
  const user = createUser(env, "alice");
  const machine = createMachine(env, user);
  const res = await worker.fetch(request("/api/longwire/ingest", {
    method: "POST",
    token: machine.token,
    body: {
      profile: "alice",
      longwire_key_hash: sha256(MGMT_KEY),
      days: [{ date_utc: "2026-10-05", records: 2, usage: { input: 100, output: 20, total: 120 }, models: [{ model: "Qwen3-Coder", records: 2, usage: { input: 100, output: 20, total: 120 } }] }],
    },
  }), env);
  assert.equal(res.status, 200, await res.clone().text());
  const day = env.DB.get("SELECT total_tokens, source, updated_by_machine_id FROM longwire_daily_usage");
  assert.deepEqual({ ...day }, { total_tokens: 120, source: "pyro", updated_by_machine_id: machine.id });
  assert.equal(env.DB.get("SELECT model FROM longwire_daily_model_usage").model, "qwen3-coder");
});

test("OpenRouter and longwire usage both count on the profile without merging keys", async () => {
  useNow("2026-10-21T12:00:00Z");
  const env = makeEnv();
  const user = createUser(env, "alice");
  const hash = sha256("same-hash-input");
  env.DB.db.prepare("INSERT INTO openrouter_daily_usage (account_id, openrouter_key_hash, date_utc, total_tokens, source) VALUES (?, ?, '2026-10-01', 1000, 'server')").run(user.id, hash);
  env.DB.db.prepare("INSERT INTO longwire_daily_usage (account_id, longwire_key_hash, date_utc, total_tokens, source) VALUES (?, ?, '2026-10-01', 500, 'server')").run(user.id, hash);
  const stats = await (await worker.fetch(request("/api/profiles/alice/stats"), env)).json();
  assert.equal(stats.total_tokens, 1500);
  const global = await (await worker.fetch(request("/api/global/stats"), env)).json();
  assert.equal(global.total_tokens, 1500);
});

test("OpenRouter pyro ingest still works through the shared router path", async () => {
  useNow("2026-10-21T12:00:00Z");
  const env = makeEnv();
  const user = createUser(env, "alice");
  const machine = createMachine(env, user);
  const res = await worker.fetch(request("/api/openrouter/ingest", {
    method: "POST",
    token: machine.token,
    body: { profile: "alice", openrouter_key_hash: sha256("sk-or-v1-x"), days: [{ date_utc: "2026-10-05", records: 1, usage: { input: 10, output: 5, total: 15 }, models: [{ model: "openai/gpt-5", records: 1, usage: { input: 10, output: 5, total: 15 } }] }] },
  }), env);
  assert.equal(res.status, 200);
  assert.equal(env.DB.get("SELECT total_tokens FROM openrouter_daily_usage").total_tokens, 15);
  assert.equal(env.DB.get("SELECT model FROM openrouter_daily_model_usage").model, "openai/gpt-5");
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM longwire_daily_usage").n, 0);
});

test("dashboard, org page and public profile render both router panels", async () => {
  useNow("2026-10-21T12:00:00Z");
  const env = makeEnv();
  const user = createUser(env, "alice");
  const org = createOrg(env, "acme", user);
  const lw = fakeLongwire();
  await connect(env, user, { key: MGMT_KEY });
  lw.opts.usageError = { status: 401, body: { error: { message: "API key revoked", type: "invalid_request_error" } } };
  const conn = env.DB.get("SELECT id FROM longwire_connections");
  await worker.fetch(request(`/api/longwire/connections/${conn.id}/sync`, { method: "POST", cookie: user.cookie }), env);
  env.DB.db.prepare("UPDATE accounts SET show_model_breakdown = 1 WHERE id = ?").run(user.id);

  const app = await (await worker.fetch(request("/app", { cookie: user.cookie }), env)).text();
  assert.match(app, /data-router="openrouter" data-router-scope="user"/);
  assert.match(app, /data-router="longwire" data-router-scope="user"/);
  assert.match(app, /href="https:\/\/longwire\.ai\/keys"/);
  assert.match(app, /read-only/);
  assert.match(app, /Paused until you reconnect or sync manually/);
  assert.match(app, /data-router-base="\/api\/longwire\/connections\//);

  const orgs = await (await worker.fetch(request(`/app/orgs?org=${org.handle}`, { cookie: user.cookie }), env)).text();
  assert.match(orgs, /data-router="longwire" data-router-scope="org" data-org="acme"/);

  const profile = await worker.fetch(request("/alice"), env);
  assert.equal(profile.status, 200);
  assert.match(await profile.text(), /longwire/);
});
