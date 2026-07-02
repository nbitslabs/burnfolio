#!/usr/bin/env bash
set -euo pipefail

repo="nbitslabs/burnfolio"
version="latest"
install_dir="${PYRO_INSTALL_DIR:-}"
profile=""
machine=""
server="${BURNFOLIO_SERVER:-https://burnfolio.ai}"
providers="amp,claude,codebuff,codex,copilot,droid,gemini,goose,hermes,kilo,kimi,openclaw,opencode,pi,qwen"
openrouter_key=""
openrouter_profile=""
openrouter_since="2020-01-01"
schedule=""
run_sync=1

usage() {
  cat <<'EOF'
Burnfolio pyro installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/install.sh | bash

Options:
  --profile <account-or-username>   Burnfolio profile to sync to.
  --machine <machine-token>         Burnfolio machine token.
                                    If omitted in an interactive shell, the installer can prompt for existing values.
  --schedule <none|hourly|daily>    Configure a cron sync schedule non-interactively.
  --server <url>                    Burnfolio server URL. Defaults to https://burnfolio.ai.
  --providers <list>                Providers to scan. Defaults to all supported sources.
  --openrouter-key <key>            OpenRouter management key for local usage import.
  --openrouter-profile <profile>    Burnfolio profile or org for OpenRouter usage. Defaults to --profile.
  --openrouter-since <date>         First OpenRouter usage date to import. Defaults to 2020-01-01.
  --install-dir <dir>               Install directory. Defaults to /usr/local/bin or ~/.local/bin.
  --version <tag|latest>            Release tag to install. Defaults to latest.
  --no-run                          Install/configure only; do not run an immediate sync.
  -h, --help                        Show this help.
EOF
}

die() {
  echo "pyro install: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      profile="${2:-}"; shift 2 ;;
    --profile=*)
      profile="${1#*=}"; shift ;;
    --machine)
      machine="${2:-}"; shift 2 ;;
    --machine=*)
      machine="${1#*=}"; shift ;;
    --schedule)
      schedule="${2:-}"; shift 2 ;;
    --schedule=*)
      schedule="${1#*=}"; shift ;;
    --server)
      server="${2:-}"; shift 2 ;;
    --server=*)
      server="${1#*=}"; shift ;;
    --providers)
      providers="${2:-}"; shift 2 ;;
    --providers=*)
      providers="${1#*=}"; shift ;;
    --openrouter-key)
      openrouter_key="${2:-}"; shift 2 ;;
    --openrouter-key=*)
      openrouter_key="${1#*=}"; shift ;;
    --openrouter-profile)
      openrouter_profile="${2:-}"; shift 2 ;;
    --openrouter-profile=*)
      openrouter_profile="${1#*=}"; shift ;;
    --openrouter-since)
      openrouter_since="${2:-}"; shift 2 ;;
    --openrouter-since=*)
      openrouter_since="${1#*=}"; shift ;;
    --install-dir)
      install_dir="${2:-}"; shift 2 ;;
    --install-dir=*)
      install_dir="${1#*=}"; shift ;;
    --version)
      version="${2:-}"; shift 2 ;;
    --version=*)
      version="${1#*=}"; shift ;;
    --no-run)
      run_sync=0; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      die "unknown option: $1" ;;
  esac
done

case "$schedule" in
  ""|none|hourly|daily) ;;
  *) die "--schedule must be one of: none, hourly, daily" ;;
esac

if [ -n "$profile" ] && [ -z "$machine" ] && [ ! -r /dev/tty ]; then
  die "--profile without --machine requires an interactive shell"
fi
if [ -z "$profile" ] && [ -n "$machine" ] && [ ! -r /dev/tty ]; then
  die "--machine without --profile requires an interactive shell"
fi
if [ -z "$profile" ] && [ -n "$schedule" ] && [ "$schedule" != "none" ]; then
  die "--schedule requires --profile and --machine"
fi
if [ -n "$openrouter_key" ] && [ -z "$profile" ] && [ ! -r /dev/tty ]; then
  die "--openrouter-key requires --profile and --machine"
fi

need curl
need tar
need uname
need mktemp

shell_quote() {
  local value="$1"
  printf "'%s'" "$(printf "%s" "$value" | sed "s/'/'\\\\''/g")"
}

prompt_schedule() {
  if [ ! -r /dev/tty ]; then
    echo "none"
    return
  fi
  while true; do
    printf "\nSet up automatic sync with cron? [none/hourly/daily] " > /dev/tty
    IFS= read -r answer < /dev/tty || answer="none"
    answer="${answer:-none}"
    case "$answer" in
      none|hourly|daily)
        echo "$answer"
        return ;;
      n|no)
        echo "none"
        return ;;
      h)
        echo "hourly"
        return ;;
      d)
        echo "daily"
        return ;;
      *)
        echo "Choose none, hourly, or daily." > /dev/tty ;;
    esac
  done
}

prompt_existing_token() {
  if [ ! -r /dev/tty ]; then
    return
  fi
  if [ -z "$profile" ] && [ -z "$machine" ]; then
    printf "\nConfigure an existing Burnfolio machine token now? [y/N] " > /dev/tty
    IFS= read -r answer < /dev/tty || answer=""
    case "$answer" in
      y|Y|yes|YES) ;;
      *) return ;;
    esac
  fi

  if [ -z "$profile" ]; then
    printf "Profile account number or username: " > /dev/tty
    IFS= read -r profile < /dev/tty || profile=""
  fi
  if [ -z "$machine" ]; then
    printf "Machine token: " > /dev/tty
    IFS= read -rs machine < /dev/tty || machine=""
    printf "\n" > /dev/tty
  fi

  if [ -z "$profile" ] || [ -z "$machine" ]; then
    profile=""
    machine=""
    echo "Skipping Burnfolio sync setup because profile or machine token was empty." > /dev/tty
  fi
}

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m | tr '[:upper:]' '[:lower:]')"
case "$os" in
  linux) os="linux" ;;
  darwin) os="darwin" ;;
  *) die "unsupported OS for this installer: $os. Download a release binary from https://github.com/${repo}/releases" ;;
esac
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) die "unsupported architecture: $arch" ;;
esac

if [ -z "$install_dir" ]; then
  if [ -w "/usr/local/bin" ]; then
    install_dir="/usr/local/bin"
  else
    install_dir="${HOME}/.local/bin"
  fi
fi

if [ "$version" = "latest" ]; then
  version="$(
    curl -fsSL "https://api.github.com/repos/${repo}/releases/latest" |
      sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
      head -n 1
  )"
  [ -n "$version" ] || die "could not determine latest release"
fi

asset="pyro_${version}_${os}_${arch}.tar.gz"
url="https://github.com/${repo}/releases/download/${version}/${asset}"
checksums_url="https://github.com/${repo}/releases/download/${version}/checksums.txt"
tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

echo "Installing pyro ${version} for ${os}/${arch}"
curl -fL "$url" -o "${tmp}/${asset}"
curl -fL "$checksums_url" -o "${tmp}/checksums.txt"
expected="$(awk -v asset="$asset" '$2 == asset { print $1 }' "${tmp}/checksums.txt" | head -n 1)"
[ -n "$expected" ] || die "checksum for ${asset} not found in release"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${tmp}/${asset}" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "${tmp}/${asset}" | awk '{ print $1 }')"
else
  die "missing required command: sha256sum or shasum"
fi
[ "$actual" = "$expected" ] || die "checksum verification failed for ${asset}"
tar -xzf "${tmp}/${asset}" -C "$tmp"

mkdir -p "$install_dir"
if [ -w "$install_dir" ]; then
  cp "${tmp}/pyro" "${install_dir}/pyro"
  chmod 0755 "${install_dir}/pyro"
else
  need sudo
  sudo mkdir -p "$install_dir"
  sudo cp "${tmp}/pyro" "${install_dir}/pyro"
  sudo chmod 0755 "${install_dir}/pyro"
fi

pyro_path="${install_dir}/pyro"
echo "Installed ${pyro_path}"
if ! command -v pyro >/dev/null 2>&1 && ! printf '%s' ":$PATH:" | grep -q ":${install_dir}:"; then
  echo "Note: ${install_dir} is not on PATH. Add it or run ${pyro_path} directly."
fi

if [ -z "$profile" ] || [ -z "$machine" ]; then
  prompt_existing_token
fi
if [ -n "$openrouter_key" ] && [ -z "$openrouter_profile" ]; then
  openrouter_profile="$profile"
fi

if [ -n "$profile" ] && [ -z "$schedule" ]; then
  schedule="$(prompt_schedule)"
fi

install_args=(install --providers "$providers" --server "$server" --install-dir "$install_dir")
if [ -n "$profile" ]; then
  install_args+=(--profile "$profile" --machine "$machine")
fi
if [ -n "$openrouter_key" ]; then
  install_args+=(--openrouter-key "$openrouter_key" --openrouter-profile "$openrouter_profile" --openrouter-since "$openrouter_since")
fi
if [ -n "$schedule" ]; then
  install_args+=(--schedule "$schedule")
fi
"$pyro_path" "${install_args[@]}"

if [ "$run_sync" = "1" ]; then
  echo "Running initial sync..."
  if [ -n "$profile" ]; then
    sync_args=(--providers "$providers" --server "$server" --profile "$profile" --machine "$machine")
    if [ -n "$openrouter_key" ]; then
      sync_args+=(--openrouter-key "$openrouter_key" --openrouter-profile "$openrouter_profile" --openrouter-since "$openrouter_since")
    fi
    "$pyro_path" "${sync_args[@]}"
  else
    "$pyro_path"
  fi
fi

if [ -n "$profile" ] && [ "$schedule" != "" ] && [ "$schedule" != "none" ]; then
  need crontab
  case "$schedule" in
    hourly) cron_time="17 * * * *" ;;
    daily) cron_time="17 3 * * *" ;;
  esac
  cron_marker="# burnfolio-pyro ${profile}"
  mkdir -p "${HOME}/.pyro"
  sync_cmd="$(shell_quote "$pyro_path") --providers $(shell_quote "$providers") --server $(shell_quote "$server") --profile $(shell_quote "$profile") --machine $(shell_quote "$machine")"
  cron_line="${cron_time} ${sync_cmd} >>$(shell_quote "${HOME}/.pyro/sync.log") 2>&1 ${cron_marker}"
  cron_err_file="$(mktemp)"
  cron_read_status=0
  existing_cron="$(crontab -l 2>"$cron_err_file")" || cron_read_status=$?
  cron_read_err="$(cat "$cron_err_file" 2>/dev/null || true)"
  rm -f "$cron_err_file"
  if [ "$cron_read_status" -ne 0 ] && ! printf '%s' "$cron_read_err" | grep -qi 'no crontab for'; then
    echo "Warning: could not read existing crontab; skipping cron setup. Re-run install to retry." >&2
  else
    current="$(printf '%s\n' "$existing_cron" | grep -vF "$cron_marker" || true)"
    printf '%s\n%s\n' "$current" "$cron_line" | sed '/^$/d' | crontab -
    echo "Installed ${schedule} cron sync for ${profile}."
  fi
fi

echo "Done."
