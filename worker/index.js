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

  if (path === "/favicon.svg") return assetResponse("pyro.svg");
  if (path === "/favicon.ico") return assetResponse("pyro-512.png");
  if (path === "/apple-touch-icon.png") return assetResponse("pyro-512.png");
  if (path.match(/^\/assets\/[^/]+$/)) return assetResponse(path.split("/")[2]);
  if (path === "/og/landing.png") return assetResponse("og-landing.png");
  if (path.match(/^\/og\/[^/]+\.svg$/)) return ogProfilePage(env, decodeURIComponent(path.split("/")[2].slice(0, -4)));
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
  if (path.match(/^\/api\/machines\/[^/]+\/token$/) && request.method === "POST") return rotateMachineTokenRoute(request, env, decodeURIComponent(path.split("/")[3]));
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
  const machine = await createMachine(env, {
    userID: user.id,
    name: body.machine_name || "First machine",
    profileRef: accountRef(user.account),
  });
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
  const machines = await machineRows(env, user.id);
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
    await env.DB.prepare(`
      INSERT INTO handles (handle, account_id)
      VALUES (?, ?)
      ON CONFLICT(account_id) DO UPDATE SET handle = excluded.handle
    `).bind(handle, user.id).run();
  } catch {
    return json({ error: "handle_unavailable" }, 409);
  }
  return json({ account: await accountView(env, user.id) });
}

async function createMachineRoute(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const body = await readBody(request);
  const scopeRef = String(body.org || body.org_ref || "").trim();
  let org = null;
  if (scopeRef) {
    org = await resolveAccount(env, scopeRef);
    if (!org || org.kind !== "org") return json({ error: "org_not_found" }, 404);
    const member = await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ? AND user_id = ?").bind(org.id, user.id).first();
    if (!member) return json({ error: "forbidden" }, 403);
  }
  const machine = await createMachine(env, {
    userID: user.id,
    name: body.name || "Machine",
    orgID: org ? org.id : "",
    profileRef: org ? accountRef(org) : accountRef(await accountView(env, user.id)),
  });
  return json({ machine }, 201);
}

async function rotateMachineTokenRoute(request, env, machineNumber) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const machine = await env.DB.prepare(`
    SELECT
      m.id,
      m.machine_number,
      m.name,
      m.org_id,
      ua.account_number AS user_account_number,
      uh.handle AS user_handle,
      oa.account_number AS org_account_number,
      oh.handle AS org_handle
    FROM machines m
    JOIN accounts ua ON ua.id = m.user_id
    LEFT JOIN handles uh ON uh.account_id = ua.id
    LEFT JOIN accounts oa ON oa.id = m.org_id
    LEFT JOIN handles oh ON oh.account_id = oa.id
    WHERE m.machine_number = ? AND m.user_id = ?
  `).bind(machineNumber, user.id).first();
  if (!machine) return json({ error: "machine_not_found" }, 404);

  const token = randomToken("bfm");
  await env.DB.prepare("UPDATE machines SET token_hash = ?, token = ? WHERE id = ?")
    .bind(await sha256(token), token, machine.id).run();
  const profile = machine.org_id
    ? machine.org_handle || machine.org_account_number
    : machine.user_handle || machine.user_account_number;
  return json({ machine: { machine_number: machine.machine_number, name: machine.name, token, profile } });
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
  await env.DB.prepare(`
    INSERT INTO memberships (org_id, user_id, role)
    VALUES (?, ?, ?)
    ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role
  `).bind(org.id, member.id, role).run();
  return json({ ok: true });
}

async function ingest(request, env) {
  const token = bearerToken(request);
  if (!token) return json({ error: "missing_machine_token" }, 401);
  const machine = await env.DB.prepare("SELECT id, user_id, org_id FROM machines WHERE token_hash = ?").bind(await sha256(token)).first();
  if (!machine) return json({ error: "invalid_machine_token" }, 401);
  const body = await readBody(request);
  const account = await resolveAccount(env, String(body.profile || ""));
  if (!account || !machineCanSyncToAccount(machine, account)) return json({ error: "profile_machine_mismatch" }, 403);
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

async function ogProfilePage(env, ref) {
  const profile = await buildProfile(env, ref);
  if (!profile) return svgResponse(ogLandingFallbackSVG("Profile not found"), 404);
  return svgResponse(ogProfileSVG(profile));
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

async function createMachine(env, { userID, name, orgID = "", profileRef = "" }) {
  const id = crypto.randomUUID();
  const machineNumber = "m_" + randomBase36(10);
  const token = randomToken("bfm");
  await env.DB.prepare("INSERT INTO machines (id, user_id, org_id, machine_number, name, token_hash, token) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, userID, orgID || null, machineNumber, cleanText(name, 80), await sha256(token), token).run();
  return { machine_number: machineNumber, name: cleanText(name, 80), token, profile: profileRef };
}

async function machineRows(env, userID) {
  return env.DB.prepare(`
    SELECT
      m.machine_number,
      m.name,
      m.created_at,
      m.last_seen_at,
      m.token,
      m.org_id,
      oa.account_number AS org_account_number,
      oh.handle AS org_handle,
      oa.display_name AS org_display_name
    FROM machines m
    LEFT JOIN accounts oa ON oa.id = m.org_id
    LEFT JOIN handles oh ON oh.account_id = oa.id
    WHERE m.user_id = ?
    ORDER BY m.created_at DESC
  `).bind(userID).all();
}

function machineCanSyncToAccount(machine, account) {
  if (account.kind === "user") return account.id === machine.user_id && !machine.org_id;
  if (account.kind === "org") return account.id === machine.org_id;
  return false;
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
  return layout("Burnfolio — Show your burn", `
    <main class="landing">
      <section class="hero">
        <div class="hero-copy">
        <p class="eyebrow">Burn graph for AI-native builders</p>
        <h1>Show your burn.</h1>
        <p class="lede">The contribution graph for everything you build with AI. Install <code>pyro</code>, sync token counts, and share a graph worth showing off.</p>
        <form class="signup" method="post" action="/api/signup" data-signup>
          <label class="sr-only" for="signup-machine">Machine name</label>
          <input id="signup-machine" name="machine_name" placeholder="machine name" autocomplete="off">
          <button>Show your burn</button>
        </form>
        <p class="helper">Counts, not content. No prompts, code, or transcripts leave your machine.</p>
        <div class="result" data-result hidden></div>
        </div>
        <section class="preview">
          <div class="preview-top">
            <div><span>Public burn graph</span><strong>8.4B sample tokens</strong></div>
          </div>
          ${heatmap(sampleDays(), { span: 365, title: "Last 365 days", subtitle: "Sample burn graph" })}
          <div class="steps">
            <span>Create a profile</span>
            <span>Run <code>pyro</code></span>
            <span>Share the graph</span>
          </div>
        </section>
      </section>
      <section class="auth-panel">
        <details>
          <summary>Already have an account?</summary>
          <div class="auth-grid">
            <section>
              <h2>Email sign-in</h2>
              <p class="muted">Use a magic link if you attached an email.</p>
              <form data-login><label class="sr-only" for="login-email">Email</label><input id="login-email" name="email" placeholder="email for magic link" autocomplete="email"><button class="secondary">Send magic link</button></form>
          <pre class="result" data-login-result hidden></pre>
            </section>
            <section>
              <h2>Anonymous sign-in</h2>
              <p class="muted">Use the account number and key from signup.</p>
              <form data-account-login><label class="sr-only" for="account-number">Account number</label><input id="account-number" name="account_number" placeholder="account number"><label class="sr-only" for="account-key">Account key</label><input id="account-key" name="account_key" placeholder="account key"><button class="secondary">Sign in</button></form>
          <pre class="result" data-account-login-result hidden></pre>
            </section>
          </div>
        </details>
      </section>
    </main>
    <script>${signupScript()}</script>
  `, {
    description: "The contribution graph for everything you build with AI. Install pyro, sync token counts, and show your burn.",
    image: "https://burnfolio.ai/og/landing.png",
    imageType: "image/png",
    canonical: "https://burnfolio.ai/",
  });
}

async function appPage(request, env) {
  const user = await requireUser(request, env);
  if (!user) return homePage();
  const account = await accountView(env, user.id);
  const userInfo = await env.DB.prepare("SELECT email, email_verified_at FROM users WHERE id = ?").bind(user.id).first();
  const machines = await machineRows(env, user.id);
  const orgs = await env.DB.prepare(`
    SELECT a.account_number, h.handle, a.display_name, m.role
    FROM memberships m
    JOIN accounts a ON a.id = m.org_id
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE m.user_id = ?
    ORDER BY a.created_at DESC
  `).bind(user.id).all();
  const profileRef = account.handle || account.account_number;
  const machineScope = orgs.results.length
    ? `<select name="org" aria-label="Machine scope"><option value="">Personal profile</option>${orgs.results.map((org) => `<option value="${esc(accountRef(org))}">${esc(org.display_name || accountRef(org))}</option>`).join("")}</select>`
    : "";
  const profileHelp = account.handle ? "Manage your public identity and recovery email." : "Claim a readable username and attach an email for recovery.";
  const handleControl = account.handle
    ? `<div class="profile-field"><span>Username</span><strong>${esc(account.handle)}</strong></div>`
    : `<form class="form-stack" data-handle><label for="profile-handle">Username</label><div class="form-row"><input id="profile-handle" name="handle" placeholder="claim username"><button>Save</button></div></form>`;
  return layout("Burnfolio app", `
    <main class="dash">
      <header class="dash-head">
        <div><p class="eyebrow">Dashboard</p><h1>${esc(account.handle || "Anonymous builder")}</h1><p class="muted">Account <code>${esc(account.account_number)}</code>${userInfo.email ? ` · ${esc(userInfo.email)}${userInfo.email_verified_at ? " verified" : " unverified"}` : ""}</p></div>
        <div class="actions"><a class="button secondary" href="/${esc(profileRef)}">Public profile</a><button class="secondary" data-logout>Log out</button></div>
      </header>
      <div class="dash-grid">
        <section class="panel primary-panel">
          <div class="section-head"><div><h2>Connect a machine</h2><p class="muted">Create a token, then copy the generated install command.</p></div></div>
          <form class="form-row" data-machine><label class="sr-only" for="machine-name">Machine name</label><input id="machine-name" name="name" placeholder="machine name, e.g. macbook-pro">${machineScope}<button>Create token</button></form>
          <div class="result" data-machine-result hidden></div>
          <div class="list">${machines.results.map((machine) => machineRow(machine, profileRef)).join("") || emptyState("No machines connected", "Create a token and sync with pyro to start filling your burn graph.")}</div>
          <details class="utility-disclosure">
            <summary>Uninstall pyro</summary>
            <p class="muted">This removes the local binary and any Burnfolio cron sync entries.</p>
            <div class="snippet"><div><span>Uninstall command</span><button type="button" class="secondary copy" data-copy="${esc(uninstallCommand())}">Copy</button></div><code>${esc(uninstallCommand())}</code></div>
          </details>
        </section>
        <section class="panel">
          <div class="section-head"><div><h2>Profile</h2><p class="muted">${esc(profileHelp)}</p></div></div>
          ${handleControl}
          <form class="form-stack" data-email><label for="profile-email">Email</label><div class="form-row"><input id="profile-email" name="email" placeholder="optional email for magic links" autocomplete="email"><button class="secondary">Add email</button></div></form>
          <pre class="result" data-email-result hidden></pre>
        </section>
        <section class="panel">
          <div class="section-head"><div><h2>Organizations</h2><p class="muted">Create org profiles and aggregate member token burn.</p></div></div>
          <form class="form-stack" data-org><label for="org-handle">New organization</label><div class="form-row"><input id="org-handle" name="handle" placeholder="org username"><input name="name" placeholder="display name"><button>Create</button></div></form>
          <pre class="result" data-org-result hidden></pre>
          <div class="list">${orgs.results.map(orgRow).join("") || emptyState("No organizations yet", "Create an org when you want a shared burn graph for a team.")}</div>
        </section>
      </div>
    </main>
    <script>${dashboardScript(profileRef)}</script>
  `);
}

function machineRow(machine, fallbackProfileRef) {
  const profileRef = machine.org_handle || machine.org_account_number || fallbackProfileRef;
  const scope = machine.org_id ? `org ${machine.org_display_name || profileRef}` : "personal profile";
  const action = machine.token
    ? `<button type="button" class="secondary copy" data-copy="${esc(installCommand(profileRef, machine.token))}">Copy install</button>`
    : `<button type="button" class="secondary copy" data-refresh-machine="${esc(machine.machine_number)}">Generate token + copy</button><span class="row-note">Creates a replacement token for this machine.</span>`;
  return `<div class="row machine-row"><div><strong>${esc(machine.name || machine.machine_number)}</strong><span>${esc(machine.machine_number)} · ${esc(scope)}${machine.last_seen_at ? ` · seen ${esc(formatDate(machine.last_seen_at.slice(0, 10)))}` : " · never synced"}</span></div><div class="row-actions">${action}</div></div>`;
}

function orgRow(org) {
  const ref = org.handle || org.account_number;
  const adminForm = org.role === "admin" ? `<form class="member-form" data-add-member data-org="${esc(ref)}"><label class="sr-only" for="member-${esc(ref)}">User account or username</label><input id="member-${esc(ref)}" name="user" placeholder="user account or username"><select name="role"><option value="member">member</option><option value="admin">admin</option></select><button>Add</button></form>` : "";
  return `<div class="row"><div><strong><a href="/${esc(ref)}">${esc(ref)}</a></strong><span>${esc(org.display_name || "Organization")} · ${esc(org.role)}</span></div>${adminForm}</div>`;
}

function installCommand(profile, machine) {
  return `curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/install.sh | bash -s -- --profile ${profile} --machine ${machine}`;
}

function uninstallCommand() {
  return "curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/uninstall.sh | bash";
}

function accountRef(account) {
  return account.handle || account.account_number;
}

function profileHtml(profile) {
  const name = profile.account.handle || profile.account.account_number;
  const hasHandle = Boolean(profile.account.handle);
  const hasLabel = Boolean(profile.account.display_name && profile.account.display_name !== "Anonymous builder" && profile.account.display_name !== profile.account.account_number);
  const displayName = hasHandle ? profile.account.handle : hasLabel ? profile.account.display_name : profile.account.account_number;
  const stats = profile.stats;
  const scriptSnippet = `<script src="https://burnfolio.ai/embed/${name}/script.js"></script>`;
  const svgSnippet = `<img src="https://burnfolio.ai/embed/${name}.svg" alt="Burnfolio token burn graph">`;
  const markdownSnippet = `[![Burnfolio token burn graph](https://burnfolio.ai/embed/${name}.svg)](https://burnfolio.ai/${name})`;
  const profileURL = `https://burnfolio.ai/${name}`;
  const description = `${formatInt(profile.total_tokens)} tokens burned across ${formatInt(stats.active_days)} active days. Show your burn on Burnfolio.`;
  return layout(`${name} on Burnfolio`, `
    <main class="profile">
      <header class="profile-head">
        <div>
          <div class="badges"><span>${esc(profile.account.kind)} profile</span>${hasHandle || hasLabel ? "" : `<span>anonymous</span>`}</div>
          <h1>${esc(displayName)}</h1>
          <p>${formatInt(profile.total_tokens)} tokens burned across ${formatInt(stats.active_days)} active days</p>
        </div>
        <div class="actions"><button class="secondary" data-copy="${esc(profileURL)}">Copy link</button></div>
      </header>
      <section class="stats">
        ${statCard("Total burn", formatCompact(profile.total_tokens), `${formatInt(profile.total_tokens)} exact`)}
        ${statCard("Active days", formatInt(stats.active_days))}
        ${statCard("Best day", formatCompact(stats.best_day_tokens), stats.best_day ? formatDate(stats.best_day) : "No activity yet")}
        ${statCard("Current streak", formatInt(stats.current_streak_days))}
      </section>
      ${heatmap(profile.days, { title: "Last 365 days", subtitle: `${formatInt(stats.last_365_tokens)} tokens burned` })}
      ${heatmapTimeline(profile.days, { title: "All-time by year", subtitle: "Grouped by calendar year" })}
      <details class="embed-disclosure">
        <summary>Embed or share this graph</summary>
        <div class="snippets">
          ${snippet("Iframe script", scriptSnippet)}
          ${snippet("Static SVG", svgSnippet)}
          ${snippet("GitHub Markdown", markdownSnippet)}
        </div>
      </details>
    </main>
  `, {
    description,
    image: `https://burnfolio.ai/og/${encodeURIComponent(name)}.svg`,
    imageType: "image/svg+xml",
    canonical: profileURL,
    siteName: "Burnfolio",
  });
}

function embedHtml(profile) {
  const name = profile.account.handle || profile.account.account_number;
  const scale = heatmapScale(profile.days);
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css()}</style><div class="embed"><div><strong>${esc(name)}</strong><span>${formatInt(profile.total_tokens)} tokens</span></div>${heatmap(profile.days, { compact: true, subtitle: `${formatInt(profile.stats.active_days)} active days`, scale })}</div><script>${globalScript()}</script>`;
}

function svgEmbed(profile) {
  const name = profile.account.handle || profile.account.account_number;
  const cells = heatmapCellData(profile.days, 365, heatmapScale(profile.days));
  const cellSize = 10;
  const gap = 4;
  const left = 22;
  const top = 62;
  const colors = ["#2A2017", "#7A3D12", "#C0590F", "#F2611C", "#FF8A3D"];
  const rects = cells.map((cell, i) => {
    const x = left + Math.floor(i / 7) * (cellSize + gap);
    const y = top + (i % 7) * (cellSize + gap);
    return `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${colors[cell.level]}"><title>${esc(cell.date)}: ${formatInt(cell.value)}</title></rect>`;
  }).join("");
  const width = left * 2 + 53 * (cellSize + gap);
  const height = 184;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(name)} Burnfolio token burn graph">
  <rect width="100%" height="100%" rx="8" fill="#1C140D"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="8" fill="none" stroke="#3A2A1B"/>
  <text x="22" y="30" fill="#FBF1E6" font-family="Bricolage Grotesque, ui-sans-serif, system-ui, sans-serif" font-size="16" font-weight="700">${esc(name)}</text>
  <text x="22" y="50" fill="#BBA68E" font-family="Space Mono, ui-monospace, monospace" font-size="12">${formatInt(profile.total_tokens)} tokens burned · ${formatInt(profile.stats.active_days)} active days</text>
  ${rects}
  <text x="22" y="164" fill="#BBA68E" font-family="Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif" font-size="11">Less</text>
  <rect x="55" y="155" width="10" height="10" rx="2" fill="${colors[0]}"/>
  <rect x="70" y="155" width="10" height="10" rx="2" fill="${colors[1]}"/>
  <rect x="85" y="155" width="10" height="10" rx="2" fill="${colors[2]}"/>
  <rect x="100" y="155" width="10" height="10" rx="2" fill="${colors[3]}"/>
  <rect x="115" y="155" width="10" height="10" rx="2" fill="${colors[4]}"/>
  <text x="132" y="164" fill="#BBA68E" font-family="Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif" font-size="11">More</text>
  <text x="${width - 22}" y="164" text-anchor="end" fill="#FF8A3D" font-family="Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif" font-size="11" font-weight="700">burnfolio.ai</text>
</svg>`;
}

function ogProfileSVG(profile) {
  const ref = profile.account.handle || profile.account.account_number;
  const displayName = profile.account.handle || profile.account.display_name || profile.account.account_number;
  const cells = heatmapCellData(profile.days, 365, heatmapScale(profile.days));
  const colors = ["#F2E7D9", "#FBD089", "#F99B3C", "#F2611C", "#D6300B"];
  const cell = 10;
  const gap = 4;
  const left = 86;
  const top = 318;
  const rects = cells.map((day, i) => {
    const x = left + Math.floor(i / 7) * (cell + gap);
    const y = top + (i % 7) * (cell + gap);
    return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${colors[day.level]}"/>`;
  }).join("");
  const best = profile.stats.best_day ? `Best day ${formatCompact(profile.stats.best_day_tokens)}` : "Install pyro to light it up";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${esc(displayName)} Burnfolio burn graph">
  <defs>
    <radialGradient id="warmA" cx="88%" cy="0%" r="70%"><stop offset="0" stop-color="#FFC23D" stop-opacity=".36"/><stop offset="1" stop-color="#FFF9F2" stop-opacity="0"/></radialGradient>
    <radialGradient id="warmB" cx="0%" cy="8%" r="68%"><stop offset="0" stop-color="#F2611C" stop-opacity=".18"/><stop offset="1" stop-color="#FFF9F2" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="#FFF9F2"/>
  <rect width="1200" height="630" fill="url(#warmA)"/>
  <rect width="1200" height="630" fill="url(#warmB)"/>
  <g transform="translate(84 70)">
    <path fill="#F2611C" d="M43.9 5.8C46.2 18.7 49.1 25.1 54.9 33.9C60.2 42.1 61.4 52 56.1 59.6C50.3 67.8 40.3 70.2 33.8 69C22.6 67.3 13.8 59.1 13.3 46.7C12.7 37.3 19.2 32 25 25C28.5 20.9 30.2 16.8 29.7 10.9C33.8 16.8 37.9 16.2 38.5 8.6C40.3 12.7 42 10.3 43.9 5.8Z"/>
    <path fill="#FFC23D" d="M40.3 35C41.4 42 44.4 45.5 46.7 50.8C49.1 56.1 47.3 62.5 41.4 64.9C36.2 67 29.7 65.5 26.8 60.8C23.8 56.1 25 50.2 29.1 45.5C32.1 42 33.8 38.5 33.2 33.8C36.2 37.9 37.9 36.7 38.5 32C39.1 33.8 39.7 33.8 40.3 35Z"/>
    <text x="84" y="48" fill="#211405" font-family="Bricolage Grotesque, Arial, sans-serif" font-size="42" font-weight="800" letter-spacing="-.8">Burnfolio</text>
  </g>
  <text x="86" y="202" fill="#A83505" font-family="Space Mono, monospace" font-size="18" font-weight="700" letter-spacing="2">SHOW YOUR BURN</text>
  <text x="84" y="270" fill="#211405" font-family="Bricolage Grotesque, Arial, sans-serif" font-size="58" font-weight="800" letter-spacing="-1.6">${esc(displayName)}</text>
  <text x="86" y="540" fill="#211405" font-family="Space Mono, monospace" font-size="28" font-weight="700">${formatInt(profile.total_tokens)} tokens</text>
  <text x="430" y="540" fill="#6F5F4D" font-family="Space Mono, monospace" font-size="22">${formatInt(profile.stats.active_days)} active days · ${esc(best)}</text>
  ${rects}
  <text x="1116" y="557" text-anchor="end" fill="#A83505" font-family="Plus Jakarta Sans, Arial, sans-serif" font-size="22" font-weight="700">burnfolio.ai/${esc(ref)}</text>
</svg>`;
}

function ogLandingFallbackSVG(message) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#FFF9F2"/><text x="80" y="320" fill="#211405" font-family="Arial, sans-serif" font-size="56" font-weight="700">${esc(message)}</text></svg>`;
}

function notFoundPage() {
  return layout("Not found", `<main class="profile"><h1>Profile not found</h1><a href="/">Create one</a></main>`);
}

function authResultPage(message, ok) {
  return layout(ok ? "Signed in" : "Sign in failed", `<main class="profile"><p class="eyebrow">${ok ? "Success" : "Link error"}</p><h1>${esc(message)}</h1><a href="/app">Open dashboard</a></main>`);
}

function layout(title, body, meta = {}) {
  const description = meta.description || "Burnfolio turns your AI token burn into a contribution graph worth sharing.";
  const canonical = meta.canonical || "https://burnfolio.ai";
  const image = meta.image || "https://burnfolio.ai/og/landing.png";
  const imageType = meta.imageType || "image/png";
  const siteName = meta.siteName || "Burnfolio";
  return `<!doctype html><html lang="en" class="brand-burnfolio"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(siteName)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:type" content="${esc(imageType)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<style>${css()}</style></head><body><nav><a class="nav-brand" href="/"><img src="/assets/logo.svg" alt="" width="28" height="28"><span>Burnfolio</span></a><a href="/app">App</a></nav>${body}<script>${globalScript()}</script></body></html>`;
}

function heatmap(days, options = {}) {
  const scale = options.scale || heatmapScale(days);
  const data = heatmapCellData(days, options.span || 365, scale);
  const cells = data.map((cell) => heatmapCell(cell));
  const classes = ["graph", options.compact ? "compact" : "", options.fit ? "fit" : ""].filter(Boolean).join(" ");
  return `<section class="${classes}">
    ${options.title ? `<div class="graph-head"><div><h2>${esc(options.title)}</h2>${options.subtitle ? `<p>${esc(options.subtitle)}</p>` : ""}</div>${legend()}</div>` : `<div class="graph-head small">${options.subtitle ? `<p>${esc(options.subtitle)}</p>` : ""}${legend()}</div>`}
    <div class="heatmap-scroll">${heatmapFrame(data, cells.join(""), "Token burn by day")}</div>
  </section>`;
}

function heatmapCellData(days, span = 365, scale = heatmapScale(days)) {
  const byDate = new Map(days.map((d) => [d.date_utc, d.total_tokens]));
  const today = new Date();
  const cells = [];
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const date = d.toISOString().slice(0, 10);
    const value = byDate.get(date) || 0;
    cells.push({ date, value, level: level(value, scale) });
  }
  return cells;
}

function heatmapTimeline(days, options = {}) {
  const years = heatmapYears(days);
  const scale = options.scale || heatmapScale(days);
  return `<section class="graph timeline">
    <div class="graph-head"><div><h2>${esc(options.title || "Token burn timeline")}</h2>${options.subtitle ? `<p>${esc(options.subtitle)}</p>` : ""}</div>${legend()}</div>
    <div class="timeline-years">${years.map((year) => {
      const data = yearHeatmapCellData(days, year, scale);
      const cells = data.map((cell) => heatmapCell(cell)).join("");
      const total = days.filter((day) => day.date_utc.startsWith(String(year))).reduce((sum, day) => sum + day.total_tokens, 0);
      return `<section class="year-row"><div class="year-label"><strong>${year}</strong><span>${formatInt(total)} tokens</span></div><div class="heatmap-scroll">${heatmapFrame(data, cells, `Token burn by day in ${year}`, "year-heatmap")}</div></section>`;
    }).join("")}</div>
  </section>`;
}

function heatmapYears(days) {
  const currentYear = new Date().getUTCFullYear();
  let minYear = currentYear;
  for (const day of days) {
    const year = Number(String(day.date_utc || "").slice(0, 4));
    if (Number.isFinite(year) && year > 2000) minYear = Math.min(minYear, year);
  }
  const years = [];
  for (let year = currentYear; year >= minYear; year--) years.push(year);
  return years;
}

function yearHeatmapCellData(days, year, scale = heatmapScale(days)) {
  const byDate = new Map(days.map((d) => [d.date_utc, d.total_tokens]));
  const cells = [];
  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const first = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31));
  const last = year === todayUTC.getUTCFullYear() ? todayUTC : yearEnd;
  for (let i = 0; i < first.getUTCDay(); i++) cells.push({ empty: true });
  for (let d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const value = byDate.get(date) || 0;
    cells.push({ date, value, level: level(value, scale) });
  }
  if (year !== todayUTC.getUTCFullYear()) {
    while (cells.length % 7 !== 0) cells.push({ empty: true });
  }
  return cells;
}

function heatmapCell(cell) {
  if (cell.empty) return `<span class="cell empty" aria-hidden="true"></span>`;
  const tip = `${cell.date}: ${formatInt(cell.value)} tokens`;
  return `<span title="${esc(tip)}" data-tip="${esc(tip)}" class="cell l${cell.level}" role="img" aria-label="${esc(tip)}"></span>`;
}

function heatmapFrame(data, cells, label, extraClass = "") {
  const months = monthLabels(data);
  const frameClass = ["heatmap-frame", extraClass ? `${extraClass}-frame` : ""].filter(Boolean).join(" ");
  return `<div class="${frameClass}">
    <div class="month-labels" aria-hidden="true">${months.map((month) => `<span style="grid-column:${month.column}">${esc(month.label)}</span>`).join("")}</div>
    <div class="weekday-labels" aria-hidden="true"><span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span></div>
    <div class="heatmap ${extraClass}" aria-label="${esc(label)}">${cells}</div>
  </div>`;
}

function monthLabels(data) {
  const labels = [];
  let seen = "";
  for (let i = 0; i < data.length; i++) {
    const cell = data[i];
    if (!cell.date) continue;
    const d = new Date(`${cell.date}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.getUTCDate() !== 1) continue;
    const month = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (key === seen) continue;
    seen = key;
    labels.push({ label: month, column: Math.floor(i / 7) + 1 });
  }
  return labels;
}

function legend() {
  return `<div class="legend"><span>Less</span><i class="cell l0"></i><i class="cell l1"></i><i class="cell l2"></i><i class="cell l3"></i><i class="cell l4"></i><span>More</span></div>`;
}

function statCard(label, value, detail = "") {
  return `<div><span>${esc(label)}</span><strong>${esc(value)}</strong>${detail ? `<em>${esc(detail)}</em>` : ""}</div>`;
}

function snippet(label, code) {
  return `<div class="snippet"><div><span>${esc(label)}</span><button type="button" class="secondary copy" data-copy="${esc(code)}">Copy</button></div><code>${esc(code)}</code></div>`;
}

function emptyState(title, body) {
  return `<div class="empty-state"><strong>${esc(title)}</strong><span>${esc(body)}</span></div>`;
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function formatCompact(value) {
  const n = Number(value || 0);
  if (n >= 1000000000000) return `${trimNumber(n / 1000000000000)}T`;
  if (n >= 1000000000) return `${trimNumber(n / 1000000000)}B`;
  if (n >= 1000000) return `${trimNumber(n / 1000000)}M`;
  if (n >= 1000) return `${trimNumber(n / 1000)}K`;
  return formatInt(n);
}

function trimNumber(value) {
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1).replace(/\.0$/, "") : value.toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
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

function heatmapScale(days) {
  const values = days.map((day) => int(day.total_tokens)).filter((value) => value > 0).sort((a, b) => a - b);
  if (!values.length) return { min: 0, max: 0 };
  return { min: values[0], max: values[values.length - 1] };
}

function level(value, scale = null) {
  if (value <= 0) return 0;
  const min = int(scale && scale.min);
  const max = int(scale && scale.max);
  if (max <= min) return 4;
  const ratio = (value - min) / (max - min);
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function css() {
  return "/* Built CSS is injected into dist/worker/index.js by scripts/build-worker.mjs. */";
}

function assetData() {
  return {};
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
    function messageFor(data) {
      const messages = {
        invalid_email: "Enter a valid email address.",
        email_send_failed: "The email could not be sent. Try again shortly.",
        missing_account_credentials: "Enter both the account number and account key.",
        invalid_account_credentials: "The account number or account key is incorrect.",
        handle_unavailable: "That username is already taken."
      };
      return messages[data && data.error] || "Something went wrong. Check the inputs and try again.";
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
        result.textContent = messageFor(data);
        return;
      }
      const profile = data.account.handle || data.account.account_number;
      const command = "curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/install.sh | bash -s -- --profile " + profile + " --machine " + data.machine.token;
      setupResult(result, [
        { label: "Account number", value: data.account.account_number },
        { label: "Account key", value: data.account_key },
        { label: "Machine token", value: data.machine.token },
        { label: "Install + sync command", value: command }
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
      result.textContent = res.ok ? "Magic link sent. Check your email." : messageFor(data);
    });
    document.querySelector("[data-account-login]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const result = document.querySelector("[data-account-login-result]");
      const body = Object.fromEntries(new FormData(form).entries());
      const res = await fetch("/api/account-login", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      result.hidden = false;
      result.textContent = res.ok ? "Signed in. Opening dashboard..." : messageFor(data);
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
    function machineResult(target, machine) {
      target.hidden = false;
      target.innerHTML = "";
      const box = document.createElement("section");
      box.className = "setup";
      const heading = document.createElement("h2");
      heading.textContent = "Machine token created";
      const profile = machine.profile || profileRef;
      const command = "curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/install.sh | bash -s -- --profile " + profile + " --machine " + machine.token;
      box.append(heading, secretRow("Machine token", machine.token), secretRow("Install + sync command", command));
      target.appendChild(box);
    }
    function messageFor(data) {
      const messages = {
        unauthorized: "Your session expired. Sign in again.",
        invalid_handle: "Choose a username with 3-32 letters, numbers, underscores, or hyphens.",
        handle_unavailable: "That username is already taken.",
        invalid_email: "Enter a valid email address.",
        email_already_claimed: "That email is already attached to another account.",
        email_send_failed: "The email could not be sent. Try again shortly.",
        org_handle_unavailable: "That organization username is already taken.",
        org_not_found: "Organization not found.",
        machine_not_found: "That machine was not found.",
        forbidden: "Only org admins can add members.",
        user_not_found: "No user was found for that account or username."
      };
      return messages[data && data.error] || "Something went wrong. Check the inputs and try again.";
    }
    async function post(form, url) {
      const body = Object.fromEntries(new FormData(form).entries());
      const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      return { ok: res.ok, data };
    }
    async function copyText(value, button) {
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Select";
      }
      setTimeout(() => button.textContent = button.dataset.label || "Copy", 1200);
    }
    document.querySelector("[data-machine]").addEventListener("submit", async e => { e.preventDefault(); const { ok, data } = await post(e.currentTarget, "/api/machines"); const out = document.querySelector("[data-machine-result]"); ok && data.machine ? machineResult(out, data.machine) : (out.hidden = false, out.textContent = messageFor(data)); });
    document.querySelectorAll("[data-refresh-machine]").forEach(button => {
      button.dataset.label = button.textContent;
      button.addEventListener("click", async () => {
        if (!button.dataset.refreshMachine) {
          await copyText(button.dataset.copy || "", button);
          return;
        }
        const original = button.dataset.label || button.textContent;
        button.disabled = true;
        button.textContent = "Generating...";
        try {
          const res = await fetch("/api/machines/" + encodeURIComponent(button.dataset.refreshMachine) + "/token", { method:"POST" });
          const data = await res.json();
          if (!res.ok || !data.machine) throw data;
          const command = "curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/install.sh | bash -s -- --profile " + data.machine.profile + " --machine " + data.machine.token;
          button.dataset.copy = command;
          button.removeAttribute("data-refresh-machine");
          button.dataset.label = "Copy install";
          button.textContent = "Copy install";
          const note = button.parentElement && button.parentElement.querySelector(".row-note");
          if (note) note.remove();
          await copyText(command, button);
        } catch (error) {
          button.textContent = "Try again";
          alert(messageFor(error));
          setTimeout(() => button.textContent = original, 1400);
        } finally {
          button.disabled = false;
        }
      });
    });
    document.querySelector("[data-handle]")?.addEventListener("submit", async e => { e.preventDefault(); const { ok, data } = await post(e.currentTarget, "/api/handles"); ok ? location.reload() : alert(messageFor(data)); });
    document.querySelector("[data-email]").addEventListener("submit", async e => { e.preventDefault(); const { ok, data } = await post(e.currentTarget, "/api/email"); const out = document.querySelector("[data-email-result]"); out.hidden = false; out.textContent = ok ? "Verification link sent. Check your email." : messageFor(data); });
    document.querySelector("[data-org]").addEventListener("submit", async e => { e.preventDefault(); const { ok, data } = await post(e.currentTarget, "/api/orgs"); const out = document.querySelector("[data-org-result]"); ok && data.org ? location.reload() : (out.hidden = false, out.textContent = messageFor(data)); });
    document.querySelectorAll("[data-add-member]").forEach(form => form.addEventListener("submit", async e => { e.preventDefault(); const { ok, data } = await post(e.currentTarget, "/api/orgs/" + e.currentTarget.dataset.org + "/members"); ok ? location.reload() : alert(messageFor(data)); }));
    document.querySelector("[data-logout]").addEventListener("click", async () => { await fetch("/api/logout", { method:"POST" }); location.href = "/"; });
  `;
}

function sampleDays() {
  const today = new Date();
  const days = [];
  for (let i = 364; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const weekday = d.getUTCDay();
    const pulse = ((i * 37) + (weekday * 19)) % 101;
    const isWorkingDay = weekday > 0 && weekday < 6;
    const active = isWorkingDay ? pulse > 17 : pulse > 72;
    const total = active ? Math.round((pulse ** 2.35) * 8200 + (weekday + 1) * 180000) : 0;
    days.push({ date_utc: d.toISOString().slice(0, 10), total_tokens: total });
  }
  return days;
}

function globalScript() {
  return `
    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copy || "");
          button.textContent = "Copied";
        } catch {
          button.textContent = "Select";
        }
        setTimeout(() => button.textContent = "Copy", 1200);
      });
    });
    const tip = document.createElement("div");
    tip.className = "burn-tooltip";
    tip.hidden = true;
    document.body.appendChild(tip);
    function showTip(event) {
      const target = event.target.closest("[data-tip]");
      if (!target) return;
      tip.textContent = target.dataset.tip;
      tip.hidden = false;
      const rect = target.getBoundingClientRect();
      tip.style.left = rect.left + rect.width / 2 + "px";
      tip.style.top = rect.top - 8 + "px";
    }
    function hideTip() {
      tip.hidden = true;
    }
    document.addEventListener("mouseover", showTip);
    document.addEventListener("focusin", showTip);
    document.addEventListener("mouseout", (event) => { if (event.target.closest("[data-tip]")) hideTip(); });
    document.addEventListener("focusout", (event) => { if (event.target.closest("[data-tip]")) hideTip(); });
  `;
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

function svgResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function assetResponse(name) {
  const asset = assetData()[name];
  if (!asset) return new Response("Not found", { status: 404 });
  const headers = {
    "Content-Type": asset.type,
    "Cache-Control": "public, max-age=31536000, immutable",
  };
  if (asset.encoding === "base64") {
    const binary = atob(asset.body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Response(bytes, { headers });
  }
  return new Response(asset.body, { headers });
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
      text: magicEmailText(link),
      html: magicEmailHtml(link),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function magicEmailText(link) {
  return `Sign in to Burnfolio\n\nUse this link to open your burn graph dashboard. It expires in 15 minutes.\n\n${link}\n\nIf you did not request this email, you can ignore it.`;
}

function magicEmailHtml(link) {
  const safeLink = esc(link);
  return `<!doctype html>
<html>
  <body style="margin:0;background:#FFF9F2;color:#211405;font-family:Plus Jakarta Sans,Segoe UI,Arial,sans-serif">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF9F2;padding:32px 16px">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;border:1px solid #EEDDCB;border-radius:18px;background:#FFFCF7;overflow:hidden">
            <tr>
              <td style="padding:28px 28px 10px;border-top:4px solid #F2611C">
                <div style="font-size:18px;font-weight:800;color:#211405">Burnfolio</div>
                <h1 style="margin:28px 0 10px;font-size:30px;line-height:1.08;color:#211405;font-family:Bricolage Grotesque,Segoe UI,Arial,sans-serif">Open your burn graph</h1>
                <p style="margin:0;color:#6F5F4D;font-size:15px;line-height:1.55">This magic link signs you in to Burnfolio and expires in 15 minutes.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px">
                <a href="${safeLink}" style="display:inline-block;background:#F2611C;color:#211405;text-decoration:none;font-weight:800;border-radius:999px;padding:13px 18px">Sign in to Burnfolio</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 28px">
                <p style="margin:0 0 10px;color:#6F5F4D;font-size:13px;line-height:1.5">If the button does not work, paste this URL into your browser:</p>
                <p style="margin:0;padding:12px;border:1px solid #EEDDCB;border-radius:12px;background:#FBEFE0;color:#A83505;font-family:Space Mono,Consolas,monospace;font-size:12px;line-height:1.45;word-break:break-all">${safeLink}</p>
                <p style="margin:18px 0 0;color:#6F5F4D;font-size:12px;line-height:1.5">If you did not request this email, you can ignore it.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
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
