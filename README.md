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
pyro -providers claude,codex
pyro -json
pyro -home /path/to/home
pyro -profile bf_ab12cd34 -machine bfm_...
```

The table output is grouped by UTC date, CLI, and model. JSON output includes
provider totals plus the same date/CLI/model segments for the future server API.

When `-profile` and `-machine` are provided, the CLI uploads all local history to
Burnfolio as one idempotent total per UTC day. Re-running the same command
replaces each machine/day row instead of double-counting it.
