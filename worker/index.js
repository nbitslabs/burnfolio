const COOKIE_NAME = "bf_session";

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error(error);
      return json({ error: "internal_error" }, 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/") return html(homePage());
  if (path === "/app") return html(await appPage(request, env));
  if (path === "/api/signup" && request.method === "POST") return signup(request, env);
  if (path === "/api/account-login" && request.method === "POST") return accountLogin(request, env);
  if (path === "/api/magic-links" && request.method === "POST") return requestMagicLink(request, env);
  if (path === "/auth/magic") return consumeMagicLink(request, env);
  if (path === "/api/email" && request.method === "POST") return attachEmail(request, env);
  if (path === "/api/logout" && request.method === "POST") return logout(request, env);
  if (path === "/api/me") return me(request, env);
  if (path === "/api/handles" && request.method === "POST") return claimHandle(request, env);
  if (path === "/api/machines" && request.method === "POST") return createMachineRoute(request, env);
  if (path === "/api/orgs" && request.method === "POST") return createOrgRoute(request, env);
  if (path.match(/^\/api\/orgs\/[^/]+\/members$/) && request.method === "POST") return addOrgMemberRoute(request, env, path.split("/")[3]);
  if (path === "/api/ingest" && request.method === "POST") return ingest(request, env);
  if (path.match(/^\/api\/profiles\/[^/]+\/stats$/)) return profileStatsRoute(env, decodeURIComponent(path.split("/")[3]));
  if (path.match(/^\/embed\/[^/]+$/)) return embedPage(env, decodeURIComponent(path.split("/")[2]));
  if (path.match(/^\/embed\/[^/]+\/script\.js$/)) return embedScript(request, decodeURIComponent(path.split("/")[2]));
  if (path.match(/^\/[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/)) return profilePage(env, path.slice(1));

  return html(notFoundPage(), 404);
}

async function signup(request, env) {
  const body = await readBody(request);
  const email = cleanEmail(body.email);
  const handle = cleanHandle(body.username || body.handle);
  const user = await createUser(env, { email, handle });
  if (user.error) return json(user, user.status || 400);
  const machine = await createMachine(env, user.id, body.machine_name || "First machine");
  const sessionToken = await createSession(env, user.id);
  return json({ account: user.account, account_key: user.accountKey, machine }, 201, {
    "Set-Cookie": cookie(sessionToken),
  });
}

async function accountLogin(request, env) {
  const body = await readBody(request);
  const accountNumber = String(body.account_number || body.account || "").trim();
  const accountKey = String(body.account_key || body.key || "").trim();
  if (!accountNumber || !accountKey) return json({ error: "missing_account_credentials" }, 400);

  const row = await env.DB.prepare(`
    SELECT u.id
    FROM users u
    JOIN accounts a ON a.id = u.id
    WHERE a.account_number = ? AND u.access_key_hash = ?
  `).bind(accountNumber, await sha256(accountKey)).first();
  if (!row) return json({ error: "invalid_account_credentials" }, 401);

  const sessionToken = await createSession(env, row.id);
  return json({ account: await accountView(env, row.id) }, 200, {
    "Set-Cookie": cookie(sessionToken),
  });
}

async function requestMagicLink(request, env) {
  const body = await readBody(request);
  const email = cleanEmail(body.email);
  if (!email) return json({ error: "invalid_email" }, 400);

  let user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (!user) {
    const created = await createUser(env, { email, handle: "" });
    if (created.error) return json(created, created.status || 400);
    user = { id: created.id };
  }

  const token = randomToken("bfl");
  const tokenHash = await sha256(token);
  await env.DB.prepare(`
    INSERT INTO magic_links (token_hash, user_id, email, expires_at)
    VALUES (?, ?, ?, datetime('now', '+15 minutes'))
  `).bind(tokenHash, user.id, email).run();

  const origin = new URL(request.url).origin;
  const link = `${origin}/auth/magic?token=${encodeURIComponent(token)}`;
  const sent = await sendMagicEmail(env, email, link);
  if (!sent.ok) return json({ error: "email_send_failed", detail: sent.error }, 502);
  return json({ ok: true });
}

async function attachEmail(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const body = await readBody(request);
  const email = cleanEmail(body.email);
  if (!email) return json({ error: "invalid_email" }, 400);

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing && existing.id !== user.id) return json({ error: "email_already_claimed" }, 409);

  await env.DB.prepare("UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?").bind(email, user.id).run();
  const token = randomToken("bfl");
  await env.DB.prepare(`
    INSERT INTO magic_links (token_hash, user_id, email, expires_at)
    VALUES (?, ?, ?, datetime('now', '+15 minutes'))
  `).bind(await sha256(token), user.id, email).run();

  const origin = new URL(request.url).origin;
  const link = `${origin}/auth/magic?token=${encodeURIComponent(token)}`;
  const sent = await sendMagicEmail(env, email, link);
  if (!sent.ok) return json({ error: "email_send_failed", detail: sent.error }, 502);
  return json({ ok: true });
}

async function logout(request, env) {
  const token = cookieValue(request, COOKIE_NAME);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  }
  return json({ ok: true }, 200, {
    "Set-Cookie": expiredCookie(),
  });
}

async function consumeMagicLink(request, env) {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!token) return html(authResultPage("Missing sign-in token.", false), 400);
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`
    SELECT user_id FROM magic_links
    WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > datetime('now')
  `).bind(tokenHash).first();
  if (!row) return html(authResultPage("This sign-in link is expired or already used.", false), 400);

  const sessionToken = await createSession(env, row.user_id);
  await env.DB.batch([
    env.DB.prepare("UPDATE magic_links SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE token_hash = ?").bind(tokenHash),
    env.DB.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = ?").bind(row.user_id),
  ]);
  return new Response(authResultPage("Signed in. Redirecting to your dashboard.", true), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": cookie(sessionToken),
      "Refresh": "1; url=/app",
    },
  });
}

async function me(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ user: null });
  const machines = await env.DB.prepare("SELECT machine_number, name, created_at, last_seen_at FROM machines WHERE user_id = ? ORDER BY created_at DESC").bind(user.id).all();
  const orgs = await env.DB.prepare(`
    SELECT a.account_number, h.handle, a.display_name, m.role
    FROM memberships m
    JOIN accounts a ON a.id = m.org_id
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE m.user_id = ?
    ORDER BY a.created_at DESC
  `).bind(user.id).all();
  return json({ account: await accountView(env, user.id), machines: machines.results, orgs: orgs.results });
}

async function claimHandle(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const body = await readBody(request);
  const handle = cleanHandle(body.handle || body.username);
  if (!handle) return json({ error: "invalid_handle" }, 400);
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM handles WHERE account_id = ?").bind(user.id),
      env.DB.prepare("INSERT INTO handles (handle, account_id) VALUES (?, ?)").bind(handle, user.id),
    ]);
  } catch {
    return json({ error: "handle_unavailable" }, 409);
  }
  return json({ account: await accountView(env, user.id) });
}

async function createMachineRoute(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const body = await readBody(request);
  const machine = await createMachine(env, user.id, body.name || "Machine");
  return json({ machine }, 201);
}

async function createOrgRoute(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const body = await readBody(request);
  const handle = cleanHandle(body.handle || body.username);
  const displayName = cleanText(body.name || handle || "Organization", 80);
  const org = await createOrg(env, { handle, displayName, ownerUserID: user.id });
  if (org.error) return json(org, 409);
  return json({ org }, 201);
}

async function addOrgMemberRoute(request, env, orgRef) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const org = await resolveAccount(env, orgRef);
  if (!org || org.kind !== "org") return json({ error: "org_not_found" }, 404);
  const admin = await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ? AND user_id = ?").bind(org.id, user.id).first();
  if (!admin || admin.role !== "admin") return json({ error: "forbidden" }, 403);
  const body = await readBody(request);
  const member = await resolveAccount(env, body.user || body.account || body.handle);
  if (!member || member.kind !== "user") return json({ error: "user_not_found" }, 404);
  const role = body.role === "admin" ? "admin" : "member";
  await env.DB.prepare("INSERT OR REPLACE INTO memberships (org_id, user_id, role) VALUES (?, ?, ?)").bind(org.id, member.id, role).run();
  return json({ ok: true });
}

async function ingest(request, env) {
  const token = bearerToken(request);
  if (!token) return json({ error: "missing_machine_token" }, 401);
  const machine = await env.DB.prepare("SELECT id, user_id FROM machines WHERE token_hash = ?").bind(await sha256(token)).first();
  if (!machine) return json({ error: "invalid_machine_token" }, 401);
  const body = await readBody(request);
  const account = await resolveAccount(env, String(body.profile || ""));
  if (!account || account.id !== machine.user_id) return json({ error: "profile_machine_mismatch" }, 403);
  const days = Array.isArray(body.days) ? body.days.slice(0, 5000) : [];
  const statements = [];
  for (const day of days) {
    const date = String(day.date_utc || "");
    if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
    const usage = day.usage || {};
    const total = int(usage.total || day.total_tokens || usage.input + usage.cache_read + usage.cache_write + usage.output);
    statements.push(env.DB.prepare(`
      INSERT INTO daily_machine_usage
        (machine_id, user_id, date_utc, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, records, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(machine_id, date_utc) DO UPDATE SET
        input_tokens = excluded.input_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        total_tokens = excluded.total_tokens,
        records = excluded.records,
        updated_at = excluded.updated_at
    `).bind(machine.id, machine.user_id, date, int(usage.input), int(usage.cache_read), int(usage.cache_write), int(usage.output), int(usage.reasoning), total, int(day.records)));
  }
  if (statements.length) await env.DB.batch(statements);
  await env.DB.prepare("UPDATE machines SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(machine.id).run();
  return json({ ok: true, upserted_days: statements.length });
}

async function profileStatsRoute(env, ref) {
  const profile = await buildProfile(env, ref);
  if (!profile) return json({ error: "not_found" }, 404);
  return json(profile);
}

async function profilePage(env, ref) {
  const profile = await buildProfile(env, ref);
  if (!profile) return html(notFoundPage(), 404);
  return html(profileHtml(profile));
}

async function embedPage(env, ref) {
  const profile = await buildProfile(env, ref);
  if (!profile) return html(notFoundPage(), 404);
  return html(embedHtml(profile));
}

function embedScript(request, ref) {
  const origin = new URL(request.url).origin;
  return new Response(`document.currentScript.insertAdjacentHTML("afterend", '<iframe src="${origin}/embed/${escapeJS(ref)}" title="Burnfolio token burn" style="width:100%;max-width:760px;height:220px;border:0;border-radius:10px;overflow:hidden"></iframe>');`, {
    headers: { "Content-Type": "application/javascript; charset=utf-8" },
  });
}

async function buildProfile(env, ref) {
  const account = await resolveAccount(env, ref);
  if (!account) return null;
  const days = account.kind === "org" ? await orgDays(env, account.id) : await userDays(env, account.id);
  const total = days.reduce((sum, day) => sum + day.total_tokens, 0);
  return { account, days, total_tokens: total, embed_url: `/embed/${account.handle || account.account_number}` };
}

async function userDays(env, userID) {
  const rows = await env.DB.prepare(`
    SELECT date_utc, SUM(total_tokens) AS total_tokens
    FROM daily_machine_usage
    WHERE user_id = ?
    GROUP BY date_utc
    ORDER BY date_utc
  `).bind(userID).all();
  return rows.results.map(dayRow);
}

async function orgDays(env, orgID) {
  const rows = await env.DB.prepare(`
    SELECT d.date_utc, SUM(d.total_tokens) AS total_tokens
    FROM daily_machine_usage d
    JOIN memberships m ON m.user_id = d.user_id
    WHERE m.org_id = ?
    GROUP BY d.date_utc
    ORDER BY d.date_utc
  `).bind(orgID).all();
  return rows.results.map(dayRow);
}

async function createUser(env, { email, handle }) {
  const id = crypto.randomUUID();
  const accountNumber = await uniqueAccountNumber(env);
  const accountKey = randomToken("bfa");
  const statements = [
    env.DB.prepare("INSERT INTO accounts (id, account_number, kind, display_name) VALUES (?, ?, 'user', ?)").bind(id, accountNumber, handle || "Anonymous builder"),
    env.DB.prepare("INSERT INTO users (id, email, access_key_hash) VALUES (?, ?, ?)").bind(id, email || null, await sha256(accountKey)),
  ];
  if (handle) statements.push(env.DB.prepare("INSERT INTO handles (handle, account_id) VALUES (?, ?)").bind(handle, id));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (message.includes("users.email")) return { error: "email_already_claimed", status: 409 };
    if (message.includes("handles")) return { error: "handle_unavailable", status: 409 };
    throw error;
  }
  return { id, account: await accountView(env, id), accountKey };
}

async function createOrg(env, { handle, displayName, ownerUserID }) {
  const id = crypto.randomUUID();
  const accountNumber = await uniqueAccountNumber(env);
  const statements = [
    env.DB.prepare("INSERT INTO accounts (id, account_number, kind, display_name) VALUES (?, ?, 'org', ?)").bind(id, accountNumber, displayName),
    env.DB.prepare("INSERT INTO orgs (id) VALUES (?)").bind(id),
    env.DB.prepare("INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, 'admin')").bind(id, ownerUserID),
  ];
  if (handle) statements.push(env.DB.prepare("INSERT INTO handles (handle, account_id) VALUES (?, ?)").bind(handle, id));
  try {
    await env.DB.batch(statements);
  } catch {
    return { error: "handle_unavailable" };
  }
  return accountView(env, id);
}

async function createMachine(env, userID, name) {
  const id = crypto.randomUUID();
  const machineNumber = "m_" + randomBase36(10);
  const token = randomToken("bfm");
  await env.DB.prepare("INSERT INTO machines (id, user_id, machine_number, name, token_hash) VALUES (?, ?, ?, ?, ?)")
    .bind(id, userID, machineNumber, cleanText(name, 80), await sha256(token)).run();
  return { machine_number: machineNumber, name: cleanText(name, 80), token };
}

async function accountView(env, id) {
  return env.DB.prepare(`
    SELECT a.id, a.account_number, a.kind, a.display_name, a.created_at, h.handle
    FROM accounts a
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE a.id = ?
  `).bind(id).first();
}

async function resolveAccount(env, ref) {
  ref = String(ref || "").trim().replace(/^@/, "");
  if (!ref) return null;
  return env.DB.prepare(`
    SELECT a.id, a.account_number, a.kind, a.display_name, a.created_at, h.handle
    FROM accounts a
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE a.account_number = ? OR h.handle = ?
  `).bind(ref, cleanHandle(ref) || ref.toLowerCase()).first();
}

async function requireUser(request, env) {
  const token = cookieValue(request, COOKIE_NAME);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT user_id FROM sessions WHERE token_hash = ?").bind(await sha256(token)).first();
  if (!row) return null;
  return { id: row.user_id };
}

async function createSession(env, userID) {
  const sessionToken = randomToken("bf_session");
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)").bind(await sha256(sessionToken), userID).run();
  return sessionToken;
}

async function uniqueAccountNumber(env) {
  for (let i = 0; i < 8; i++) {
    const accountNumber = "bf_" + randomBase36(16);
    const existing = await env.DB.prepare("SELECT id FROM accounts WHERE account_number = ?").bind(accountNumber).first();
    if (!existing) return accountNumber;
  }
  throw new Error("account_number_exhausted");
}

function homePage() {
  return layout("Burnfolio", `
    <main class="hero">
      <section>
        <p class="eyebrow">Token burn profiles for AI-native builders</p>
        <h1>Show your AI work like a contribution graph.</h1>
        <p class="lede">Burnfolio turns local Claude, Codex, OpenCode, and Pi usage into a public token-burn profile for you, your machines, and your orgs.</p>
        <form class="signup" method="post" action="/api/signup" data-signup>
          <input name="username" placeholder="optional username" autocomplete="username">
          <input name="email" placeholder="optional email" autocomplete="email">
          <button>Create anonymous account</button>
        </form>
        <pre class="result" data-result hidden></pre>
        <div class="login">
          <p class="muted">Already have an email on the account?</p>
          <form data-login><input name="email" placeholder="email for magic link" autocomplete="email"><button class="secondary">Send magic link</button></form>
          <pre class="result" data-login-result hidden></pre>
        </div>
        <div class="login">
          <p class="muted">Anonymous account sign-in</p>
          <form data-account-login><input name="account_number" placeholder="account number"><input name="account_key" placeholder="account key"><button class="secondary">Sign in</button></form>
          <pre class="result" data-account-login-result hidden></pre>
        </div>
      </section>
      <section class="preview">${heatmap(sampleDays())}</section>
    </main>
    <script>${signupScript()}</script>
  `);
}

async function appPage(request, env) {
  const user = await requireUser(request, env);
  if (!user) return homePage();
  const account = await accountView(env, user.id);
  const userInfo = await env.DB.prepare("SELECT email, email_verified_at FROM users WHERE id = ?").bind(user.id).first();
  const machines = await env.DB.prepare("SELECT machine_number, name, created_at, last_seen_at FROM machines WHERE user_id = ? ORDER BY created_at DESC").bind(user.id).all();
  const orgs = await env.DB.prepare(`
    SELECT a.account_number, h.handle, a.display_name, m.role
    FROM memberships m
    JOIN accounts a ON a.id = m.org_id
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE m.user_id = ?
    ORDER BY a.created_at DESC
  `).bind(user.id).all();
  const profileRef = account.handle || account.account_number;
  return layout("Burnfolio app", `
    <main class="dash">
      <header class="dash-head">
        <div><p class="eyebrow">Dashboard</p><h1>${esc(profileRef)}</h1></div>
        <div class="actions"><a class="button secondary" href="/${esc(profileRef)}">Public profile</a><button class="secondary" data-logout>Log out</button></div>
      </header>
      <section class="panel">
        <h2>Connect a machine</h2>
        <p class="muted">Create a token, then run <code>pyro --profile ${esc(profileRef)} --machine &lt;token&gt;</code>.</p>
        <form data-machine><input name="name" placeholder="machine name"><button>Create token</button></form>
        <pre class="result" data-machine-result hidden></pre>
        <div class="list">${machines.results.map(machineRow).join("") || `<p class="muted">No machines yet.</p>`}</div>
      </section>
      <section class="panel">
        <h2>Profile</h2>
        <p class="muted">Account ${esc(account.account_number)}${userInfo.email ? ` · ${esc(userInfo.email)}${userInfo.email_verified_at ? " verified" : " unverified"}` : ""}</p>
        <form data-handle><input name="handle" placeholder="claim username"><button>Save username</button></form>
        <form data-email><input name="email" placeholder="optional email for magic links" autocomplete="email"><button class="secondary">Add email</button></form>
        <pre class="result" data-email-result hidden></pre>
      </section>
      <section class="panel">
        <h2>Organizations</h2>
        <form data-org><input name="handle" placeholder="org username, e.g. nbitslabs"><input name="name" placeholder="display name"><button>Create org</button></form>
        <pre class="result" data-org-result hidden></pre>
        <div class="list">${orgs.results.map(orgRow).join("") || `<p class="muted">No organizations yet.</p>`}</div>
      </section>
    </main>
    <script>${dashboardScript()}</script>
  `);
}

function machineRow(machine) {
  return `<div class="row"><div><strong>${esc(machine.name || machine.machine_number)}</strong><span>${esc(machine.machine_number)}${machine.last_seen_at ? ` · seen ${esc(machine.last_seen_at.slice(0, 10))}` : ""}</span></div></div>`;
}

function orgRow(org) {
  const ref = org.handle || org.account_number;
  const adminForm = org.role === "admin" ? `<form data-add-member data-org="${esc(ref)}"><input name="user" placeholder="user account or username"><select name="role"><option value="member">member</option><option value="admin">admin</option></select><button>Add</button></form>` : "";
  return `<div class="row"><div><strong><a href="/${esc(ref)}">${esc(ref)}</a></strong><span>${esc(org.display_name || "Organization")} · ${esc(org.role)}</span></div>${adminForm}</div>`;
}

function profileHtml(profile) {
  const name = profile.account.handle || profile.account.account_number;
  return layout(`${name} on Burnfolio`, `
    <main class="profile">
      <header class="profile-head">
        <div><p class="eyebrow">${profile.account.kind}</p><h1>${esc(name)}</h1><p>${formatInt(profile.total_tokens)} tokens burned</p></div>
        <a class="button secondary" href="${profile.embed_url}">Embed</a>
      </header>
      ${heatmap(profile.days)}
      <section class="panel">
        <h2>Embed</h2>
        <code>&lt;script src="https://burnfolio.ai/embed/${esc(name)}/script.js"&gt;&lt;/script&gt;</code>
      </section>
    </main>
  `);
}

function embedHtml(profile) {
  const name = profile.account.handle || profile.account.account_number;
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css()}</style><div class="embed"><div><strong>${esc(name)}</strong><span>${formatInt(profile.total_tokens)} tokens</span></div>${heatmap(profile.days)}</div>`;
}

function notFoundPage() {
  return layout("Not found", `<main class="profile"><h1>Profile not found</h1><a href="/">Create one</a></main>`);
}

function authResultPage(message, ok) {
  return layout(ok ? "Signed in" : "Sign in failed", `<main class="profile"><p class="eyebrow">${ok ? "Success" : "Link error"}</p><h1>${esc(message)}</h1><a href="/app">Open dashboard</a></main>`);
}

function layout(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css()}</style></head><body><nav><a href="/">Burnfolio</a><a href="/app">App</a></nav>${body}</body></html>`;
}

function heatmap(days) {
  const byDate = new Map(days.map((d) => [d.date_utc, d.total_tokens]));
  const today = new Date();
  const cells = [];
  for (let i = 364; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    const value = byDate.get(key) || 0;
    cells.push(`<span title="${key}: ${formatInt(value)}" class="cell l${level(value)}"></span>`);
  }
  return `<div class="heatmap">${cells.join("")}</div>`;
}

function level(value) {
  if (value <= 0) return 0;
  if (value < 100000) return 1;
  if (value < 1000000) return 2;
  if (value < 10000000) return 3;
  return 4;
}

function css() {
  return `
    :root{color-scheme:dark;background:#0b0c0f;color:#edf1f7;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#162117,#0b0c0f 44%);min-height:100vh}
    nav{height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;border-bottom:1px solid #242932;background:rgba(11,12,15,.82);backdrop-filter:blur(14px);position:sticky;top:0}
    a{color:#dff6a0;text-decoration:none}button,.button{border:0;border-radius:8px;background:#d7ff70;color:#11160c;padding:11px 14px;font-weight:700;cursor:pointer;display:inline-flex}.secondary{background:#222a24;color:#dff6a0;border:1px solid #354231}
    input,select{border:1px solid #343b45;background:#11151b;color:#f5f7fb;border-radius:8px;padding:11px 12px;min-width:0}code,pre{background:#11151b;border:1px solid #262d37;border-radius:8px;padding:10px;overflow:auto}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,620px);gap:48px;align-items:center;max-width:1180px;margin:0 auto;padding:72px 28px}.eyebrow{color:#9caf88;text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:800}.hero h1{font-size:58px;line-height:1.02;margin:10px 0 18px;letter-spacing:0}.lede{font-size:19px;color:#bcc7d4;max-width:620px}.signup,form{display:flex;gap:10px;flex-wrap:wrap}.result{margin-top:18px;white-space:pre-wrap}.login{margin-top:28px}
    .preview{padding:28px;border:1px solid #26301f;background:#101511;border-radius:8px}.profile,.dash{max-width:1050px;margin:0 auto;padding:46px 28px}.profile-head,.dash-head{display:flex;justify-content:space-between;gap:22px;align-items:flex-start}.profile h1,.dash h1{font-size:44px;margin:0}.profile-head p{color:#bcc7d4}.panel{margin-top:24px;padding:22px 0;border-top:1px solid #252b34}.panel h2{margin:0 0 12px;font-size:20px}.muted{color:#aab4c1}
    .heatmap{display:grid;grid-template-rows:repeat(7,12px);grid-auto-flow:column;grid-auto-columns:12px;gap:4px;overflow:auto;padding:18px 0}.cell{width:12px;height:12px;border-radius:3px;background:#1c232b}.l1{background:#24462e}.l2{background:#3f7d3c}.l3{background:#82bd45}.l4{background:#d7ff70}.embed{padding:14px;background:#0b0c0f;border:1px solid #222a24;border-radius:10px}.embed>div:first-child{display:flex;justify-content:space-between;color:#edf1f7}
    .list{display:grid;gap:10px;margin-top:16px}.row{display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid #222a24;background:#0f1317;border-radius:8px;padding:12px}.row span{display:block;color:#9faab8;font-size:13px;margin-top:3px}.row form{justify-content:flex-end}
    @media(max-width:820px){.hero{grid-template-columns:1fr;padding-top:42px}.hero h1{font-size:42px}nav{padding:0 18px}.profile-head,.dash-head{display:block}.signup input,form input{width:100%}}
  `;
}

function signupScript() {
  return `
    document.querySelector("[data-signup]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const result = document.querySelector("[data-result]");
      const body = Object.fromEntries(new FormData(form).entries());
      const res = await fetch("/api/signup", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      result.hidden = false;
      result.textContent = res.ok ? "Account: " + data.account.account_number + (data.account.handle ? " / " + data.account.handle : "") + "\\nAccount key: " + data.account_key + "\\nMachine token: " + data.machine.token + "\\n\\nRun: pyro --profile " + (data.account.handle || data.account.account_number) + " --machine " + data.machine.token + "\\n\\nSave the account key before closing this page. Open /app when you have saved it." : JSON.stringify(data, null, 2);
    });
    document.querySelector("[data-login]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const result = document.querySelector("[data-login-result]");
      const body = Object.fromEntries(new FormData(form).entries());
      const res = await fetch("/api/magic-links", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      result.hidden = false;
      result.textContent = res.ok ? "Magic link sent. Check your email." : JSON.stringify(data, null, 2);
    });
    document.querySelector("[data-account-login]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const result = document.querySelector("[data-account-login-result]");
      const body = Object.fromEntries(new FormData(form).entries());
      const res = await fetch("/api/account-login", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      result.hidden = false;
      result.textContent = res.ok ? "Signed in. Opening dashboard..." : JSON.stringify(data, null, 2);
      if (res.ok) location.href = "/app";
    });
  `;
}

function dashboardScript() {
  return `
    async function post(form, url) {
      const body = Object.fromEntries(new FormData(form).entries());
      const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
      return res.json();
    }
    document.querySelector("[data-machine]").addEventListener("submit", async e => { e.preventDefault(); const data = await post(e.currentTarget, "/api/machines"); const out = document.querySelector("[data-machine-result]"); out.hidden = false; out.textContent = "Machine token: " + data.machine.token; });
    document.querySelector("[data-handle]").addEventListener("submit", async e => { e.preventDefault(); await post(e.currentTarget, "/api/handles"); location.reload(); });
    document.querySelector("[data-email]").addEventListener("submit", async e => { e.preventDefault(); const data = await post(e.currentTarget, "/api/email"); const out = document.querySelector("[data-email-result]"); out.hidden = false; out.textContent = data.ok ? "Verification link sent. Check your email." : JSON.stringify(data, null, 2); });
    document.querySelector("[data-org]").addEventListener("submit", async e => { e.preventDefault(); const data = await post(e.currentTarget, "/api/orgs"); const out = document.querySelector("[data-org-result]"); out.hidden = false; out.textContent = JSON.stringify(data, null, 2); });
    document.querySelectorAll("[data-add-member]").forEach(form => form.addEventListener("submit", async e => { e.preventDefault(); await post(e.currentTarget, "/api/orgs/" + e.currentTarget.dataset.org + "/members"); location.reload(); }));
    document.querySelector("[data-logout]").addEventListener("click", async () => { await fetch("/api/logout", { method:"POST" }); location.href = "/"; });
  `;
}

function sampleDays() {
  return Array.from({ length: 180 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    return { date_utc: d.toISOString().slice(0, 10), total_tokens: Math.floor(Math.pow((i * 7919) % 97, 3) * 1500) };
  });
}

async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) return request.json();
  if (type.includes("form")) return Object.fromEntries(await request.formData());
  return {};
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function cookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
}

function expiredCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function cookieValue(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const [key, value] = part.trim().split("=");
    if (key === name) return value;
  }
  return "";
}

function bearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}${randomBase36(12)}`;
}

function randomBase36(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => (b % 36).toString(36)).join("");
}

function cleanHandle(value) {
  value = String(value || "").trim().toLowerCase();
  if (!value) return "";
  if (!value.match(/^[a-z0-9][a-z0-9_-]{2,31}$/)) return "";
  return value;
}

function cleanEmail(value) {
  value = String(value || "").trim().toLowerCase();
  return value && value.includes("@") ? value : "";
}

async function sendMagicEmail(env, to, link) {
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") {
    return { ok: false, error: "EMAIL binding is not configured" };
  }
  try {
    await env.EMAIL.send({
      to,
      from: { email: "login@burnfolio.ai", name: "Burnfolio" },
      subject: "Sign in to Burnfolio",
      text: `Use this link to sign in to Burnfolio. It expires in 15 minutes.\n\n${link}`,
      html: `<p>Use this link to sign in to Burnfolio. It expires in 15 minutes.</p><p><a href="${esc(link)}">Sign in to Burnfolio</a></p>`,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function cleanText(value, max) {
  return String(value || "").trim().slice(0, max);
}

function int(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function dayRow(row) {
  return { date_utc: row.date_utc, total_tokens: int(row.total_tokens) };
}

function formatInt(value) {
  return int(value).toLocaleString("en-US");
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeJS(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/'/g, "\\'");
}
