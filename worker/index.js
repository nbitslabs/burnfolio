const COOKIE_NAME = "bf_session";
const API_BODY_LIMIT = 1024 * 1024;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_SYNC_DAYS = 3000;
const MAX_TOKEN_FIELD = 1_000_000_000_000;
const MAX_RECORDS_PER_DAY = 1_000_000;
const MAX_SOURCE_ROWS_PER_DAY = 200;

const MIN_INGEST_DATE = "2020-01-01";
const DEFAULT_MAX_DAILY_TOKENS_PER_SOURCE = 100_000_000_000;
const OPENROUTER_ANALYTICS_URL = "https://openrouter.ai/api/v1/analytics/query";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_SYNC_SINCE = "2020-01-01";
const RESERVED_HANDLES = new Set([
  "app",
  "signup",
  "signin",
  "auth",
  "api",
  "assets",
  "embed",
  "og",
  "how-we-count",
  "how_we_count",
  "howwecount",
  "leaderboard",
  "badges",
  "vs",
  "install",
  "uninstall",
  "admin",
  "account",
  "accounts",
  "org",
  "orgs",
  "organization",
  "organizations",
  "settings",
  "support",
  "help",
  "docs",
  "pricing",
  "terms",
  "privacy",
  "security",
  "status",
  "burnfolio",
  "pyro",
]);

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      if (error && error.status) return json({ error: error.code || "bad_request" }, error.status);
      console.error(error);
      return json({ error: "internal_error" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncDueOpenRouterConnections(env));
    ctx.waitUntil(cleanupExpiredRecords(env));
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith("/api/") && tooLarge(request, API_BODY_LIMIT)) return json({ error: "request_too_large" }, 413);
  const originFailure = rejectCrossOrigin(request, path);
  if (originFailure) return originFailure;

  if (path === "/favicon.svg") return assetResponse("pyro.svg");
  if (path === "/favicon.ico") return assetResponse("pyro-512.png");
  if (path === "/apple-touch-icon.png") return assetResponse("pyro-512.png");
  if (path.match(/^\/assets\/[^/]+$/)) return assetResponse(path.split("/")[2]);
  if (path === "/og/landing.png") return assetResponse("og-landing.png");
  if (path.match(/^\/og\/[^/]+\.png$/)) return ogProfilePNGPage(env, decodeURIComponent(path.split("/")[2].slice(0, -4)));
  if (path.match(/^\/og\/[^/]+\.svg$/)) return ogProfilePage(env, decodeURIComponent(path.split("/")[2].slice(0, -4)));
  if (path === "/") return html(homePage(await signedIn(request, env), await globalStats(request, env), await platformStats(env), await cachedRecentActivity(env)));
  if (path === "/signup") return authRoute(request, env, "signup");
  if (path === "/signin") return authRoute(request, env, "signin");
  if (path === "/how-we-count") return html(howWeCountPage(await signedIn(request, env)));
  if (path === "/privacy") return html(privacyPage(await signedIn(request, env)));
  if (path === "/leaderboard") return leaderboardPage(request, env);
  if (path === "/badges") return badgesPage(request, env);
  if (path === "/api/leaderboard" && (request.method === "GET" || request.method === "HEAD")) return leaderboardRoute(request, env);
  if (path === "/app") return html(await appPage(request, env));
  if (path === "/app/orgs") return html(await orgsPage(request, env));
  if (path === "/api/signup" && request.method === "POST") return signup(request, env);
  if (path === "/api/account-login" && request.method === "POST") return accountLogin(request, env);
  if (path === "/api/magic-links" && request.method === "POST") return requestMagicLink(request, env);
  if (path === "/auth/magic" && (request.method === "GET" || request.method === "HEAD")) return magicLinkConfirmPage(request, env);
  if (path === "/auth/magic" && request.method === "POST") return consumeMagicLink(request, env);
  if (path === "/api/email" && request.method === "POST") return attachEmail(request, env);
  if (path === "/api/logout" && request.method === "POST") return logout(request, env);
  if (path === "/api/me" && request.method === "DELETE") return deleteAccountRoute(request, env);
  if (path === "/api/me") return me(request, env);
  if (path === "/api/me/usage.csv" && (request.method === "GET" || request.method === "HEAD")) return usageDailyCSVRoute(request, env);
  if (path === "/api/me/usage-breakdown.csv" && (request.method === "GET" || request.method === "HEAD")) return usageBreakdownCSVRoute(request, env);
  if (path === "/api/me/export.json" && (request.method === "GET" || request.method === "HEAD")) return meExportRoute(request, env);
  if (path === "/api/me/delete" && request.method === "POST") return deleteAccountRoute(request, env);
  if (path === "/api/global/stats" && (request.method === "GET" || request.method === "HEAD")) return globalStatsResponse(request, env);
  if (path === "/api/global/recent" && (request.method === "GET" || request.method === "HEAD")) return recentActivityRoute(request, env);
  if (path === "/api/handles" && request.method === "POST") return claimHandle(request, env);
  if (path === "/api/profile" && request.method === "PATCH") return updateUserProfileRoute(request, env);
  if (path === "/api/openrouter/ingest" && request.method === "POST") return ingestOpenRouter(request, env);
  if (path === "/api/openrouter/connections" && request.method === "POST") return connectOpenRouterRoute(request, env);
  if (path.match(/^\/api\/openrouter\/connections\/[^/]+$/) && request.method === "DELETE") return deleteOpenRouterConnectionRoute(request, env, decodeURIComponent(path.split("/")[4]));
  if (path.match(/^\/api\/openrouter\/connections\/[^/]+\/sync$/) && request.method === "POST") return syncOpenRouterConnectionRoute(request, env, decodeURIComponent(path.split("/")[4]));
  if (path === "/api/machines" && request.method === "POST") return createMachineRoute(request, env);
  if (path.match(/^\/api\/machines\/[^/]+\/token$/) && request.method === "POST") return rotateMachineTokenRoute(request, env, decodeURIComponent(path.split("/")[3]));
  if (path === "/api/orgs" && request.method === "POST") return createOrgRoute(request, env);
  if (path.match(/^\/api\/orgs\/[^/]+\/profile$/) && request.method === "PATCH") return updateOrgProfileRoute(request, env, path.split("/")[3]);
  if (path.match(/^\/api\/orgs\/[^/]+\/openrouter\/connections$/) && request.method === "POST") return connectOpenRouterRoute(request, env, path.split("/")[3]);
  if (path.match(/^\/api\/orgs\/[^/]+\/openrouter\/connections\/[^/]+$/) && request.method === "DELETE") return deleteOpenRouterConnectionRoute(request, env, decodeURIComponent(path.split("/")[6]), path.split("/")[3]);
  if (path.match(/^\/api\/orgs\/[^/]+\/openrouter\/connections\/[^/]+\/sync$/) && request.method === "POST") return syncOpenRouterConnectionRoute(request, env, decodeURIComponent(path.split("/")[6]), path.split("/")[3]);
  if (path.match(/^\/api\/orgs\/[^/]+\/members$/) && request.method === "POST") return addOrgMemberRoute(request, env, path.split("/")[3]);
  if (path.match(/^\/api\/orgs\/[^/]+\/members\/[^/]+$/) && request.method === "PATCH") return updateOrgMemberRoute(request, env, path.split("/")[3], decodeURIComponent(path.split("/")[5]));
  if (path.match(/^\/api\/orgs\/[^/]+\/members\/[^/]+$/) && request.method === "DELETE") return removeOrgMemberRoute(request, env, path.split("/")[3], decodeURIComponent(path.split("/")[5]));
  if (path.match(/^\/api\/orgs\/[^/]+\/invite\/accept$/) && request.method === "POST") return acceptOrgInviteRoute(request, env, decodeURIComponent(path.split("/")[3]));
  if (path.match(/^\/api\/orgs\/[^/]+\/invite\/decline$/) && request.method === "POST") return declineOrgInviteRoute(request, env, decodeURIComponent(path.split("/")[3]));
  if (path === "/api/ingest" && request.method === "POST") return ingest(request, env);
  if (path.match(/^\/api\/profiles\/[^/]+\/stats$/)) return profileStatsRoute(env, decodeURIComponent(path.split("/")[3]));
  if (path.match(/^\/embed\/[^/]+\.svg$/)) return embedSVGPage(request, env, decodeURIComponent(path.split("/")[2].slice(0, -4)));
  if (path.match(/^\/embed\/[^/]+$/)) return embedPage(request, env, decodeURIComponent(path.split("/")[2]));
  if (path.match(/^\/embed\/[^/]+\/script\.js$/)) return embedScript(request, decodeURIComponent(path.split("/")[2]));
  if (path.match(/^\/[A-Za-z0-9][A-Za-z0-9_-]{2,31}\/badges$/)) return profileBadgesPage(request, env, path.split("/")[1]);
  if (path.match(/^\/[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/)) return profilePage(request, env, path.slice(1));

  return html(notFoundPage(await signedIn(request, env)), 404);
}

async function signup(request, env) {
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("signup:ip", clientIP(request)), 5, 3600],
  ]);
  if (limited) return limited;

  const body = await readBody(request);
  if (cleanEmail(body.email)) return json({ error: "email_signup_requires_magic_link" }, 400);
  const rawHandle = body.username || body.handle;
  const handle = cleanHandle(rawHandle);
  if (String(rawHandle || "").trim() && !handle) return json({ error: "invalid_handle" }, 400);
  const user = await createUser(env, { email: "", handle });
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
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("account-login:ip", clientIP(request)), 20, 3600],
    [await rateKey("account-login:account", accountNumber), 10, 3600],
  ]);
  if (limited) return limited;

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

async function authRoute(request, env, mode) {
  const user = await requireUser(request, env);
  if (user) return redirect("/app");
  return html(authPage(mode));
}

async function requestMagicLink(request, env) {
  const body = await readBody(request);
  const email = cleanEmail(body.email);
  if (!email) return json({ error: "invalid_email" }, 400);
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("magic:ip", clientIP(request)), 10, 3600],
    [await rateKey("magic:email", email), 3, 3600],
  ]);
  if (limited) return limited;

  const existing = await userByVerifiedEmail(env, email);

  const token = randomToken("bfl");
  const tokenHash = await sha256(token);
  await env.DB.prepare(`
    INSERT INTO magic_links (token_hash, user_id, email, expires_at, purpose)
    VALUES (?, ?, ?, datetime('now', '+15 minutes'), 'login')
  `).bind(tokenHash, existing ? existing.id : null, email).run();

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
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("email:user", user.id), 10, 3600],
    [await rateKey("email:email", email), 3, 3600],
  ]);
  if (limited) return limited;

  const existing = await userByVerifiedEmail(env, email);
  if (existing && existing.id === user.id) return json({ ok: true, already_verified: true });
  if (existing && existing.id !== user.id) return json({ error: "email_already_claimed" }, 409);

  const token = randomToken("bfl");
  await env.DB.prepare(`
    INSERT INTO magic_links (token_hash, user_id, email, expires_at, purpose)
    VALUES (?, ?, ?, datetime('now', '+15 minutes'), 'attach')
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

async function magicLinkConfirmPage(request, env) {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!token) return html(authResultPage("Missing sign-in token.", false), 400);
  return html(magicLinkConfirmHtml(token));
}

function magicLinkConfirmHtml(token) {
  return layout("Confirm sign-in — Burnfolio", `
    <main class="profile">
      <p class="eyebrow">Almost there</p>
      <h1>Confirm your sign-in</h1>
      <p class="lede">Click continue to finish signing in to Burnfolio. This extra step keeps email scanners and link previews from signing in on your behalf.</p>
      <form method="POST" action="/auth/magic">
        <input type="hidden" name="token" value="${esc(token)}">
        <button class="button" type="submit">Continue to sign in</button>
      </form>
    </main>
  `);
}

async function consumeMagicLink(request, env) {
  const body = await readBody(request);
  const token = String(body.token || "").trim();
  if (!token) return html(authResultPage("Missing sign-in token.", false), 400);
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`
    SELECT user_id, email, COALESCE(purpose, 'login') AS purpose FROM magic_links
    WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > datetime('now')
  `).bind(tokenHash).first();
  if (!row) return html(authResultPage("This sign-in link is expired or already used.", false), 400);

  let targetUserID = row.user_id;
  if (row.purpose === "attach") {
    const current = await requireUser(request, env);
    if (!current || current.id !== row.user_id) {
      return html(authResultPage("Open this email link in the same browser where you requested it.", false), 403);
    }
    const existing = await userByVerifiedEmail(env, row.email);
    if (existing && existing.id !== row.user_id) {
      await env.DB.prepare("UPDATE magic_links SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE token_hash = ?").bind(tokenHash).run();
      return html(authResultPage("That email is already attached to another profile.", false), 409);
    }
  } else {
    const existing = await userByVerifiedEmail(env, row.email);
    if (existing) {
      targetUserID = existing.id;
    } else if (!targetUserID) {
      const created = await createUser(env, { email: "", handle: "" });
      if (created.error) return html(authResultPage("Could not create your profile. Try again.", false), 400);
      targetUserID = created.id;
    }
  }

  await verifyEmailForUser(env, targetUserID, row.email);
  const sessionToken = await createSession(env, targetUserID);
  await env.DB.batch([
    env.DB.prepare("UPDATE magic_links SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE token_hash = ?").bind(tokenHash),
  ]);
  return new Response(authResultPage("Signed in. Redirecting to your dashboard.", true), {
    status: 200,
    headers: {
      ...securityHeaders(CSP_DEFAULT),
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
  const memberships = await env.DB.prepare(`
    SELECT a.account_number, h.handle, a.display_name, m.role, m.status
    FROM memberships m
    JOIN accounts a ON a.id = m.org_id
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE m.user_id = ?
    ORDER BY a.created_at DESC
  `).bind(user.id).all();
  const rows = memberships.results || [];
  return json({
    account: await accountView(env, user.id),
    machines: machines.results,
    orgs: rows.filter((row) => row.status === "active"),
    invites: rows.filter((row) => row.status === "pending"),
  });
}

async function usageDailyCSVRoute(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const account = await accountView(env, user.id);
  const rows = await userDailyComponentRows(env, user.id);
  return csvResponse(usageDailyCSV(rows), csvFilename(account, "daily"));
}

async function usageBreakdownCSVRoute(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const account = await accountView(env, user.id);
  const rows = await userDailySourceRows(env, user.id);
  return csvResponse(usageBreakdownCSV(rows), csvFilename(account, "breakdown"));
}

// --- Self-serve export ---------------------------------------------------

async function exportEmails(env, userID) {
  const rows = await env.DB.prepare("SELECT email, verified_at, is_primary, created_at FROM user_emails WHERE user_id = ? ORDER BY created_at").bind(userID).all();
  return (rows.results || []).map((r) => ({ email: r.email, verified_at: r.verified_at, is_primary: Boolean(r.is_primary), created_at: r.created_at }));
}

async function exportMachines(env, userID) {
  const rows = await env.DB.prepare("SELECT machine_number, name, created_at, last_seen_at FROM machines WHERE user_id = ? ORDER BY created_at").bind(userID).all();
  return rows.results || [];
}

async function exportDailyMachineUsage(env, userID) {
  const rows = await env.DB.prepare(`
    SELECT m.machine_number, d.date_utc, d.records, d.input_tokens, d.cache_read_tokens, d.cache_write_tokens, d.output_tokens, d.reasoning_tokens, d.total_tokens, d.updated_at
    FROM daily_machine_usage d
    JOIN machines m ON m.id = d.machine_id
    WHERE d.user_id = ?
    ORDER BY d.date_utc, m.machine_number
  `).bind(userID).all();
  return rows.results || [];
}

async function exportDailyMachineSourceUsage(env, userID) {
  const rows = await env.DB.prepare(`
    SELECT m.machine_number, s.date_utc, s.cli, s.model, s.records, s.input_tokens, s.cache_read_tokens, s.cache_write_tokens, s.output_tokens, s.reasoning_tokens, s.total_tokens, s.updated_at
    FROM daily_machine_source_usage s
    JOIN machines m ON m.id = s.machine_id
    WHERE s.user_id = ?
    ORDER BY s.date_utc, m.machine_number, s.cli, s.model
  `).bind(userID).all();
  return rows.results || [];
}

async function exportOpenRouterUsage(env, accountID) {
  const rows = await env.DB.prepare(`
    SELECT openrouter_key_hash, date_utc, records, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, updated_at
    FROM openrouter_daily_usage WHERE account_id = ? ORDER BY date_utc
  `).bind(accountID).all();
  return rows.results || [];
}

async function exportOpenRouterModelUsage(env, accountID) {
  const rows = await env.DB.prepare(`
    SELECT openrouter_key_hash, date_utc, model, records, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, updated_at
    FROM openrouter_daily_model_usage WHERE account_id = ? ORDER BY date_utc, model
  `).bind(accountID).all();
  return rows.results || [];
}

// owner_user_id catches org-scoped connections this user connected; account_id catches their own personal ones.
async function exportOpenRouterConnections(env, userID, accountID) {
  const rows = await env.DB.prepare(`
    SELECT openrouter_key_hash, label, status, last_sync_at, last_error, created_at, updated_at
    FROM openrouter_connections WHERE owner_user_id = ? OR account_id = ?
  `).bind(userID, accountID).all();
  return rows.results || [];
}

async function exportMemberships(env, userID) {
  const rows = await env.DB.prepare(`
    SELECT a.account_number, h.handle, m.role, m.status, m.created_at
    FROM memberships m
    JOIN accounts a ON a.id = m.org_id
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE m.user_id = ?
  `).bind(userID).all();
  return (rows.results || []).map((r) => ({ org: r.handle || r.account_number, role: r.role, status: r.status, joined_at: r.created_at }));
}

async function buildUserExport(env, user) {
  const account = await accountView(env, user.id);
  const [emails, machines, dailyUsage, dailySourceUsage, orUsage, orModelUsage, orConnections, memberships] = await Promise.all([
    exportEmails(env, user.id),
    exportMachines(env, user.id),
    exportDailyMachineUsage(env, user.id),
    exportDailyMachineSourceUsage(env, user.id),
    exportOpenRouterUsage(env, account.id),
    exportOpenRouterModelUsage(env, account.id),
    exportOpenRouterConnections(env, user.id, account.id),
    exportMemberships(env, user.id),
  ]);
  return {
    generated_at: new Date().toISOString(),
    account: {
      account_number: account.account_number,
      handle: account.handle || null,
      kind: account.kind,
      display_name: account.display_name,
      bio: account.bio,
      website_url: account.website_url,
      github_url: account.github_url,
      x_url: account.x_url,
      show_model_breakdown: Boolean(account.show_model_breakdown),
      monthly_goal_tokens: account.monthly_goal_tokens === null || account.monthly_goal_tokens === undefined ? null : int(account.monthly_goal_tokens),
      created_at: account.created_at,
    },
    emails,
    machines,
    daily_machine_usage: dailyUsage,
    daily_machine_source_usage: dailySourceUsage,
    openrouter_daily_usage: orUsage,
    openrouter_daily_model_usage: orModelUsage,
    openrouter_connections: orConnections,
    org_memberships: memberships,
  };
}

async function meExportRoute(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const data = await buildUserExport(env, user);
  const ref = String((data.account.handle || data.account.account_number) || "burnfolio").replace(/[^a-zA-Z0-9_-]/g, "") || "burnfolio";
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="burnfolio-${ref}-export.json"`,
      "Cache-Control": "no-store",
    },
  });
}

// --- Account deletion ------------------------------------------------------
// No FK-cascade reliance: every referencing table is deleted explicitly, in
// dependency order, inside one atomic batch.

async function deleteAccountRoute(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const account = await accountView(env, user.id);
  if (!account) return json({ error: "unauthorized" }, 401);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const confirm = String(body.confirm || "").trim().toLowerCase();
  const expectedHandle = account.handle ? String(account.handle).toLowerCase() : null;
  const expectedNumber = String(account.account_number || "").toLowerCase();
  if (!confirm || (confirm !== expectedHandle && confirm !== expectedNumber)) {
    return json({ error: "confirm_mismatch" }, 400);
  }

  const ownsOrg = await env.DB.prepare("SELECT 1 FROM memberships WHERE user_id = ? AND role = 'owner' LIMIT 1").bind(user.id).first();
  if (ownsOrg) return json({ error: "owns_orgs" }, 409);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM magic_links WHERE user_id = ? OR email IN (SELECT email FROM user_emails WHERE user_id = ?)").bind(user.id, user.id),
    env.DB.prepare("DELETE FROM user_emails WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM daily_machine_source_usage WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM daily_machine_usage WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM machines WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM openrouter_daily_model_usage WHERE account_id = ?").bind(account.id),
    env.DB.prepare("DELETE FROM openrouter_daily_usage WHERE account_id = ?").bind(account.id),
    env.DB.prepare("DELETE FROM openrouter_connections WHERE owner_user_id = ? OR account_id = ?").bind(user.id, account.id),
    env.DB.prepare("DELETE FROM memberships WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM account_badges WHERE account_id = ?").bind(account.id),
    env.DB.prepare("DELETE FROM handles WHERE account_id = ?").bind(account.id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(account.id),
  ]);

  return json({ ok: true }, 200, { "Set-Cookie": expiredCookie() });
}

function csvFilename(account, suffix) {
  const ref = String((account && (account.handle || account.account_number)) || "burnfolio").replace(/[^a-zA-Z0-9_-]/g, "") || "burnfolio";
  return `burnfolio-${ref}-${suffix}.csv`;
}

function csvField(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvLine(values) {
  return values.map(csvField).join(",") + "\r\n";
}

function usageDailyCSV(rows) {
  let out = csvLine(["date_utc", "records", "input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens", "total_tokens"]);
  for (const row of rows) {
    out += csvLine([
      row.date_utc,
      int(row.records),
      int(row.input_tokens),
      int(row.cache_read_tokens),
      int(row.cache_write_tokens),
      int(row.output_tokens),
      int(row.reasoning_tokens),
      int(row.total_tokens),
    ]);
  }
  return out;
}

function usageBreakdownCSV(rows) {
  let out = csvLine(["date_utc", "cli", "model", "records", "input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens", "total_tokens"]);
  for (const row of rows) {
    out += csvLine([
      row.date_utc,
      row.cli,
      row.model,
      int(row.records),
      int(row.input_tokens),
      int(row.cache_read_tokens),
      int(row.cache_write_tokens),
      int(row.output_tokens),
      int(row.reasoning_tokens),
      int(row.total_tokens),
    ]);
  }
  return out;
}

function csvResponse(text, filename) {
  const safeFilename = filename.replace(/["\r\n]/g, "");
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "Cache-Control": "no-store",
      ...securityHeaders(),
    },
  });
}

async function globalStats(request, env) {
  return readGlobalStats(env);
}

async function globalStatsResponse(request, env) {
  const data = await readGlobalStats(env);
  return json(data, 200, { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
}

async function readGlobalStats(env) {
  const today = todayUTCDate();
  const first = sameDatePreviousYear(today);
  const gridStart = startOfWeekUTC(first);
  const start = gridStart.toISOString().slice(0, 10);
  const end = today.toISOString().slice(0, 10);
  const clamp = dailyTokenClamp(env);
  const rows = await env.DB.prepare(`
    SELECT date_utc, SUM(total_tokens) AS total_tokens
    FROM (
      SELECT date_utc, MIN(total_tokens, ?) AS total_tokens FROM daily_machine_usage
      UNION ALL
      SELECT date_utc, MIN(total_tokens, ?) AS total_tokens FROM (
        SELECT date_utc, MAX(total_tokens) AS total_tokens
        FROM openrouter_daily_usage
        GROUP BY openrouter_key_hash, date_utc
      )
    )
    WHERE date_utc BETWEEN ? AND ?
    GROUP BY date_utc
    ORDER BY date_utc
  `).bind(clamp, clamp, start, end).all();
  const total = await env.DB.prepare(`
    SELECT COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM (
      SELECT MIN(total_tokens, ?) AS total_tokens FROM daily_machine_usage
      UNION ALL
      SELECT MIN(total_tokens, ?) AS total_tokens FROM (
        SELECT MAX(total_tokens) AS total_tokens
        FROM openrouter_daily_usage
        GROUP BY openrouter_key_hash, date_utc
      )
    )
  `).bind(clamp, clamp).first();
  let lastYearTokens = 0;
  for (const row of rows.results || []) {
    if (row.date_utc >= first.toISOString().slice(0, 10)) lastYearTokens += int(row.total_tokens);
  }
  return {
    days: (rows.results || []).map(dayRow),
    total_tokens: int(total && total.total_tokens),
    last_year_tokens: lastYearTokens,
    generated_at: new Date().toISOString(),
  };
}

function emptyGlobalStats() {
  return { days: [], total_tokens: 0, last_year_tokens: 0 };
}

// Anonymized: only a token total and a timestamp, never account/machine/handle.
const RECENT_ACTIVITY_LIMIT = 6;

// Anonymous sync events (tokens + timestamp only) merged with attributed badge
// earns (badges are public — the earner's ref is shown), newest first, capped
// at RECENT_ACTIVITY_LIMIT. Each entry carries a `type` so the renderer (server
// and client) can distinguish them.
async function recentActivity(env) {
  const clamp = dailyTokenClamp(env);
  const [syncRows, badgeRows] = await Promise.all([
    env.DB.prepare(`
      SELECT MIN(total_tokens, ?) AS total_tokens, updated_at
      FROM daily_machine_usage
      WHERE total_tokens > 0
      ORDER BY updated_at DESC
      LIMIT 5
    `).bind(clamp).all(),
    env.DB.prepare(`
      SELECT ab.badge_key, ab.earned_at, a.account_number, h.handle, a.display_name
      FROM account_badges ab
      JOIN accounts a ON a.id = ab.account_id
      LEFT JOIN handles h ON h.account_id = a.id
      ORDER BY ab.earned_at DESC
      LIMIT 5
    `).all(),
  ]);
  const syncs = (syncRows.results || []).map((r) => ({
    type: "sync",
    total_tokens: int(r.total_tokens),
    tokens_display: formatCompact(int(r.total_tokens)),
    at: r.updated_at,
  }));
  const badges = (badgeRows.results || []).map((r) => {
    const def = badgeDef(r.badge_key);
    if (!def) return null;
    const ref = r.handle || "Anonymous builder";
    return {
      type: "badge",
      badge_name: def.name,
      badge_tier: def.tier,
      ref,
      at: r.earned_at,
    };
  }).filter(Boolean);
  return [...syncs, ...badges].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, RECENT_ACTIVITY_LIMIT);
}

async function cachedRecentActivity(env) {
  const cacheKey = new Request("https://cache.internal/global/recent");
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();
  const rows = await recentActivity(env);
  const response = json(rows, 200, { "Cache-Control": "public, max-age=60" });
  await cache.put(cacheKey, response.clone());
  return rows;
}

async function recentActivityRoute(request, env) {
  const rows = await cachedRecentActivity(env);
  return json(rows, 200, { "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" });
}

async function platformStats(env) {
  const row = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN a.kind = 'user' AND (
        EXISTS (SELECT 1 FROM daily_machine_usage d WHERE d.user_id = a.id)
        OR EXISTS (SELECT 1 FROM openrouter_daily_usage o WHERE o.account_id = a.id)
      ) THEN 1 ELSE 0 END) AS users,
      SUM(CASE WHEN a.kind = 'org' THEN 1 ELSE 0 END) AS orgs
    FROM accounts a
  `).first();
  return {
    users: int(row && row.users),
    orgs: int(row && row.orgs),
  };
}

async function claimHandle(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const body = await readBody(request);
  const rawHandle = body.handle || body.username;
  const handle = cleanHandle(rawHandle);
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

async function updateUserProfileRoute(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("profile:user", user.id), 60, 3600],
  ]);
  if (limited) return limited;
  const body = await readBody(request);
  const fields = cleanProfileMetadata(body);
  if (fields.error) return json({ error: fields.error }, 400);
  await updateAccountMetadata(env, user.id, fields);
  return json({ account: await accountView(env, user.id) });
}

async function createMachineRoute(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("machines:user", user.id), 20, 3600],
  ]);
  if (limited) return limited;
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
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("machine-token:user", user.id), 20, 3600],
  ]);
  if (limited) return limited;
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
  await env.DB.prepare("UPDATE machines SET token_hash = ? WHERE id = ?")
    .bind(await sha256(token), machine.id).run();
  const profile = machine.org_id
    ? machine.org_handle || machine.org_account_number
    : machine.user_handle || machine.user_account_number;
  return json({ machine: { machine_number: machine.machine_number, name: machine.name, token, profile } });
}

async function createOrgRoute(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("orgs:user", user.id), 10, 3600],
  ]);
  if (limited) return limited;
  const body = await readBody(request);
  const rawHandle = body.handle || body.username;
  const handle = cleanHandle(rawHandle);
  if (String(rawHandle || "").trim() && !handle) return json({ error: "invalid_handle" }, 400);
  const displayName = cleanText(body.name || handle || "Organization", 80);
  const org = await createOrg(env, { handle, displayName, ownerUserID: user.id });
  if (org.error) return json(org, 409);
  return json({ org }, 201);
}

async function updateOrgProfileRoute(request, env, orgRef) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const org = await resolveAccount(env, orgRef);
  if (!org || org.kind !== "org") return json({ error: "org_not_found" }, 404);
  const actor = await membershipRole(env, org.id, user.id);
  if (!canManageOrg(actor)) return json({ error: "forbidden" }, 403);
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("org-profile:user", user.id), 60, 3600],
    [await rateKey("org-profile:org", org.id), 120, 3600],
  ]);
  if (limited) return limited;
  const body = await readBody(request);
  const fields = cleanProfileMetadata(body);
  if (fields.error) return json({ error: fields.error }, 400);
  await updateAccountMetadata(env, org.id, fields);
  return json({ org: await accountView(env, org.id) });
}

async function addOrgMemberRoute(request, env, orgRef) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("org-members:user", user.id), 60, 3600],
  ]);
  if (limited) return limited;
  const org = await resolveAccount(env, orgRef);
  if (!org || org.kind !== "org") return json({ error: "org_not_found" }, 404);
  const actor = await membershipRole(env, org.id, user.id);
  if (!canManageOrg(actor)) return json({ error: "forbidden" }, 403);
  const body = await readBody(request);
  const member = await resolveAccount(env, body.user || body.account || body.handle);
  if (!member || member.kind !== "user") return json({ error: "user_not_found" }, 404);
  const role = cleanRole(body.role);
  if (role === "owner" && actor !== "owner") return json({ error: "owner_required" }, 403);
  if (role === "owner") {
    // Ownership can only be transferred to a member who already accepted
    // an invite — otherwise the transfer would activate a membership (and
    // absorb the target's usage into the org) without their consent.
    const existing = await anyMembership(env, org.id, member.id);
    if (!existing || existing.status !== "active") return json({ error: "member_must_accept_invite" }, 409);
    await setOrgMemberRole(env, org.id, member.id, role);
  } else {
    await inviteOrgMember(env, org.id, member.id, role);
  }
  return json({ ok: true });
}

async function updateOrgMemberRoute(request, env, orgRef, memberRef) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("org-members:user", user.id), 60, 3600],
  ]);
  if (limited) return limited;
  const org = await resolveAccount(env, orgRef);
  if (!org || org.kind !== "org") return json({ error: "org_not_found" }, 404);
  const actor = await membershipRole(env, org.id, user.id);
  if (!canManageOrg(actor)) return json({ error: "forbidden" }, 403);
  const member = await resolveAccount(env, memberRef);
  if (!member || member.kind !== "user") return json({ error: "user_not_found" }, 404);
  const current = await anyMembership(env, org.id, member.id);
  if (!current) return json({ error: "member_not_found" }, 404);
  const body = await readBody(request);
  const role = cleanRole(body.role);
  if (role === "owner" && actor !== "owner") return json({ error: "owner_required" }, 403);
  if (current.role === "owner" && role !== "owner") return json({ error: "owner_transfer_required" }, 409);
  if (role === "owner" && current.status !== "active") return json({ error: "member_must_accept_invite" }, 409);
  if (current.status === "pending") {
    // Role changes on a pending invite update the invite, not the
    // membership — acceptance is still required before usage rolls up.
    await inviteOrgMember(env, org.id, member.id, role);
    return json({ ok: true });
  }
  await setOrgMemberRole(env, org.id, member.id, role);
  return json({ ok: true });
}

async function removeOrgMemberRoute(request, env, orgRef, memberRef) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("org-members:user", user.id), 60, 3600],
  ]);
  if (limited) return limited;
  const org = await resolveAccount(env, orgRef);
  if (!org || org.kind !== "org") return json({ error: "org_not_found" }, 404);
  const actor = await membershipRole(env, org.id, user.id);
  if (!canManageOrg(actor)) return json({ error: "forbidden" }, 403);
  const member = await resolveAccount(env, memberRef);
  if (!member || member.kind !== "user") return json({ error: "user_not_found" }, 404);
  const current = await anyMembership(env, org.id, member.id);
  if (!current) return json({ error: "member_not_found" }, 404);
  if (current.role === "owner") return json({ error: "owner_cannot_be_removed" }, 409);
  await env.DB.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ?").bind(org.id, member.id).run();
  return json({ ok: true });
}

async function acceptOrgInviteRoute(request, env, orgRef) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const org = await resolveAccount(env, orgRef);
  if (!org || org.kind !== "org") return json({ error: "org_not_found" }, 404);
  const accepted = await acceptOrgInvite(env, org.id, user.id);
  if (!accepted) return json({ error: "invite_not_found" }, 404);
  return json({ ok: true, org: await accountView(env, org.id) });
}

async function declineOrgInviteRoute(request, env, orgRef) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const org = await resolveAccount(env, orgRef);
  if (!org || org.kind !== "org") return json({ error: "org_not_found" }, 404);
  const declined = await declineOrgInvite(env, org.id, user.id);
  if (!declined) return json({ error: "invite_not_found" }, 404);
  return json({ ok: true });
}

async function ingest(request, env) {
  const token = bearerToken(request);
  if (!token) return json({ error: "missing_machine_token" }, 401);
  const tokenHash = await sha256(token);
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("ingest:ip", clientIP(request)), 120, 60],
    [`ingest:token:${tokenHash.slice(0, 32)}`, 120, 60],
  ]);
  if (limited) return limited;
  const machine = await env.DB.prepare("SELECT id, user_id, org_id FROM machines WHERE token_hash = ?").bind(tokenHash).first();
  if (!machine) return json({ error: "invalid_machine_token" }, 401);
  const body = await readBody(request);
  const account = await resolveAccount(env, String(body.profile || ""));
  if (!account || !machineCanSyncToAccount(machine, account)) return json({ error: "profile_machine_mismatch" }, 403);
  const pyroVersion = cleanVersion(body.pyro_version || body.version);
  const days = Array.isArray(body.days) ? body.days : [];
  if (days.length > MAX_SYNC_DAYS) return json({ error: "too_many_days" }, 400);

  const incomingDates = [...new Set(days.map((day) => String(day.date_utc || "")).filter(validIngestDate))];
  const priorTotals = new Map();
  // D1 caps bound parameters per statement, and a first full-history sync
  // can carry years of dates — chunk the IN() lookup to stay under it.
  for (let i = 0; i < incomingDates.length; i += 90) {
    const chunk = incomingDates.slice(i, i + 90);
    const placeholders = chunk.map(() => "?").join(",");
    const existing = await env.DB.prepare(`SELECT date_utc, total_tokens FROM daily_machine_usage WHERE machine_id = ? AND date_utc IN (${placeholders})`).bind(machine.id, ...chunk).all();
    for (const row of existing.results || []) priorTotals.set(row.date_utc, row.total_tokens);
  }

  const statements = [];
  let skippedDays = 0;
  let upsertedDays = 0;
  for (const day of days) {
    const date = String(day.date_utc || "");
    if (!validIngestDate(date)) {
      skippedDays++;
      continue;
    }
    const usage = day.usage || {};
    const input = boundedInt(usage.input, MAX_TOKEN_FIELD);
    const cacheRead = boundedInt(usage.cache_read, MAX_TOKEN_FIELD);
    const cacheWrite = boundedInt(usage.cache_write, MAX_TOKEN_FIELD);
    const output = boundedInt(usage.output, MAX_TOKEN_FIELD);
    const reasoning = boundedInt(usage.reasoning, MAX_TOKEN_FIELD);
    const explicitTotal = usage.total || day.total_tokens;
    const total = explicitTotal ? boundedInt(explicitTotal, MAX_TOKEN_FIELD) : boundedInt(input + cacheRead + cacheWrite + output, MAX_TOKEN_FIELD);
    const records = boundedInt(day.records, MAX_RECORDS_PER_DAY);
    if ([input, cacheRead, cacheWrite, output, reasoning, total, records].some((value) => value === null)) {
      skippedDays++;
      continue;
    }
    statements.push(env.DB.prepare(`
      INSERT INTO daily_machine_usage
        (machine_id, user_id, date_utc, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, records, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(machine_id, date_utc) DO UPDATE SET
        input_tokens = CASE WHEN excluded.total_tokens >= daily_machine_usage.total_tokens THEN excluded.input_tokens ELSE daily_machine_usage.input_tokens END,
        cache_read_tokens = CASE WHEN excluded.total_tokens >= daily_machine_usage.total_tokens THEN excluded.cache_read_tokens ELSE daily_machine_usage.cache_read_tokens END,
        cache_write_tokens = CASE WHEN excluded.total_tokens >= daily_machine_usage.total_tokens THEN excluded.cache_write_tokens ELSE daily_machine_usage.cache_write_tokens END,
        output_tokens = CASE WHEN excluded.total_tokens >= daily_machine_usage.total_tokens THEN excluded.output_tokens ELSE daily_machine_usage.output_tokens END,
        reasoning_tokens = CASE WHEN excluded.total_tokens >= daily_machine_usage.total_tokens THEN excluded.reasoning_tokens ELSE daily_machine_usage.reasoning_tokens END,
        total_tokens = MAX(daily_machine_usage.total_tokens, excluded.total_tokens),
        records = MAX(daily_machine_usage.records, excluded.records),
        updated_at = CASE WHEN excluded.total_tokens >= daily_machine_usage.total_tokens THEN excluded.updated_at ELSE daily_machine_usage.updated_at END
    `).bind(machine.id, machine.user_id, date, input, cacheRead, cacheWrite, output, reasoning, total, records));
    upsertedDays++;

    if (!Array.isArray(day.sources)) continue;
    const priorTotal = priorTotals.has(date) ? priorTotals.get(date) : -1;
    if (total < priorTotal) continue;
    priorTotals.set(date, total);

    const seen = new Set();
    const sourceRows = [];
    for (const src of day.sources.slice(0, MAX_SOURCE_ROWS_PER_DAY)) {
      if (!src || typeof src !== "object") continue;
      const cli = cleanSourceField(src.cli);
      const model = cleanSourceField(src.model);
      const key = `${cli} ${model}`;
      if (seen.has(key)) continue;
      const srcUsage = src.usage || {};
      const sInput = boundedInt(srcUsage.input, MAX_TOKEN_FIELD);
      const sCacheRead = boundedInt(srcUsage.cache_read, MAX_TOKEN_FIELD);
      const sCacheWrite = boundedInt(srcUsage.cache_write, MAX_TOKEN_FIELD);
      const sOutput = boundedInt(srcUsage.output, MAX_TOKEN_FIELD);
      const sReasoning = boundedInt(srcUsage.reasoning, MAX_TOKEN_FIELD);
      const sExplicitTotal = srcUsage.total;
      const sTotal = sExplicitTotal ? boundedInt(sExplicitTotal, MAX_TOKEN_FIELD) : boundedInt(sInput + sCacheRead + sCacheWrite + sOutput, MAX_TOKEN_FIELD);
      const sRecords = boundedInt(src.records, MAX_RECORDS_PER_DAY);
      if ([sInput, sCacheRead, sCacheWrite, sOutput, sReasoning, sTotal, sRecords].some((value) => value === null)) continue;
      seen.add(key);
      sourceRows.push({ cli, model, records: sRecords, input: sInput, cacheRead: sCacheRead, cacheWrite: sCacheWrite, output: sOutput, reasoning: sReasoning, total: sTotal });
    }

    statements.push(env.DB.prepare("DELETE FROM daily_machine_source_usage WHERE machine_id = ? AND date_utc = ?").bind(machine.id, date));
    for (const row of sourceRows) {
      statements.push(env.DB.prepare(`
        INSERT INTO daily_machine_source_usage
          (machine_id, user_id, date_utc, cli, model, records, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).bind(machine.id, machine.user_id, date, row.cli, row.model, row.records, row.input, row.cacheRead, row.cacheWrite, row.output, row.reasoning, row.total));
    }
  }
  if (statements.length) await env.DB.batch(statements);
  await env.DB.prepare("UPDATE machines SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_pyro_version = ? WHERE id = ?").bind(pyroVersion || null, machine.id).run();
  await awardBadgesForAccountID(env, machine.user_id);
  if (machine.org_id) await awardBadgesForAccountID(env, machine.org_id);
  return json({ ok: true, upserted_days: upsertedDays, skipped_days: skippedDays });
}

async function ingestOpenRouter(request, env) {
  const token = bearerToken(request);
  if (!token) return json({ error: "missing_machine_token" }, 401);
  const tokenHash = await sha256(token);
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("openrouter-ingest:ip", clientIP(request)), 120, 60],
    [`openrouter-ingest:token:${tokenHash.slice(0, 32)}`, 120, 60],
  ]);
  if (limited) return limited;
  const machine = await env.DB.prepare("SELECT id, user_id, org_id FROM machines WHERE token_hash = ?").bind(tokenHash).first();
  if (!machine) return json({ error: "invalid_machine_token" }, 401);
  const body = await readBody(request);
  const account = await resolveAccount(env, String(body.profile || ""));
  if (!account || !(await canUploadOpenRouterToAccount(env, machine.user_id, account))) return json({ error: "profile_machine_mismatch" }, 403);
  const sourceHash = cleanOpenRouterHash(body.openrouter_key_hash || body.source_hash);
  if (!sourceHash) return json({ error: "invalid_openrouter_source" }, 400);
  const result = await upsertOpenRouterDays(env, {
    accountID: account.id,
    keyHash: sourceHash,
    days: Array.isArray(body.days) ? body.days : [],
    source: "pyro",
    machineID: machine.id,
  });
  if (result.error) return json({ error: result.error }, result.status || 400);
  await env.DB.prepare("UPDATE machines SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(machine.id).run();
  await awardBadgesForAccountID(env, account.id);
  return json({ ok: true, upserted_days: result.upsertedDays, skipped_days: result.skippedDays });
}

async function canUploadOpenRouterToAccount(env, userID, account) {
  if (account.kind === "user") return account.id === userID;
  if (account.kind !== "org") return false;
  return Boolean(await membershipRole(env, account.id, userID));
}

async function connectOpenRouterRoute(request, env, orgRef = "") {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("openrouter-connect:user", user.id), 20, 3600],
  ]);
  if (limited) return limited;
  const target = await openRouterTargetAccount(env, user.id, orgRef);
  if (target.error) return json({ error: target.error }, target.status || 400);
  const body = await readBody(request);
  const key = cleanOpenRouterKey(body.key || body.openrouter_key);
  if (!key) return json({ error: "invalid_openrouter_key" }, 400);
  const customName = cleanOpenRouterName(body.name || body.label);
  const details = await validateOpenRouterKey(key);
  if (details.error) return json({ error: details.error }, details.status || 400);
  const encrypted = await encryptStoredSecret(env, key);
  if (encrypted.error) return json({ error: encrypted.error }, 500);
  const keyHash = await sha256(key);
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO openrouter_connections
      (id, account_id, owner_user_id, openrouter_key_hash, key_ciphertext, key_nonce, label, status, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(account_id, openrouter_key_hash) DO UPDATE SET
      owner_user_id = excluded.owner_user_id,
      key_ciphertext = excluded.key_ciphertext,
      key_nonce = excluded.key_nonce,
      label = excluded.label,
      status = 'active',
      last_error = NULL,
      updated_at = excluded.updated_at
  `).bind(id, target.account.id, user.id, keyHash, encrypted.ciphertext, encrypted.nonce, customName || details.label).run();
  const connection = await openRouterConnectionForKey(env, target.account.id, keyHash);
  const sync = await syncOpenRouterConnection(env, connection, { full: true });
  return json({ connection: publicOpenRouterConnection(connection, sync) });
}

async function deleteOpenRouterConnectionRoute(request, env, connectionID, orgRef = "") {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const connection = await openRouterConnectionByID(env, connectionID);
  if (!connection) return json({ error: "openrouter_not_found" }, 404);
  const allowed = await canManageOpenRouterConnection(env, user.id, connection, orgRef);
  if (allowed.error) return json({ error: allowed.error }, allowed.status || 403);
  await env.DB.prepare("DELETE FROM openrouter_connections WHERE id = ?").bind(connection.id).run();
  return json({ ok: true });
}

async function syncOpenRouterConnectionRoute(request, env, connectionID, orgRef = "") {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const connection = await openRouterConnectionByID(env, connectionID);
  if (!connection) return json({ error: "openrouter_not_found" }, 404);
  const allowed = await canManageOpenRouterConnection(env, user.id, connection, orgRef);
  if (allowed.error) return json({ error: allowed.error }, allowed.status || 403);
  const limited = await rateLimitChecks(request, env, [
    [await rateKey("openrouter-sync:user", user.id), 30, 3600],
    [await rateKey("openrouter-sync:connection", connection.id), 10, 3600],
  ]);
  if (limited) return limited;
  const sync = await syncOpenRouterConnection(env, connection, { full: false });
  return json({ connection: publicOpenRouterConnection(connection, sync), sync });
}

async function openRouterTargetAccount(env, userID, orgRef = "") {
  if (!orgRef) return { account: await accountView(env, userID) };
  const org = await resolveAccount(env, orgRef);
  if (!org || org.kind !== "org") return { error: "org_not_found", status: 404 };
  const role = await membershipRole(env, org.id, userID);
  if (!canManageOrg(role)) return { error: "forbidden", status: 403 };
  return { account: org };
}

async function canManageOpenRouterConnection(env, userID, connection, orgRef = "") {
  if (orgRef) {
    const org = await resolveAccount(env, orgRef);
    if (!org || org.id !== connection.account_id || org.kind !== "org") return { error: "org_not_found", status: 404 };
    const role = await membershipRole(env, org.id, userID);
    return canManageOrg(role) ? {} : { error: "forbidden", status: 403 };
  }
  const account = await accountView(env, connection.account_id);
  if (!account) return { error: "openrouter_not_found", status: 404 };
  if (account.kind === "user") return account.id === userID ? {} : { error: "forbidden", status: 403 };
  const role = await membershipRole(env, account.id, userID);
  return canManageOrg(role) ? {} : { error: "forbidden", status: 403 };
}

async function upsertOpenRouterDays(env, { accountID, keyHash, days, source, machineID = null }) {
  if (days.length > MAX_SYNC_DAYS) return { error: "too_many_days", status: 400 };
  const statements = [];
  let skippedDays = 0;
  let upsertedDays = 0;
  for (const day of days) {
    const date = String(day.date_utc || day.date || "");
    if (!validIngestDate(date)) {
      skippedDays++;
      continue;
    }
    const usage = day.usage || {};
    const input = boundedInt(usage.input ?? usage.tokens_prompt, MAX_TOKEN_FIELD);
    const cacheRead = boundedInt(usage.cache_read ?? usage.cached_tokens, MAX_TOKEN_FIELD);
    const cacheWrite = boundedInt(usage.cache_write, MAX_TOKEN_FIELD);
    const output = boundedInt(usage.output ?? usage.tokens_completion, MAX_TOKEN_FIELD);
    const reasoning = boundedInt(usage.reasoning ?? usage.reasoning_tokens, MAX_TOKEN_FIELD);
    const explicitTotal = usage.total ?? usage.tokens_total ?? day.total_tokens;
    const total = explicitTotal !== undefined && explicitTotal !== null && explicitTotal !== ""
      ? boundedInt(explicitTotal, MAX_TOKEN_FIELD)
      : boundedInt(input + cacheRead + cacheWrite + output, MAX_TOKEN_FIELD);
    const records = boundedInt(day.records ?? day.request_count, MAX_RECORDS_PER_DAY);
    if ([input, cacheRead, cacheWrite, output, reasoning, total, records].some((value) => value === null)) {
      skippedDays++;
      continue;
    }
    statements.push(env.DB.prepare(`
      INSERT INTO openrouter_daily_usage
        (account_id, openrouter_key_hash, date_utc, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, records, source, updated_by_machine_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(account_id, openrouter_key_hash, date_utc) DO UPDATE SET
        input_tokens = excluded.input_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        total_tokens = excluded.total_tokens,
        records = excluded.records,
        source = excluded.source,
        updated_by_machine_id = excluded.updated_by_machine_id,
        updated_at = excluded.updated_at
    `).bind(accountID, keyHash, date, input, cacheRead, cacheWrite, output, reasoning, total, records, source, machineID));
    upsertedDays++;

    if (Array.isArray(day.models)) {
      const seen = new Set();
      const modelRows = [];
      for (const m of day.models.slice(0, MAX_SOURCE_ROWS_PER_DAY)) {
        if (!m || typeof m !== "object") continue;
        const model = String(m.model || "").trim().toLowerCase().slice(0, 200);
        if (!model || seen.has(model)) continue;
        const mUsage = m.usage || {};
        const mInput = boundedInt(mUsage.input, MAX_TOKEN_FIELD);
        const mCacheRead = boundedInt(mUsage.cache_read, MAX_TOKEN_FIELD);
        const mCacheWrite = boundedInt(mUsage.cache_write, MAX_TOKEN_FIELD);
        const mOutput = boundedInt(mUsage.output, MAX_TOKEN_FIELD);
        const mReasoning = boundedInt(mUsage.reasoning, MAX_TOKEN_FIELD);
        const mExplicitTotal = mUsage.total;
        const mTotal = mExplicitTotal ? boundedInt(mExplicitTotal, MAX_TOKEN_FIELD) : boundedInt(mInput + mCacheRead + mCacheWrite + mOutput, MAX_TOKEN_FIELD);
        const mRecords = boundedInt(m.records, MAX_RECORDS_PER_DAY);
        if ([mInput, mCacheRead, mCacheWrite, mOutput, mReasoning, mTotal, mRecords].some((value) => value === null)) continue;
        seen.add(model);
        modelRows.push({ model, records: mRecords, input: mInput, cacheRead: mCacheRead, cacheWrite: mCacheWrite, output: mOutput, reasoning: mReasoning, total: mTotal });
      }
      statements.push(...openRouterModelReplaceStatements(env, accountID, keyHash, date, modelRows));
    }
  }
  if (statements.length) await env.DB.batch(statements);
  return { upsertedDays, skippedDays };
}

function openRouterModelReplaceStatements(env, accountID, keyHash, date, rows) {
  const statements = [env.DB.prepare("DELETE FROM openrouter_daily_model_usage WHERE account_id = ? AND openrouter_key_hash = ? AND date_utc = ?").bind(accountID, keyHash, date)];
  for (const row of rows) {
    statements.push(env.DB.prepare(`
      INSERT INTO openrouter_daily_model_usage
        (account_id, openrouter_key_hash, date_utc, model, records, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).bind(accountID, keyHash, date, row.model, row.records, row.input, row.cacheRead, row.cacheWrite, row.output, row.reasoning, row.total));
  }
  return statements;
}

async function cleanupExpiredRecords(env) {
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM magic_links WHERE consumed_at IS NOT NULL OR expires_at <= datetime('now')"),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')"),
      env.DB.prepare("DELETE FROM rate_limits WHERE updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days')"),
    ]);
  } catch (error) {
    console.error("cleanup cron failed", error && error.message ? error.message : error);
  }
}

async function syncDueOpenRouterConnections(env) {
  const rows = await env.DB.prepare(`
    SELECT *
    FROM openrouter_connections
    WHERE status != 'disabled'
      AND (last_sync_at IS NULL OR last_sync_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-55 minutes'))
    ORDER BY COALESCE(last_sync_at, '1970-01-01') ASC
    LIMIT 25
  `).all();
  for (const connection of rows.results || []) {
    try {
      await syncOpenRouterConnection(env, connection, { full: false });
    } catch (error) {
      console.error("openrouter scheduled sync failed", connection.id, error && error.message ? error.message : error);
    }
  }
}

async function syncOpenRouterConnection(env, connection, { full = false } = {}) {
  const key = await decryptStoredSecret(env, connection.key_ciphertext, connection.key_nonce);
  if (key.error) {
    await markOpenRouterConnectionError(env, connection.id, key.error);
    return { error: key.error };
  }
  const start = full || !connection.last_sync_at ? OPENROUTER_SYNC_SINCE : dateOffsetUTC(connection.last_sync_at.slice(0, 10), -7);
  const end = tomorrowUTCISO();
  const days = await fetchOpenRouterUsageDays(key.value, start, end);
  if (days.error) {
    await markOpenRouterConnectionError(env, connection.id, days.error);
    return { error: days.error };
  }
  const result = await upsertOpenRouterDays(env, {
    accountID: connection.account_id,
    keyHash: connection.openrouter_key_hash,
    days: days.days,
    source: "server",
  });
  if (result.error) {
    await markOpenRouterConnectionError(env, connection.id, result.error);
    return { error: result.error };
  }
  await syncOpenRouterModelUsage(env, connection, key.value, start, end);
  await env.DB.prepare(`
    UPDATE openrouter_connections
    SET status = 'active', last_sync_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).bind(connection.id).run();
  await awardBadgesForAccountID(env, connection.account_id);
  return { ok: true, upserted_days: result.upsertedDays, skipped_days: result.skippedDays };
}

async function syncOpenRouterModelUsage(env, connection, key, start, end) {
  try {
    const result = await fetchOpenRouterModelUsageDays(key, start, end);
    if (result.error) {
      console.error("openrouter model sync failed", connection.id, result.error);
      return;
    }
    const byDate = new Map();
    for (const day of result.days || []) {
      const date = day.date_utc;
      if (!validIngestDate(date)) continue;
      const model = String(day.model || "").trim().toLowerCase().slice(0, 200);
      if (!model) continue;
      const usage = day.usage || {};
      const input = boundedInt(usage.input, MAX_TOKEN_FIELD);
      const cacheRead = boundedInt(usage.cache_read, MAX_TOKEN_FIELD);
      const output = boundedInt(usage.output, MAX_TOKEN_FIELD);
      const reasoning = boundedInt(usage.reasoning, MAX_TOKEN_FIELD);
      const total = boundedInt(usage.total, MAX_TOKEN_FIELD);
      const records = boundedInt(day.records, MAX_RECORDS_PER_DAY);
      if ([input, cacheRead, output, reasoning, total, records].some((value) => value === null)) continue;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push({ model, records, input, cacheRead, cacheWrite: 0, output, reasoning, total });
    }
    const statements = [];
    for (const [date, rows] of byDate) {
      statements.push(...openRouterModelReplaceStatements(env, connection.account_id, connection.openrouter_key_hash, date, rows));
    }
    if (statements.length) await env.DB.batch(statements);
  } catch (error) {
    console.error("openrouter model sync error", connection.id, error && error.message ? error.message : error);
  }
}

async function markOpenRouterConnectionError(env, id, error) {
  await env.DB.prepare(`
    UPDATE openrouter_connections
    SET status = 'error', last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).bind(cleanText(error, 160), id).run();
}

async function fetchOpenRouterUsageDays(key, start, end) {
  const startDate = parseUTCDate(start);
  const endDate = new Date(end);
  if (!startDate || Number.isNaN(endDate.getTime())) return { error: "openrouter_fetch_failed" };
  const allDays = [];
  for (let cursor = new Date(startDate); cursor < endDate;) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 366);
    const effectiveEnd = chunkEnd < endDate ? chunkEnd : endDate;
    const result = await fetchOpenRouterUsageRange(key, cursor.toISOString().slice(0, 10), effectiveEnd.toISOString());
    if (result.error) return result;
    allDays.push(...result.days);
    cursor = effectiveEnd;
  }
  return { days: allDays };
}

async function fetchOpenRouterUsageRange(key, start, end) {
  const res = await fetch(OPENROUTER_ANALYTICS_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      metrics: ["request_count", "tokens_prompt", "tokens_completion", "reasoning_tokens", "cached_tokens", "tokens_total"],
      dimensions: [],
      granularity: "day",
      limit: MAX_SYNC_DAYS,
      time_range: { start: `${start}T00:00:00Z`, end },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: openRouterError(data, "openrouter_fetch_failed"), status: res.status };
  const rows = data && data.data && Array.isArray(data.data.data) ? data.data.data : [];
  const days = rows.map((row) => {
    const input = int(row.tokens_prompt);
    const output = int(row.tokens_completion);
    const reasoning = int(row.reasoning_tokens);
    const cacheRead = int(row.cached_tokens);
    return {
      date_utc: String(row.date__day || "").slice(0, 10),
      records: int(row.request_count),
      usage: {
        input,
        output,
        cache_read: cacheRead,
        reasoning,
        total: input + cacheRead + output,
      },
    };
  });
  return { days };
}

async function fetchOpenRouterModelUsageDays(key, start, end) {
  const startDate = parseUTCDate(start);
  const endDate = new Date(end);
  if (!startDate || Number.isNaN(endDate.getTime())) return { error: "openrouter_fetch_failed" };
  const allDays = [];
  for (let cursor = new Date(startDate); cursor < endDate;) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 366);
    const effectiveEnd = chunkEnd < endDate ? chunkEnd : endDate;
    const result = await fetchOpenRouterModelUsageRange(key, cursor.toISOString().slice(0, 10), effectiveEnd.toISOString());
    if (result.error) return result;
    allDays.push(...result.days);
    cursor = effectiveEnd;
  }
  return { days: allDays };
}

// Defensive: the exact response shape for a dimensions:["model"] query hasn't
// been verified against a live key. Rows missing a recognizable model field are
// skipped rather than guessed, and any fetch/parse failure is caught by the
// caller (syncOpenRouterModelUsage) so it never blocks the day-totals sync.
async function fetchOpenRouterModelUsageRange(key, start, end) {
  const res = await fetch(OPENROUTER_ANALYTICS_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      metrics: ["request_count", "tokens_prompt", "tokens_completion", "reasoning_tokens", "cached_tokens", "tokens_total"],
      dimensions: ["model"],
      granularity: "day",
      limit: MAX_SYNC_DAYS,
      time_range: { start: `${start}T00:00:00Z`, end },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: openRouterError(data, "openrouter_fetch_failed"), status: res.status };
  const rows = data && data.data && Array.isArray(data.data.data) ? data.data.data : [];
  const days = [];
  for (const row of rows) {
    const rawModel = row.model ?? row.model_permaslug ?? "";
    const model = String(rawModel).trim().toLowerCase().slice(0, 200);
    if (!model) continue;
    const input = int(row.tokens_prompt);
    const output = int(row.tokens_completion);
    const reasoning = int(row.reasoning_tokens);
    const cacheRead = int(row.cached_tokens);
    days.push({
      date_utc: String(row.date__day || "").slice(0, 10),
      model,
      records: int(row.request_count),
      usage: {
        input,
        output,
        cache_read: cacheRead,
        reasoning,
        total: input + cacheRead + output,
      },
    });
  }
  return { days };
}

async function validateOpenRouterKey(key) {
  const res = await fetch(OPENROUTER_KEY_URL, { headers: { "Authorization": `Bearer ${key}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: openRouterError(data, "invalid_openrouter_key"), status: 400 };
  const details = data && data.data ? data.data : {};
  if (!details.is_management_key) return { error: "openrouter_management_key_required", status: 400 };
  return { label: safeOpenRouterLabel(details.label) };
}

function safeOpenRouterLabel(value) {
  value = cleanText(value || "OpenRouter", 80);
  if (!value || value.startsWith("sk-or-")) return "OpenRouter";
  return value;
}

function cleanOpenRouterName(value) {
  const text = cleanText(value, 80);
  if (!text || text.startsWith("sk-or-")) return "";
  return text;
}

function openRouterError(data, fallback) {
  const message = data && data.error && data.error.message ? String(data.error.message).toLowerCase() : "";
  if (message.includes("management")) return "openrouter_management_key_required";
  if (message.includes("auth") || message.includes("invalid")) return "invalid_openrouter_key";
  return fallback;
}

async function openRouterConnectionByID(env, id) {
  return env.DB.prepare(`
    SELECT c.*, a.kind, a.account_number, h.handle, a.display_name
    FROM openrouter_connections c
    JOIN accounts a ON a.id = c.account_id
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE c.id = ?
  `).bind(id).first();
}

async function openRouterConnectionForKey(env, accountID, keyHash) {
  return env.DB.prepare(`
    SELECT c.*, a.kind, a.account_number, h.handle, a.display_name
    FROM openrouter_connections c
    JOIN accounts a ON a.id = c.account_id
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE c.account_id = ? AND c.openrouter_key_hash = ?
  `).bind(accountID, keyHash).first();
}

async function openRouterConnectionRows(env, accountID) {
  const rows = await env.DB.prepare(`
    SELECT id, label, status, last_sync_at, last_error, created_at
    FROM openrouter_connections
    WHERE account_id = ?
    ORDER BY created_at DESC
  `).bind(accountID).all();
  return rows.results || [];
}

function publicOpenRouterConnection(connection, sync = {}) {
  return {
    id: connection.id,
    label: connection.label || "OpenRouter",
    status: sync.error ? "error" : connection.status || "active",
    last_sync_at: sync.ok ? new Date().toISOString() : connection.last_sync_at || null,
    last_error: sync.error || connection.last_error || null,
    sync,
  };
}

// --- Badges ----------------------------------------------------------------
// Computed on read from existing usage data — no new tables. Rarity tiers use
// AI-flavored names but the underlying `tier` key stays common/uncommon/rare
// so sorting and styling don't depend on the display copy.

const BADGE_TIERS = { common: "Base Model", uncommon: "Fine-Tune", rare: "Frontier" };
const BADGE_TIER_ORDER = ["rare", "uncommon", "common"];

const BADGE_DEFS = [
  // --- Base Model (common) ---
  { key: "hello_world", name: "Hello, World", tier: "common", description: "Every run starts with a single token.", check: (s) => s.lifetimeTokens > 0 },
  { key: "tokenizer", name: "Tokenizer", tier: "common", description: "Your first million. The vocabulary is warm.", check: (s) => s.lifetimeTokens >= 1_000_000 },
  { key: "context_builder", name: "Context Builder", tier: "common", description: "Ten million tokens in. It's becoming a habit.", check: (s) => s.lifetimeTokens >= 10_000_000 },
  { key: "warm_cache", name: "Warm Cache", tier: "common", description: "One hundred million tokens. The KV cache remembers you now.", check: (s) => s.lifetimeTokens >= 100_000_000 },
  { key: "training_loop", name: "Training Loop", tier: "common", description: "Seven consecutive days. The loss curve is trending down.", check: (s) => Math.max(s.currentStreak, s.longestStreak) >= 7 },
  { key: "multi_agent", name: "Multi-Agent", tier: "common", description: "Three agents, one human in the loop. Allegedly.", check: (s) => s.distinctTools >= 3 },
  { key: "model_collector", name: "Model Collector", tier: "common", description: "Gotta prompt 'em all.", check: (s) => s.distinctModels >= 5 },
  { key: "always_on", name: "Always On", tier: "common", description: "Uptime rivaling the API you call.", check: (s) => s.activeDays >= 30 },
  { key: "wordsmith", name: "Wordsmith", tier: "common", description: "Ten million tokens generated. Some of them compiled.", check: (s) => s.outputTokens >= 10_000_000 },
  { key: "context_stuffer", name: "Context Stuffer", tier: "common", description: "Everything is relevant context if you believe hard enough.", check: (s) => s.inputTokens >= 50_000_000 },
  { key: "chain_of_thought", name: "Chain of Thought", tier: "common", description: "Let's think step by step.", check: (s) => s.reasoningTokens >= 1_000_000 },
  { key: "chatterbox", name: "Chatterbox", tier: "common", description: "A thousand requests. It remembers you fondly. Probably.", check: (s) => s.records >= 1_000 },
  { key: "fortnight", name: "Fortnight", tier: "common", description: "Two weeks in the loop. No checkpoint needed.", check: (s) => Math.max(s.currentStreak, s.longestStreak) >= 14 },
  { key: "pair_programmer", name: "Pair Programmer", tier: "common", description: "Two agents, four hands, one merge conflict.", check: (s) => s.distinctTools >= 2 },
  { key: "weekend_warrior", name: "Weekend Warrior", tier: "common", description: "Shipping doesn't check the calendar.", check: (s) => s.weekendActiveDays >= 10 },
  { key: "open_book", name: "Open Book", tier: "common", description: "Alignment through transparency.", check: (s) => s.hasBioAndLink },
  { key: "team_player", name: "Team Player", tier: "common", description: "Multi-agent systems work better with trust.", check: (s) => s.hasActiveOrgMembership },
  { key: "router", name: "The Router", tier: "common", description: "All roads lead through you.", check: (s) => s.hasOpenRouterUsage },

  // --- Fine-Tune (uncommon) ---
  { key: "billion_token_brain", name: "Billion-Token Brain", tier: "uncommon", description: "Enough tokens to pretrain a very small, very confused model.", check: (s) => s.lifetimeTokens >= 1_000_000_000 },
  { key: "epoch", name: "Epoch", tier: "uncommon", description: "One full pass over the month. No early stopping.", check: (s) => Math.max(s.currentStreak, s.longestStreak) >= 30 },
  { key: "overclocked", name: "Overclocked", tier: "uncommon", description: "Your fans are audible from space.", check: (s) => s.bestDayTokens >= 100_000_000 },
  { key: "orchestrator", name: "Orchestrator", tier: "uncommon", description: "You don't write code anymore. You conduct it.", check: (s) => s.distinctTools >= 5 },
  { key: "ensemble", name: "Ensemble", tier: "uncommon", description: "Ten models polled. Consensus pending.", check: (s) => s.distinctModels >= 10 },
  { key: "cache_whisperer", name: "Cache Whisperer", tier: "uncommon", description: "Half your context came straight from cache. The bill thanks you.", check: (s) => s.cacheReadTokens >= 10_000_000 && s.cacheReadTokens >= 0.5 * (s.inputTokens + s.cacheReadTokens) },
  { key: "novelist", name: "Novelist", tier: "uncommon", description: "A hundred million tokens out. War and Peace, 120 times, in one sitting.", check: (s) => s.outputTokens >= 100_000_000 },
  { key: "context_maximalist", name: "Context Maximalist", tier: "uncommon", description: "Why summarize when you can paste?", check: (s) => s.inputTokens >= 500_000_000 },
  { key: "cache_architect", name: "Cache Architect", tier: "uncommon", description: "You build the cache other people read from.", check: (s) => s.cacheWriteTokens >= 100_000_000 },
  { key: "deliberator", name: "The Deliberator", tier: "uncommon", description: "A hundred million tokens of thinking. The answer was 4.", check: (s) => s.reasoningTokens >= 100_000_000 },
  { key: "api_hammer", name: "API Hammer", tier: "uncommon", description: "When all you have is an API key, everything looks like a request.", check: (s) => s.records >= 10_000 },
  { key: "half_life", name: "Half-Life", tier: "uncommon", description: "Fifty consecutive days. Still no crowbar.", check: (s) => Math.max(s.currentStreak, s.longestStreak) >= 50 },
  { key: "habitual", name: "Habitual", tier: "uncommon", description: "A hundred days of burn. This is your workflow now.", check: (s) => s.activeDays >= 100 },
  { key: "polyglot", name: "Polyglot", tier: "uncommon", description: "Fifteen models. You speak fluent everything.", check: (s) => s.distinctModels >= 15 },
  { key: "provider_hopper", name: "Provider Hopper", tier: "uncommon", description: "Vendor lock-in is a state of mind.", check: (s) => s.distinctProviders >= 3 },
  { key: "perfect_attendance", name: "Perfect Attendance", tier: "uncommon", description: "One month, zero gaps. The cron job is jealous.", check: (s) => s.hasPerfectMonth },
  { key: "four_seasons", name: "Four Seasons", tier: "uncommon", description: "A full trip around the sun, one burn at a time.", check: (s) => s.distinctActiveMonths >= 12 },
  { key: "badge_collector", name: "Badge Collector", tier: "uncommon", description: "Achievement unlocked: achievements.", meta: true, metaThreshold: 10 },
  {
    key: "leet",
    name: "1337",
    tier: "uncommon",
    secret: true,
    description: "Nice. (You know what you did.)",
    secretName: "???",
    secretDescription: "Some numbers speak for themselves.",
    check: (s) => String(s.lifetimeTokens).includes("1337") || String(s.bestDayTokens).includes("1337"),
  },

  // --- Frontier (rare) ---
  { key: "pretraining_run", name: "Pretraining Run", tier: "rare", description: "That's not usage. That's a dataset.", check: (s) => s.lifetimeTokens >= 10_000_000_000 },
  { key: "foundation_model", name: "Foundation Model", tier: "rare", description: "Please disclose your training data.", check: (s) => s.lifetimeTokens >= 100_000_000_000 },
  { key: "convergence", name: "Convergence", tier: "rare", description: "One hundred days in the loop. Gradient fully descended.", check: (s) => Math.max(s.currentStreak, s.longestStreak) >= 100 },
  { key: "datacenter_cosplay", name: "Datacenter Cosplay", tier: "rare", description: "Somewhere, a cluster spun up just for you.", check: (s) => s.bestDayTokens >= 1_000_000_000 },
  { key: "mixture_of_experts", name: "Mixture of Experts", tier: "rare", description: "You are the gating network.", check: (s) => s.distinctModels >= 25 },
  {
    key: "deep_thought",
    name: "Deep Thought",
    tier: "rare",
    secret: true,
    description: "42. The answer to burn, the universe, and everything.",
    secretName: "???",
    secretDescription: "Some questions answer themselves.",
    check: (s) => s.activeDays === 42 || s.currentStreak === 42 || s.longestStreak === 42,
  },
  { key: "superintelligence", name: "Superintelligence", tier: "rare", description: "One trillion tokens. We are legally required to mention safety.", check: (s) => s.lifetimeTokens >= 1_000_000_000_000 },
  { key: "printing_press", name: "Printing Press", tier: "rare", description: "A billion tokens generated. Gutenberg walked so you could prompt.", check: (s) => s.outputTokens >= 1_000_000_000 },
  { key: "librarian", name: "The Librarian", tier: "rare", description: "You didn't read the docs. You fed them.", check: (s) => s.inputTokens >= 5_000_000_000 },
  { key: "rate_limit_tourist", name: "Rate Limit Tourist", tier: "rare", description: "On a first-name basis with HTTP 429.", check: (s) => s.records >= 100_000 },
  { key: "year_of_burn", name: "Year of Burn", tier: "rare", description: "A full year, every single day. Touch grass. (Badge includes grass.)", check: (s) => Math.max(s.currentStreak, s.longestStreak) >= 365 },
  { key: "lifer", name: "Lifer", tier: "rare", description: "Two hundred and fifty days. The context window of a lifetime.", check: (s) => s.activeDays >= 250 },
  { key: "completionist", name: "Completionist", tier: "rare", description: "You optimized the reward function.", meta: true, metaThreshold: 40 },
];

function badgeDef(key) {
  return BADGE_DEFS.find((b) => b.key === key) || null;
}

function badgeTooltip(def) {
  return `${BADGE_TIERS[def.tier]} · ${def.name} badge`;
}

// Non-meta badges whose check() is satisfied right now. Meta badges
// (badge_collector, completionist) are evaluated separately by awardBadges,
// against the account's earned-row count, not this bundle.
function computeEarnableBadges(statsBundle) {
  return BADGE_DEFS.filter((b) => !b.meta && b.check(statsBundle)).map((b) => b.key);
}

// Nearest-progress fraction toward an unearned badge, for the dashboard goals panel.
function badgeProgress(def, statsBundle) {
  const s = statsBundle;
  switch (def.key) {
    case "tokenizer": return s.lifetimeTokens / 1_000_000;
    case "context_builder": return s.lifetimeTokens / 10_000_000;
    case "warm_cache": return s.lifetimeTokens / 100_000_000;
    case "training_loop": return Math.max(s.currentStreak, s.longestStreak) / 7;
    case "multi_agent": return s.distinctTools / 3;
    case "model_collector": return s.distinctModels / 5;
    case "always_on": return s.activeDays / 30;
    case "wordsmith": return s.outputTokens / 10_000_000;
    case "context_stuffer": return s.inputTokens / 50_000_000;
    case "chain_of_thought": return s.reasoningTokens / 1_000_000;
    case "chatterbox": return s.records / 1_000;
    case "fortnight": return Math.max(s.currentStreak, s.longestStreak) / 14;
    case "pair_programmer": return s.distinctTools / 2;
    case "weekend_warrior": return s.weekendActiveDays / 10;
    case "open_book": return s.hasBioAndLink ? 1 : 0;
    case "team_player": return s.hasActiveOrgMembership ? 1 : 0;
    case "router": return s.hasOpenRouterUsage ? 1 : 0;
    case "billion_token_brain": return s.lifetimeTokens / 1_000_000_000;
    case "epoch": return Math.max(s.currentStreak, s.longestStreak) / 30;
    case "overclocked": return s.bestDayTokens / 100_000_000;
    case "orchestrator": return s.distinctTools / 5;
    case "ensemble": return s.distinctModels / 10;
    case "cache_whisperer": return Math.min(s.cacheReadTokens / 10_000_000, (s.cacheReadTokens || 0) / Math.max(0.5 * (s.inputTokens + s.cacheReadTokens), 1));
    case "novelist": return s.outputTokens / 100_000_000;
    case "context_maximalist": return s.inputTokens / 500_000_000;
    case "cache_architect": return s.cacheWriteTokens / 100_000_000;
    case "deliberator": return s.reasoningTokens / 100_000_000;
    case "api_hammer": return s.records / 10_000;
    case "half_life": return Math.max(s.currentStreak, s.longestStreak) / 50;
    case "habitual": return s.activeDays / 100;
    case "polyglot": return s.distinctModels / 15;
    case "provider_hopper": return s.distinctProviders / 3;
    case "perfect_attendance": return s.hasPerfectMonth ? 1 : 0;
    case "four_seasons": return s.distinctActiveMonths / 12;
    case "pretraining_run": return s.lifetimeTokens / 10_000_000_000;
    case "foundation_model": return s.lifetimeTokens / 100_000_000_000;
    case "convergence": return Math.max(s.currentStreak, s.longestStreak) / 100;
    case "datacenter_cosplay": return s.bestDayTokens / 1_000_000_000;
    case "mixture_of_experts": return s.distinctModels / 25;
    case "superintelligence": return s.lifetimeTokens / 1_000_000_000_000;
    case "printing_press": return s.outputTokens / 1_000_000_000;
    case "librarian": return s.inputTokens / 5_000_000_000;
    case "rate_limit_tourist": return s.records / 100_000;
    case "year_of_burn": return Math.max(s.currentStreak, s.longestStreak) / 365;
    case "lifer": return s.activeDays / 250;
    default: return 0;
  }
}

// containing "/" -> provider is the prefix (e.g. "anthropic/claude-3" -> anthropic).
// Otherwise map bare model-family names to a provider; unrecognized -> null (skipped).
function modelProvider(model) {
  const m = String(model || "").trim().toLowerCase();
  if (!m) return null;
  if (m.includes("/")) return m.split("/")[0] || null;
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("davinci")) return "openai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("qwen")) return "alibaba";
  if (m.startsWith("kimi") || m.startsWith("moonshot")) return "moonshot";
  if (m.startsWith("llama")) return "meta";
  if (m.startsWith("grok")) return "xai";
  if (m.startsWith("glm")) return "zhipu";
  if (m.startsWith("mistral") || m.startsWith("mixtral")) return "mistral";
  return null;
}

// Weekend-active-day count, "every day of some fully-elapsed calendar month"
// flag, and distinct-active-calendar-month count, derived from the days array
// already fetched for the heatmap/stats — no extra query needed.
function badgeCalendarStats(days) {
  const active = (days || []).filter((d) => int(d.total_tokens) > 0);
  let weekendActiveDays = 0;
  const monthActiveDayCounts = new Map();
  for (const day of active) {
    const date = parseUTCDate(day.date_utc);
    if (!date) continue;
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) weekendActiveDays++;
    const ym = day.date_utc.slice(0, 7);
    monthActiveDayCounts.set(ym, (monthActiveDayCounts.get(ym) || 0) + 1);
  }
  const currentYM = todayUTCDate().toISOString().slice(0, 7);
  let hasPerfectMonth = false;
  for (const [ym, count] of monthActiveDayCounts) {
    if (ym >= currentYM) continue; // only fully-elapsed months count as "full calendar month"
    const [y, mo] = ym.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (count >= daysInMonth) {
      hasPerfectMonth = true;
      break;
    }
  }
  return { weekendActiveDays, hasPerfectMonth, distinctActiveMonths: monthActiveDayCounts.size };
}

// Lifetime day-level component sums (input/cache-read/cache-write/output/
// reasoning/records) plus whether the account has ever synced any OpenRouter
// usage — always available regardless of whether per-source segment tracking
// exists. One UNION ALL CTE aggregated once, rather than paired scalar
// subqueries per column (far fewer bind params to get wrong).
async function badgeDayTotals(env, account) {
  if (account.kind === "org") {
    const row = await env.DB.prepare(`
      WITH org_openrouter AS (
        SELECT o.input_tokens, o.cache_read_tokens, o.cache_write_tokens, o.output_tokens, o.reasoning_tokens, o.records
        FROM openrouter_daily_usage o
        LEFT JOIN memberships m ON m.user_id = o.account_id AND m.org_id = ? AND m.status = 'active'
        WHERE o.account_id = ? OR m.user_id IS NOT NULL
      ),
      combined AS (
        SELECT d.input_tokens, d.cache_read_tokens, d.cache_write_tokens, d.output_tokens, d.reasoning_tokens, d.records
        FROM daily_machine_usage d
        JOIN memberships m ON m.user_id = d.user_id AND m.status = 'active'
        WHERE m.org_id = ?
        UNION ALL
        SELECT input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, records FROM org_openrouter
      )
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(records), 0) AS records,
        EXISTS(SELECT 1 FROM org_openrouter) AS has_openrouter
      FROM combined
    `).bind(account.id, account.id, account.id).first();
    return badgeDayTotalsFromRow(row);
  }
  const row = await env.DB.prepare(`
    WITH combined AS (
      SELECT d.input_tokens, d.cache_read_tokens, d.cache_write_tokens, d.output_tokens, d.reasoning_tokens, d.records
      FROM daily_machine_usage d
      JOIN machines mm ON mm.id = d.machine_id
      WHERE d.user_id = ? AND mm.org_id IS NULL
      UNION ALL
      SELECT input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, records
      FROM openrouter_daily_usage WHERE account_id = ?
    )
    SELECT
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(records), 0) AS records,
      EXISTS(SELECT 1 FROM openrouter_daily_usage WHERE account_id = ?) AS has_openrouter
    FROM combined
  `).bind(account.id, account.id, account.id).first();
  return badgeDayTotalsFromRow(row);
}

function badgeDayTotalsFromRow(row) {
  return {
    inputTokens: int(row && row.input_tokens),
    cacheReadTokens: int(row && row.cache_read_tokens),
    cacheWriteTokens: int(row && row.cache_write_tokens),
    outputTokens: int(row && row.output_tokens),
    reasoningTokens: int(row && row.reasoning_tokens),
    records: int(row && row.records),
    hasOpenRouterUsage: Boolean(row && row.has_openrouter),
  };
}

// Distinct (cli, model) segment rows — same scoping as the profile breakdown
// queries but unbounded by date (badges are lifetime), used to derive distinct
// tool/model counts and the model-name list for provider inference.
async function badgeSegmentRows(env, account) {
  if (account.kind === "org") {
    const rows = await env.DB.prepare(`
      SELECT DISTINCT cli, model FROM (
        SELECT s.cli AS cli, s.model AS model
        FROM daily_machine_source_usage s
        JOIN memberships m ON m.user_id = s.user_id AND m.status = 'active'
        WHERE m.org_id = ?
        UNION ALL
        SELECT 'openrouter' AS cli, o.model
        FROM openrouter_daily_model_usage o
        LEFT JOIN memberships m ON m.user_id = o.account_id AND m.org_id = ? AND m.status = 'active'
        WHERE o.account_id = ? OR m.user_id IS NOT NULL
      )
    `).bind(account.id, account.id, account.id).all();
    return rows.results || [];
  }
  const rows = await env.DB.prepare(`
    SELECT DISTINCT cli, model FROM (
      SELECT s.cli AS cli, s.model AS model
      FROM daily_machine_source_usage s
      JOIN machines mm ON mm.id = s.machine_id
      WHERE s.user_id = ? AND mm.org_id IS NULL
      UNION ALL
      SELECT 'openrouter' AS cli, model FROM openrouter_daily_model_usage WHERE account_id = ?
    )
  `).bind(account.id, account.id).all();
  return rows.results || [];
}

async function badgeHasActiveOrgMembership(env, account) {
  if (account.kind === "org") return (await orgMemberCount(env, account.id)) > 1;
  const row = await env.DB.prepare("SELECT EXISTS(SELECT 1 FROM memberships WHERE user_id = ? AND status = 'active') AS has_membership").bind(account.id).first();
  return Boolean(row && row.has_membership);
}

async function badgeBundleFor(env, account, stats, total, days) {
  const [dayTotals, segmentRows, hasActiveOrgMembership] = await Promise.all([
    badgeDayTotals(env, account),
    badgeSegmentRows(env, account),
    badgeHasActiveOrgMembership(env, account),
  ]);
  const distinctTools = new Set(segmentRows.map((r) => r.cli)).size;
  const distinctModels = new Set(segmentRows.map((r) => r.model)).size;
  const distinctProviders = new Set(segmentRows.map((r) => modelProvider(r.model)).filter(Boolean)).size;
  const calendar = badgeCalendarStats(days || []);
  return {
    lifetimeTokens: total,
    bestDayTokens: stats.best_day_tokens,
    activeDays: stats.active_days,
    currentStreak: stats.current_streak_days,
    longestStreak: stats.longest_streak_days,
    distinctTools,
    distinctModels,
    distinctProviders,
    cacheReadTokens: dayTotals.cacheReadTokens,
    inputTokens: dayTotals.inputTokens,
    cacheWriteTokens: dayTotals.cacheWriteTokens,
    outputTokens: dayTotals.outputTokens,
    reasoningTokens: dayTotals.reasoningTokens,
    records: dayTotals.records,
    hasOpenRouterUsage: dayTotals.hasOpenRouterUsage,
    weekendActiveDays: calendar.weekendActiveDays,
    hasPerfectMonth: calendar.hasPerfectMonth,
    distinctActiveMonths: calendar.distinctActiveMonths,
    hasBioAndLink: Boolean(account.bio && (account.website_url || account.github_url || account.x_url)),
    hasActiveOrgMembership,
  };
}

// Awards: INSERT OR IGNORE any newly-earnable non-meta badges, then cascade
// the two meta badges (badge_collector, completionist) against the resulting
// row count. Badges never un-earn — this only ever adds rows. Returns the
// keys newly inserted in this call (empty on repeat calls once fully caught up).
async function awardBadges(env, account, statsBundle) {
  const earnable = computeEarnableBadges(statsBundle);
  if (!earnable.length) return [];
  await env.DB.batch(earnable.map((key) =>
    env.DB.prepare("INSERT OR IGNORE INTO account_badges (account_id, badge_key) VALUES (?, ?)").bind(account.id, key)
  ));
  const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM account_badges WHERE account_id = ?").bind(account.id).first();
  const n = int(countRow && countRow.n);
  const metaEarnable = BADGE_DEFS.filter((b) => b.meta && n >= b.metaThreshold).map((b) => b.key);
  if (metaEarnable.length) {
    await env.DB.batch(metaEarnable.map((key) =>
      env.DB.prepare("INSERT OR IGNORE INTO account_badges (account_id, badge_key) VALUES (?, ?)").bind(account.id, key)
    ));
  }
  return [...earnable, ...metaEarnable];
}

// Single entry point for all three award triggers (ingest, OpenRouter
// sync/ingest, lazy profile/dashboard view) — re-derives the account and its
// full stats bundle fresh each time, so it's self-healing by construction.
async function awardBadgesForAccountID(env, accountID) {
  const account = await accountView(env, accountID);
  if (!account) return [];
  const days = account.kind === "org" ? await orgDays(env, account.id) : await userDays(env, account.id);
  const total = days.reduce((sum, d) => sum + d.total_tokens, 0);
  const stats = profileStats(days, total);
  const bundle = await badgeBundleFor(env, account, stats, total, days);
  return awardBadges(env, account, bundle);
}

async function fetchEarnedBadges(env, accountID) {
  const rows = await env.DB.prepare("SELECT badge_key, earned_at FROM account_badges WHERE account_id = ? ORDER BY earned_at DESC").bind(accountID).all();
  return rows.results || [];
}

async function profileBadgeStats(env, profile) {
  const bundle = await badgeBundleFor(env, profile.account, profile.stats, profile.total_tokens, profile.days);
  await awardBadges(env, profile.account, bundle); // lazy self-healing catch-up
  const rows = await fetchEarnedBadges(env, profile.account.id);
  return { bundle, earned: rows.map((r) => r.badge_key), earnedRows: rows };
}

// Cheap now that earn state is persisted — a single GROUP BY over account_badges
// rather than a per-account sweep. No cache: the query is trivial at this scale.
async function badgeEarnedCountsFromTable(env) {
  const rows = await env.DB.prepare("SELECT badge_key, COUNT(*) AS n FROM account_badges GROUP BY badge_key").all();
  const counts = Object.fromEntries(BADGE_DEFS.map((b) => [b.key, 0]));
  for (const row of rows.results || []) counts[row.badge_key] = int(row.n);
  return counts;
}

// Per-tier earned-badge counts for one account (OG card rarity strip).
async function accountBadgeTierCounts(env, accountID) {
  const rows = await env.DB.prepare("SELECT badge_key FROM account_badges WHERE account_id = ?").bind(accountID).all();
  const counts = { rare: 0, uncommon: 0, common: 0 };
  for (const row of rows.results || []) {
    const def = badgeDef(row.badge_key);
    if (def) counts[def.tier]++;
  }
  return counts;
}

async function badgesPage(request, env) {
  const isSignedIn = await signedIn(request, env);
  const user = await requireUser(request, env);
  let earnedByViewer = new Map();
  if (user) {
    const rows = await fetchEarnedBadges(env, user.id);
    earnedByViewer = new Map(rows.map((r) => [r.badge_key, r.earned_at]));
  }
  const counts = await badgeEarnedCountsFromTable(env);
  return html(badgesPageHtml(counts, earnedByViewer, isSignedIn));
}

function badgesPageHtml(counts, earnedByViewer, isSignedIn) {
  const groups = BADGE_TIER_ORDER.map((tier) => ({
    tier,
    label: BADGE_TIERS[tier],
    defs: BADGE_DEFS.filter((b) => b.tier === tier),
  }));
  const sections = groups.map((group) => `<section class="badge-tier-group">
    <h2>${esc(group.label)}</h2>
    <div class="badge-grid">${group.defs.map((def) => badgeCard(def, { count: counts[def.key] || 0, earnedAt: earnedByViewer.get(def.key) || null, showPill: true, personalLabel: "Yours since" })).join("")}</div>
  </section>`).join("");
  return layout("Badges — Burnfolio", `
    <main class="profile badges-page">
      <header class="profile-head">
        <div>
          <p class="eyebrow">Achievements</p>
          <h1>Badges</h1>
          <p class="profile-summary"><span>${BADGE_DEFS.length} badges across three tiers, computed from real usage: Base Model, Fine-Tune, Frontier.</span></p>
        </div>
      </header>
      ${sections}
    </main>
  `, {
    description: `All ${BADGE_DEFS.length} Burnfolio badges — Base Model, Fine-Tune, and Frontier tiers — with earned-by counts.`,
    canonical: "https://burnfolio.ai/badges",
    signedIn: isSignedIn,
  });
}

// Small filled medallion, tier color set purely via CSS from the parent's
// .badge-tier-* class — the same visual atom used everywhere a badge appears.
function badgeMedallion() {
  return `<i class="badge-medallion" aria-hidden="true"></i>`;
}

// Shared card: header (medallion + name + earned pill), body (description),
// footer (community fact left, personal fact right, split by a top border).
// Used on both /badges (showPill: true, "Yours since") and /:ref/badges
// (showPill: false — every card there is earned by definition — "Earned").
function badgeCard(def, { count = 0, earnedAt = null, showPill = true, personalLabel = "Yours since" } = {}) {
  const isSecret = Boolean(def.secret);
  const name = isSecret ? def.secretName : def.name;
  const description = isSecret ? def.secretDescription : def.description;
  const earned = Boolean(earnedAt);
  const footerLeft = count === 0 ? "No one has earned this yet" : `Earned by ${count} ${count === 1 ? "builder" : "builders"}`;
  const footerRight = earned ? `${personalLabel} ${formatDate(String(earnedAt).slice(0, 10))}` : "";
  const pill = earned && showPill ? `<span class="badge-pill" title="You earned this" aria-label="You earned this"><i class="badge-check" aria-hidden="true">&#10003;</i> Earned</span>` : "";
  return `<div class="badge-card badge-tier-${def.tier}${earned ? " earned" : ""}">
    <div class="badge-card-head">${badgeMedallion()}<strong>${esc(name)}</strong>${pill}</div>
    <p class="badge-card-body">${esc(description)}</p>
    <div class="badge-card-footer">
      <span class="badge-footer-left">${esc(footerLeft)}</span>
      ${footerRight ? `<span class="badge-footer-right">${esc(footerRight)}</span>` : ""}
    </div>
  </div>`;
}

async function profileStatsRoute(env, ref) {
  const profile = await buildProfile(env, ref);
  if (!profile) return json({ error: "not_found" }, 404);
  const payload = {
    account: profile.account,
    days: profile.days,
    total_tokens: profile.total_tokens,
    stats: profile.stats,
    member_count: profile.member_count,
    embed_url: profile.embed_url,
    streaks: { current_days: profile.stats.current_streak_days, longest_days: profile.stats.longest_streak_days },
  };
  if (profile.account.show_model_breakdown) {
    const economics = await profileEconomics(env, profile.account);
    payload.by_cli = economics.byTool;
    payload.top_models = economics.topModels;
  }
  const { earnedRows } = await profileBadgeStats(env, profile);
  payload.badges = earnedRows.map((row) => {
    const def = badgeDef(row.badge_key);
    return { key: row.badge_key, name: def.name, tier: def.tier, earned_at: row.earned_at };
  });
  return json(payload, 200, { "Access-Control-Allow-Origin": "*" });
}

async function profilePage(request, env, ref) {
  const profile = await buildProfile(env, ref);
  const isSignedIn = await signedIn(request, env);
  if (!profile) return html(notFoundPage(isSignedIn), 404);
  profile.economics = await profileEconomics(env, profile.account);
  profile.percentile = await accountPercentile(env, profile.account.id);
  profile.badgeRows = (await profileBadgeStats(env, profile)).earnedRows;
  return html(profileHtml(profile, isSignedIn));
}

async function profileBadgesPage(request, env, ref) {
  const profile = await buildProfile(env, ref);
  const isSignedIn = await signedIn(request, env);
  if (!profile) return html(notFoundPage(isSignedIn), 404);
  const [{ earnedRows }, counts] = await Promise.all([
    profileBadgeStats(env, profile),
    badgeEarnedCountsFromTable(env),
  ]);
  return html(profileBadgesHtml(profile, earnedRows, counts, isSignedIn));
}

function profileBadgesHtml(profile, earnedRows, counts, isSignedIn) {
  const name = profile.account.handle || profile.account.account_number;
  const hasHandle = Boolean(profile.account.handle);
  const hasLabel = Boolean(profile.account.display_name && profile.account.display_name !== "Anonymous builder" && profile.account.display_name !== profile.account.account_number);
  const displayName = hasHandle ? profile.account.handle : hasLabel ? profile.account.display_name : profile.account.account_number;
  const groups = BADGE_TIER_ORDER.map((tier) => ({
    tier,
    label: BADGE_TIERS[tier],
    rows: earnedRows.filter((row) => {
      const def = badgeDef(row.badge_key);
      return def && def.tier === tier;
    }),
  })).filter((group) => group.rows.length);
  const sections = groups.map((group) => `<section class="badge-tier-group">
    <h2>${esc(group.label)}</h2>
    <div class="badge-grid">${group.rows.map((row) => {
      const def = badgeDef(row.badge_key);
      return badgeCard(def, { count: counts[row.badge_key] || 0, earnedAt: row.earned_at, showPill: false, personalLabel: "Earned" });
    }).join("")}</div>
  </section>`).join("");
  const body = earnedRows.length ? sections : emptyState("No badges yet", `${displayName} hasn't earned any badges yet.`);
  return layout(`${displayName}'s badges — Burnfolio`, `
    <main class="profile badges-page">
      <header class="profile-head">
        <div>
          <p class="eyebrow"><a href="/${esc(name)}">${esc(displayName)}</a></p>
          <h1>Badges</h1>
          <p class="profile-summary"><span>${formatInt(earnedRows.length)} of ${BADGE_DEFS.length} badges earned.</span> <a href="/badges">View the full catalog &rarr;</a></p>
        </div>
      </header>
      ${body}
    </main>
  `, {
    description: `${displayName} has earned ${earnedRows.length} of ${BADGE_DEFS.length} Burnfolio badges.`,
    canonical: `https://burnfolio.ai/${name}/badges`,
    signedIn: isSignedIn,
  });
}

async function leaderboardRoute(request, env) {
  const range = cleanLeaderboardRange(new URL(request.url).searchParams.get("range"));
  const payload = await cachedLeaderboard(env, range);
  return json(payload, 200, { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" });
}

async function leaderboardPage(request, env) {
  const params = new URL(request.url).searchParams;
  const range = cleanLeaderboardRange(params.get("range"));
  const board = cleanLeaderboardBoard(params.get("board"));
  const payload = await cachedLeaderboard(env, range);
  return html(leaderboardHtml(payload, board, await signedIn(request, env)));
}

function leaderboardHtml(payload, board, isSignedIn) {
  const isWeek = payload.range === "7d";
  const isOrgs = board === "orgs";
  const individualRows = payload.individuals.map(leaderboardRow).join("") || emptyState("No burn yet", "Sync usage with pyro to appear on the leaderboard.");
  const orgRows = payload.organizations.map(leaderboardRow).join("") || emptyState("No organizations on the board yet", "Create one from your dashboard.");
  const claimCTA = isSignedIn ? "" : `<a class="leaderboard-cta" href="/signup">Your burn belongs here. Claim your spot &rarr;</a>`;
  return layout("Leaderboard — Burnfolio", `
    <main class="profile leaderboard-page">
      <header class="profile-head">
        <div>
          <p class="eyebrow">Top burn</p>
          <h1>Leaderboard</h1>
          <p class="profile-summary"><span>Top ${LEADERBOARD_LIMIT} profiles by token burn. Zero-usage accounts don't appear.</span></p>
        </div>
      </header>
      <nav class="embed-theme-tabs leaderboard-tabs" role="tablist" aria-label="Leaderboard range">
        <a class="theme-tab${isWeek ? "" : " active"}" role="tab" aria-selected="${isWeek ? "false" : "true"}" href="${leaderboardURL("all", board)}">All time</a>
        <a class="theme-tab${isWeek ? " active" : ""}" role="tab" aria-selected="${isWeek ? "true" : "false"}" href="${leaderboardURL("7d", board)}">Last 7 days</a>
      </nav>
      <nav class="embed-theme-tabs leaderboard-tabs" role="tablist" aria-label="Leaderboard board">
        <a class="theme-tab${isOrgs ? "" : " active"}" role="tab" aria-selected="${isOrgs ? "false" : "true"}" href="${leaderboardURL(payload.range, "individuals")}">Individuals</a>
        <a class="theme-tab${isOrgs ? " active" : ""}" role="tab" aria-selected="${isOrgs ? "true" : "false"}" href="${leaderboardURL(payload.range, "orgs")}">Organizations</a>
      </nav>
      ${claimCTA}
      <div class="leaderboard-list">${isOrgs ? orgRows : individualRows}</div>
    </main>
  `, {
    description: "The Burnfolio leaderboard: top AI token burn, all time and last 7 days.",
    canonical: `https://burnfolio.ai/leaderboard${isWeek ? "?range=7d" : ""}`,
    signedIn: isSignedIn,
  });
}

function leaderboardRow(entry) {
  const name = esc(entry.display_name && entry.display_name !== "Anonymous builder" ? entry.display_name : entry.ref);
  const topClass = entry.rank <= 3 ? ` leaderboard-top leaderboard-top-${entry.rank}` : "";
  return `<a class="leaderboard-row${topClass}" href="/${esc(entry.ref)}">
    <span class="leaderboard-rank">#${entry.rank}</span>
    <span class="leaderboard-name"><span class="profile-kind-icon" aria-label="${esc(entry.kind)}">${faIcon(entry.kind)}</span>${name}</span>
    <span class="leaderboard-total">${formatCompact(entry.total_tokens)}</span>
    <span class="leaderboard-meta">${formatInt(entry.active_days)} active days</span>
    <span class="leaderboard-meta">${formatInt(entry.current_streak_days)} day streak</span>
  </a>`;
}

async function ogProfilePage(env, ref) {
  const profile = await buildProfile(env, ref);
  if (!profile) return svgResponse(ogLandingFallbackSVG("Profile not found"), 404);
  const badgeCounts = await accountBadgeTierCounts(env, profile.account.id);
  return svgResponse(ogProfileSVG(profile, badgeCounts));
}

async function ogProfilePNGPage(env, ref) {
  const profile = await buildProfile(env, ref);
  if (!profile) return pngResponse(ogFallbackPNG("PROFILE NOT FOUND"), 404, 60);
  const badgeCounts = await accountBadgeTierCounts(env, profile.account.id);
  const badgeKey = `${badgeCounts.rare}-${badgeCounts.uncommon}-${badgeCounts.common}`;
  const cacheKey = new Request(`https://cache.internal/og-png/${encodeURIComponent(ref)}/${profile.total_tokens}/${badgeKey}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  const response = pngResponse(ogProfilePNG(profile, badgeCounts), 200, 600);
  await cache.put(cacheKey, response.clone());
  return response;
}

async function embedPage(request, env, ref) {
  const profile = await buildProfile(env, ref);
  const params = new URL(request.url).searchParams;
  const theme = cleanTheme(params.get("theme"));
  const mode = cleanMode(params.get("mode"));
  if (!profile) return html(notFoundPage(), 404, { embed: true });
  return html(embedHtml(profile, theme, mode), 200, { embed: true });
}

async function embedSVGPage(request, env, ref) {
  const profile = await buildProfile(env, ref);
  const params = new URL(request.url).searchParams;
  const theme = cleanTheme(params.get("theme"));
  const mode = cleanMode(params.get("mode"));
  if (!profile) return new Response("Not found", { status: 404 });
  return new Response(svgEmbed(profile, theme, mode), {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function embedScript(request, ref) {
  const origin = new URL(request.url).origin;
  const params = new URL(request.url).searchParams;
  const theme = cleanTheme(params.get("theme"));
  const mode = cleanMode(params.get("mode"));
  return new Response(`document.currentScript.insertAdjacentHTML("afterend", '<iframe src="${origin}/embed/${escapeJS(encodeURIComponent(ref))}${embedThemeQuery(theme, mode)}" title="Burnfolio token burn" style="width:100%;max-width:760px;height:220px;border:0;border-radius:8px;overflow:hidden"></iframe>');`, {
    headers: { "Content-Type": "application/javascript; charset=utf-8" },
  });
}

async function buildProfile(env, ref) {
  const account = await resolveAccount(env, ref);
  if (!account) return null;
  const days = account.kind === "org" ? await orgDays(env, account.id) : await userDays(env, account.id);
  const memberCount = account.kind === "org" ? await orgMemberCount(env, account.id) : 0;
  const total = days.reduce((sum, day) => sum + day.total_tokens, 0);
  return { account, days, total_tokens: total, stats: profileStats(days, total), member_count: memberCount, embed_url: `/embed/${account.handle || account.account_number}` };
}

async function userDays(env, userID) {
  const clamp = dailyTokenClamp(env);
  const rows = await env.DB.prepare(`
    SELECT date_utc, SUM(total_tokens) AS total_tokens
    FROM (
      SELECT d.date_utc, MIN(d.total_tokens, ?) AS total_tokens
      FROM daily_machine_usage d
      JOIN machines mm ON mm.id = d.machine_id
      WHERE d.user_id = ? AND mm.org_id IS NULL
      UNION ALL
      SELECT date_utc, MIN(total_tokens, ?) AS total_tokens
      FROM openrouter_daily_usage
      WHERE account_id = ?
    )
    GROUP BY date_utc
    ORDER BY date_utc
  `).bind(clamp, userID, clamp, userID).all();
  return rows.results.map(dayRow);
}

async function orgDays(env, orgID) {
  const clamp = dailyTokenClamp(env);
  const rows = await env.DB.prepare(`
    WITH openrouter_rows AS (
      SELECT o.date_utc, o.openrouter_key_hash, MAX(o.total_tokens) AS total_tokens
      FROM openrouter_daily_usage o
      LEFT JOIN memberships m ON m.user_id = o.account_id AND m.org_id = ? AND m.status = 'active'
      WHERE o.account_id = ? OR m.user_id IS NOT NULL
      GROUP BY o.date_utc, o.openrouter_key_hash
    )
    SELECT date_utc, SUM(total_tokens) AS total_tokens
    FROM (
      SELECT d.date_utc, MIN(d.total_tokens, ?) AS total_tokens
      FROM daily_machine_usage d
      JOIN memberships m ON m.user_id = d.user_id AND m.status = 'active'
      WHERE m.org_id = ?
      UNION ALL
      SELECT date_utc, MIN(total_tokens, ?) AS total_tokens
      FROM openrouter_rows
    )
    GROUP BY date_utc
    ORDER BY date_utc
  `).bind(orgID, orgID, clamp, orgID, clamp).all();
  return rows.results.map(dayRow);
}

async function orgMemberCount(env, orgID) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM memberships WHERE org_id = ? AND status = 'active'").bind(orgID).first();
  return int(row && row.count);
}

async function userSourceRows(env, userID, sinceDate) {
  const rows = await env.DB.prepare(`
    SELECT cli, model, SUM(total_tokens) AS total_tokens
    FROM (
      SELECT s.cli, s.model, s.total_tokens
      FROM daily_machine_source_usage s
      JOIN machines mm ON mm.id = s.machine_id
      WHERE s.user_id = ? AND mm.org_id IS NULL AND s.date_utc >= ?
      UNION ALL
      SELECT 'openrouter' AS cli, o.model, o.total_tokens
      FROM openrouter_daily_model_usage o
      WHERE o.account_id = ? AND o.date_utc >= ?
    )
    GROUP BY cli, model
  `).bind(userID, sinceDate, userID, sinceDate).all();
  return rows.results || [];
}

async function orgSourceRows(env, orgID, sinceDate) {
  const rows = await env.DB.prepare(`
    WITH openrouter_model_rows AS (
      SELECT o.date_utc, o.openrouter_key_hash, o.model, MAX(o.total_tokens) AS total_tokens
      FROM openrouter_daily_model_usage o
      LEFT JOIN memberships m ON m.user_id = o.account_id AND m.org_id = ? AND m.status = 'active'
      WHERE (o.account_id = ? OR m.user_id IS NOT NULL) AND o.date_utc >= ?
      GROUP BY o.date_utc, o.openrouter_key_hash, o.model
    )
    SELECT cli, model, SUM(total_tokens) AS total_tokens
    FROM (
      SELECT s.cli, s.model, s.total_tokens
      FROM daily_machine_source_usage s
      JOIN memberships m ON m.user_id = s.user_id AND m.status = 'active'
      WHERE m.org_id = ? AND s.date_utc >= ?
      UNION ALL
      SELECT 'openrouter' AS cli, model, total_tokens
      FROM openrouter_model_rows
    )
    GROUP BY cli, model
  `).bind(orgID, orgID, sinceDate, orgID, sinceDate).all();
  return rows.results || [];
}

// Personal (org_id IS NULL machines only), full history, raw/unclamped — used by
// the dashboard history chart/table and the CSV export. Unlike userDays, this is
// never shown publicly, so there's no reason to clamp it.
async function userDailyComponentRows(env, userID) {
  const rows = await env.DB.prepare(`
    SELECT date_utc,
      SUM(records) AS records,
      SUM(input_tokens) AS input_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(reasoning_tokens) AS reasoning_tokens,
      SUM(total_tokens) AS total_tokens
    FROM (
      SELECT d.date_utc, d.records, d.input_tokens, d.cache_read_tokens, d.cache_write_tokens, d.output_tokens, d.reasoning_tokens, d.total_tokens
      FROM daily_machine_usage d
      JOIN machines mm ON mm.id = d.machine_id
      WHERE d.user_id = ? AND mm.org_id IS NULL
      UNION ALL
      SELECT date_utc, records, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens
      FROM openrouter_daily_usage
      WHERE account_id = ?
    )
    GROUP BY date_utc
    ORDER BY date_utc
  `).bind(userID, userID).all();
  return rows.results || [];
}

// Same scope as userDailyComponentRows but broken out per (date, cli, model),
// aggregated across the user's machines — used by the tool-split/top-tool-per-day
// dashboard views and the breakdown CSV.
async function userDailySourceRows(env, userID) {
  const rows = await env.DB.prepare(`
    SELECT date_utc, cli, model,
      SUM(records) AS records,
      SUM(input_tokens) AS input_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(reasoning_tokens) AS reasoning_tokens,
      SUM(total_tokens) AS total_tokens
    FROM (
      SELECT s.date_utc, s.cli, s.model, s.records, s.input_tokens, s.cache_read_tokens, s.cache_write_tokens, s.output_tokens, s.reasoning_tokens, s.total_tokens
      FROM daily_machine_source_usage s
      JOIN machines mm ON mm.id = s.machine_id
      WHERE s.user_id = ? AND mm.org_id IS NULL
      UNION ALL
      SELECT o.date_utc, 'openrouter' AS cli, o.model, o.records, o.input_tokens, o.cache_read_tokens, o.cache_write_tokens, o.output_tokens, o.reasoning_tokens, o.total_tokens
      FROM openrouter_daily_model_usage o
      WHERE o.account_id = ?
    )
    GROUP BY date_utc, cli, model
    ORDER BY date_utc, total_tokens DESC
  `).bind(userID, userID).all();
  return rows.results || [];
}

function summarizeSourceRows(rows) {
  const total = rows.reduce((sum, r) => sum + int(r.total_tokens), 0);
  const byToolMap = new Map();
  const byModelMap = new Map();
  for (const r of rows) {
    const tokens = int(r.total_tokens);
    byToolMap.set(r.cli, (byToolMap.get(r.cli) || 0) + tokens);
    byModelMap.set(r.model, (byModelMap.get(r.model) || 0) + tokens);
  }
  const byTool = [...byToolMap.entries()]
    .map(([cli, tokens]) => ({ cli, tokens, pct: total ? tokens / total : 0 }))
    .sort((a, b) => b.tokens - a.tokens);
  const topModels = [...byModelMap.entries()]
    .map(([model, tokens]) => ({ model, tokens, pct: total ? tokens / total : 0 }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 10);
  return { total, byTool, topModels };
}

async function profileEconomics(env, account) {
  if (!account.show_model_breakdown) return { enabled: false, hasBreakdown: false, byTool: [], topModels: [] };
  const since = sameDatePreviousYear(todayUTCDate()).toISOString().slice(0, 10);
  const isOrg = account.kind === "org";
  const sourceRows = isOrg ? await orgSourceRows(env, account.id, since) : await userSourceRows(env, account.id, since);
  const breakdown = summarizeSourceRows(sourceRows);
  return { enabled: true, hasBreakdown: sourceRows.length > 0, byTool: breakdown.byTool, topModels: breakdown.topModels };
}

const LEADERBOARD_LIMIT = 50;

function cleanLeaderboardRange(value) {
  return value === "7d" ? "7d" : "all";
}

function cleanLeaderboardBoard(value) {
  return value === "orgs" ? "orgs" : "individuals";
}

function leaderboardURL(range, board) {
  const params = [];
  if (range === "7d") params.push("range=7d");
  if (board === "orgs") params.push("board=orgs");
  return `/leaderboard${params.length ? `?${params.join("&")}` : ""}`;
}

// The full ranked-by-clamped-total account list (all accounts with nonzero
// usage, no LIMIT), shared by the leaderboard (top LEADERBOARD_LIMIT) and
// percentile computation (an account's position among all of them).
async function rankedAccountRows(env, range) {
  const clamp = dailyTokenClamp(env);
  const since = range === "7d" ? dateOffsetUTC(todayUTCDate().toISOString().slice(0, 10), -6) : MIN_INGEST_DATE;
  const rows = await env.DB.prepare(`
    WITH personal_machine AS (
      SELECT d.user_id AS account_id, MIN(d.total_tokens, ?) AS total_tokens
      FROM daily_machine_usage d
      JOIN machines mm ON mm.id = d.machine_id
      WHERE mm.org_id IS NULL AND d.date_utc >= ?
    ),
    personal_openrouter AS (
      SELECT o.account_id, MIN(o.total_tokens, ?) AS total_tokens
      FROM openrouter_daily_usage o
      JOIN accounts ua ON ua.id = o.account_id AND ua.kind = 'user'
      WHERE o.date_utc >= ?
    ),
    user_totals AS (
      SELECT account_id, SUM(total_tokens) AS total_tokens, 'user' AS kind
      FROM (
        SELECT account_id, total_tokens FROM personal_machine
        UNION ALL
        SELECT account_id, total_tokens FROM personal_openrouter
      )
      GROUP BY account_id
    ),
    org_machine AS (
      SELECT m.org_id AS account_id, MIN(d.total_tokens, ?) AS total_tokens
      FROM daily_machine_usage d
      JOIN memberships m ON m.user_id = d.user_id AND m.status = 'active'
      WHERE d.date_utc >= ?
    ),
    org_openrouter_raw AS (
      SELECT m.org_id AS account_id, o.date_utc, o.openrouter_key_hash, o.total_tokens
      FROM openrouter_daily_usage o
      JOIN memberships m ON m.user_id = o.account_id AND m.status = 'active'
      WHERE o.date_utc >= ?
      UNION ALL
      SELECT o.account_id, o.date_utc, o.openrouter_key_hash, o.total_tokens
      FROM openrouter_daily_usage o
      JOIN accounts a ON a.id = o.account_id AND a.kind = 'org'
      WHERE o.date_utc >= ?
    ),
    org_openrouter AS (
      SELECT account_id, MIN(MAX(total_tokens), ?) AS total_tokens
      FROM org_openrouter_raw
      GROUP BY account_id, date_utc, openrouter_key_hash
    ),
    org_totals AS (
      SELECT account_id, SUM(total_tokens) AS total_tokens, 'org' AS kind
      FROM (
        SELECT account_id, total_tokens FROM org_machine
        UNION ALL
        SELECT account_id, total_tokens FROM org_openrouter
      )
      GROUP BY account_id
    ),
    ranked AS (
      SELECT account_id, SUM(total_tokens) AS total_tokens, kind
      FROM (
        SELECT * FROM user_totals
        UNION ALL
        SELECT * FROM org_totals
      )
      GROUP BY account_id, kind
    )
    SELECT a.id AS account_id, a.account_number, h.handle, a.display_name, r.kind, r.total_tokens
    FROM ranked r
    JOIN accounts a ON a.id = r.account_id
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE r.total_tokens > 0
    ORDER BY r.total_tokens DESC
  `).bind(clamp, since, clamp, since, clamp, since, since, since, clamp).all();
  return rows.results || [];
}

async function cachedRankedAccountRows(env, range) {
  const cacheKey = new Request(`https://cache.internal/ranked-totals/${range}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();
  const rows = await rankedAccountRows(env, range);
  const response = json(rows, 200, { "Cache-Control": "public, max-age=300" });
  await cache.put(cacheKey, response.clone());
  return rows;
}

async function rankedEntries(env, rankedSubset) {
  const entries = [];
  for (const [index, row] of rankedSubset.slice(0, LEADERBOARD_LIMIT).entries()) {
    const days = row.kind === "org" ? await orgDays(env, row.account_id) : await userDays(env, row.account_id);
    const stats = profileStats(days, int(row.total_tokens));
    entries.push({
      rank: index + 1,
      ref: row.handle || row.account_number,
      display_name: row.display_name,
      kind: row.kind,
      total_tokens: int(row.total_tokens),
      active_days: stats.active_days,
      current_streak_days: stats.current_streak_days,
    });
  }
  return entries;
}

async function fetchLeaderboard(env, range) {
  const ranked = await cachedRankedAccountRows(env, range);
  const individuals = await rankedEntries(env, ranked.filter((row) => row.kind === "user"));
  const organizations = await rankedEntries(env, ranked.filter((row) => row.kind === "org"));
  return { individuals, organizations };
}

async function cachedLeaderboard(env, range) {
  const cacheKey = new Request(`https://cache.internal/leaderboard/${range}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();
  const { individuals, organizations } = await fetchLeaderboard(env, range);
  // `entries` kept for API back-compat (no internal consumer left after the split) — mirrors individuals, the closest match to the old combined+ranked list.
  const payload = { range, generated_at: new Date().toISOString(), individuals, organizations, entries: individuals };
  const response = json(payload, 200, { "Cache-Control": "public, max-age=300" });
  await cache.put(cacheKey, response.clone());
  return payload;
}

const PERCENTILE_MIN_ACCOUNTS = 20;

async function accountPercentile(env, accountID) {
  const ranked = await cachedRankedAccountRows(env, "all");
  if (ranked.length < PERCENTILE_MIN_ACCOUNTS) return null;
  const index = ranked.findIndex((row) => row.account_id === accountID);
  if (index === -1) return null;
  const percentile = Math.max(1, Math.round(((index + 1) / ranked.length) * 100));
  return { percentile, totalAccounts: ranked.length };
}

async function updateAccountMetadata(env, accountID, fields) {
  const columns = ["bio", "website_url", "github_url", "x_url", "show_model_breakdown", "monthly_goal_tokens"].filter((key) => key in fields);
  if (!columns.length) return;
  const assignments = columns.map((key) => `${key} = ?`).join(", ");
  const values = columns.map((key) => (key === "show_model_breakdown" ? (fields[key] ? 1 : 0) : fields[key] || null));
  await env.DB.prepare(`UPDATE accounts SET ${assignments} WHERE id = ?`).bind(...values, accountID).run();
}

async function createUser(env, { email, handle }) {
  const id = crypto.randomUUID();
  const accountNumber = await uniqueAccountNumber(env);
  const accountKey = randomToken("bfa");
  const statements = [
    env.DB.prepare("INSERT INTO accounts (id, account_number, kind, display_name) VALUES (?, ?, 'user', ?)").bind(id, accountNumber, handle || "Anonymous builder"),
    env.DB.prepare("INSERT INTO users (id, email, access_key_hash) VALUES (?, ?, ?)").bind(id, email || null, await sha256(accountKey)),
  ];
  if (email) statements.push(env.DB.prepare("INSERT INTO user_emails (user_id, email, is_primary) VALUES (?, ?, 1)").bind(id, email));
  if (handle) statements.push(env.DB.prepare("INSERT INTO handles (handle, account_id) VALUES (?, ?)").bind(handle, id));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (message.includes("users.email") || message.includes("user_emails")) return { error: "email_already_claimed", status: 409 };
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
    env.DB.prepare("INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, 'owner')").bind(id, ownerUserID),
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
  await env.DB.prepare("INSERT INTO machines (id, user_id, org_id, machine_number, name, token_hash) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, userID, orgID || null, machineNumber, cleanText(name, 80), await sha256(token)).run();
  return { machine_number: machineNumber, name: cleanText(name, 80), token, profile: profileRef };
}

async function machineRows(env, userID) {
  return env.DB.prepare(`
    SELECT
      m.machine_number,
      m.name,
      m.created_at,
      m.last_seen_at,
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

async function emailRows(env, userID) {
  const rows = await env.DB.prepare(`
    SELECT email, verified_at, is_primary
    FROM user_emails
    WHERE user_id = ?
    ORDER BY is_primary DESC, created_at ASC, email ASC
  `).bind(userID).all();
  return rows.results || [];
}

async function userByEmail(env, email) {
  return env.DB.prepare(`
    SELECT u.id
    FROM users u
    LEFT JOIN user_emails ue ON ue.user_id = u.id
    WHERE u.email = ? OR ue.email = ?
    LIMIT 1
  `).bind(email, email).first();
}

async function userByVerifiedEmail(env, email) {
  return env.DB.prepare(`
    SELECT u.id
    FROM users u
    LEFT JOIN user_emails ue ON ue.user_id = u.id
    WHERE (u.email = ? AND u.email_verified_at IS NOT NULL)
       OR (ue.email = ? AND ue.verified_at IS NOT NULL)
    LIMIT 1
  `).bind(email, email).first();
}

async function verifyEmailForUser(env, userID, email) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_emails WHERE email = ? AND verified_at IS NULL").bind(email),
    env.DB.prepare("UPDATE users SET email = NULL WHERE email = ? AND id != ? AND email_verified_at IS NULL").bind(email, userID),
    env.DB.prepare(`
      INSERT INTO user_emails (user_id, email, verified_at, is_primary)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE((SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM user_emails WHERE user_id = ?), 1))
      ON CONFLICT(email) DO UPDATE SET
        verified_at = CASE WHEN user_emails.user_id = excluded.user_id THEN excluded.verified_at ELSE user_emails.verified_at END,
        is_primary = CASE WHEN user_emails.user_id = excluded.user_id THEN user_emails.is_primary ELSE user_emails.is_primary END
    `).bind(userID, email, userID),
    env.DB.prepare(`
      UPDATE users
      SET email = COALESCE(email, ?),
          email_verified_at = COALESCE(email_verified_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE id = ?
    `).bind(email, userID),
  ]);
}

async function membershipRole(env, orgID, userID) {
  const row = await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active'").bind(orgID, userID).first();
  return row ? row.role : "";
}

async function anyMembership(env, orgID, userID) {
  return env.DB.prepare("SELECT role, status FROM memberships WHERE org_id = ? AND user_id = ?").bind(orgID, userID).first();
}

function canManageOrg(role) {
  return role === "owner" || role === "admin";
}

function cleanRole(value) {
  return ["member", "admin", "owner"].includes(value) ? value : "member";
}

async function inviteOrgMember(env, orgID, userID, role) {
  await env.DB.prepare(`
    INSERT INTO memberships (org_id, user_id, role, status)
    VALUES (?, ?, ?, 'pending')
    ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role
  `).bind(orgID, userID, role).run();
}

async function setOrgMemberRole(env, orgID, userID, role) {
  if (role === "owner") {
    await env.DB.batch([
      env.DB.prepare("UPDATE memberships SET role = 'admin' WHERE org_id = ? AND role = 'owner'").bind(orgID),
      env.DB.prepare(`
        INSERT INTO memberships (org_id, user_id, role)
        VALUES (?, ?, 'owner')
        ON CONFLICT(org_id, user_id) DO UPDATE SET role = 'owner'
      `).bind(orgID, userID),
    ]);
    return;
  }
  await env.DB.prepare(`
    INSERT INTO memberships (org_id, user_id, role)
    VALUES (?, ?, ?)
    ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role
  `).bind(orgID, userID, role).run();
}

async function acceptOrgInvite(env, orgID, userID) {
  const result = await env.DB.prepare("UPDATE memberships SET status = 'active' WHERE org_id = ? AND user_id = ? AND status = 'pending'").bind(orgID, userID).run();
  return result.meta && result.meta.changes > 0;
}

async function declineOrgInvite(env, orgID, userID) {
  const result = await env.DB.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'pending'").bind(orgID, userID).run();
  return result.meta && result.meta.changes > 0;
}

function machineCanSyncToAccount(machine, account) {
  if (account.kind === "user") return account.id === machine.user_id && !machine.org_id;
  if (account.kind === "org") return account.id === machine.org_id;
  return false;
}

async function accountView(env, id) {
  return env.DB.prepare(`
    SELECT a.id, a.account_number, a.kind, a.display_name, a.bio, a.website_url, a.github_url, a.x_url, a.show_model_breakdown, a.monthly_goal_tokens, a.created_at, h.handle
    FROM accounts a
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE a.id = ?
  `).bind(id).first();
}

async function resolveAccount(env, ref) {
  ref = String(ref || "").trim().replace(/^@/, "");
  if (!ref) return null;
  if (ref.length > 80) return null;
  return env.DB.prepare(`
    SELECT a.id, a.account_number, a.kind, a.display_name, a.bio, a.website_url, a.github_url, a.x_url, a.show_model_breakdown, a.created_at, h.handle
    FROM accounts a
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE a.account_number = ? OR h.handle = ?
  `).bind(ref, cleanHandle(ref) || ref.toLowerCase()).first();
}

async function requireUser(request, env) {
  const token = cookieValue(request, COOKIE_NAME);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')").bind(await sha256(token)).first();
  if (!row) return null;
  return { id: row.user_id };
}

async function signedIn(request, env) {
  return Boolean(await requireUser(request, env));
}

async function createSession(env, userID) {
  const sessionToken = randomToken("bf_session");
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))").bind(await sha256(sessionToken), userID).run();
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

function homePage(isSignedIn = false, global = emptyGlobalStats(), counts = { users: 0, orgs: 0 }, recent = []) {
  const globalTotal = formatCompact(global.total_tokens);
  const globalSubtitle = `${formatInt(global.last_year_tokens)} tokens burned globally`;
  const showSocialProof = counts.users >= 50;
  return layout("Burnfolio — Show your burn", `
    <main class="landing">
      <section class="hero">
        <div class="hero-copy">
        <img class="hero-pyro" src="/assets/pyro-gpu.svg" alt="Pyro warming up a GPU" width="156" height="156">
        <p class="eyebrow">Burn graph for AI-native builders</p>
        <h1>Show your burn.</h1>
        <p class="lede">The contribution graph for everything you build with AI. Install <code>pyro</code>, sync token counts, and share a graph worth showing off.</p>
        <div class="hero-actions">
          ${isSignedIn
            ? `<a class="button" href="/app">Open dashboard</a>`
            : `<a class="button" href="/signup">Create your graph</a><a class="button secondary" href="/signin">Sign in</a>`}
        </div>
        <p class="helper">Counts, not content. No prompts, code, or transcripts leave your machine.</p>
        <a class="example-link" href="/raghavsood">See an example profile &rarr;</a>
        </div>
        <section class="showcase">
          <div class="showcase-top">
            <div><span>Global burn graph</span><strong>${esc(globalTotal)} tokens burned</strong></div>
            ${showSocialProof ? `<div class="showcase-counts" aria-label="Burnfolio account counts">
              <span>${faIcon("user")} ${formatInt(counts.users)} ${counts.users === 1 ? "user" : "users"}</span>
              <span>${faIcon("org")} ${formatInt(counts.orgs)} ${counts.orgs === 1 ? "org" : "orgs"}</span>
            </div>` : ""}
          </div>
          ${heatmap(global.days, { title: "Past year", subtitle: globalSubtitle })}
          ${recentSyncsTicker(recent)}
          ${landingSteps()}
        </section>
      </section>
    </main>
  `, {
    description: "The contribution graph for everything you build with AI. Install pyro, sync token counts, and show your burn.",
    image: "https://burnfolio.ai/og/landing.png",
    imageType: "image/png",
    canonical: "https://burnfolio.ai/",
    signedIn: isSignedIn,
  });
}

function recentSyncsTicker(recent) {
  return `<div class="recent-ticker" data-recent-ticker${!recent || !recent.length ? " hidden" : ""}>
    <p class="eyebrow">Recent activity</p>
    <ul>${recentSyncsItems(recent)}</ul>
  </div>`;
}

function recentActivityItem(r) {
  if (r.type === "badge") {
    return `<li><strong>${esc(r.ref)}</strong> earned <strong>${esc(r.badge_name)}</strong> &middot; <span data-since="${esc(r.at)}">recently</span></li>`;
  }
  return `<li><strong>${esc(r.tokens_display)}</strong> tokens synced &middot; <span data-since="${esc(r.at)}">recently</span></li>`;
}

function recentSyncsItems(recent) {
  return (recent || []).map(recentActivityItem).join("");
}

function landingSteps() {
  const installCmd = "curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/install.sh | bash";
  return `<ol class="steps">
    <li><span class="step-index">1</span><div><strong>Create your graph</strong><p>Claim a profile in seconds. No password, just an email magic link.</p><a class="button secondary" href="/signup">Create your graph</a></div></li>
    <li><span class="step-index">2</span><div><strong>Run pyro</strong><p>One command installs the local collector and starts syncing your daily token counts.</p><div class="snippet"><div><span>Install command</span><button type="button" class="secondary copy" data-copy="${esc(installCmd)}">Copy</button></div><code>${esc(installCmd)}</code></div></div></li>
    <li><span class="step-index">3</span><div><strong>Share the graph</strong><p>Drop a live embed in your GitHub README, or link your public profile anywhere.</p></div></li>
  </ol>`;
}

function authPage(mode = "signup") {
  const isSignup = mode === "signup";
  const title = isSignup ? "Create your Burnfolio" : "Sign in to Burnfolio";
  const eyebrow = isSignup ? "Create profile" : "Welcome back";
  const heading = isSignup ? "Start with an email magic link." : "Open your burn graph.";
  const body = isSignup
    ? "We'll create your profile and send a sign-in link. Add machines after you land in the dashboard."
    : "Use the email attached to your profile. We'll send a fresh magic link.";
  const submit = isSignup ? "Create profile" : "Send magic link";
  const switchHref = isSignup ? "/signin" : "/signup";
  const switchText = isSignup ? "Already have a profile? Sign in" : "New to Burnfolio? Create a profile";
  return layout(`${title} — Burnfolio`, `
    <main class="auth-shell">
      <section class="auth-card primary-auth">
        <p class="eyebrow">${esc(eyebrow)}</p>
        <h1>${esc(heading)}</h1>
        <p class="lede">${esc(body)}</p>
        <form class="auth-form" data-login data-email-action data-resend-label="Resend link" data-auth-mode="${isSignup ? "signup" : "signin"}">
          <label for="auth-email">Email</label>
          <div class="form-row">
            <input id="auth-email" name="email" type="email" placeholder="you@example.com" autocomplete="email" required>
            <button>${esc(submit)}</button>
          </div>
        </form>
        <div class="result auth-result" data-login-result hidden></div>
        <p class="helper">No password. The link expires in 15 minutes.</p>
        <p class="auth-switch"><a href="${switchHref}">${esc(switchText)}</a></p>
      </section>
      <aside class="auth-card auth-side">
        <div>
          <span>Primary flow</span>
          <strong>Email profile</strong>
          <p>Best for recovery, username claims, teams, and setting up machines across devices.</p>
        </div>
        <details>
          <summary>Continue without email</summary>
          <p class="muted">Anonymous profiles use an account number and private account key. Save the key immediately; it is your only recovery path until you attach an email.</p>
          <form class="auth-form" data-signup>
            <label for="anon-machine">First machine name</label>
            <div class="form-row">
              <input id="anon-machine" name="machine_name" placeholder="macbook-pro" autocomplete="off">
              <button class="secondary">Create anonymous profile</button>
            </div>
          </form>
          <div class="result" data-result hidden></div>
        </details>
        <details>
          <summary>Sign in with account number</summary>
          <form class="auth-form" data-account-login>
            <label for="account-number">Account number</label>
            <input id="account-number" name="account_number" placeholder="bf_..." autocomplete="off">
            <label for="account-key">Account key</label>
            <input id="account-key" name="account_key" placeholder="private account key" autocomplete="off">
            <button class="secondary">Sign in</button>
          </form>
          <div class="result" data-account-login-result hidden></div>
        </details>
      </aside>
    </main>
    <script>${signupScript()}</script>
  `, {
    description: "Create or sign in to Burnfolio with an email magic link, then connect pyro and show your burn.",
    canonical: `https://burnfolio.ai/${isSignup ? "signup" : "signin"}`,
  });
}

async function appPage(request, env) {
  const user = await requireUser(request, env);
  if (!user) return authPage("signin");
  const account = await accountView(env, user.id);
  const emails = await emailRows(env, user.id);
  const machines = await machineRows(env, user.id);
  const openRouterConnections = await openRouterConnectionRows(env, user.id);
  const memberships = await env.DB.prepare(`
    SELECT a.account_number, h.handle, a.display_name, m.role, m.status
    FROM memberships m
    JOIN accounts a ON a.id = m.org_id
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE m.user_id = ?
    ORDER BY a.created_at DESC
  `).bind(user.id).all();
  const orgs = { results: (memberships.results || []).filter((row) => row.status === "active") };
  const invites = (memberships.results || []).filter((row) => row.status === "pending");
  const profileRef = account.handle || account.account_number;
  const machineScope = orgs.results.length
    ? `<select name="org" aria-label="Machine scope"><option value="">Personal profile</option>${orgs.results.map((org) => `<option value="${esc(accountRef(org))}">${esc(org.display_name || accountRef(org))}</option>`).join("")}</select>`
    : "";
  const profileHelp = account.handle ? "Manage your public identity and recovery email." : "Claim a readable username and attach an email for recovery.";
  const handleControl = account.handle
    ? `<div class="profile-field"><span>Username</span><strong>${esc(account.handle)}</strong></div>`
    : `<form class="form-stack" data-handle><label for="profile-handle">Username</label><div class="form-row"><input id="profile-handle" name="handle" placeholder="claim username"><button>Save</button></div></form>`;
  const emailSummary = emails.length
    ? ` · ${esc(emails[0].email)}${emails[0].verified_at ? " verified" : " pending"}`
    : "";
  const history = await historyPanel(env, account);
  const goals = await goalsPanel(env, account);
  return layout("Burnfolio dashboard", `
    <main class="dash">
      <header class="dash-head">
        <div><p class="eyebrow">Dashboard</p><h1>${esc(account.handle || "Anonymous builder")}</h1><p class="muted">Account <code>${esc(account.account_number)}</code>${emailSummary}</p></div>
        <div class="actions"><a class="button secondary" href="/${esc(profileRef)}">Public profile</a><button class="secondary" data-logout>Log out</button></div>
      </header>
      ${history}
      <div class="dash-grid">
        <section class="panel">
          <div class="section-head"><div><h2>Connect a machine</h2><p class="muted">Create a token, then copy the generated install command.</p></div></div>
          <form class="form-row" data-machine><label class="sr-only" for="machine-name">Machine name</label><input id="machine-name" name="name" placeholder="machine name, e.g. macbook-pro">${machineScope}<button>Create token</button></form>
          <div class="result" data-machine-result hidden></div>
          <div class="list">${machines.results.map((machine) => machineRow(machine, profileRef)).join("") || emptyState("No machines connected", "Create a token and sync with pyro to start filling your burn graph.")}</div>
          <details class="utility-disclosure">
            <summary>Uninstall pyro</summary>
            <p class="muted">This disables Burnfolio cron sync and marks pyro uninstalled while leaving local <code>~/.pyro</code> state in place.</p>
            <div class="snippet"><div><span>Uninstall command</span><button type="button" class="secondary copy" data-copy="${esc(uninstallCommand())}">Copy</button></div><code>${esc(uninstallCommand())}</code></div>
          </details>
        </section>
        ${goals}
      </div>
      <div class="dash-grid">
        <section class="panel">
          <div class="section-head"><div><h2>Profile</h2><p class="muted">${esc(profileHelp)}</p></div></div>
          ${handleControl}
          ${profileMetadataForm(account, { kind: "user" })}
          ${openRouterPanel(openRouterConnections, { kind: "user" })}
          <div class="list">${emails.map(emailRow).join("") || emptyState("No emails linked", "Add an email to use magic links and recover this profile.")}</div>
          <form class="form-stack" data-email data-email-action data-resend-label="Send verification again"><label for="profile-email">Add another email</label><div class="form-row"><input id="profile-email" name="email" placeholder="you@example.com" autocomplete="email"><button class="secondary">Send verification</button></div></form>
          <pre class="result" data-email-result hidden></pre>
        </section>
        <section class="panel">
          <div class="section-head"><div><h2>Organizations</h2><p class="muted">Create org profiles and aggregate member token burn.</p></div></div>
          ${invites.length ? `<div class="section-head compact"><div><h3>Org invites</h3><p class="muted">Accept to roll your usage into the org graph, or decline.</p></div></div><div class="list" data-org-invites>${invites.map(orgInviteRow).join("")}</div>` : ""}
          <form class="form-stack" data-org><label for="org-handle">New organization</label><div class="form-row"><input id="org-handle" name="handle" placeholder="org username"><input name="name" placeholder="display name"><button>Create</button></div></form>
          <pre class="result" data-org-result hidden></pre>
          <div class="list">${orgs.results.map(orgRow).join("") || emptyState("No organizations yet", "Create an org when you want a shared burn graph for a team.")}</div>
        </section>
      </div>
      ${dangerZone(account)}
    </main>
    <script>${dashboardScript(profileRef)}</script>
  `, { signedIn: true });
}

function dangerZone(account) {
  const name = esc(account.handle || account.account_number);
  return `<section class="panel danger-zone">
    <div class="section-head"><div><h2>Danger zone</h2><p class="muted">Export everything Burnfolio has stored about you, or permanently delete your account.</p></div></div>
    <div class="danger-actions">
      <a class="button secondary" href="/api/me/export.json">Export your data (JSON)</a>
    </div>
    <form class="form-row" data-delete-account>
      <label class="sr-only" for="delete-confirm">Type your username to confirm</label>
      <input id="delete-confirm" name="confirm" placeholder="Type &quot;${name}&quot; to confirm" autocomplete="off">
      <button type="submit" class="danger">Delete account</button>
    </form>
    <p class="result" data-delete-result hidden></p>
  </section>`;
}

async function orgsPage(request, env) {
  const user = await requireUser(request, env);
  if (!user) return authPage("signin");
  const account = await accountView(env, user.id);
  const profileRef = account.handle || account.account_number;
  const orgs = await env.DB.prepare(`
    SELECT a.id, a.account_number, h.handle, a.display_name, a.bio, a.website_url, a.github_url, a.x_url, a.show_model_breakdown, m.role
    FROM memberships m
    JOIN accounts a ON a.id = m.org_id
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE m.user_id = ? AND m.status = 'active'
    ORDER BY lower(a.display_name), a.created_at DESC
  `).bind(user.id).all();
  const requested = new URL(request.url).searchParams.get("org") || "";
  const selected = orgs.results.find((org) => accountRef(org) === requested || org.account_number === requested) || orgs.results[0] || null;
  const members = selected ? await orgMemberRows(env, selected.id) : [];
  const openRouterConnections = selected ? await openRouterConnectionRows(env, selected.id) : [];
  const canManage = selected && canManageOrg(selected.role);
  return layout("Organizations — Burnfolio", `
    <main class="dash org-management">
      <header class="dash-head">
        <div><p class="eyebrow">Organizations</p><h1>Manage organizations</h1><p class="muted">Separate team membership, roles, and ownership from your personal profile.</p></div>
        <div class="actions"><a class="button secondary" href="/app">Dashboard</a><a class="button secondary" href="/${esc(profileRef)}">Public profile</a></div>
      </header>
      <section class="org-shell">
        <aside class="panel org-sidebar">
          <div class="section-head"><div><h2>Your orgs</h2><p class="muted">You can belong to more than one org.</p></div></div>
          <div class="org-nav">${orgs.results.map((org) => {
            const ref = accountRef(org);
            const active = selected && selected.id === org.id;
            return `<a class="${active ? "active" : ""}" href="/app/orgs?org=${encodeURIComponent(ref)}"><strong>${esc(org.display_name || ref)}</strong><span>${esc(ref)} · ${esc(org.role)}</span></a>`;
          }).join("") || emptyState("No organizations yet", "Create one from the dashboard.")}</div>
        </aside>
        <section class="panel org-detail">
          ${selected ? orgDetail(selected, members, canManage, openRouterConnections) : emptyState("No organization selected", "Create an organization before managing members.")}
        </section>
      </section>
    </main>
    <script>${orgManagementScript()}</script>
  `, { signedIn: true });
}

async function orgMemberRows(env, orgID) {
  const rows = await env.DB.prepare(`
    SELECT a.account_number, h.handle, a.display_name, m.role, m.status, m.created_at
    FROM memberships m
    JOIN accounts a ON a.id = m.user_id
    LEFT JOIN handles h ON h.account_id = a.id
    WHERE m.org_id = ?
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, CASE m.status WHEN 'pending' THEN 1 ELSE 0 END, lower(COALESCE(h.handle, a.display_name, a.account_number))
  `).bind(orgID).all();
  return rows.results || [];
}

function orgDetail(org, members, canManage, openRouterConnections = []) {
  const ref = accountRef(org);
  return `
    <div class="section-head"><div><h2>${esc(org.display_name || ref)}</h2><p class="muted"><a href="/${esc(ref)}">/${esc(ref)}</a> · your role is ${esc(org.role)}</p></div></div>
    ${canManage ? profileMetadataForm(org, { kind: "org", ref }) : ""}
    ${canManage ? openRouterPanel(openRouterConnections, { kind: "org", ref }) : ""}
    ${canManage ? `<form class="form-stack org-add-member" data-add-member data-org="${esc(ref)}"><label for="org-member">Invite a member or admin</label><div class="form-row"><input id="org-member" name="user" placeholder="username or account number"><select name="role"><option value="member">member</option><option value="admin">admin</option>${org.role === "owner" ? `<option value="owner">owner (transfer)</option>` : ""}</select><button>Invite</button></div></form><p class="muted">Invited members roll their usage into this org's graph once they accept.</p>` : `<p class="muted">Members can view the org here. Ask an admin or owner to change roles.</p>`}
    <div class="member-list">${members.map((member) => orgMemberRow(org, member, canManage)).join("")}</div>
  `;
}

function profileMetadataForm(account, { kind, ref = "" }) {
  const prefix = kind === "org" ? `org-profile-${account.account_number}` : "profile";
  const attrs = kind === "org"
    ? `data-org-profile data-org="${esc(ref || accountRef(account))}"`
    : "data-profile";
  return `<form class="form-stack profile-meta-form" ${attrs}>
    <label for="${esc(prefix)}-bio">Bio</label>
    <textarea id="${esc(prefix)}-bio" name="bio" maxlength="280" rows="4" placeholder="What are you building?">${esc(account.bio || "")}</textarea>
    <div class="form-row">
      <label class="field-inline" for="${esc(prefix)}-website"><span>Website</span><input id="${esc(prefix)}-website" name="website_url" placeholder="https://example.com" value="${esc(account.website_url || "")}"></label>
      <label class="field-inline" for="${esc(prefix)}-github"><span>GitHub</span><input id="${esc(prefix)}-github" name="github_url" placeholder="github.com/username" value="${esc(account.github_url || "")}"></label>
      <label class="field-inline" for="${esc(prefix)}-x"><span>X.com</span><input id="${esc(prefix)}-x" name="x_url" placeholder="x.com/username" value="${esc(account.x_url || "")}"></label>
    </div>
    <label class="field-checkbox">
      <input type="hidden" name="show_model_breakdown" value="false">
      <input id="${esc(prefix)}-breakdown" type="checkbox" name="show_model_breakdown" value="true"${account.show_model_breakdown ? " checked" : ""}>
      Show tool &amp; model breakdown on your public profile
    </label>
    <div class="form-actions"><button type="submit" class="secondary">Save profile details</button><span class="result inline-result" data-profile-result hidden></span></div>
  </form>`;
}

function openRouterPanel(connections, { kind, ref = "" }) {
  const attrs = kind === "org"
    ? `data-openrouter data-openrouter-scope="org" data-org="${esc(ref)}"`
    : `data-openrouter data-openrouter-scope="user"`;
  const prefix = kind === "org" ? `org-openrouter-${ref}` : "openrouter";
  return `<section class="integration-panel" ${attrs}>
    <div class="section-head compact"><div><h3>OpenRouter</h3><p class="muted">Connect a management key to import account token usage hourly.</p></div></div>
    <form class="form-stack" data-openrouter-connect>
      <label for="${esc(prefix)}-key">Management key</label>
      <div class="form-row">
        <input id="${esc(prefix)}-key" name="key" type="password" placeholder="sk-or-v1-..." autocomplete="off">
        <input id="${esc(prefix)}-name" name="name" type="text" maxlength="80" placeholder="Name (optional)" autocomplete="off">
        <button type="submit" class="secondary">Connect</button>
      </div>
    </form>
    <div class="result inline-result" data-openrouter-result hidden></div>
    <div class="list integration-list">${connections.map((connection) => openRouterConnectionRow(connection, kind, ref)).join("") || emptyState("No OpenRouter key connected", "Use a management key. Burnfolio stores it encrypted and imports daily totals only.")}</div>
  </section>`;
}

function openRouterConnectionRow(connection, kind, ref) {
  const base = kind === "org"
    ? `/api/orgs/${encodeURIComponent(ref)}/openrouter/connections/${encodeURIComponent(connection.id)}`
    : `/api/openrouter/connections/${encodeURIComponent(connection.id)}`;
  const state = connection.status === "error" ? `Error${connection.last_error ? `: ${connection.last_error}` : ""}` : connection.last_sync_at ? `Synced ${formatDate(connection.last_sync_at.slice(0, 10))}` : "Waiting for first sync";
  const label = connection.label || "OpenRouter";
  return `<div class="row integration-row" data-openrouter-connection="${esc(connection.id)}" data-openrouter-base="${esc(base)}">
    <div><strong title="${esc(label)}">${esc(label)}</strong><span>${esc(state)}</span></div>
    <div class="row-actions"><button type="button" class="secondary" data-openrouter-sync>Sync now</button><button type="button" class="secondary" data-openrouter-delete>Remove</button></div>
  </div>`;
}

function orgMemberRow(org, member, canManage) {
  const orgRef = accountRef(org);
  const memberRef = member.handle || member.account_number;
  const isOwner = member.role === "owner";
  const isPending = member.status === "pending";
  const controls = canManage
    ? `<div class="row-actions">
        <form data-member-role data-org="${esc(orgRef)}" data-member="${esc(memberRef)}">
          <select name="role" ${isOwner ? "disabled" : ""}>
            <option value="member"${member.role === "member" ? " selected" : ""}>member</option>
            <option value="admin"${member.role === "admin" ? " selected" : ""}>admin</option>
            ${org.role === "owner" ? `<option value="owner"${member.role === "owner" ? " selected" : ""}>owner${isOwner ? "" : " (transfer)"}</option>` : ""}
          </select>
        </form>
        ${isOwner ? `<span class="row-note">Owner cannot be removed.</span>` : `<button type="button" class="secondary" data-remove-member data-org="${esc(orgRef)}" data-member="${esc(memberRef)}">${isPending ? "Cancel invite" : "Remove"}</button>`}
      </div>`
    : "";
  const memberName = member.handle || member.display_name || member.account_number;
  return `<div class="row member-row"><div><strong title="${esc(memberName)}">${esc(memberName)}</strong><span>${esc(member.account_number)} · ${esc(member.role)}${isPending ? " · invited" : ""}</span></div>${controls}</div>`;
}

function machineRow(machine, fallbackProfileRef) {
  const profileRef = machine.org_handle || machine.org_account_number || fallbackProfileRef;
  const scope = machine.org_id ? `org ${machine.org_display_name || profileRef}` : "personal profile";
  const name = machine.name || machine.machine_number;
  const action = `<button type="button" class="secondary copy" data-refresh-machine="${esc(machine.machine_number)}">Rotate token</button><span class="row-note">Reveals a fresh install command once. The previous token stops working.</span>`;
  return `<div class="row machine-row"><div><strong title="${esc(name)}">${esc(name)}</strong><span>${esc(machine.machine_number)} · ${esc(scope)}${machine.last_seen_at ? ` · seen ${esc(formatDate(machine.last_seen_at.slice(0, 10)))}` : " · never synced"}</span></div><div class="row-actions">${action}</div></div>`;
}

function orgRow(org) {
  const ref = org.handle || org.account_number;
  return `<div class="row"><div><strong><a href="/${esc(ref)}" title="${esc(ref)}">${esc(ref)}</a></strong><span>${esc(org.display_name || "Organization")} · ${esc(org.role)}</span></div><div class="row-actions"><a class="button secondary" href="/app/orgs?org=${encodeURIComponent(ref)}">Manage</a></div></div>`;
}

function orgInviteRow(org) {
  const ref = org.handle || org.account_number;
  const name = org.display_name || ref;
  return `<div class="row" data-org-invite="${esc(ref)}"><div><strong title="${esc(name)}">${esc(name)}</strong><span>Invited as ${esc(org.role)}</span></div><div class="row-actions"><button type="button" data-invite-accept data-org="${esc(ref)}">Accept</button><button type="button" class="secondary" data-invite-decline data-org="${esc(ref)}">Decline</button></div></div>`;
}

function emailRow(row) {
  const state = row.verified_at ? "Verified" : "Pending verification";
  return `<div class="row email-row"><div><strong title="${esc(row.email)}">${esc(row.email)}</strong><span>${esc(state)}${row.is_primary ? " · primary" : ""}</span></div></div>`;
}

function uninstallCommand() {
  return "curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/uninstall.sh | bash";
}

function accountRef(account) {
  return account.handle || account.account_number;
}

function profileHtml(profile, isSignedIn = false) {
  const name = profile.account.handle || profile.account.account_number;
  const hasHandle = Boolean(profile.account.handle);
  const hasLabel = Boolean(profile.account.display_name && profile.account.display_name !== "Anonymous builder" && profile.account.display_name !== profile.account.account_number);
  const displayName = hasHandle ? profile.account.handle : hasLabel ? profile.account.display_name : profile.account.account_number;
  const stats = profile.stats;
  const profileURL = `https://burnfolio.ai/${name}`;
  const shareImagePath = `/og/${encodeURIComponent(name)}.png`;
  const shareImageURL = `https://burnfolio.ai${shareImagePath}`;
  const shareText = shareCopy(profile, displayName);
  const description = `${formatInt(profile.total_tokens)} tokens burned across ${formatInt(stats.active_days)} active days. Show your burn on Burnfolio.`;
  return layout(`${name} on Burnfolio`, `
    <main class="profile">
      <header class="profile-head">
        <div>
          <h1>${esc(displayName)}</h1>
          <p class="profile-summary"><span class="profile-kind-icon" aria-label="${esc(profile.account.kind)}">${faIcon(profile.account.kind)}</span><span class="summary-separator" aria-hidden="true"></span><span>${formatInt(profile.total_tokens)} tokens burned across ${formatInt(stats.active_days)} active days</span></p>
        </div>
        <div class="actions"><button class="share-button" type="button" data-share-open data-share-image="${esc(shareImagePath)}" data-share-text="${esc(shareText)}">Share</button><button class="secondary" data-copy="${esc(profileURL)}">Copy link</button></div>
      </header>
      ${profileAbout(profile.account)}
      <section class="stats">
        ${statCard("Total burn", formatCompact(profile.total_tokens), `${formatInt(profile.total_tokens)} exact`)}
        ${statCard("Active days", formatInt(stats.active_days))}
        ${profile.account.kind === "org" ? statCard("Members", formatInt(profile.member_count)) : ""}
        ${statCard("Best day", formatCompact(stats.best_day_tokens), stats.best_day ? formatDate(stats.best_day) : "No activity yet")}
        ${statCard("Current streak", formatInt(stats.current_streak_days))}
        ${statCard("Longest streak", formatInt(stats.longest_streak_days))}
        ${statCard("Daily average", formatCompact(stats.average_active_day_tokens), "on active days")}
        ${profile.percentile ? statCard("Percentile", `Top ${profile.percentile.percentile}%`, "by total tokens", "Among all Burnfolio profiles by total tokens.") : ""}
      </section>
      ${badgeRarityPills(name, profile.badgeRows)}
      ${badgeRecentAchievements(name, profile.badgeRows)}
      ${heatmap(profile.days, { title: "Past year", subtitle: `${formatInt(stats.last_365_tokens)} tokens burned`, eras: true })}
      ${heatmapYears(profile.days).length > 1 ? heatmapTimeline(profile.days, { title: "All-time by year", subtitle: "Grouped by calendar year" }) : ""}
      ${sourceBreakdownSection(profile.economics)}
      <details class="embed-disclosure">
        <summary>Embed this graph</summary>
        ${embedThemePanel(name)}
      </details>
      ${shareDialog(shareImagePath, shareText)}
    </main>
  `, {
    description,
    image: shareImageURL,
    imageType: "image/png",
    canonical: profileURL,
    siteName: "Burnfolio",
    signedIn: isSignedIn,
  });
}

function profileAbout(account) {
  const links = profileLinks(account);
  if (!account.bio && links.length === 0) return "";
  return `<section class="profile-about">
    ${account.bio ? `<p>${esc(account.bio)}</p>` : ""}
    ${links.length ? `<div class="profile-links">${links.map((link) => `<a href="${esc(link.href)}" rel="me noopener noreferrer" target="_blank">${link.icon}<span>${esc(link.label)}</span></a>`).join("")}</div>` : ""}
  </section>`;
}

function profileLinks(account) {
  const links = [];
  if (account.website_url) links.push({ href: account.website_url, label: displayURL(account.website_url), icon: faIcon("website") });
  if (account.github_url) links.push({ href: account.github_url, label: githubLabel(account.github_url), icon: faIcon("github") });
  if (account.x_url) links.push({ href: account.x_url, label: xLabel(account.x_url), icon: faIcon("x") });
  return links;
}

function shareCopy(profile, displayName) {
  const stats = profile.stats;
  const best = stats.best_day ? ` Best day: ${formatCompact(stats.best_day_tokens)} tokens.` : "";
  const percentile = profile.percentile ? ` Top ${profile.percentile.percentile}% of burners.` : "";
  const equivalence = shareEquivalence(profile.total_tokens);
  const equivalenceLine = equivalence ? ` ${equivalence}.` : "";
  return `${displayName} burned ${formatInt(profile.total_tokens)} AI tokens across ${formatInt(stats.active_days)} active days.${best}${percentile}${equivalenceLine} Show your burn.`;
}

function shareDialog(imageURL, text) {
  return `<div class="share-dialog" data-share-dialog hidden role="dialog" aria-modal="true" aria-labelledby="share-title">
    <div class="share-backdrop" data-share-close></div>
    <section class="share-card">
      <div class="share-card-head">
        <div><p class="eyebrow">Share card</p><h2 id="share-title">Show your burn</h2></div>
        <button type="button" class="secondary" data-share-close aria-label="Close share dialog">Close</button>
      </div>
      <div class="share-preview"><img src="${esc(imageURL)}" alt="Burnfolio share card" loading="lazy"></div>
      <div class="share-actions">
        <button type="button" data-copy-share-image data-share-image="${esc(imageURL)}">Copy image</button>
        <button type="button" class="secondary" data-copy="${esc(text)}">Copy text</button>
      </div>
      <div class="share-text"><span>Suggested text</span><p>${esc(text)}</p></div>
      <p class="result" data-share-result hidden></p>
    </section>
  </div>`;
}

const EMBED_THEMES = ["orange", "green", "blue"];
const EMBED_MODES = ["dark", "light"];

function embedThemePanel(name) {
  const variants = {};
  for (const theme of EMBED_THEMES) {
    for (const mode of EMBED_MODES) {
      const suffix = embedThemeQuery(theme, mode);
      variants[`${theme}-${mode}`] = {
        script: `<script src="https://burnfolio.ai/embed/${name}/script.js${suffix}"></script>`,
        svg: `<img src="https://burnfolio.ai/embed/${name}.svg${suffix}" alt="Burnfolio token burn graph">`,
        markdown: `[![Burnfolio token burn graph](https://burnfolio.ai/embed/${name}.svg${suffix})](https://burnfolio.ai/${name})`,
      };
    }
  }
  return `<div class="embed-panel" data-embed-panel>
    <div class="embed-theme-tabs" role="tablist" aria-label="Embed color theme">
      ${EMBED_THEMES.map((theme) => `<button type="button" class="theme-tab${theme === "orange" ? " active" : ""}" role="tab" aria-selected="${theme === "orange" ? "true" : "false"}" data-embed-theme="${theme}">${esc(theme)}</button>`).join("")}
    </div>
    <div class="embed-theme-tabs" role="tablist" aria-label="Embed background">
      ${EMBED_MODES.map((mode) => `<button type="button" class="theme-tab${mode === "dark" ? " active" : ""}" role="tab" aria-selected="${mode === "dark" ? "true" : "false"}" data-embed-mode="${mode}">${esc(mode)}</button>`).join("")}
    </div>
    <div class="snippets">
      ${embedSnippet("Iframe script", variants, "script")}
      ${embedSnippet("Static SVG", variants, "svg")}
      ${embedSnippet("GitHub Markdown", variants, "markdown")}
    </div>
  </div>`;
}

function embedSnippet(label, variants, key) {
  const attrs = Object.entries(variants).map(([variant, snippet]) => `data-variant-${variant}="${esc(snippet[key])}"`).join(" ");
  const initial = variants["orange-dark"][key];
  return `<div class="snippet" data-theme-snippet><div><span>${esc(label)}</span><button type="button" class="secondary copy" data-copy="${esc(initial)}">Copy</button></div><code ${attrs}>${esc(initial)}</code></div>`;
}

function embedHtml(profile, theme = "orange", mode = "dark") {
  const name = profile.account.handle || profile.account.account_number;
  const scale = heatmapScale(profile.days);
  const classes = `embed theme-${esc(theme)}${mode === "light" ? " mode-light" : ""}`;
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css()}</style><div class="${classes}"><div><strong>${esc(name)}</strong><span>${formatInt(profile.total_tokens)} tokens</span></div>${heatmap(profile.days, { compact: true, subtitle: `${formatInt(profile.stats.active_days)} active days`, scale })}</div><script>${globalScript()}</script>`;
}

function svgEmbed(profile, theme = "orange", mode = "dark") {
  const name = profile.account.handle || profile.account.account_number;
  const cells = heatmapCellData(profile.days, heatmapScale(profile.days));
  const cellSize = 10;
  const gap = 4;
  const left = 22;
  const top = 62;
  const colors = embedPalette(theme, mode);
  const isLight = mode === "light";
  const bg = isLight ? "#FFFCF7" : "#1C140D";
  const border = isLight ? "#EEDDCB" : "#3A2A1B";
  const titleColor = isLight ? "#211405" : "#FBF1E6";
  const mutedColor = isLight ? "#6F5F4D" : "#BBA68E";
  const brandColor = isLight ? "#C2400A" : "#FF8A3D";
  const columns = Math.ceil(cells.length / 7);
  const gridWidth = columns * cellSize + Math.max(0, columns - 1) * gap;
  const gridBottom = top + 7 * cellSize + 6 * gap;
  const footerBaseline = gridBottom + 28;
  const legendX = Math.max(left, left + gridWidth - 138);
  const rects = cells.map((cell, i) => {
    const x = left + Math.floor(i / 7) * (cellSize + gap);
    const y = top + (i % 7) * (cellSize + gap);
    return `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${colors[cell.level]}"><title>${esc(cell.date)}: ${formatInt(cell.value)}</title></rect>`;
  }).join("");
  const width = left * 2 + gridWidth;
  const height = footerBaseline + 22;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(name)} Burnfolio token burn graph">
  <rect width="100%" height="100%" rx="8" fill="${bg}"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="8" fill="none" stroke="${border}"/>
  <text x="22" y="30" fill="${titleColor}" font-family="Bricolage Grotesque, ui-sans-serif, system-ui, sans-serif" font-size="16" font-weight="700">${esc(name)}</text>
  <text x="22" y="50" fill="${mutedColor}" font-family="Space Mono, ui-monospace, monospace" font-size="12">${formatInt(profile.total_tokens)} tokens burned · ${formatInt(profile.stats.active_days)} active days</text>
  ${rects}
  <text x="22" y="${footerBaseline}" fill="${brandColor}" font-family="Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif" font-size="11" font-weight="700">burnfolio.ai</text>
  <text x="${legendX}" y="${footerBaseline}" fill="${mutedColor}" font-family="Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif" font-size="11">Less</text>
  <rect x="${legendX + 33}" y="${footerBaseline - 9}" width="10" height="10" rx="2" fill="${colors[0]}"/>
  <rect x="${legendX + 48}" y="${footerBaseline - 9}" width="10" height="10" rx="2" fill="${colors[1]}"/>
  <rect x="${legendX + 63}" y="${footerBaseline - 9}" width="10" height="10" rx="2" fill="${colors[2]}"/>
  <rect x="${legendX + 78}" y="${footerBaseline - 9}" width="10" height="10" rx="2" fill="${colors[3]}"/>
  <rect x="${legendX + 93}" y="${footerBaseline - 9}" width="10" height="10" rx="2" fill="${colors[4]}"/>
  <text x="${legendX + 110}" y="${footerBaseline}" fill="${mutedColor}" font-family="Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif" font-size="11">More</text>
</svg>`;
}

// Average glyph-width-to-font-size ratios per font family used in the OG SVG.
// There's no DOM/canvas available server-side to measure real text, so these
// are calibrated approximations (checked against real browser rendering) —
// good enough to keep every element inside its budget without overlap.
const OG_FONT_RATIO = { display: 0.62, mono: 0.62, sans: 0.58 };

function ogTextWidth(text, size, family) {
  return String(text || "").length * size * (OG_FONT_RATIO[family] || 0.6);
}

function ogTruncate(text, size, family, maxWidth) {
  const str = String(text || "");
  if (ogTextWidth(str, size, family) <= maxWidth) return str;
  let value = str;
  while (value.length > 1 && ogTextWidth(`${value}…`, size, family) > maxWidth) value = value.slice(0, -1);
  return `${value}…`;
}

// Handle truncation/downscale: try the full title size first, then two
// smaller steps, only truncating with an ellipsis if it still doesn't fit
// at the smallest step. Keeps ~18-char handles (e.g. "pokeapallascat") at
// full size, per the stated budget below.
function ogTitleLayout(displayName, maxWidth) {
  const steps = [58, 46, 36];
  for (const size of steps) {
    if (ogTextWidth(displayName, size, "display") <= maxWidth) return { text: displayName, size };
  }
  const size = steps[steps.length - 1];
  return { text: ogTruncate(displayName, size, "display", maxWidth), size };
}

// Left-to-right stats row (token total, active days, best day) with a fixed
// minimum gap, dropping trailing items that would overflow into the
// right-aligned profile URL — never overlapping, never clipping mid-glyph.
function ogStatsLayout(profile) {
  const urlSize = 22;
  const rightEdge = 1116;
  const ref = profile.account.handle || profile.account.account_number;
  const urlPrefix = "burnfolio.ai/";
  const urlBudget = 500;
  let urlText = `${urlPrefix}${ref}`;
  if (ogTextWidth(urlText, urlSize, "sans") > urlBudget) {
    const refBudget = urlBudget - ogTextWidth(urlPrefix, urlSize, "sans");
    urlText = urlPrefix + ogTruncate(ref, urlSize, "sans", Math.max(refBudget, urlSize * 2));
  }
  const urlLeft = rightEdge - ogTextWidth(urlText, urlSize, "sans");

  const startX = 86;
  const gap = 20;
  const rowMaxX = urlLeft - 24;

  const tokensSize = 28;
  const tokensFull = `${formatInt(profile.total_tokens)} tokens`;
  const tokensText = ogTextWidth(tokensFull, tokensSize, "mono") > 340 ? `${formatCompact(profile.total_tokens)} tokens` : tokensFull;
  const best = profile.stats.best_day ? `Best day ${formatCompact(profile.stats.best_day_tokens)}` : "Install pyro to light it up";
  const items = [
    { text: tokensText, size: tokensSize, family: "mono", color: "#211405", weight: 700 },
    { text: `${formatInt(profile.stats.active_days)} active days`, size: 22, family: "mono", color: "#6F5F4D", weight: 400 },
    { text: best, size: 22, family: "mono", color: "#6F5F4D", weight: 400 },
  ];
  const laid = [];
  let cursor = startX;
  for (const item of items) {
    const w = ogTextWidth(item.text, item.size, item.family);
    if (cursor + w > rowMaxX) break;
    laid.push({ ...item, x: cursor });
    cursor += w + gap;
  }
  return { items: laid, url: { text: urlText, x: urlLeft, size: urlSize } };
}

const OG_BADGE_TIER_ORDER = [
  { tier: "rare", color: "#C2400A" },
  { tier: "uncommon", color: "#A83505" },
  { tier: "common", color: "#BBA68E" },
];

function ogBadgeDotsSVG(counts, x, y) {
  let cursor = x;
  const parts = [];
  for (const { tier, color } of OG_BADGE_TIER_ORDER) {
    const n = (counts && counts[tier]) || 0;
    if (!n) continue;
    const label = String(n);
    parts.push(`<circle cx="${cursor + 6}" cy="${y - 6}" r="6" fill="${color}"/>`);
    parts.push(`<text x="${cursor + 18}" y="${y}" fill="#6F5F4D" font-family="Space Mono, monospace" font-size="18" font-weight="700">${esc(label)}</text>`);
    cursor += 18 + ogTextWidth(label, 18, "mono") + 22;
  }
  return parts.join("");
}

function ogProfileSVG(profile, badgeCounts = { rare: 0, uncommon: 0, common: 0 }) {
  const displayName = profile.account.handle || profile.account.display_name || profile.account.account_number;
  const cells = heatmapCellData(profile.days, heatmapScale(profile.days));
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
  const title = ogTitleLayout(displayName, 1032);
  const stats = ogStatsLayout(profile);
  const statsText = stats.items.map((item) =>
    `<text x="${item.x}" y="540" fill="${item.color}" font-family="Space Mono, monospace" font-size="${item.size}" font-weight="${item.weight}">${esc(item.text)}</text>`
  ).join("");
  const badgeDots = ogBadgeDotsSVG(badgeCounts, 86, 505);
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
  <text x="84" y="270" fill="#211405" font-family="Bricolage Grotesque, Arial, sans-serif" font-size="${title.size}" font-weight="800" letter-spacing="-1.6">${esc(title.text)}</text>
  ${badgeDots}
  ${statsText}
  ${rects}
  <text x="1116" y="557" text-anchor="end" fill="#A83505" font-family="Plus Jakarta Sans, Arial, sans-serif" font-size="${stats.url.size}" font-weight="700">${esc(stats.url.text)}</text>
</svg>`;
}

function ogLandingFallbackSVG(message) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#FFF9F2"/><text x="80" y="320" fill="#211405" font-family="Arial, sans-serif" font-size="56" font-weight="700">${esc(message)}</text></svg>`;
}

function ogPngBadgeDots(image, counts, x, y) {
  let cursor = x;
  for (const { tier, color } of OG_BADGE_TIER_ORDER) {
    const n = (counts && counts[tier]) || 0;
    if (!n) continue;
    image.disc(cursor + 6, y + 3, 6, color);
    const label = String(n);
    image.text(label, cursor + 18, y, 2, "#6F5F4D", 60);
    cursor += 18 + measureBitmap(label.toUpperCase(), 2) + 26;
  }
}

function ogProfilePNG(profile, badgeCounts = { rare: 0, uncommon: 0, common: 0 }) {
  const width = 1200;
  const height = 630;
  const image = landingOGCanvas() || pngCanvas(width, height, "#FFF9F2");
  const ref = profile.account.handle || profile.account.account_number;
  const cells = heatmapCellData(profile.days, heatmapScale(profile.days));
  const heat = ["#F2E7D9", "#FBD089", "#F99B3C", "#F2611C", "#D6300B"];

  // Extended a little from the original 278px tall patch so the new
  // two-row stats block (row + URL line) always stays on clean background.
  image.rect(72, 322, 1058, 296, "#FFF9F2");

  const startX = 78;
  const startY = 330;
  const cell = 16;
  const gap = 4;
  for (let i = 0; i < cells.length; i++) {
    const x = startX + Math.floor(i / 7) * (cell + gap);
    const y = startY + (i % 7) * (cell + gap);
    image.roundRect(x, y, cell, cell, 2, heat[cells[i].level]);
  }

  ogPngBadgeDots(image, badgeCounts, 76, 500);

  // Handle: generous budget, step the scale down before ever truncating —
  // keeps ~14-char handles (e.g. "pokeapallascat") fully readable.
  const handleMaxWidth = 340;
  const handleScale = measureBitmap(ref.toUpperCase(), 3) <= handleMaxWidth ? 3 : 2;
  const handleWidth = Math.min(measureBitmap(ref.toUpperCase(), handleScale), handleMaxWidth);
  image.text(ref, 76, 552, handleScale, "#A83505", handleMaxWidth);

  // Sequential stats row (tokens, active days, best day): starts right after
  // the handle's actual rendered width, drops trailing items rather than
  // ever overlapping — never a fixed slot that assumes a fixed handle width.
  const rowY = handleScale === 3 ? 560 : 555;
  const rowMaxX = 1124;
  const tokensFull = `${formatInt(profile.total_tokens)} tokens burned`;
  const tokensText = measureBitmap(tokensFull.toUpperCase(), 2) > 320 ? `${formatCompact(profile.total_tokens)} tokens burned` : tokensFull;
  const best = profile.stats.best_day ? `best ${formatCompact(profile.stats.best_day_tokens)}` : "best pending";
  let cursor = 76 + handleWidth + 28;
  for (const itemText of [tokensText, `${formatInt(profile.stats.active_days)} active days`, best]) {
    const w = measureBitmap(itemText.toUpperCase(), 2);
    if (cursor + w > rowMaxX) break;
    image.text(itemText, cursor, rowY, 2, "#A83505", w + 4);
    cursor += w + 24;
  }

  // Profile URL: its own line below, right-aligned, own truncation budget —
  // guaranteed never to collide with the row above regardless of its length.
  const urlY = 594;
  const urlMaxWidth = 320;
  const urlText = `burnfolio.ai/${ref}`;
  const urlWidth = Math.min(measureBitmap(urlText.toUpperCase(), 2), urlMaxWidth);
  image.text(urlText, 1124 - urlWidth, urlY, 2, "#211405", urlMaxWidth);

  return image.png();
}

function ogFallbackPNG(message) {
  const image = landingOGCanvas() || pngCanvas(1200, 630, "#FFF9F2");
  image.rect(72, 322, 1058, 278, "#FFF9F2", 0.96);
  image.text(message, 86, 286, 7, "#211405", 840);
  return image.png();
}

function landingOGCanvas() {
  const asset = assetData()["og-landing-rgba"];
  if (!asset) return null;
  const binary = atob(asset.body);
  const pixels = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) pixels[i] = binary.charCodeAt(i);
  return pngCanvas(asset.width, asset.height, pixels);
}

function pngCanvas(width, height, background) {
  const pixels = new Uint8Array(width * height * 4);
  if (background instanceof Uint8Array) {
    pixels.set(background.subarray(0, pixels.length));
  } else {
    const bg = rgba(background);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = bg[0];
      pixels[i + 1] = bg[1];
      pixels[i + 2] = bg[2];
      pixels[i + 3] = 255;
    }
  }
  const blendPixel = (x, y, color, alpha = 1) => {
    if (x < 0 || y < 0 || x >= width || y >= height || alpha <= 0) return;
    const i = (y * width + x) * 4;
    const inv = 1 - alpha;
    pixels[i] = Math.round(color[0] * alpha + pixels[i] * inv);
    pixels[i + 1] = Math.round(color[1] * alpha + pixels[i + 1] * inv);
    pixels[i + 2] = Math.round(color[2] * alpha + pixels[i + 2] * inv);
    pixels[i + 3] = 255;
  };
  return {
    rect(x, y, w, h, color, alpha = 1) {
      const c = rgba(color);
      for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
        for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) blendPixel(xx, yy, c, alpha);
      }
    },
    roundRect(x, y, w, h, r, color, alpha = 1, stroke = false) {
      const c = rgba(color);
      for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
        for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) {
          const dx = xx < x + r ? x + r - xx : xx >= x + w - r ? xx - (x + w - r - 1) : 0;
          const dy = yy < y + r ? y + r - yy : yy >= y + h - r ? yy - (y + h - r - 1) : 0;
          if (dx * dx + dy * dy > r * r) continue;
          if (stroke && xx > x && xx < x + w - 1 && yy > y && yy < y + h - 1) continue;
          blendPixel(xx, yy, c, alpha);
        }
      }
    },
    disc(cx, cy, radius, color, alpha = 1) {
      const c = rgba(color);
      for (let yy = Math.max(0, cy - radius); yy < Math.min(height, cy + radius); yy++) {
        for (let xx = Math.max(0, cx - radius); xx < Math.min(width, cx + radius); xx++) {
          const d = Math.hypot(xx - cx, yy - cy);
          if (d <= radius) blendPixel(xx, yy, c, alpha * Math.max(0, 1 - d / radius));
        }
      }
    },
    text(text, x, y, scale, color, maxWidth = Infinity) {
      const raw = String(text || "").toUpperCase();
      let value = raw;
      while (measureBitmap(value, scale) > maxWidth && value.length > 4) value = `${value.slice(0, -4)}...`;
      drawBitmapText({ set: blendPixel }, value, x, y, scale, rgba(color));
    },
    png() {
      return encodePNG(width, height, pixels);
    },
  };
}

function rgba(hex) {
  const value = String(hex || "").replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16) || 0,
    parseInt(value.slice(2, 4), 16) || 0,
    parseInt(value.slice(4, 6), 16) || 0,
  ];
}

const BITMAP_FONT = {
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
  "A": ["01110","10001","10001","11111","10001","10001","10001"],
  "B": ["11110","10001","10001","11110","10001","10001","11110"],
  "C": ["01111","10000","10000","10000","10000","10000","01111"],
  "D": ["11110","10001","10001","10001","10001","10001","11110"],
  "E": ["11111","10000","10000","11110","10000","10000","11111"],
  "F": ["11111","10000","10000","11110","10000","10000","10000"],
  "G": ["01111","10000","10000","10111","10001","10001","01111"],
  "H": ["10001","10001","10001","11111","10001","10001","10001"],
  "I": ["11111","00100","00100","00100","00100","00100","11111"],
  "J": ["00111","00010","00010","00010","10010","10010","01100"],
  "K": ["10001","10010","10100","11000","10100","10010","10001"],
  "L": ["10000","10000","10000","10000","10000","10000","11111"],
  "M": ["10001","11011","10101","10101","10001","10001","10001"],
  "N": ["10001","11001","10101","10011","10001","10001","10001"],
  "O": ["01110","10001","10001","10001","10001","10001","01110"],
  "P": ["11110","10001","10001","11110","10000","10000","10000"],
  "Q": ["01110","10001","10001","10001","10101","10010","01101"],
  "R": ["11110","10001","10001","11110","10100","10010","10001"],
  "S": ["01111","10000","10000","01110","00001","00001","11110"],
  "T": ["11111","00100","00100","00100","00100","00100","00100"],
  "U": ["10001","10001","10001","10001","10001","10001","01110"],
  "V": ["10001","10001","10001","10001","10001","01010","00100"],
  "W": ["10001","10001","10001","10101","10101","10101","01010"],
  "X": ["10001","10001","01010","00100","01010","10001","10001"],
  "Y": ["10001","10001","01010","00100","00100","00100","00100"],
  "Z": ["11111","00001","00010","00100","01000","10000","11111"],
  "0": ["01110","10001","10011","10101","11001","10001","01110"],
  "1": ["00100","01100","00100","00100","00100","00100","01110"],
  "2": ["01110","10001","00001","00010","00100","01000","11111"],
  "3": ["11110","00001","00001","01110","00001","00001","11110"],
  "4": ["00010","00110","01010","10010","11111","00010","00010"],
  "5": ["11111","10000","10000","11110","00001","00001","11110"],
  "6": ["01110","10000","10000","11110","10001","10001","01110"],
  "7": ["11111","00001","00010","00100","01000","01000","01000"],
  "8": ["01110","10001","10001","01110","10001","10001","01110"],
  "9": ["01110","10001","10001","01111","00001","00001","01110"],
  ".": ["00000","00000","00000","00000","00000","01100","01100"],
  ",": ["00000","00000","00000","00000","01100","01100","01000"],
  ":": ["00000","01100","01100","00000","01100","01100","00000"],
  "-": ["00000","00000","00000","11111","00000","00000","00000"],
  "_": ["00000","00000","00000","00000","00000","00000","11111"],
  "/": ["00001","00010","00010","00100","01000","01000","10000"],
};

function measureBitmap(text, scale) {
  return String(text || "").length ? String(text).length * 6 * scale - scale : 0;
}

function drawBitmapText(ctx, text, x, y, scale, color) {
  let cursor = x;
  for (const ch of String(text || "")) {
    const glyph = BITMAP_FONT[ch] || BITMAP_FONT[" "];
    for (let row = 0; row < glyph.length; row++) {
      for (let col = 0; col < glyph[row].length; col++) {
        if (glyph[row][col] !== "1") continue;
        for (let yy = 0; yy < scale; yy++) {
          for (let xx = 0; xx < scale; xx++) ctx.set(cursor + col * scale + xx, y + row * scale + yy, color, 1);
        }
      }
    }
    cursor += 6 * scale;
  }
}

function encodePNG(width, height, rgbaPixels) {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rawOffset = y * (width * 4 + 1);
    const pixelOffset = y * width * 4;
    raw[rawOffset] = 0;
    raw.set(rgbaPixels.subarray(pixelOffset, pixelOffset + width * 4), rawOffset + 1);
  }
  return concatBytes(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", concatBytes(u32(width), u32(height), new Uint8Array([8, 6, 0, 0, 0]))),
    pngChunk("IDAT", zlibStore(raw)),
    pngChunk("IEND", new Uint8Array())
  );
}

function zlibStore(data) {
  const parts = [new Uint8Array([0x78, 0x01])];
  for (let offset = 0; offset < data.length; offset += 65535) {
    const len = Math.min(65535, data.length - offset);
    const final = offset + len >= data.length ? 1 : 0;
    parts.push(new Uint8Array([final, len & 255, len >> 8, (~len) & 255, ((~len) >> 8) & 255]));
    parts.push(data.subarray(offset, offset + len));
  }
  parts.push(u32(adler32(data)));
  return concatBytes(...parts);
}

function pngChunk(type, data) {
  const name = new TextEncoder().encode(type);
  return concatBytes(u32(data.length), name, data, u32(crc32(concatBytes(name, data))));
}

function u32(value) {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 255;
  out[1] = (value >>> 16) & 255;
  out[2] = (value >>> 8) & 255;
  out[3] = value & 255;
  return out;
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function adler32(data) {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

let crcTable = null;
function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (const byte of data) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function notFoundPage(isSignedIn = false) {
  return layout("Not found", `<main class="profile"><h1>Profile not found</h1><a href="/">Create one</a></main>`, { signedIn: isSignedIn });
}

function authResultPage(message, ok) {
  return layout(ok ? "Signed in" : "Sign in failed", `<main class="profile"><p class="eyebrow">${ok ? "Success" : "Link error"}</p><h1>${esc(message)}</h1><a href="/app">Open dashboard</a></main>`);
}

function howWeCountPage(isSignedIn = false) {
  return layout("How Burnfolio counts token burn", `
    <main class="learn-page">
      <header class="learn-hero">
        <p class="eyebrow">Graph settings</p>
        <h1>How we count token burn</h1>
        <p class="lede">Burnfolio turns local AI session records into daily token totals. The graph is about activity counts, not content.</p>
      </header>
      <section class="learn-grid">
        <article class="learn-card">
          <h2>What counts</h2>
          <p><code>pyro</code> reads supported local session records for Claude, Codex, OpenCode, and Pi, normalizes token usage, and syncs daily totals to your profile.</p>
          <p>Each square represents the total tokens Burnfolio has received for that day. Higher totals render hotter cells.</p>
          <p>A day's total is input + cache read + cache write + output tokens. Reasoning tokens are informational only and are not added to the total, since providers generally already include them in the output count.</p>
          <p>Each source (a machine or an OpenRouter connection) is capped at a configurable per-day ceiling to keep a single misconfigured client from distorting a graph. Raw usage is always stored; only the displayed total is capped.</p>
          <p>A profile can also show a per-tool and per-model breakdown of its burn ("What's burning"). It's off by default — the profile owner turns it on from their dashboard, and it's the only piece of usage detail that's opt-in rather than shown automatically.</p>
        </article>
        <article class="learn-card">
          <h2>What does not count</h2>
          <p>Prompts, generated code, transcripts, file contents, and message bodies are not sent to Burnfolio.</p>
          <p>Local runs that happen before <code>pyro</code> can find a supported session record may not appear until the source tool writes its usage data.</p>
        </article>
        <article class="learn-card">
          <h2>Machines and organizations</h2>
          <p>Machine tokens tag usage to one machine and one profile or organization. A machine scoped to an organization contributes to that org's graph only, not your personal graph.</p>
          <p>Organization graphs also roll up members' personal usage, but only after a member accepts the org's invite. Pending invites don't contribute usage until accepted.</p>
        </article>
        <article class="learn-card">
          <h2>OpenRouter imports</h2>
          <p>OpenRouter management keys can import daily account totals. Burnfolio stores those rows separately from machine-local inference data and deduplicates by profile, key fingerprint, and day.</p>
        </article>
        <article class="learn-card">
          <h2>Duplicate protection</h2>
          <p>Syncs are idempotent by day, tool, model, machine, and profile. Re-running <code>pyro</code> updates totals instead of adding the same local records again.</p>
        </article>
        <article class="learn-card">
          <h2>API</h2>
          <p><code>GET /api/profiles/:ref/stats</code> returns a profile's public data as JSON: the daily token series, current and longest streaks, and per-tool/per-model breakdowns when the profile owner has turned that on. No authentication required — it's the same data shown on the public profile page.</p>
          <p><code>GET /api/leaderboard?range=all|7d</code> returns the current leaderboard as JSON.</p>
        </article>
      </section>
      <section class="learn-card learn-wide">
        <h2>Missing burn?</h2>
        <div class="learn-steps">
          <p><strong>Check the machine token.</strong> Copy the install command from the machine row in your dashboard so the profile and machine are both set.</p>
          <p><strong>Run a manual sync.</strong> Run <code>pyro sync</code> after a session to confirm the local collector can find records.</p>
          <p><strong>Check your source tool.</strong> If a tool has not written usage records yet, Burnfolio has nothing to count.</p>
          <p><strong>Look at the right profile.</strong> Organization machines contribute to the org graph only; personal machines contribute to your profile.</p>
        </div>
      </section>
    </main>
  `, {
    description: "Learn how Burnfolio counts token burn, updates daily graph cells, and handles machines and organizations.",
    canonical: "https://burnfolio.ai/how-we-count",
    signedIn: isSignedIn,
  });
}

function privacyPage(isSignedIn = false) {
  return layout("Privacy — Burnfolio", `
    <main class="learn-page">
      <header class="learn-hero">
        <p class="eyebrow">Legal</p>
        <h1>Privacy</h1>
        <p class="lede">Burnfolio is a counts-only product. This page is a short, honest explanation of what that means.</p>
      </header>
      <section class="learn-grid">
        <article class="learn-card">
          <h2>What we collect</h2>
          <p>Per synced day, per machine or OpenRouter connection: the date, a request count, and six token counters (input, cache read, cache write, output, reasoning, and total).</p>
          <p><code>pyro</code> also computes a per-CLI and per-model breakdown of those same six counters locally and includes it in the sync payload. We store that breakdown too — it's still counts only, per tool and per model, per day; no prompts, file paths, or session identifiers are ever part of it. This breakdown is only shown on your public profile if you turn it on; it's off by default.</p>
          <p>Account data: an account number and key, an optional email address (for magic-link sign-in and recovery), an optional handle, and any bio or profile links you choose to add.</p>
          <p>OpenRouter keys you connect from the dashboard are encrypted at rest. Keys <code>pyro</code> imports from your local OpenRouter config never leave your machine — only a SHA-256 fingerprint of the key and daily usage totals are uploaded.</p>
        </article>
        <article class="learn-card">
          <h2>What we never collect</h2>
          <p>Prompts, generated code, transcripts, file contents, message bodies, file paths, or session identifiers never leave your machine. <code>pyro</code> reads local usage records and reports token counts only.</p>
        </article>
        <article class="learn-card">
          <h2>Cookies</h2>
          <p>One HttpOnly session cookie, used only to keep you signed in. We don't run third-party trackers or ad pixels. Cloudflare, our hosting provider, collects standard aggregate web analytics for the site.</p>
        </article>
        <article class="learn-card">
          <h2>Data deletion</h2>
          <p>Account deletion is self-serve: open the Danger zone at the bottom of your <a href="/app">dashboard</a> to export your data or permanently delete your account and all associated usage data.</p>
        </article>
      </section>
    </main>
  `, {
    description: "What Burnfolio collects, what it never collects, and how to request deletion.",
    canonical: "https://burnfolio.ai/privacy",
    signedIn: isSignedIn,
  });
}

function layout(title, body, meta = {}) {
  const description = meta.description || "Burnfolio turns your AI token burn into a contribution graph worth sharing.";
  const canonical = meta.canonical || "https://burnfolio.ai";
  const image = meta.image || "https://burnfolio.ai/og/landing.png";
  const imageType = meta.imageType || "image/png";
  const siteName = meta.siteName || "Burnfolio";
  const navLinks = meta.signedIn
    ? `<a href="/leaderboard">Leaderboard</a><a href="/how-we-count">How we count</a><a class="nav-cta" href="/app">Dashboard</a>`
    : `<a href="/leaderboard">Leaderboard</a><a href="/how-we-count">How we count</a><a href="/signin">Sign in</a><a class="nav-cta" href="/signup">Create graph</a>`;
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
<style>${css()}</style></head><body><nav><a class="nav-brand" href="/"><img src="/assets/logo.svg" alt="" width="28" height="28"><span>Burnfolio</span></a><div class="nav-links">${navLinks}</div></nav>${body}${siteFooter()}<script>${globalScript()}</script></body></html>`;
}

function siteFooter() {
  const year = new Date().getUTCFullYear();
  return `<footer class="site-footer">
    <div class="site-footer-links">
      <a href="https://github.com/nbitslabs/burnfolio" rel="noopener noreferrer" target="_blank">GitHub</a>
      <a href="/leaderboard">Leaderboard</a>
      <a href="/badges">Badges</a>
      <a href="/how-we-count">How we count</a>
      <a href="/privacy">Privacy</a>
    </div>
    <p>&copy; ${year} Burnfolio</p>
  </footer>`;
}

// Editorial markers, approximate dates — subtle annotations only, not authoritative release history.
const MODEL_ERAS = [
  { date: "2025-05-22", label: "Claude 4" },
  { date: "2025-08-07", label: "GPT-5" },
  { date: "2025-09-29", label: "Sonnet 4.5" },
  { date: "2025-11-24", label: "Opus 4.5" },
  { date: "2026-02-01", label: "Gemini 3.5" },
  { date: "2026-04-01", label: "Opus 4.8" },
  { date: "2026-06-01", label: "Fable 5" },
];

function eraMarksHTML(data) {
  const dated = data.filter((c) => c.date);
  if (!dated.length) return "";
  const start = dated[0].date;
  const end = dated[dated.length - 1].date;
  const marks = [];
  for (const era of MODEL_ERAS) {
    if (era.date < start || era.date > end) continue;
    let index = data.findIndex((c) => c.date === era.date);
    if (index === -1) index = data.findIndex((c) => c.date && c.date >= era.date);
    if (index === -1) continue;
    const column = Math.floor(index / 7) + 1;
    const tip = `${era.label} released ${formatDate(era.date)}`;
    marks.push(`<span class="era-mark" style="grid-column:${column}" data-tip="${esc(tip)}" title="${esc(tip)}" tabindex="0" role="img" aria-label="${esc(tip)}"></span>`);
  }
  return marks.join("");
}

function heatmap(days, options = {}) {
  const scale = options.scale || heatmapScale(days);
  const data = heatmapCellData(days, scale);
  const cells = data.map((cell) => heatmapCell(cell));
  const classes = ["graph", options.compact ? "compact" : "", options.fit ? "fit" : ""].filter(Boolean).join(" ");
  const learn = options.learn === false ? "" : graphLearnLink();
  const eraMarks = options.eras ? eraMarksHTML(data) : "";
  return `<section class="${classes}">
    ${options.title ? `<div class="graph-head"><div><h2>${esc(options.title)}</h2>${options.subtitle ? `<p>${esc(options.subtitle)}</p>` : ""}</div>${legend()}</div>` : `<div class="graph-head small">${options.subtitle ? `<p>${esc(options.subtitle)}</p>` : ""}${legend()}</div>`}
    <div class="heatmap-scroll">${heatmapFrame(data, cells.join(""), "Token burn by day", "", eraMarks)}</div>
    ${learn}
  </section>`;
}

function heatmapCellData(days, scale = heatmapScale(days)) {
  const byDate = new Map(days.map((d) => [d.date_utc, d.total_tokens]));
  const today = todayUTCDate();
  const first = sameDatePreviousYear(today);
  const gridStart = startOfWeekUTC(first);
  const cells = [];
  for (let d = new Date(gridStart); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const value = d >= first ? byDate.get(date) || 0 : 0;
    cells.push({ date, value, level: level(value, scale) });
  }
  return cells;
}

function heatmapTimeline(days, options = {}) {
  const years = heatmapYears(days);
  const scale = options.scale || heatmapScale(days);
  return `<section class="timeline-layout">
    <div class="graph timeline">
    <div class="graph-head"><div><h2>${esc(options.title || "Token burn timeline")}</h2>${options.subtitle ? `<p>${esc(options.subtitle)}</p>` : ""}</div>${legend()}</div>
    <div class="timeline-years">${years.map((year, index) => {
      const data = yearHeatmapCellData(days, year, scale);
      const cells = data.map((cell) => heatmapCell(cell)).join("");
      const total = days.filter((day) => day.date_utc.startsWith(String(year))).reduce((sum, day) => sum + day.total_tokens, 0);
      return `<section class="year-panel" data-year-panel="${year}"${index ? " hidden" : ""}><div class="year-label"><strong>${year}</strong><span>${formatInt(total)} tokens</span></div><div class="heatmap-scroll">${heatmapFrame(data, cells, `Token burn by day in ${year}`, "year-heatmap")}</div>${graphLearnLink()}</section>`;
    }).join("")}</div>
    </div>
    <nav class="year-selector" aria-label="Contribution years">${years.map((year, index) => `<button type="button" class="year-button${index ? "" : " active"}" data-year-button="${year}" aria-pressed="${index ? "false" : "true"}">${year}</button>`).join("")}</nav>
  </section>`;
}

function graphLearnLink() {
  return `<div class="graph-meta"><a href="/how-we-count">Learn how we count token burn</a></div>`;
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
  const todayUTC = todayUTCDate();
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

function heatmapFrame(data, cells, label, extraClass = "", eraMarks = "") {
  const months = monthLabels(data);
  const frameClass = ["heatmap-frame", extraClass ? `${extraClass}-frame` : "", eraMarks ? "has-eras" : ""].filter(Boolean).join(" ");
  return `<div class="${frameClass}">
    <div class="month-labels" aria-hidden="true">${months.map((month) => `<span style="grid-column:${month.column}">${esc(month.label)}</span>`).join("")}</div>
    ${eraMarks ? `<div class="era-markers">${eraMarks}</div>` : ""}
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

function faIcon(name) {
  const icons = {
    user: {
      viewBox: "0 0 448 512",
      path: "M224 256A128 128 0 1 0 224 0a128 128 0 1 0 0 256zm-45.7 48C79.8 304 0 383.8 0 482.3C0 498.7 13.3 512 29.7 512H418.3c16.4 0 29.7-13.3 29.7-29.7C448 383.8 368.2 304 269.7 304H178.3z",
    },
    org: {
      viewBox: "0 0 640 512",
      path: "M144 0a80 80 0 1 1 0 160A80 80 0 1 1 144 0zM512 0a80 80 0 1 1 0 160A80 80 0 1 1 512 0zM0 298.7C0 239.8 47.8 192 106.7 192h42.7c15.9 0 31 3.5 44.6 9.7c-1.3 7.2-1.9 14.7-1.9 22.3c0 38.2 16.8 72.5 43.3 96H21.3C9.6 320 0 310.4 0 298.7zM405.3 320c26.5-23.5 43.3-57.8 43.3-96c0-7.6-.7-15-1.9-22.3c13.6-6.3 28.7-9.7 44.6-9.7h42.7C592.2 192 640 239.8 640 298.7c0 11.8-9.6 21.3-21.3 21.3H405.3zM224 224a96 96 0 1 1 192 0 96 96 0 1 1 -192 0zM128 485.3C128 411.7 187.7 352 261.3 352h117.3C452.3 352 512 411.7 512 485.3c0 14.7-11.9 26.7-26.7 26.7H154.7c-14.7 0-26.7-11.9-26.7-26.7z",
    },
    website: {
      viewBox: "0 0 512 512",
      path: "M352 256c0 22.2-1.2 43.6-3.3 64H163.3c-2.2-20.4-3.3-41.8-3.3-64s1.2-43.6 3.3-64H348.7c2.2 20.4 3.3 41.8 3.3 64zm28.8-64H503.9c5.3 20.5 8.1 41.9 8.1 64s-2.8 43.5-8.1 64H380.8c2.1-20.6 3.2-42 3.2-64s-1.1-43.4-3.2-64zm112.6-32H376.7c-10-63.9-29.8-117.4-55.3-151.6C397.5 30.9 458.4 87.9 493.4 160zM344.3 160H167.7c6.1-36.4 15.5-68.6 27-94.7C212.5 24.9 234.1 0 256 0s43.5 24.9 61.3 65.3c11.5 26.1 20.9 58.2 27 94.7zm-209 0H18.6C53.6 87.9 114.5 30.9 190.6 8.4C165.1 42.6 145.3 96.1 135.3 160zM8.1 192H131.2c-2.1 20.6-3.2 42-3.2 64s1.1 43.4 3.2 64H8.1C2.8 299.5 0 278.1 0 256s2.8-43.5 8.1-64zM167.7 352H344.3c-6.1 36.4-15.5 68.6-27 94.7C299.5 487.1 277.9 512 256 512s-43.5-24.9-61.3-65.3c-11.5-26.1-20.9-58.2-27-94.7zm-32.4 0c10 63.9 29.8 117.4 55.3 151.6C114.5 481.1 53.6 424.1 18.6 352H135.3zm358.1 0c-35 72.1-95.9 129.1-172 151.6c25.5-34.2 45.3-87.7 55.3-151.6H493.4z",
    },
    github: {
      viewBox: "0 0 496 512",
      path: "M165.9 397.4c0 2-2.3 3.6-5.2 3.6c-3.3 .3-5.6-1.3-5.6-3.6c0-2 2.3-3.6 5.2-3.6c3-.3 5.6 1.3 5.6 3.6zm-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9c2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5 .3-6.2 2.3zm44.2-1.7c-2.9 .7-4.9 2.6-4.6 4.9c.3 2 2.9 3.3 5.9 2.6c2.9-.7 4.9-2.6 4.6-4.6c-.3-1.9-3-3.2-5.9-2.9zM244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2c12.8 2.3 17.3-5.6 17.3-12.1c0-6.2-.3-40.4-.3-61.4c0 0-70 15-84.7-29.8c0 0-11.4-29.1-27.8-36.6c0 0-22.9-15.7 1.6-15.4c0 0 24.9 2 38.6 25.8c21.9 38.6 58.6 27.5 72.9 20.9c2.3-16 8.8-27.1 16-33.7c-55.9-6.2-112.3-14.3-112.3-110.5c0-27.5 7.6-41.3 23.6-58.9c-2.6-6.5-11.1-33.3 2.6-67.9c20.9-6.5 69 27 69 27c20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27c13.7 34.6 5.2 61.4 2.6 67.9c16 17.7 25.8 31.5 25.8 58.9c0 96.5-58.9 104.2-114.8 110.5c9.2 7.9 17 22.9 17 46.4c0 33.7-.3 75.4-.3 86.2c0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252C496 113.3 383.5 8 244.8 8z",
    },
    x: {
      viewBox: "0 0 512 512",
      path: "M389.2 48h70.6L305.6 224.2L487 464H345L233.7 318.6L106.5 464H35.8L200.7 275.5L26.8 48H172.4L272.9 180.9L389.2 48zM364.4 421.8h39.1L151.1 88h-42L364.4 421.8z",
    },
  };
  const icon = icons[name] || icons.user;
  return `<svg class="fa-icon" aria-hidden="true" viewBox="${icon.viewBox}" focusable="false"><path fill="currentColor" d="${icon.path}"></path></svg>`;
}

function statCard(label, value, detail = "", tip = "") {
  const tipMarkup = tip ? ` <span class="stat-tip" data-tip="${esc(tip)}" title="${esc(tip)}" tabindex="0" role="img" aria-label="${esc(tip)}">?</span>` : "";
  return `<div><span>${esc(label)}${tipMarkup}</span><strong>${esc(value)}</strong>${detail ? `<em>${esc(detail)}</em>` : ""}</div>`;
}

// StackOverflow-style rarity summary: one "medallion + count" pill per tier
// that actually has earned badges, linking to the profile's badge detail page.
function badgeRarityPills(ref, earnedRows) {
  if (!earnedRows || !earnedRows.length) return "";
  const counts = { rare: 0, uncommon: 0, common: 0 };
  for (const row of earnedRows) {
    const def = badgeDef(row.badge_key);
    if (def) counts[def.tier] = (counts[def.tier] || 0) + 1;
  }
  const pills = BADGE_TIER_ORDER.filter((tier) => counts[tier] > 0).map((tier) =>
    `<a class="badge-rarity-pill badge-tier-${tier}" href="/${esc(ref)}/badges" data-tip="${esc(BADGE_TIERS[tier])} badges" title="${esc(BADGE_TIERS[tier])} badges">${badgeMedallion()}<span>${counts[tier]}</span></a>`
  ).join("");
  return pills ? `<div class="badge-rarity-pills">${pills}</div>` : "";
}

// Compact single-line "Name · Tier · Mon D" rows — the shared achievement-row
// shape used on both the dashboard Goals panel and public profiles.
function badgeAchievementRow(row) {
  const def = badgeDef(row.badge_key);
  if (!def) return "";
  const tip = `${def.description} (${badgeTooltip(def)})`;
  const dateLabel = formatShortDate(String(row.earned_at || "").slice(0, 10));
  return `<div class="badge-achievement-row badge-tier-${def.tier}" data-tip="${esc(tip)}" title="${esc(tip)}">
    ${badgeMedallion()}
    <span class="badge-achievement-name">${esc(def.name)}</span>
    <span class="badge-achievement-tier">${esc(BADGE_TIERS[def.tier])}</span>
    <span class="badge-achievement-date badge-footer-right">${esc(dateLabel)}</span>
  </div>`;
}

function badgeRecentAchievements(ref, earnedRows) {
  if (!earnedRows || !earnedRows.length) return "";
  const recent = earnedRows.slice(0, 3);
  return `<div class="recent-achievements">
    <h3>Recent achievements</h3>
    ${recent.map((row) => badgeAchievementRow(row)).join("")}
    <a class="badge-more" href="/${esc(ref)}/badges">All badges &rarr;</a>
  </div>`;
}

function sourceBreakdownSection(economics) {
  if (!economics || !economics.enabled) return "";
  if (!economics.hasBreakdown) {
    return `<section class="graph burning-panel">
      <div class="section-head"><div><h2>What's burning</h2><p class="muted">Past year, by tool and model.</p></div></div>
      ${emptyState("No breakdown data yet", "The tool & model breakdown is on, but there's no per-tool usage in the past year yet. Sync with pyro to start filling this in.")}
    </section>`;
  }
  const toolBars = economics.byTool.map((row) => `
    <div class="tool-bar">
      <div class="tool-bar-label"><span>${esc(row.cli)}</span><span>${formatCompact(row.tokens)} · ${Math.round(row.pct * 100)}%</span></div>
      <div class="tool-bar-track"><div class="tool-bar-fill" style="width:${Math.max(2, Math.round(row.pct * 100))}%"></div></div>
    </div>`).join("");
  const modelRows = economics.topModels.map((row, i) => `
    <div class="model-row"><span class="model-rank">${i + 1}</span><span class="model-name">${esc(row.model)}</span><span class="model-tokens">${formatCompact(row.tokens)}</span></div>`).join("");
  return `<section class="graph burning-panel">
    <div class="section-head"><div><h2>What's burning</h2><p class="muted">Past year, by tool and model.</p></div></div>
    <div class="burning-grid">
      <div class="tool-bars">${toolBars}</div>
      <div class="model-list">${modelRows || `<p class="muted">Not enough model data yet.</p>`}</div>
    </div>
  </section>`;
}

const HISTORY_CHART_DAYS = 90;
const HISTORY_TABLE_DAYS = 30;

function badgeProgressLabel(def, bundle) {
  const fmt = formatCompact;
  switch (def.key) {
    case "tokenizer": return `${fmt(bundle.lifetimeTokens)} / ${fmt(1_000_000)} tokens`;
    case "context_builder": return `${fmt(bundle.lifetimeTokens)} / ${fmt(10_000_000)} tokens`;
    case "warm_cache": return `${fmt(bundle.lifetimeTokens)} / ${fmt(100_000_000)} tokens`;
    case "training_loop": return `${Math.max(bundle.currentStreak, bundle.longestStreak)} / 7 day streak`;
    case "multi_agent": return `${bundle.distinctTools} / 3 tools`;
    case "model_collector": return `${bundle.distinctModels} / 5 models`;
    case "always_on": return `${bundle.activeDays} / 30 active days`;
    case "wordsmith": return `${fmt(bundle.outputTokens)} / ${fmt(10_000_000)} output tokens`;
    case "context_stuffer": return `${fmt(bundle.inputTokens)} / ${fmt(50_000_000)} input tokens`;
    case "chain_of_thought": return `${fmt(bundle.reasoningTokens)} / ${fmt(1_000_000)} reasoning tokens`;
    case "chatterbox": return `${formatInt(bundle.records)} / 1,000 records`;
    case "fortnight": return `${Math.max(bundle.currentStreak, bundle.longestStreak)} / 14 day streak`;
    case "pair_programmer": return `${bundle.distinctTools} / 2 tools`;
    case "weekend_warrior": return `${bundle.weekendActiveDays} / 10 weekend days`;
    case "open_book": return "add a bio and a link";
    case "team_player": return "join or accept an org invite";
    case "router": return "connect OpenRouter";
    case "billion_token_brain": return `${fmt(bundle.lifetimeTokens)} / ${fmt(1_000_000_000)} tokens`;
    case "epoch": return `${Math.max(bundle.currentStreak, bundle.longestStreak)} / 30 day streak`;
    case "overclocked": return `${fmt(bundle.bestDayTokens)} / ${fmt(100_000_000)} best day`;
    case "orchestrator": return `${bundle.distinctTools} / 5 tools`;
    case "ensemble": return `${bundle.distinctModels} / 10 models`;
    case "cache_whisperer": return `${fmt(bundle.cacheReadTokens)} cache-read so far`;
    case "novelist": return `${fmt(bundle.outputTokens)} / ${fmt(100_000_000)} output tokens`;
    case "context_maximalist": return `${fmt(bundle.inputTokens)} / ${fmt(500_000_000)} input tokens`;
    case "cache_architect": return `${fmt(bundle.cacheWriteTokens)} / ${fmt(100_000_000)} cache-write tokens`;
    case "deliberator": return `${fmt(bundle.reasoningTokens)} / ${fmt(100_000_000)} reasoning tokens`;
    case "api_hammer": return `${formatInt(bundle.records)} / 10,000 records`;
    case "half_life": return `${Math.max(bundle.currentStreak, bundle.longestStreak)} / 50 day streak`;
    case "habitual": return `${bundle.activeDays} / 100 active days`;
    case "polyglot": return `${bundle.distinctModels} / 15 models`;
    case "provider_hopper": return `${bundle.distinctProviders} / 3 providers`;
    case "perfect_attendance": return "no full calendar month yet";
    case "four_seasons": return `${bundle.distinctActiveMonths} / 12 months`;
    case "pretraining_run": return `${fmt(bundle.lifetimeTokens)} / ${fmt(10_000_000_000)} tokens`;
    case "foundation_model": return `${fmt(bundle.lifetimeTokens)} / ${fmt(100_000_000_000)} tokens`;
    case "convergence": return `${Math.max(bundle.currentStreak, bundle.longestStreak)} / 100 day streak`;
    case "datacenter_cosplay": return `${fmt(bundle.bestDayTokens)} / ${fmt(1_000_000_000)} best day`;
    case "mixture_of_experts": return `${bundle.distinctModels} / 25 models`;
    case "superintelligence": return `${fmt(bundle.lifetimeTokens)} / ${fmt(1_000_000_000_000)} tokens`;
    case "printing_press": return `${fmt(bundle.outputTokens)} / ${fmt(1_000_000_000)} output tokens`;
    case "librarian": return `${fmt(bundle.inputTokens)} / ${fmt(5_000_000_000)} input tokens`;
    case "rate_limit_tourist": return `${formatInt(bundle.records)} / 100,000 records`;
    case "year_of_burn": return `${Math.max(bundle.currentStreak, bundle.longestStreak)} / 365 day streak`;
    case "lifer": return `${bundle.activeDays} / 250 active days`;
    default: return "";
  }
}

function badgeProgressRow(def, fraction, bundle) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  const tip = `${def.description} (${badgeTooltip(def)})`;
  return `<div class="badge-progress-row" data-tip="${esc(tip)}" title="${esc(tip)}">
    <div class="badge-progress-row-head"><span>${esc(def.name)}</span><span class="muted">${esc(badgeProgressLabel(def, bundle))}</span></div>
    <div class="goal-progress-track"><div class="goal-progress-fill" style="width:${pct}%"></div></div>
  </div>`;
}

async function goalsPanel(env, account) {
  const days = await userDays(env, account.id);
  const total = days.reduce((sum, d) => sum + d.total_tokens, 0);
  const stats = profileStats(days, total);
  const bundle = await badgeBundleFor(env, account, stats, total, days);
  await awardBadges(env, account, bundle); // lazy catch-up — visiting your own dashboard counts too
  const earnedRows = await fetchEarnedBadges(env, account.id);
  const earned = new Set(earnedRows.map((r) => r.badge_key));

  const monthStart = `${todayUTCDate().toISOString().slice(0, 7)}-01`;
  const monthToDate = days.filter((d) => d.date_utc >= monthStart).reduce((sum, d) => sum + int(d.total_tokens), 0);
  const goal = int(account.monthly_goal_tokens);
  const hasGoal = goal > 0;
  const pct = hasGoal ? Math.round((monthToDate / goal) * 100) : 0;
  const barPct = Math.min(100, pct);
  const met = hasGoal && pct >= 100;

  const nearest = BADGE_DEFS
    .filter((def) => !def.secret && !def.meta && !earned.has(def.key))
    .map((def) => ({ def, fraction: Math.min(badgeProgress(def, bundle), 0.99) }))
    .sort((a, b) => b.fraction - a.fraction)
    .slice(0, 4);
  const recent = earnedRows.slice(0, 3);

  return `<section class="panel goals-panel">
    <div class="section-head"><div><h2>Goals</h2><p class="muted">Your monthly burn goal and nearest badge progress. Private — never shown on your public profile.</p></div></div>
    <div class="goal-panel">
      <h3>Monthly goal</h3>
      <form class="form-row" data-goal>
        <label class="sr-only" for="goal-tokens">Monthly token goal</label>
        <input id="goal-tokens" name="monthly_goal_tokens" type="number" min="0" step="1" placeholder="e.g. 5000000" value="${hasGoal ? goal : ""}">
        <button type="submit" class="secondary">Save goal</button>
      </form>
      ${hasGoal ? `<div class="goal-progress">
        <div class="goal-progress-track"><div class="goal-progress-fill${met ? " met" : ""}" style="width:${barPct}%"></div></div>
        <p class="muted">${formatCompact(monthToDate)} / ${formatCompact(goal)} tokens this month (${pct}%)${met ? " — Goal met \u{1F525}" : ""}</p>
      </div>` : `<p class="muted">Set a monthly token goal to track progress here.</p>`}
    </div>
    ${recent.length ? `<div class="recent-achievements">
      <h3>Recent achievements</h3>
      ${recent.map((row) => badgeAchievementRow(row)).join("")}
    </div>` : ""}
    <div class="badge-progress-list">
      <h3>Nearest badges</h3>
      ${nearest.length ? nearest.map((n) => badgeProgressRow(n.def, n.fraction, bundle)).join("") : `<p class="muted">All badges earned. Nicely done.</p>`}
    </div>
    <p class="goals-earned-line">${earned.size} of ${BADGE_DEFS.length} badges earned &middot; <a href="/badges">View all &rarr;</a></p>
  </section>`;
}

async function historyPanel(env, account) {
  const userID = account.id;
  const [componentRows, sourceRows] = await Promise.all([
    userDailyComponentRows(env, userID),
    userDailySourceRows(env, userID),
  ]);
  if (!componentRows.length) {
    return `<section class="panel history-panel">
      <div class="section-head"><div><h2>Your history</h2><p class="muted">Personal usage across your machines and OpenRouter connections. Exports cover full history; the chart and table below show recent activity.</p></div></div>
      ${emptyState("No usage yet", "Sync with pyro or connect OpenRouter to start filling in your history.")}
    </section>`;
  }

  const today = todayUTCDate();
  const todayKey = today.toISOString().slice(0, 10);
  const start90 = dateOffsetUTC(todayKey, -(HISTORY_CHART_DAYS - 1));
  const start30 = dateOffsetUTC(todayKey, -(HISTORY_TABLE_DAYS - 1));

  const componentByDate = new Map(componentRows.map((r) => [r.date_utc, r]));
  const last90 = [];
  for (let d = parseUTCDate(start90); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const row = componentByDate.get(key);
    last90.push({ date_utc: key, total_tokens: row ? int(row.total_tokens) : 0 });
  }

  const sourceByDate = dailyTopBreakdown(sourceRows);
  const toolTotals90 = summarizeSourceRows(sourceRows.filter((r) => r.date_utc >= start90));

  const tableRows = [];
  for (let d = new Date(today); d >= parseUTCDate(start30); d.setUTCDate(d.getUTCDate() - 1)) {
    const key = d.toISOString().slice(0, 10);
    const row = componentByDate.get(key);
    const top = sourceByDate.get(key);
    tableRows.push({
      date_utc: key,
      total_tokens: row ? int(row.total_tokens) : 0,
      records: row ? int(row.records) : 0,
      topCli: top ? top.topCli : "",
      topModel: top ? top.topModel : "",
    });
  }

  return `<section class="panel history-panel">
    <div class="section-head"><div><h2>Your history</h2><p class="muted">Personal usage across your machines and OpenRouter connections. Exports cover full history; the chart and table below show the last ${HISTORY_CHART_DAYS} days.</p></div></div>
    <div class="history-chart-wrap">${historyBarChartSVG(last90)}</div>
    ${historyToolSplit(toolTotals90)}
    <div class="history-actions">
      <a class="button secondary" href="/api/me/usage.csv">Download CSV (daily totals)</a>
      <a class="button secondary" href="/api/me/usage-breakdown.csv">Download CSV (by tool &amp; model)</a>
    </div>
    ${historyTable(tableRows)}
  </section>`;
}

function dailyTopBreakdown(sourceRows) {
  const byDate = new Map();
  for (const row of sourceRows) {
    if (!byDate.has(row.date_utc)) byDate.set(row.date_utc, { cli: new Map(), model: new Map() });
    const bucket = byDate.get(row.date_utc);
    const tokens = int(row.total_tokens);
    bucket.cli.set(row.cli, (bucket.cli.get(row.cli) || 0) + tokens);
    bucket.model.set(row.model, (bucket.model.get(row.model) || 0) + tokens);
  }
  const result = new Map();
  for (const [date, bucket] of byDate) {
    const topCli = [...bucket.cli.entries()].sort((a, b) => b[1] - a[1])[0];
    const topModel = [...bucket.model.entries()].sort((a, b) => b[1] - a[1])[0];
    result.set(date, { topCli: topCli ? topCli[0] : "", topModel: topModel ? topModel[0] : "" });
  }
  return result;
}

function historyBarChartSVG(days) {
  const barWidth = 6;
  const gap = 2;
  const left = 40;
  const top = 10;
  const chartHeight = 130;
  const bottomAxis = 22;
  const n = days.length;
  const width = left + n * (barWidth + gap);
  const height = top + chartHeight + bottomAxis;
  const max = Math.max(1, ...days.map((d) => int(d.total_tokens)));
  const baseline = top + chartHeight;
  const bars = days.map((day, i) => {
    const value = int(day.total_tokens);
    if (value <= 0) return "";
    const barHeight = Math.max(2, Math.round((value / max) * chartHeight));
    const x = left + i * (barWidth + gap);
    const y = baseline - barHeight;
    const tip = `${formatDate(day.date_utc)}: ${formatInt(value)} tokens`;
    return `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="1.5" fill="var(--burnfolio-flame, #F2611C)" data-tip="${esc(tip)}" tabindex="0" role="img" aria-label="${esc(tip)}"><title>${esc(tip)}</title></rect>`;
  }).join("");
  const tickEvery = 14;
  const ticks = days.map((day, i) => {
    if (i % tickEvery !== 0 && i !== n - 1) return "";
    const x = left + i * (barWidth + gap) + barWidth / 2;
    return `<text x="${x}" y="${baseline + 16}" text-anchor="middle" font-family="Space Mono, ui-monospace, monospace" font-size="9" fill="var(--burnfolio-ash, #6F5F4D)">${esc(formatShortDate(day.date_utc))}</text>`;
  }).join("");
  return `<svg class="history-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily token burn, last ${n} days">
    <line x1="${left}" y1="${baseline}" x2="${width}" y2="${baseline}" stroke="var(--burnfolio-line, #EEDDCB)" stroke-width="1"/>
    <text x="${left - 6}" y="${baseline}" text-anchor="end" font-family="Space Mono, ui-monospace, monospace" font-size="10" fill="var(--burnfolio-ash, #6F5F4D)">0</text>
    <text x="${left - 6}" y="${top + 9}" text-anchor="end" font-family="Space Mono, ui-monospace, monospace" font-size="10" fill="var(--burnfolio-ash, #6F5F4D)">${esc(formatCompact(max))}</text>
    ${bars}
    ${ticks}
  </svg>`;
}

function historyToolSplit(breakdown) {
  if (!breakdown.byTool.length) return "";
  const bars = breakdown.byTool.map((row) => `
    <div class="tool-bar">
      <div class="tool-bar-label"><span>${esc(row.cli)}</span><span>${formatCompact(row.tokens)} · ${Math.round(row.pct * 100)}%</span></div>
      <div class="tool-bar-track"><div class="tool-bar-fill" style="width:${Math.max(2, Math.round(row.pct * 100))}%"></div></div>
    </div>`).join("");
  return `<div class="history-tools"><h3>Tool split, last ${HISTORY_CHART_DAYS} days</h3><div class="tool-bars">${bars}</div></div>`;
}

function historyTable(rows) {
  const body = rows.map((row) => `
    <tr>
      <td>${esc(formatDate(row.date_utc))}</td>
      <td>${formatInt(row.total_tokens)}</td>
      <td>${formatInt(row.records)}</td>
      <td>${row.topCli ? esc(row.topCli) : "—"}</td>
      <td>${row.topModel ? esc(row.topModel) : "—"}</td>
    </tr>`).join("");
  return `<div class="history-table-wrap">
    <table class="history-table">
      <thead><tr><th>Date</th><th>Total tokens</th><th>Records</th><th>Top tool</th><th>Top model</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

const SHARE_EQUIVALENCES = [
  { min: 1_000_000_000_000, unit: 4_000_000_000, label: "the entire English Wikipedia (~4B tokens)" },
  { min: 10_000_000_000, unit: 1_200_000, label: "the complete works of Shakespeare (~1.2M tokens)" },
  { min: 100_000_000, unit: 900_000, label: "the Lord of the Rings trilogy (~900K tokens)" },
  { min: 1_000_000, unit: 130_000, label: "a Harry Potter novel (~130K tokens)" },
];

function shareEquivalence(totalTokens) {
  totalTokens = int(totalTokens);
  for (const rung of SHARE_EQUIVALENCES) {
    if (totalTokens >= rung.min) {
      const count = Math.max(1, Math.round(totalTokens / rung.unit));
      return `≈ ${formatCompact(count)} ${count === 1 ? "copy" : "copies"} of ${rung.label}`;
    }
  }
  return "";
}

function snippet(label, code) {
  return `<div class="snippet"><div><span>${esc(label)}</span><button type="button" class="secondary copy" data-copy="${esc(code)}">Copy</button></div><code>${esc(code)}</code></div>`;
}

function emptyState(title, body) {
  return `<div class="empty-state"><strong>${esc(title)}</strong><span>${esc(body)}</span></div>`;
}

function todayUTCDate() {
  const today = new Date();
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
}

function sameDatePreviousYear(date) {
  const year = date.getUTCFullYear() - 1;
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}

function startOfWeekUTC(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay()));
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function formatShortDate(value) {
  if (!value) return "";
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
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
  const today = todayUTCDate();
  let currentStreak = 0;
  const todayHasUsage = (dayMap.get(today.toISOString().slice(0, 10)) || 0) > 0;
  const streakStart = todayHasUsage ? 0 : 1;
  for (let i = streakStart; i < streakStart + 365; i++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    if ((dayMap.get(key) || 0) <= 0) break;
    currentStreak++;
  }

  let last365Tokens = 0;
  const first = sameDatePreviousYear(today);
  for (let d = new Date(first); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    last365Tokens += dayMap.get(d.toISOString().slice(0, 10)) || 0;
  }

  let longestStreak = 0;
  let running = 0;
  let prevDate = null;
  for (const dateStr of activeDays.map((day) => day.date_utc).sort()) {
    const d = parseUTCDate(dateStr);
    if (!d) continue;
    running = prevDate && Math.round((d - prevDate) / 86400000) === 1 ? running + 1 : 1;
    if (running > longestStreak) longestStreak = running;
    prevDate = d;
  }
  longestStreak = Math.max(longestStreak, currentStreak);

  return {
    active_days: activeDays.length,
    best_day: bestDay,
    best_day_tokens: bestDayTokens,
    current_streak_days: currentStreak,
    longest_streak_days: longestStreak,
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
        invalid_handle: "Choose a different username. Some app paths are reserved.",
        handle_unavailable: "That username is already taken."
      };
      return messages[data && data.error] || "Something went wrong. Check the inputs and try again.";
    }
    function submitButton(form) {
      return form.querySelector("button[type='submit'], button:not([type])");
    }
    function setBusy(button, label) {
      if (!button) return "";
      const original = button.dataset.label || button.textContent;
      button.dataset.label = original;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = label;
      return original;
    }
    function restoreButton(button, label) {
      if (!button) return;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = label || button.dataset.label || "Continue";
    }
    function startEmailCooldown(form, seconds = 60) {
      const button = submitButton(form);
      if (!button) return;
      const doneLabel = form.dataset.resendLabel || button.dataset.label || "Send again";
      button.removeAttribute("aria-busy");
      let remaining = seconds;
      button.disabled = true;
      button.textContent = "Resend in " + remaining + "s";
      const timer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(timer);
          restoreButton(button, doneLabel);
          return;
        }
        button.textContent = "Resend in " + remaining + "s";
      }, 1000);
    }
    document.querySelector("[data-signup]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = submitButton(form);
      const result = document.querySelector("[data-result]");
      const body = Object.fromEntries(new FormData(form).entries());
      setBusy(button, "Creating...");
      result.hidden = false;
      result.textContent = "Creating your profile...";
      try {
        const res = await fetch("/api/signup", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) {
          result.textContent = messageFor(data);
          restoreButton(button);
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
      } catch {
        result.textContent = "Something went wrong. Check the inputs and try again.";
        restoreButton(button);
      }
    });
    document.querySelector("[data-login]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = submitButton(form);
      const result = document.querySelector("[data-login-result]");
      const body = Object.fromEntries(new FormData(form).entries());
      setBusy(button, "Sending...");
      result.hidden = false;
      result.textContent = "Sending your magic link...";
      try {
        const res = await fetch("/api/magic-links", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
        const data = await res.json();
        const mode = form.dataset.authMode || "signin";
        if (res.ok) {
          result.textContent = mode === "signup" ? "Magic link sent. Check your email to finish creating your profile." : "Magic link sent. Check your email to sign in.";
          startEmailCooldown(form);
          return;
        }
        result.textContent = messageFor(data);
        restoreButton(button);
      } catch {
        result.textContent = "The email could not be sent. Try again shortly.";
        restoreButton(button);
      }
    });
    document.querySelector("[data-account-login]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = submitButton(form);
      const result = document.querySelector("[data-account-login-result]");
      const body = Object.fromEntries(new FormData(form).entries());
      setBusy(button, "Signing in...");
      result.hidden = false;
      result.textContent = "Checking your account key...";
      try {
        const res = await fetch("/api/account-login", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
        const data = await res.json();
        result.textContent = res.ok ? "Signed in. Opening dashboard..." : messageFor(data);
        if (res.ok) location.href = "/app";
        else restoreButton(button);
      } catch {
        result.textContent = "Something went wrong. Check the inputs and try again.";
        restoreButton(button);
      }
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
        invalid_url: "Use valid website, GitHub, and X.com links.",
        invalid_openrouter_key: "Enter a valid OpenRouter management key.",
        openrouter_management_key_required: "Use an OpenRouter management key, not a regular inference key.",
        openrouter_key_storage_not_configured: "OpenRouter key storage is not configured yet.",
        openrouter_fetch_failed: "OpenRouter usage could not be fetched right now.",
        email_already_claimed: "That email is already attached to another account.",
        email_send_failed: "The email could not be sent. Try again shortly.",
        org_handle_unavailable: "That organization username is already taken.",
        org_not_found: "Organization not found.",
        machine_not_found: "That machine was not found.",
        forbidden: "Only org admins or owners can manage members.",
        owner_required: "Only the current owner can transfer ownership.",
        owner_transfer_required: "Transfer ownership to another member before changing the current owner.",
        owner_cannot_be_removed: "The owner cannot be removed.",
        member_not_found: "That member was not found.",
        member_must_accept_invite: "That user has to accept the org invite before ownership can be transferred.",
        invite_not_found: "That invite is no longer available.",
        user_not_found: "No user was found for that account or username.",
        invalid_goal: "Enter a whole number of tokens, 0 or blank to clear.",
        confirm_mismatch: "That doesn't match your username or account number.",
        owns_orgs: "Transfer ownership of your organizations before deleting your account."
      };
      return messages[data && data.error] || "Something went wrong. Check the inputs and try again.";
    }
    function submitButton(form) {
      return form.querySelector("button[type='submit'], button:not([type])");
    }
    function setBusy(button, label) {
      if (!button) return "";
      const original = button.dataset.label || button.textContent;
      button.dataset.label = original;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = label;
      return original;
    }
    function restoreButton(button, label) {
      if (!button) return;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = label || button.dataset.label || "Continue";
    }
    function startEmailCooldown(form, seconds = 60) {
      const button = submitButton(form);
      if (!button) return;
      const doneLabel = form.dataset.resendLabel || button.dataset.label || "Send again";
      button.removeAttribute("aria-busy");
      let remaining = seconds;
      button.disabled = true;
      button.textContent = "Resend in " + remaining + "s";
      const timer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(timer);
          restoreButton(button, doneLabel);
          return;
        }
        button.textContent = "Resend in " + remaining + "s";
      }, 1000);
    }
    async function post(form, url) {
      const body = Object.fromEntries(new FormData(form).entries());
      const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      return { ok: res.ok, data };
    }
    async function patch(form, url) {
      const body = Object.fromEntries(new FormData(form).entries());
      const res = await fetch(url, { method:"PATCH", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
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
    document.querySelector("[data-machine]").addEventListener("submit", async e => {
      e.preventDefault();
      const form = e.currentTarget;
      const button = submitButton(form);
      const out = document.querySelector("[data-machine-result]");
      setBusy(button, "Creating...");
      out.hidden = false;
      out.textContent = "Creating machine token...";
      try {
        const { ok, data } = await post(form, "/api/machines");
        ok && data.machine ? machineResult(out, data.machine) : (out.textContent = messageFor(data));
      } catch {
        out.textContent = "Something went wrong. Check the inputs and try again.";
      } finally {
        restoreButton(button);
      }
    });
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
    document.querySelector("[data-handle]")?.addEventListener("submit", async e => {
      e.preventDefault();
      const form = e.currentTarget;
      const button = submitButton(form);
      setBusy(button, "Saving...");
      try {
        const { ok, data } = await post(form, "/api/handles");
        ok ? location.reload() : alert(messageFor(data));
        if (!ok) restoreButton(button);
      } catch {
        alert("Something went wrong. Check the inputs and try again.");
        restoreButton(button);
      }
    });
    document.querySelector("[data-profile]")?.addEventListener("submit", async e => {
      e.preventDefault();
      const form = e.currentTarget;
      const button = submitButton(form);
      const out = form.querySelector("[data-profile-result]");
      setBusy(button, "Saving...");
      if (out) {
        out.hidden = false;
        out.textContent = "Saving...";
      }
      try {
        const { ok, data } = await patch(form, "/api/profile");
        if (out) out.textContent = ok ? "Saved." : messageFor(data);
        if (!ok) restoreButton(button);
        else setTimeout(() => restoreButton(button), 900);
      } catch {
        if (out) out.textContent = "Something went wrong. Check the links and try again.";
        restoreButton(button);
      }
    });
    document.querySelector("[data-goal]")?.addEventListener("submit", async e => {
      e.preventDefault();
      const form = e.currentTarget;
      const button = submitButton(form);
      setBusy(button, "Saving...");
      try {
        const { ok, data } = await patch(form, "/api/profile");
        if (ok) location.reload();
        else {
          alert(messageFor(data));
          restoreButton(button);
        }
      } catch {
        alert("Something went wrong. Try again.");
        restoreButton(button);
      }
    });
    document.querySelectorAll("[data-openrouter]").forEach(panel => {
      const result = panel.querySelector("[data-openrouter-result]");
      const connect = panel.querySelector("[data-openrouter-connect]");
      const endpoint = panel.dataset.openrouterScope === "org"
        ? "/api/orgs/" + encodeURIComponent(panel.dataset.org) + "/openrouter/connections"
        : "/api/openrouter/connections";
      function show(message) {
        if (!result) return;
        result.hidden = false;
        result.textContent = message;
      }
      connect?.addEventListener("submit", async event => {
        event.preventDefault();
        const button = submitButton(connect);
        setBusy(button, "Connecting...");
        show("Checking OpenRouter key...");
        try {
          const { ok, data } = await post(connect, endpoint);
          show(ok ? "Connected. Usage import is running." : messageFor(data));
          ok ? setTimeout(() => location.reload(), 900) : restoreButton(button);
        } catch {
          show("Something went wrong. Check the key and try again.");
          restoreButton(button);
        }
      });
      panel.querySelectorAll("[data-openrouter-sync]").forEach(button => button.addEventListener("click", async () => {
        const row = button.closest("[data-openrouter-connection]");
        setBusy(button, "Syncing...");
        show("Fetching OpenRouter usage...");
        try {
          const res = await fetch(row.dataset.openrouterBase + "/sync", { method:"POST" });
          const data = await res.json();
          show(res.ok ? "OpenRouter usage synced." : messageFor(data));
          res.ok ? setTimeout(() => location.reload(), 900) : restoreButton(button);
        } catch {
          show("OpenRouter usage could not be fetched right now.");
          restoreButton(button);
        }
      }));
      panel.querySelectorAll("[data-openrouter-delete]").forEach(button => button.addEventListener("click", async () => {
        if (!confirm("Remove this OpenRouter connection? Imported usage will remain on the graph.")) return;
        const row = button.closest("[data-openrouter-connection]");
        setBusy(button, "Removing...");
        try {
          const res = await fetch(row.dataset.openrouterBase, { method:"DELETE" });
          const data = await res.json().catch(() => ({}));
          if (res.ok) location.reload();
          else {
            show(messageFor(data));
            restoreButton(button);
          }
        } catch {
          show("Something went wrong. Try again.");
          restoreButton(button);
        }
      }));
    });
    document.querySelector("[data-email]").addEventListener("submit", async e => {
      e.preventDefault();
      const form = e.currentTarget;
      const button = submitButton(form);
      const out = document.querySelector("[data-email-result]");
      setBusy(button, "Sending...");
      out.hidden = false;
      out.textContent = "Sending verification link...";
      try {
        const { ok, data } = await post(form, "/api/email");
        if (ok) {
          out.textContent = "Verification link sent. This email will show as pending until the link is opened.";
          startEmailCooldown(form);
          return;
        }
        out.textContent = messageFor(data);
        restoreButton(button);
      } catch {
        out.textContent = "The email could not be sent. Try again shortly.";
        restoreButton(button);
      }
    });
    document.querySelector("[data-org]").addEventListener("submit", async e => {
      e.preventDefault();
      const form = e.currentTarget;
      const button = submitButton(form);
      const out = document.querySelector("[data-org-result]");
      setBusy(button, "Creating...");
      out.hidden = false;
      out.textContent = "Creating organization...";
      try {
        const { ok, data } = await post(form, "/api/orgs");
        ok && data.org ? location.reload() : (out.textContent = messageFor(data));
        if (!ok) restoreButton(button);
      } catch {
        out.textContent = "Something went wrong. Check the inputs and try again.";
        restoreButton(button);
      }
    });
    document.querySelector("[data-logout]").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      setBusy(button, "Logging out...");
      await fetch("/api/logout", { method:"POST" });
      location.href = "/";
    });
    document.querySelector("[data-delete-account]")?.addEventListener("submit", async e => {
      e.preventDefault();
      const form = e.currentTarget;
      const button = submitButton(form);
      const out = form.querySelector("[data-delete-result]") || document.querySelector("[data-delete-result]");
      const confirmValue = new FormData(form).get("confirm") || "";
      if (!confirmValue.trim()) {
        if (out) { out.hidden = false; out.textContent = "Type your username to confirm."; }
        return;
      }
      if (!confirm("This permanently deletes your account and all its data. This cannot be undone. Continue?")) return;
      setBusy(button, "Deleting...");
      try {
        const res = await fetch("/api/me", { method:"DELETE", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ confirm: confirmValue }) });
        const data = await res.json();
        if (res.ok) {
          location.href = "/";
          return;
        }
        if (out) { out.hidden = false; out.textContent = messageFor(data); }
        restoreButton(button);
      } catch {
        if (out) { out.hidden = false; out.textContent = "Something went wrong. Try again."; }
        restoreButton(button);
      }
    });
    document.querySelectorAll("[data-invite-accept]").forEach(button => button.addEventListener("click", async () => {
      setBusy(button, "Accepting...");
      try {
        const res = await fetch("/api/orgs/" + encodeURIComponent(button.dataset.org) + "/invite/accept", { method:"POST" });
        const data = await res.json();
        if (res.ok) location.reload();
        else {
          alert(messageFor(data));
          restoreButton(button);
        }
      } catch {
        alert("Something went wrong. Try again.");
        restoreButton(button);
      }
    }));
    document.querySelectorAll("[data-invite-decline]").forEach(button => button.addEventListener("click", async () => {
      if (!confirm("Decline this org invite?")) return;
      const row = button.closest("[data-org-invite]");
      setBusy(button, "Declining...");
      try {
        const res = await fetch("/api/orgs/" + encodeURIComponent(button.dataset.org) + "/invite/decline", { method:"POST" });
        const data = await res.json().catch(() => ({}));
        if (res.ok) row.remove();
        else {
          alert(messageFor(data));
          restoreButton(button);
        }
      } catch {
        alert("Something went wrong. Try again.");
        restoreButton(button);
      }
    }));
  `;
}

function orgManagementScript() {
  return `
    function messageFor(data) {
      const messages = {
        unauthorized: "Your session expired. Sign in again.",
        invalid_handle: "Choose a different username. Some app paths are reserved.",
        invalid_url: "Use valid website, GitHub, and X.com links.",
        invalid_openrouter_key: "Enter a valid OpenRouter management key.",
        openrouter_management_key_required: "Use an OpenRouter management key, not a regular inference key.",
        openrouter_key_storage_not_configured: "OpenRouter key storage is not configured yet.",
        openrouter_fetch_failed: "OpenRouter usage could not be fetched right now.",
        org_not_found: "Organization not found.",
        forbidden: "Only org admins or owners can manage members.",
        owner_required: "Only the current owner can transfer ownership.",
        owner_transfer_required: "Transfer ownership to another member before changing the current owner.",
        owner_cannot_be_removed: "The owner cannot be removed.",
        member_not_found: "That member was not found.",
        member_must_accept_invite: "That user has to accept the org invite before ownership can be transferred.",
        user_not_found: "No user was found for that account or username."
      };
      return messages[data && data.error] || "Something went wrong. Check the inputs and try again.";
    }
    async function send(url, method, body) {
      const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type":"application/json" } : {},
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, data };
    }
    function submitButton(form) {
      return form.querySelector("button[type='submit'], button:not([type])");
    }
    function setBusy(control, label) {
      if (!control) return "";
      const original = control.dataset.label || control.textContent || control.value;
      control.dataset.label = original;
      control.disabled = true;
      control.setAttribute("aria-busy", "true");
      if ("value" in control && control.tagName === "INPUT") control.value = label;
      else control.textContent = label;
      return original;
    }
    function restoreControl(control, label) {
      if (!control) return;
      control.disabled = false;
      control.removeAttribute("aria-busy");
      const next = label || control.dataset.label || "Continue";
      if ("value" in control && control.tagName === "INPUT") control.value = next;
      else control.textContent = next;
    }
    document.querySelectorAll("[data-add-member]").forEach(form => form.addEventListener("submit", async event => {
      event.preventDefault();
      const button = submitButton(form);
      const body = Object.fromEntries(new FormData(form).entries());
      setBusy(button, "Inviting...");
      try {
        const { ok, data } = await send("/api/orgs/" + encodeURIComponent(form.dataset.org) + "/members", "POST", body);
        ok ? location.reload() : alert(messageFor(data));
        if (!ok) restoreControl(button);
      } catch {
        alert("Something went wrong. Check the inputs and try again.");
        restoreControl(button);
      }
    }));
    document.querySelectorAll("[data-org-profile]").forEach(form => form.addEventListener("submit", async event => {
      event.preventDefault();
      const button = submitButton(form);
      const out = form.querySelector("[data-profile-result]");
      const body = Object.fromEntries(new FormData(form).entries());
      setBusy(button, "Saving...");
      if (out) {
        out.hidden = false;
        out.textContent = "Saving...";
      }
      try {
        const { ok, data } = await send("/api/orgs/" + encodeURIComponent(form.dataset.org) + "/profile", "PATCH", body);
        if (out) out.textContent = ok ? "Saved." : messageFor(data);
        if (!ok) restoreControl(button);
        else setTimeout(() => restoreControl(button), 900);
      } catch {
        if (out) out.textContent = "Something went wrong. Check the links and try again.";
        restoreControl(button);
      }
    }));
    document.querySelectorAll("[data-openrouter]").forEach(panel => {
      const result = panel.querySelector("[data-openrouter-result]");
      const connect = panel.querySelector("[data-openrouter-connect]");
      const endpoint = "/api/orgs/" + encodeURIComponent(panel.dataset.org) + "/openrouter/connections";
      function show(message) {
        if (!result) return;
        result.hidden = false;
        result.textContent = message;
      }
      connect?.addEventListener("submit", async event => {
        event.preventDefault();
        const button = submitButton(connect);
        const body = Object.fromEntries(new FormData(connect).entries());
        setBusy(button, "Connecting...");
        show("Checking OpenRouter key...");
        try {
          const { ok, data } = await send(endpoint, "POST", body);
          show(ok ? "Connected. Usage import is running." : messageFor(data));
          ok ? setTimeout(() => location.reload(), 900) : restoreControl(button);
        } catch {
          show("Something went wrong. Check the key and try again.");
          restoreControl(button);
        }
      });
      panel.querySelectorAll("[data-openrouter-sync]").forEach(button => button.addEventListener("click", async () => {
        const row = button.closest("[data-openrouter-connection]");
        setBusy(button, "Syncing...");
        show("Fetching OpenRouter usage...");
        try {
          const { ok, data } = await send(row.dataset.openrouterBase + "/sync", "POST");
          show(ok ? "OpenRouter usage synced." : messageFor(data));
          ok ? setTimeout(() => location.reload(), 900) : restoreControl(button);
        } catch {
          show("OpenRouter usage could not be fetched right now.");
          restoreControl(button);
        }
      }));
      panel.querySelectorAll("[data-openrouter-delete]").forEach(button => button.addEventListener("click", async () => {
        if (!confirm("Remove this OpenRouter connection? Imported usage will remain on the graph.")) return;
        const row = button.closest("[data-openrouter-connection]");
        setBusy(button, "Removing...");
        try {
          const { ok, data } = await send(row.dataset.openrouterBase, "DELETE");
          ok ? location.reload() : show(messageFor(data));
          if (!ok) restoreControl(button);
        } catch {
          show("Something went wrong. Try again.");
          restoreControl(button);
        }
      }));
    });
    document.querySelectorAll("[data-member-role] select").forEach(select => select.addEventListener("change", async event => {
      const form = event.target.closest("[data-member-role]");
      const body = Object.fromEntries(new FormData(form).entries());
      select.disabled = true;
      select.setAttribute("aria-busy", "true");
      try {
        const { ok, data } = await send("/api/orgs/" + encodeURIComponent(form.dataset.org) + "/members/" + encodeURIComponent(form.dataset.member), "PATCH", body);
        ok ? location.reload() : alert(messageFor(data));
        if (!ok) {
          select.disabled = false;
          select.removeAttribute("aria-busy");
        }
      } catch {
        alert("Something went wrong. Check the inputs and try again.");
        select.disabled = false;
        select.removeAttribute("aria-busy");
      }
    }));
    document.querySelectorAll("[data-remove-member]").forEach(button => button.addEventListener("click", async () => {
      if (!confirm("Remove this member from the organization?")) return;
      setBusy(button, "Removing...");
      try {
        const { ok, data } = await send("/api/orgs/" + encodeURIComponent(button.dataset.org) + "/members/" + encodeURIComponent(button.dataset.member), "DELETE");
        ok ? location.reload() : alert(messageFor(data));
        if (!ok) restoreControl(button);
      } catch {
        alert("Something went wrong. Check the inputs and try again.");
        restoreControl(button);
      }
    }));
  `;
}

function globalScript() {
  return `
    function scrollHeatmapsToNow(root) {
      (root || document).querySelectorAll(".heatmap-scroll").forEach((el) => {
        if (el.offsetParent === null) return;
        el.scrollLeft = el.scrollWidth;
      });
    }
    requestAnimationFrame(() => scrollHeatmapsToNow());
    (function recentTicker() {
      const root = document.querySelector("[data-recent-ticker]");
      if (!root) return;
      const list = root.querySelector("ul");
      function relativeTime(iso) {
        const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
        if (sec < 60) return "just now";
        const min = Math.round(sec / 60);
        if (min < 60) return min + (min === 1 ? " minute ago" : " minutes ago");
        const hr = Math.round(min / 60);
        if (hr < 24) return hr + (hr === 1 ? " hour ago" : " hours ago");
        const day = Math.round(hr / 24);
        return day + (day === 1 ? " day ago" : " days ago");
      }
      function refreshTimes() {
        list.querySelectorAll("[data-since]").forEach((el) => {
          el.textContent = relativeTime(el.dataset.since);
        });
      }
      function renderRows(rows) {
        if (!rows || !rows.length) {
          root.hidden = true;
          return;
        }
        root.hidden = false;
        list.textContent = "";
        rows.forEach((r) => {
          const li = document.createElement("li");
          const since = document.createElement("span");
          since.dataset.since = r.at;
          since.textContent = "recently";
          if (r.type === "badge") {
            const who = document.createElement("strong");
            who.textContent = r.ref;
            const badgeName = document.createElement("strong");
            badgeName.textContent = r.badge_name;
            li.append(who, document.createTextNode(" earned "), badgeName, document.createTextNode(" · "), since);
          } else {
            const strong = document.createElement("strong");
            strong.textContent = r.tokens_display;
            li.append(strong, document.createTextNode(" tokens synced · "), since);
          }
          list.appendChild(li);
        });
        refreshTimes();
      }
      refreshTimes();
      setInterval(refreshTimes, 30000);
      setInterval(async () => {
        try {
          const res = await fetch("/api/global/recent");
          if (!res.ok) return;
          renderRows(await res.json());
        } catch {}
      }, 60000);
    })();
    function shareStatus(message) {
      const out = document.querySelector("[data-share-result]");
      if (!out) return;
      out.hidden = false;
      out.textContent = message;
    }
    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copy || "");
          button.textContent = "Copied";
          if (button.closest("[data-share-dialog]")) shareStatus("Text copied.");
        } catch {
          button.textContent = "Select";
          if (button.closest("[data-share-dialog]")) shareStatus("Select the text and copy it manually.");
        }
        setTimeout(() => button.textContent = "Copy", 1200);
      });
    });
    document.querySelectorAll("[data-embed-panel]").forEach((panel) => {
      function applyEmbedVariant() {
        const theme = panel.querySelector("[data-embed-theme].active")?.dataset.embedTheme || "orange";
        const mode = panel.querySelector("[data-embed-mode].active")?.dataset.embedMode || "dark";
        panel.querySelectorAll("[data-theme-snippet]").forEach((snippet) => {
          const code = snippet.querySelector("code");
          const copy = snippet.querySelector("[data-copy]");
          const next = code?.getAttribute("data-variant-" + theme + "-" + mode) || code?.getAttribute("data-variant-orange-dark") || "";
          if (code) code.textContent = next;
          if (copy) {
            copy.dataset.copy = next;
            copy.textContent = "Copy";
          }
        });
      }
      panel.querySelectorAll("[data-embed-theme]").forEach((button) => {
        button.addEventListener("click", () => {
          panel.querySelectorAll("[data-embed-theme]").forEach((tab) => {
            const active = tab === button;
            tab.classList.toggle("active", active);
            tab.setAttribute("aria-selected", active ? "true" : "false");
          });
          applyEmbedVariant();
        });
      });
      panel.querySelectorAll("[data-embed-mode]").forEach((button) => {
        button.addEventListener("click", () => {
          panel.querySelectorAll("[data-embed-mode]").forEach((tab) => {
            const active = tab === button;
            tab.classList.toggle("active", active);
            tab.setAttribute("aria-selected", active ? "true" : "false");
          });
          applyEmbedVariant();
        });
      });
    });
    document.querySelectorAll("[data-share-open]").forEach((button) => {
      button.addEventListener("click", () => {
        const dialog = document.querySelector("[data-share-dialog]");
        if (!dialog) return;
        dialog.hidden = false;
        document.documentElement.classList.add("share-open");
        document.body.classList.add("share-open");
        dialog.querySelector("[data-copy-share-image]")?.focus({ preventScroll: true });
      });
    });
    document.querySelectorAll("[data-share-close]").forEach((button) => {
      button.addEventListener("click", () => closeShareDialog());
    });
    function closeShareDialog() {
      const dialog = document.querySelector("[data-share-dialog]");
      if (!dialog) return;
      dialog.hidden = true;
      document.documentElement.classList.remove("share-open");
      document.body.classList.remove("share-open");
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeShareDialog();
    });
    document.querySelectorAll("[data-copy-share-image]").forEach((button) => {
      button.addEventListener("click", async () => {
        const original = button.textContent;
        button.disabled = true;
        button.textContent = "Copying...";
        try {
          if (!navigator.clipboard || !window.ClipboardItem) throw new Error("image_clipboard_unavailable");
          const res = await fetch(button.dataset.shareImage || "", { cache: "no-store" });
          if (!res.ok) throw new Error("image_fetch_failed");
          const blob = await res.blob();
          await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
          button.textContent = "Copied";
          shareStatus("Image copied. Paste it into your post composer.");
        } catch {
          button.textContent = "Open image";
          shareStatus("Image copy is not available in this browser. Open the card image and copy or save it manually.");
          window.open(button.dataset.shareImage || "", "_blank", "noopener,noreferrer");
          return;
        } finally {
          button.disabled = false;
        }
        setTimeout(() => button.textContent = original, 1400);
      });
    });
    const tip = document.createElement("div");
    tip.className = "burn-tooltip";
    tip.hidden = true;
    document.body.appendChild(tip);
    function showTip(event) {
      const target = event.target.closest("[data-tip]");
      if (!target) return;
      const margin = 8;
      tip.textContent = target.dataset.tip;
      tip.hidden = false;
      const rect = target.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      // Flip below the target when there isn't room above; otherwise sit above it.
      const fitsAbove = rect.top - tipRect.height - margin >= 0;
      const top = fitsAbove ? rect.top - tipRect.height - margin : Math.min(rect.bottom + margin, window.innerHeight - tipRect.height - margin);
      // Center horizontally on the target, then clamp within the viewport.
      let left = rect.left + rect.width / 2 - tipRect.width / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
      tip.style.left = left + "px";
      tip.style.top = Math.max(margin, top) + "px";
    }
    function hideTip() {
      tip.hidden = true;
    }
    document.addEventListener("mouseover", showTip);
    document.addEventListener("focusin", showTip);
    document.addEventListener("mouseout", (event) => { if (event.target.closest("[data-tip]")) hideTip(); });
    document.addEventListener("focusout", (event) => { if (event.target.closest("[data-tip]")) hideTip(); });
    document.querySelectorAll("[data-year-button]").forEach((button) => {
      button.addEventListener("click", () => {
        const year = button.dataset.yearButton;
        document.querySelectorAll("[data-year-panel]").forEach((panel) => {
          panel.hidden = panel.dataset.yearPanel !== year;
        });
        document.querySelectorAll("[data-year-button]").forEach((item) => {
          const active = item === button;
          item.classList.toggle("active", active);
          item.setAttribute("aria-pressed", active ? "true" : "false");
        });
        requestAnimationFrame(() => scrollHeatmapsToNow());
      });
    });
  `;
}

async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const raw = await request.text();
    if (raw.length > API_BODY_LIMIT) throw new HttpError(413, "request_too_large");
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid_json");
    }
  }
  if (type.includes("form")) return Object.fromEntries(await request.formData());
  return {};
}

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function tooLarge(request, maxBytes) {
  const raw = request.headers.get("content-length");
  if (!raw) return false;
  const value = Number(raw);
  return Number.isFinite(value) && value > maxBytes;
}

function rejectCrossOrigin(request, path) {
  if (!path.startsWith("/api/")) return null;
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return null;
  if (path === "/api/ingest" || path === "/api/openrouter/ingest") return null;
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  try {
    if (new URL(origin).origin === new URL(request.url).origin) return null;
  } catch {
    return json({ error: "bad_origin" }, 403);
  }
  return json({ error: "bad_origin" }, 403);
}

function clientIP(request) {
  return (request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim() || "unknown";
}

async function rateKey(prefix, value) {
  return `${prefix}:${(await sha256(String(value || ""))).slice(0, 32)}`;
}

async function rateLimitChecks(request, env, checks) {
  for (const [key, limit, windowSeconds] of checks) {
    const ok = await hitRateLimit(env, key, limit, windowSeconds);
    if (!ok) {
      return json({ error: "rate_limited" }, 429, { "Retry-After": String(windowSeconds) });
    }
  }
  return null;
}

async function hitRateLimit(env, key, limit, windowSeconds) {
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  await env.DB.prepare(`
    INSERT INTO rate_limits (key, window_start, count, updated_at)
    VALUES (?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
      window_start = excluded.window_start,
      updated_at = excluded.updated_at
  `).bind(key, windowStart).run();
  const row = await env.DB.prepare("SELECT count FROM rate_limits WHERE key = ?").bind(key).first();
  return int(row && row.count) <= limit;
}

const CSP_SOURCES = "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://cloudflareinsights.com";
const CSP_DEFAULT = `${CSP_SOURCES}; frame-ancestors 'none'`;
const CSP_EMBED = `${CSP_SOURCES}; frame-ancestors *`;

function securityHeaders(csp) {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
  if (csp) headers["Content-Security-Policy"] = csp;
  return headers;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...securityHeaders(), ...headers } });
}

function html(body, status = 200, { embed = false } = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...securityHeaders(embed ? CSP_EMBED : CSP_DEFAULT) } });
}

function redirect(location, status = 302) {
  return new Response("", { status, headers: { Location: location } });
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

function pngResponse(body, status = 200, maxAge = 300) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": `public, max-age=${maxAge}`,
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
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
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
  if (RESERVED_HANDLES.has(value)) return "";
  return value;
}

function cleanEmail(value) {
  value = String(value || "").trim().toLowerCase();
  return value && value.includes("@") ? value : "";
}

function cleanVersion(value) {
  value = String(value || "").trim();
  if (!value || value.length > 40) return "";
  return value.match(/^v?[0-9][0-9A-Za-z._+-]{0,39}$/) ? value : "";
}

function cleanTheme(value) {
  value = String(value || "").trim().toLowerCase();
  return EMBED_THEMES.includes(value) ? value : "orange";
}

function cleanMode(value) {
  value = String(value || "").trim().toLowerCase();
  return EMBED_MODES.includes(value) ? value : "dark";
}

function cleanProfileMetadata(body) {
  const fields = {};
  if ("bio" in body) fields.bio = cleanText(body.bio, 280);
  if ("website_url" in body || "website" in body) {
    const website = cleanWebsiteURL(body.website_url ?? body.website);
    if (website === null) return { error: "invalid_url" };
    fields.website_url = website;
  }
  if ("github_url" in body || "github" in body) {
    const github = cleanSocialURL(body.github_url ?? body.github, "github.com");
    if (github === null) return { error: "invalid_url" };
    fields.github_url = github;
  }
  if ("x_url" in body || "x" in body || "twitter" in body) {
    const x = cleanSocialURL(body.x_url ?? body.x ?? body.twitter, "x.com");
    if (x === null) return { error: "invalid_url" };
    fields.x_url = x;
  }
  if ("show_model_breakdown" in body) fields.show_model_breakdown = body.show_model_breakdown === true || body.show_model_breakdown === "true";
  if ("monthly_goal_tokens" in body) {
    const raw = body.monthly_goal_tokens;
    if (raw === null || raw === "") {
      fields.monthly_goal_tokens = null;
    } else {
      const value = boundedInt(raw, MAX_TOKEN_FIELD);
      if (value === null) return { error: "invalid_goal" };
      fields.monthly_goal_tokens = value > 0 ? value : null;
    }
  }
  return fields;
}

function cleanWebsiteURL(value) {
  value = String(value || "").trim();
  if (!value) return "";
  if (!value.match(/^https?:\/\//i)) value = `https://${value}`;
  return cleanURLForHost(value, null);
}

function cleanSocialURL(value, host) {
  value = String(value || "").trim().replace(/^@/, "");
  if (!value) return "";
  if (!value.match(/^https?:\/\//i)) {
    const lower = value.toLowerCase().replace(/^www\./, "");
    value = lower === host || lower.startsWith(`${host}/`) ? `https://${value}` : `https://${host}/${value}`;
  }
  return cleanURLForHost(value, host);
}

function cleanURLForHost(value, expectedHost) {
  if (value.length > 240) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    if (expectedHost) {
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (host !== expectedHost) return null;
      if (!url.pathname || url.pathname === "/") return null;
    }
    return url.toString().slice(0, 240);
  } catch {
    return null;
  }
}

function displayURL(value) {
  try {
    const url = new URL(value);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`.replace(/\/$/, "");
  } catch {
    return value;
  }
}

function githubLabel(value) {
  return socialPathLabel(value, "GitHub");
}

function xLabel(value) {
  return socialPathLabel(value, "X.com");
}

function socialPathLabel(value, fallback) {
  try {
    const url = new URL(value);
    const handle = url.pathname.split("/").filter(Boolean)[0];
    return handle ? `@${handle}` : fallback;
  } catch {
    return fallback;
  }
}

function embedThemeQuery(theme, mode = "dark") {
  theme = cleanTheme(theme);
  mode = cleanMode(mode);
  const params = [];
  if (theme !== "orange") params.push(`theme=${theme}`);
  if (mode !== "dark") params.push(`mode=${mode}`);
  return params.length ? `?${params.join("&")}` : "";
}

function embedPalette(theme, mode = "dark") {
  const darkPalettes = {
    orange: ["#2A2017", "#7A3D12", "#C0590F", "#F2611C", "#FF8A3D"],
    green: ["#18251B", "#1F5D35", "#2F8C4C", "#48B86A", "#8CE99A"],
    blue: ["#172235", "#214D7A", "#2E7BC4", "#4AA3FF", "#9BD1FF"],
  };
  const lightPalettes = {
    orange: ["#F2E7D9", "#FBD089", "#F99B3C", "#F2611C", "#D6300B"],
    green: ["#E4F3E8", "#B8E4C4", "#6FC98A", "#2F8C4C", "#1F5D35"],
    blue: ["#E4EEFB", "#BBDBFA", "#6FB3F5", "#2E7BC4", "#173F73"],
  };
  const palettes = cleanMode(mode) === "light" ? lightPalettes : darkPalettes;
  return palettes[cleanTheme(theme)] || palettes.orange;
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
  return `Open your Burnfolio graph\n\nUse this magic link to open your burn graph dashboard. It expires in 15 minutes.\n\n${link}\n\nIf you did not request this email, you can ignore it.`;
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
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="vertical-align:top">
                      <div style="font-size:18px;font-weight:800;color:#211405">Burnfolio</div>
                      <h1 style="margin:28px 0 10px;font-size:30px;line-height:1.08;color:#211405;font-family:Bricolage Grotesque,Segoe UI,Arial,sans-serif">Open your burn graph</h1>
                      <p style="margin:0;color:#6F5F4D;font-size:15px;line-height:1.55">Pyro has the GPU warm. This magic link signs you in and expires in 15 minutes.</p>
                    </td>
                    <td align="right" style="vertical-align:top;width:118px;padding-left:18px">
                      <img src="https://burnfolio.ai/assets/pyro-gpu.svg" width="104" height="104" alt="Pyro warming up a GPU" style="display:block;width:104px;height:104px;border:0">
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px">
                <a href="${safeLink}" style="display:inline-block;background:#C2400A;color:#FFFFFF;text-decoration:none;font-weight:800;border-radius:999px;padding:13px 18px">Sign in to Burnfolio</a>
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

function cleanSourceField(value) {
  const text = String(value || "").trim().toLowerCase().slice(0, 200);
  return text || "unknown";
}

function int(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function boundedInt(value, max) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.floor(n);
  if (!Number.isSafeInteger(rounded) || rounded < 0 || rounded > max) return null;
  return rounded;
}

function dailyTokenClamp(env) {
  const raw = Number(env && env.MAX_DAILY_TOKENS_PER_SOURCE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_DAILY_TOKENS_PER_SOURCE;
}

function cleanOpenRouterKey(value) {
  value = String(value || "").trim();
  if (!value || value.length > 240) return "";
  return value.startsWith("sk-or-v1-") ? value : "";
}

function cleanOpenRouterHash(value) {
  value = String(value || "").trim().toLowerCase();
  return value.match(/^[a-f0-9]{64}$/) ? value : "";
}

function validIngestDate(value) {
  if (!String(value || "").match(/^\d{4}-\d{2}-\d{2}$/)) return false;
  if (value < MIN_INGEST_DATE) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  const tomorrow = new Date(todayUTCDate().getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return value <= tomorrow;
}

function tomorrowUTCISO() {
  return new Date(todayUTCDate().getTime() + 24 * 60 * 60 * 1000).toISOString();
}

function dateOffsetUTC(date, offsetDays) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return OPENROUTER_SYNC_SINCE;
  parsed.setUTCDate(parsed.getUTCDate() + offsetDays);
  const value = parsed.toISOString().slice(0, 10);
  return value < OPENROUTER_SYNC_SINCE ? OPENROUTER_SYNC_SINCE : value;
}

function parseUTCDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  return parsed;
}

async function encryptStoredSecret(env, value) {
  const key = await storageCryptoKey(env);
  if (!key) return { error: "openrouter_key_storage_not_configured" };
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(value);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, encoded);
  return { ciphertext: base64Encode(new Uint8Array(encrypted)), nonce: base64Encode(nonce) };
}

async function decryptStoredSecret(env, ciphertext, nonce) {
  const key = await storageCryptoKey(env);
  if (!key) return { error: "openrouter_key_storage_not_configured" };
  try {
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64Decode(nonce) }, key, base64Decode(ciphertext));
    return { value: new TextDecoder().decode(decrypted) };
  } catch {
    return { error: "openrouter_key_decrypt_failed" };
  }
}

async function storageCryptoKey(env) {
  const secret = String(env.OPENROUTER_KEY_SECRET || "");
  if (secret.length < 32) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function base64Encode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
