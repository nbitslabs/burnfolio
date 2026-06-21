# Burnfolio

Burnfolio collects local AI coding-agent usage data and summarizes token burn by UTC
date, CLI type, and model.

The hosted app runs on Cloudflare Workers at `https://burnfolio.ai`, with D1 for
storage and Cloudflare Email Service for optional magic-link sign-in.

Current collectors:

- Claude: `~/.claude`
- Codex: `~/.codex/sessions`
- OpenCode: `~/.config/opencode`
- Pi: `~/.pi/agent/sessions`

## Usage

```sh
go run ./cmd/pyro
```

Build or install the local CLI:

```sh
make build
./bin/pyro

go install ./cmd/pyro
pyro
```

Useful flags:

```sh
pyro --providers claude,codex
pyro --json
pyro --home /path/to/home
pyro --profile bf_ab12cd34 --machine bfm_...
```

The table output is grouped by UTC date, CLI, and model. JSON output includes
provider totals plus the same date/CLI/model segments for the future server API.

When `--profile` and `--machine` are provided, the CLI uploads all local history to
Burnfolio as one idempotent total per UTC day. Re-running the same command
replaces each machine/day row instead of double-counting it.

## Hosted Flow

Create an anonymous account at `https://burnfolio.ai`. Signup returns an account
number, account key, machine token, and a ready-to-run sync command. Save the
account key: it is the private credential used with the public account number to
sign back in before adding an email or username.

Run the generated command locally:

```sh
pyro --profile <account-number-or-username> --machine <machine-token>
```

From the dashboard you can claim a username, attach an optional email for magic
links, create more machine tokens, create the `nbitslabs` org, and add users as
members or admins. Public user and org pages expose the same burn graph plus
iframe and SVG embed snippets.

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
