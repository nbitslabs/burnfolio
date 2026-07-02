# Burnfolio

Burnfolio collects local AI coding-agent usage data and summarizes token burn by
date, CLI type, and model.

The hosted app runs on Cloudflare Workers at `https://burnfolio.ai`, with D1 for
storage and Cloudflare Email Service for optional magic-link sign-in.

Current collectors:

- Claude Code: `~/.config/claude/projects` and `~/.claude/projects`
- Codex: `${CODEX_HOME:-~/.codex}/sessions` and `archived_sessions`
- OpenCode: `${OPENCODE_DATA_DIR:-~/.local/share/opencode}`
- Pi: `${PI_AGENT_DIR:-~/.pi/agent/sessions}`
- Amp: `${AMP_DATA_DIR:-~/.local/share/amp}`
- Droid: `${DROID_SESSIONS_DIR:-~/.factory/sessions}`
- Codebuff: `${CODEBUFF_DATA_DIR}` or `~/.config/manicode*`
- Hermes Agent: `${HERMES_HOME:-~/.hermes}/state.db`
- Goose: local `sessions.db` roots or `GOOSE_PATH_ROOT`
- Kilo: `${KILO_DATA_DIR:-~/.local/share/kilo}/kilo.db`
- Kimi: `${KIMI_DATA_DIR:-~/.kimi}`
- OpenClaw: `~/.openclaw`, `~/.clawdbot`, `~/.moltbot`, `~/.moldbot`
- Qwen Code: `${QWEN_DATA_DIR:-~/.qwen}`
- GitHub Copilot CLI: `~/.copilot/otel/*.jsonl` or `COPILOT_OTEL_FILE_EXPORTER_PATH`
- Gemini CLI: `${GEMINI_DATA_DIR:-~/.gemini/tmp}`

## Install Pyro

```sh
curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/install.sh | bash
```

Burnfolio publishes pre-built `pyro` binaries for every release tag on GitHub:

- Linux: `amd64`, `arm64`
- macOS: `amd64`, `arm64`
- Windows: `amd64`, `arm64`

Release assets are available at
`https://github.com/nbitslabs/burnfolio/releases`.

The installer downloads the latest release binary, installs it to
`/usr/local/bin` or `~/.local/bin`, writes `~/.pyro/config.json`, and can
optionally run an immediate sync.
If you already have a Burnfolio machine token, you can either pass it with
`--profile` and `--machine` or let the interactive installer prompt for it.

For a new machine token from the dashboard, copy the generated one-liner:

```sh
curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/install.sh | bash -s -- --profile <account-number-or-username> --machine <machine-token>
```

The dashboard keeps a copy-ready install command on each machine row. Burnfolio
stores machine tokens hashed server-side and shows the full token only once,
at creation or rotation — the row action rotates the token (the previous
token stops working) and copies a fresh install command.

The installer asks whether to set up automatic sync with cron: `none`, `hourly`,
or `daily`. Cron sync output is logged to `~/.pyro/sync.log`. For non-interactive
setup, pass the schedule explicitly:

```sh
curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/install.sh | bash -s -- \
  --profile <account-number-or-username> \
  --machine <machine-token> \
  --schedule daily
```

Useful installer flags:

```sh
--profile <account-or-username>
--machine <machine-token>
--schedule <none|hourly|daily>
--providers amp,claude,codebuff,codex,copilot,droid,gemini,goose,hermes,kilo,kimi,openclaw,opencode,pi,qwen
--openrouter-key <management-key>
--openrouter-profile <account-or-org>
--openrouter-since 2020-01-01
--server https://burnfolio.ai
--install-dir ~/.local/bin
--version v0.1.2
```

Uninstall disables Burnfolio cron sync and marks the local install as
uninstalled in `~/.pyro/config.json`. It leaves the `.pyro` folder and saved
machine config in place so you can reinstall or inspect status later:

```sh
curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/uninstall.sh | bash
```

Useful uninstaller flags:

```sh
--profile <account-or-username>
--install-dir ~/.local/bin
--remove-binary
--keep-cron
--yes
```

## CLI Usage

Show local install state:

```sh
pyro status
```

Run a local summary and automatically sync when `~/.pyro/config.json` has an
active profile and machine token:

```sh
pyro
```

Useful CLI flags:

```sh
pyro --providers claude,codex,opencode,pi
pyro --json
pyro --no-sync
pyro --home /path/to/home
pyro --profile bf_ab12cd34 --machine bfm_...
pyro --profile bf_ab12cd34 --machine bfm_... --openrouter-key sk-or-v1-... --openrouter-profile bf_ab12cd34
pyro install --profile bf_ab12cd34 --machine bfm_...
pyro uninstall
```

The first time you sync with `--profile`/`--machine` outside of `pyro install`,
pyro prints a one-line notice that it saved those credentials to
`~/.pyro/config.json` so future runs sync automatically.

Build from source for local development:

```sh
make build
./bin/pyro

go install ./cmd/pyro
pyro
```

The table output is grouped by date, CLI, and model. JSON output includes
provider totals plus the same date/CLI/model segments for the server API.

When `--profile` and `--machine` are provided, the CLI uploads all local history to
Burnfolio as one idempotent total per day, broken down by CLI and model.
Re-running the same command replaces each machine/day row instead of
double-counting it. Only counts leave your machine — no prompts, code, or
transcripts are ever uploaded. Each synced day carries the date, a record
count, six token counters (input, cache read, cache write, output, reasoning,
total), and the same six counters split out per CLI and model.

Total token counts are `input + cache_read + cache_write + output`. Reasoning
tokens are reported separately but are informational only and never added
into the total, since providers already include them in the output count.
OpenRouter imports use the same definition.

## OpenRouter Usage

Burnfolio can import OpenRouter account usage from an OpenRouter management key.
Management keys are not inference keys, but they can read account analytics.

Local import keeps the OpenRouter key on your machine and uploads only daily
token totals:

```sh
pyro install \
  --profile <account-or-username> \
  --machine <machine-token> \
  --openrouter-key <openrouter-management-key> \
  --openrouter-profile <account-or-org>

pyro
```

You can also connect a management key in the Burnfolio dashboard for your
personal profile or from an organization management page. Server-side
connections are encrypted and fetched hourly.

OpenRouter data is stored separately from local machine inference data and is
deduplicated by target profile, OpenRouter key fingerprint, and day. If the same
key is synced from multiple machines or from both Pyro and the dashboard, the
same daily rows are updated instead of added twice.

## Hosted Flow

Create an anonymous account at `https://burnfolio.ai`. Signup returns an account
number, account key, machine token, and a ready-to-run sync command. Save the
account key: it is the private credential used with the public account number to
sign back in before adding an email or username.

Run the generated install + sync command locally:

```sh
curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/install.sh | bash -s -- --profile <account-number-or-username> --machine <machine-token>
```

From the dashboard you can claim a username, attach an optional email for magic
links, create personal or organization machine tokens, create the `nbitslabs`
org, and add users as members or admins. Public user and org pages expose the
same burn graph plus iframe and SVG embed snippets.

## Live Smoke Test

The smoke test creates throwaway timestamped accounts on the configured server
and verifies anonymous login, CLI sync, dedupe, multi-machine aggregation, org
rollup, and embed output.

```sh
scripts/smoke-live.sh
```

By default it uses `https://burnfolio.ai` and the `pi` collector to keep the
test lightweight. Override with `BURNFOLIO_SERVER` or
`BURNFOLIO_SMOKE_PROVIDERS` when needed.

For a real account acceptance pass, set the profile and machine token generated
by the dashboard:

```sh
BURNFOLIO_PROFILE=<account-or-username> \
BURNFOLIO_MACHINE=<machine-token> \
scripts/verify-account.sh
```

Optional checks can verify a fresh second machine and an org profile:

```sh
BURNFOLIO_PROFILE=<account-or-username> \
BURNFOLIO_MACHINE=<machine-token> \
BURNFOLIO_SECOND_MACHINE=<second-machine-token> \
BURNFOLIO_EXPECT_SECOND_INCREASE=1 \
BURNFOLIO_ORG=nbitslabs \
BURNFOLIO_EXPECT_ORG_MATCH=1 \
scripts/verify-account.sh
```

Profiles expose both iframe and SVG embeds:

```html
<script src="https://burnfolio.ai/embed/<profile>/script.js"></script>
<img src="https://burnfolio.ai/embed/<profile>.svg" alt="Burnfolio token burn graph">
```

See `examples/embed.html` for a complete third-party page template.

## Web UI Build

The Cloudflare Worker keeps its UI code in `worker/index.js` and its stylesheet
in `worker/styles.css`. Tailwind processes and minifies the stylesheet, then the
build step writes the deployable Worker to `dist/worker/index.js`.

```sh
npm install
npm run build:ui
```

`make deploy` runs the UI build before `wrangler deploy`, so production deploys
use the generated Worker bundle.
