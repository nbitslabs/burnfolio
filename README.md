# Burnfolio

Burnfolio collects local AI coding-agent usage data and summarizes token burn by
date, CLI type, and model.

The hosted app runs on Cloudflare Workers at `https://burnfolio.ai`, with D1 for
storage and Cloudflare Email Service for optional magic-link sign-in.

Current collectors:

- Claude: `~/.claude`
- Codex: `~/.codex/sessions`
- OpenCode: `~/.config/opencode`
- Pi: `~/.pi/agent/sessions`

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
`/usr/local/bin` or `~/.local/bin`, and can optionally run an immediate sync.
If you already have a Burnfolio machine token, you can either pass it with
`--profile` and `--machine` or let the interactive installer prompt for it.

For a new machine token from the dashboard, copy the generated one-liner:

```sh
curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/install.sh | bash -s -- --profile <account-number-or-username> --machine <machine-token>
```

The dashboard keeps a copy-ready install command on each machine row. For older
machines where Burnfolio only has the token hash, the row action creates a
replacement token and copies a complete install command.

The installer asks whether to set up automatic sync with cron: `none`, `hourly`,
or `daily`. For non-interactive setup, pass the schedule explicitly:

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
--providers claude,codex,opencode,pi
--server https://burnfolio.ai
--install-dir ~/.local/bin
--version v0.1.0
```

Uninstall pyro and remove Burnfolio cron sync entries:

```sh
curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/uninstall.sh | bash
```

Useful uninstaller flags:

```sh
--profile <account-or-username>
--install-dir ~/.local/bin
--keep-binary
--keep-cron
--yes
```

## CLI Usage

Run a local summary without syncing:

```sh
pyro
```

Useful CLI flags:

```sh
pyro --providers claude,codex
pyro --json
pyro --home /path/to/home
pyro --profile bf_ab12cd34 --machine bfm_...
```

Build from source for local development:

```sh
make build
./bin/pyro

go install ./cmd/pyro
pyro
```

The table output is grouped by date, CLI, and model. JSON output includes
provider totals plus the same date/CLI/model segments for the future server API.

When `--profile` and `--machine` are provided, the CLI uploads all local history to
Burnfolio as one idempotent total per day. Re-running the same command
replaces each machine/day row instead of double-counting it.

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
