# Burnfolio

Burnfolio collects local AI coding-agent usage data and summarizes token burn by UTC
date, CLI type, and model.

Current collectors:

- Claude: `~/.claude`
- Codex: `~/.codex/sessions`
- OpenCode: `~/.config/opencode`
- Pi: `~/.pi/agent/sessions`

## Usage

```sh
go run ./cmd/pyro
```

Useful flags:

```sh
go run ./cmd/pyro -providers claude,codex
go run ./cmd/pyro -json
go run ./cmd/pyro -home /path/to/home
```

The table output is grouped by UTC date, CLI, and model. JSON output includes
provider totals plus the same date/CLI/model segments for the future server API.
