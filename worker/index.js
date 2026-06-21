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
  if (path.match(/^\/embed\/[^/]+\.svg$/)) return embedSVGPage(env, decodeURIComponent(path.split("/")[2].slice(0, -4)));
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

async function embedSVGPage(env, ref) {
  const profile = await buildProfile(env, ref);
  if (!profile) return new Response("Not found", { status: 404 });
  return new Response(svgEmbed(profile), {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function embedScript(request, ref) {
  const origin = new URL(request.url).origin;
  return new Response(`document.currentScript.insertAdjacentHTML("afterend", '<iframe src="${origin}/embed/${escapeJS(encodeURIComponent(ref))}" title="Burnfolio token burn" style="width:100%;max-width:760px;height:220px;border:0;border-radius:8px;overflow:hidden"></iframe>');`, {
    headers: { "Content-Type": "application/javascript; charset=utf-8" },
  });
}

async function buildProfile(env, ref) {
  const account = await resolveAccount(env, ref);
  if (!account) return null;
  const days = account.kind === "org" ? await orgDays(env, account.id) : await userDays(env, account.id);
  const total = days.reduce((sum, day) => sum + day.total_tokens, 0);
  return { account, days, total_tokens: total, stats: profileStats(days, total), embed_url: `/embed/${account.handle || account.account_number}` };
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
          <input name="machine_name" placeholder="machine name" autocomplete="off">
          <button>Create anonymous account</button>
        </form>
        <div class="result" data-result hidden></div>
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
        <div class="result" data-machine-result hidden></div>
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
    <script>${dashboardScript(profileRef)}</script>
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
  const stats = profile.stats;
  return layout(`${name} on Burnfolio`, `
    <main class="profile">
      <header class="profile-head">
        <div>
          <p class="eyebrow">${profile.account.kind} profile</p>
          <h1>${esc(name)}</h1>
          <p>${formatInt(profile.total_tokens)} tokens burned across ${formatInt(stats.active_days)} active UTC days</p>
        </div>
        <div class="actions"><a class="button secondary" href="${profile.embed_url}">Embed</a></div>
      </header>
      <section class="stats">
        <div><span>Total burn</span><strong>${formatInt(profile.total_tokens)}</strong></div>
        <div><span>Active days</span><strong>${formatInt(stats.active_days)}</strong></div>
        <div><span>Best day</span><strong>${formatInt(stats.best_day_tokens)}</strong><em>${esc(stats.best_day || "No activity yet")}</em></div>
        <div><span>Current streak</span><strong>${formatInt(stats.current_streak_days)}</strong></div>
      </section>
      ${heatmap(profile.days, { title: "Token burn graph", subtitle: `${formatInt(stats.last_365_tokens)} tokens in the last 365 days` })}
      <section class="panel">
        <h2>Embed</h2>
        <code>&lt;script src="https://burnfolio.ai/embed/${esc(name)}/script.js"&gt;&lt;/script&gt;</code>
        <code>&lt;img src="https://burnfolio.ai/embed/${esc(name)}.svg" alt="Burnfolio token burn graph"&gt;</code>
      </section>
    </main>
  `);
}

function embedHtml(profile) {
  const name = profile.account.handle || profile.account.account_number;
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css()}</style><div class="embed"><div><strong>${esc(name)}</strong><span>${formatInt(profile.total_tokens)} tokens</span></div>${heatmap(profile.days, { compact: true, subtitle: `${formatInt(profile.stats.active_days)} active days` })}</div>`;
}

function svgEmbed(profile) {
  const name = profile.account.handle || profile.account.account_number;
  const cells = heatmapCellData(profile.days);
  const cellSize = 10;
  const gap = 4;
  const left = 22;
  const top = 62;
  const colors = ["#1c232b", "#24462e", "#3f7d3c", "#82bd45", "#d7ff70"];
  const rects = cells.map((cell, i) => {
    const x = left + Math.floor(i / 7) * (cellSize + gap);
    const y = top + (i % 7) * (cellSize + gap);
    return `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${colors[cell.level]}"><title>${esc(cell.date)}: ${formatInt(cell.value)}</title></rect>`;
  }).join("");
  const width = left * 2 + 53 * (cellSize + gap);
  const height = 184;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(name)} Burnfolio token burn graph">
  <rect width="100%" height="100%" rx="8" fill="#0b0c0f"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="8" fill="none" stroke="#222a24"/>
  <text x="22" y="30" fill="#edf1f7" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="16" font-weight="700">${esc(name)}</text>
  <text x="22" y="50" fill="#9faab8" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="12">${formatInt(profile.total_tokens)} tokens burned · ${formatInt(profile.stats.active_days)} active UTC days</text>
  ${rects}
  <text x="22" y="164" fill="#9faab8" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="11">Less</text>
  <rect x="55" y="155" width="10" height="10" rx="2" fill="${colors[0]}"/>
  <rect x="70" y="155" width="10" height="10" rx="2" fill="${colors[1]}"/>
  <rect x="85" y="155" width="10" height="10" rx="2" fill="${colors[2]}"/>
  <rect x="100" y="155" width="10" height="10" rx="2" fill="${colors[3]}"/>
  <rect x="115" y="155" width="10" height="10" rx="2" fill="${colors[4]}"/>
  <text x="132" y="164" fill="#9faab8" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="11">More</text>
</svg>`;
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

function heatmap(days, options = {}) {
  const cells = heatmapCellData(days).map((cell) => `<span title="${cell.date}: ${formatInt(cell.value)}" class="cell l${cell.level}"></span>`);
  return `<section class="${options.compact ? "graph compact" : "graph"}">
    ${options.title ? `<div class="graph-head"><div><h2>${esc(options.title)}</h2>${options.subtitle ? `<p>${esc(options.subtitle)}</p>` : ""}</div>${legend()}</div>` : `<div class="graph-head small">${options.subtitle ? `<p>${esc(options.subtitle)}</p>` : ""}${legend()}</div>`}
    <div class="heatmap" aria-label="Token burn by UTC day">${cells.join("")}</div>
  </section>`;
}

function heatmapCellData(days) {
  const byDate = new Map(days.map((d) => [d.date_utc, d.total_tokens]));
  const today = new Date();
  const cells = [];
  for (let i = 364; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const date = d.toISOString().slice(0, 10);
    const value = byDate.get(date) || 0;
    cells.push({ date, value, level: level(value) });
  }
  return cells;
}

function legend() {
  return `<div class="legend"><span>Less</span><i class="cell l0"></i><i class="cell l1"></i><i class="cell l2"></i><i class="cell l3"></i><i class="cell l4"></i><span>More</span></div>`;
}

function profileStats(days, total) {
  const activeDays = days.filter((day) => day.total_tokens > 0);
  let bestDay = "";
  let bestDayTokens = 0;
  for (const day of activeDays) {
    if (day.total_tokens > bestDayTokens) {
      bestDay = day.date_utc;
      bestDayTokens = day.total_tokens;
    }
  }

  const dayMap = new Map(days.map((day) => [day.date_utc, day.total_tokens]));
  const today = new Date();
  let currentStreak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    if ((dayMap.get(key) || 0) <= 0) break;
    currentStreak++;
  }

  let last365Tokens = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    last365Tokens += dayMap.get(d.toISOString().slice(0, 10)) || 0;
  }

  return {
    active_days: activeDays.length,
    best_day: bestDay,
    best_day_tokens: bestDayTokens,
    current_streak_days: currentStreak,
    average_active_day_tokens: activeDays.length ? Math.round(total / activeDays.length) : 0,
    last_365_tokens: last365Tokens,
  };
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
    *{box-sizing:border-box}body{margin:0;background:#0b0c0f;min-height:100vh}
    nav{height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;border-bottom:1px solid #242932;background:rgba(11,12,15,.82);backdrop-filter:blur(14px);position:sticky;top:0}
    a{color:#dff6a0;text-decoration:none}button,.button{border:0;border-radius:8px;background:#d7ff70;color:#11160c;padding:11px 14px;font-weight:700;cursor:pointer;display:inline-flex}.secondary{background:#222a24;color:#dff6a0;border:1px solid #354231}
    input,select{border:1px solid #343b45;background:#11151b;color:#f5f7fb;border-radius:8px;padding:11px 12px;min-width:0}code,pre{background:#11151b;border:1px solid #262d37;border-radius:8px;padding:10px;overflow:auto}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,620px);gap:48px;align-items:center;max-width:1180px;margin:0 auto;padding:72px 28px}.eyebrow{color:#9caf88;text-transform:uppercase;letter-spacing:0;font-size:12px;font-weight:800}.hero h1{font-size:58px;line-height:1.02;margin:10px 0 18px;letter-spacing:0}.lede{font-size:19px;color:#bcc7d4;max-width:620px}.signup,form{display:flex;gap:10px;flex-wrap:wrap}.result{margin-top:18px;white-space:pre-wrap}.login{margin-top:28px}
    .setup{display:grid;gap:12px;margin-top:18px;padding:16px;border:1px solid #293321;background:#101511;border-radius:8px;white-space:normal}.setup h2{font-size:18px;margin:0}.setup p{margin:0;color:#aab4c1}.secret-grid{display:grid;gap:10px}.secret{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;border:1px solid #222a24;background:#0f1317;border-radius:8px;padding:10px}.secret span{display:block;color:#9faab8;font-size:12px;text-transform:uppercase;font-weight:800}.secret code{display:block;margin-top:5px;padding:0;border:0;background:transparent;color:#edf1f7;white-space:normal;overflow-wrap:anywhere}.copy{padding:9px 11px}
    .preview{padding:28px;border:1px solid #26301f;background:#101511;border-radius:8px}.profile,.dash{max-width:1050px;margin:0 auto;padding:46px 28px}.profile-head,.dash-head{display:flex;justify-content:space-between;gap:22px;align-items:flex-start}.profile h1,.dash h1{font-size:44px;margin:0}.profile-head p{color:#bcc7d4}.panel{margin-top:24px;padding:22px 0;border-top:1px solid #252b34}.panel h2{margin:0 0 12px;font-size:20px}.muted{color:#aab4c1}
    .stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:30px 0}.stats div{border:1px solid #222a24;background:#0f1317;border-radius:8px;padding:14px}.stats span{display:block;color:#9faab8;font-size:12px;text-transform:uppercase;font-weight:800}.stats strong{display:block;font-size:25px;margin-top:6px}.stats em{display:block;color:#9faab8;font-style:normal;font-size:12px;margin-top:4px}
    .graph{border:1px solid #26301f;background:#101511;border-radius:8px;padding:18px 18px 8px;margin-top:22px}.graph.compact{border:0;background:transparent;padding:8px 0 0;margin-top:8px}.graph-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.graph-head h2{font-size:19px;margin:0}.graph-head p{margin:5px 0 0;color:#9faab8}.graph-head.small{align-items:center}.legend{display:flex;align-items:center;gap:5px;color:#9faab8;font-size:12px;white-space:nowrap}.heatmap{display:grid;grid-template-rows:repeat(7,12px);grid-auto-flow:column;grid-auto-columns:12px;gap:4px;overflow:auto;padding:18px 0}.cell{width:12px;height:12px;border-radius:3px;background:#1c232b;display:inline-block}.l1{background:#24462e}.l2{background:#3f7d3c}.l3{background:#82bd45}.l4{background:#d7ff70}.embed{padding:14px;background:#0b0c0f;border:1px solid #222a24;border-radius:8px}.embed>div:first-child{display:flex;justify-content:space-between;color:#edf1f7}
    .list{display:grid;gap:10px;margin-top:16px}.row{display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid #222a24;background:#0f1317;border-radius:8px;padding:12px}.row span{display:block;color:#9faab8;font-size:13px;margin-top:3px}.row form{justify-content:flex-end}
    @media(max-width:820px){.hero{grid-template-columns:1fr;padding-top:42px}.hero h1{font-size:42px}nav{padding:0 18px}.profile-head,.dash-head{display:block}.signup input,form input{width:100%}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.graph-head{display:block}.legend{margin-top:12px}}
  `;
}

function signupScript() {
  return `
    function secretRow(label, value) {
      const row = document.createElement("div");
      row.className = "secret";
      const wrap = document.createElement("div");
      const name = document.createElement("span");
      name.textContent = label;
      const code = document.createElement("code");
      code.textContent = value;
      wrap.append(name, code);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary copy";
      button.textContent = "Copy";
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(value);
          button.textContent = "Copied";
        } catch {
          button.textContent = "Select";
        }
        setTimeout(() => button.textContent = "Copy", 1200);
      });
      row.append(wrap, button);
      return row;
    }
    function setupResult(target, items, footer) {
      target.hidden = false;
      target.innerHTML = "";
      const box = document.createElement("section");
      box.className = "setup";
      const heading = document.createElement("h2");
      heading.textContent = "Account created";
      const grid = document.createElement("div");
      grid.className = "secret-grid";
      for (const item of items) grid.appendChild(secretRow(item.label, item.value));
      const note = document.createElement("p");
      note.textContent = footer;
      const app = document.createElement("a");
      app.className = "button secondary";
      app.href = "/app";
      app.textContent = "Open dashboard";
      box.append(heading, grid, note, app);
      target.appendChild(box);
    }
    document.querySelector("[data-signup]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const result = document.querySelector("[data-result]");
      const body = Object.fromEntries(new FormData(form).entries());
      const res = await fetch("/api/signup", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        result.hidden = false;
        result.textContent = JSON.stringify(data, null, 2);
        return;
      }
      const profile = data.account.handle || data.account.account_number;
      const command = "pyro --profile " + profile + " --machine " + data.machine.token;
      setupResult(result, [
        { label: "Account number", value: data.account.account_number },
        { label: "Account key", value: data.account_key },
        { label: "Machine token", value: data.machine.token },
        { label: "Sync command", value: command }
      ], "Save the account key now. It is the private credential for anonymous sign-in.");
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

function dashboardScript(profileRef) {
  return `
    const profileRef = ${JSON.stringify(profileRef)};
    function secretRow(label, value) {
      const row = document.createElement("div");
      row.className = "secret";
      const wrap = document.createElement("div");
      const name = document.createElement("span");
      name.textContent = label;
      const code = document.createElement("code");
      code.textContent = value;
      wrap.append(name, code);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary copy";
      button.textContent = "Copy";
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(value);
          button.textContent = "Copied";
        } catch {
          button.textContent = "Select";
        }
        setTimeout(() => button.textContent = "Copy", 1200);
      });
      row.append(wrap, button);
      return row;
    }
    function machineResult(target, token) {
      target.hidden = false;
      target.innerHTML = "";
      const box = document.createElement("section");
      box.className = "setup";
      const heading = document.createElement("h2");
      heading.textContent = "Machine token created";
      const command = "pyro --profile " + profileRef + " --machine " + token;
      box.append(heading, secretRow("Machine token", token), secretRow("Sync command", command));
      target.appendChild(box);
    }
    async function post(form, url) {
      const body = Object.fromEntries(new FormData(form).entries());
      const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
      return res.json();
    }
    document.querySelector("[data-machine]").addEventListener("submit", async e => { e.preventDefault(); const data = await post(e.currentTarget, "/api/machines"); const out = document.querySelector("[data-machine-result]"); data.machine ? machineResult(out, data.machine.token) : (out.hidden = false, out.textContent = JSON.stringify(data, null, 2)); });
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
