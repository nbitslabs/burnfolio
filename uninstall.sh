#!/usr/bin/env bash
set -euo pipefail

install_dir="${PYRO_INSTALL_DIR:-}"
profile=""
keep_binary=0
keep_cron=0
yes=0

usage() {
  cat <<'EOF'
Burnfolio pyro uninstaller

Usage:
  curl -fsSL https://raw.githubusercontent.com/nbitslabs/burnfolio/main/uninstall.sh | bash

Options:
  --install-dir <dir>  Directory containing pyro. Defaults to /usr/local/bin, ~/.local/bin, then PATH.
  --profile <profile>  Remove cron entries only for this profile.
  --keep-binary        Leave the pyro binary installed.
  --keep-cron          Leave Burnfolio cron entries installed.
  -y, --yes            Do not prompt before uninstalling.
  -h, --help           Show this help.
EOF
}

die() {
  echo "pyro uninstall: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      install_dir="${2:-}"; shift 2 ;;
    --install-dir=*)
      install_dir="${1#*=}"; shift ;;
    --profile)
      profile="${2:-}"; shift 2 ;;
    --profile=*)
      profile="${1#*=}"; shift ;;
    --keep-binary)
      keep_binary=1; shift ;;
    --keep-cron)
      keep_cron=1; shift ;;
    -y|--yes)
      yes=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      die "unknown option: $1" ;;
  esac
done

if [ "$yes" != "1" ] && [ -r /dev/tty ]; then
  printf "Remove pyro and Burnfolio cron sync entries? [y/N] " > /dev/tty
  IFS= read -r answer < /dev/tty || answer=""
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Cancelled."; exit 0 ;;
  esac
fi

if [ "$keep_cron" != "1" ] && command -v crontab >/dev/null 2>&1; then
  if [ -n "$profile" ]; then
    marker="# burnfolio-pyro ${profile}"
    current="$(crontab -l 2>/dev/null | grep -vF "$marker" || true)"
  else
    current="$(crontab -l 2>/dev/null | grep -v '# burnfolio-pyro ' || true)"
  fi
  printf '%s\n' "$current" | sed '/^$/d' | crontab -
  echo "Removed Burnfolio cron sync entries."
fi

if [ "$keep_binary" != "1" ]; then
  candidates=()
  if [ -n "$install_dir" ]; then
    candidates+=("${install_dir}/pyro")
  else
    candidates+=("/usr/local/bin/pyro" "${HOME}/.local/bin/pyro")
    if command -v pyro >/dev/null 2>&1; then
      candidates+=("$(command -v pyro)")
    fi
  fi

  removed=0
  for path in "${candidates[@]}"; do
    [ -n "$path" ] || continue
    [ -e "$path" ] || continue
    if [ -w "$(dirname "$path")" ]; then
      rm -f "$path"
    else
      command -v sudo >/dev/null 2>&1 || die "need sudo to remove ${path}"
      sudo rm -f "$path"
    fi
    echo "Removed ${path}."
    removed=1
  done
  [ "$removed" = "1" ] || echo "No pyro binary found."
fi

echo "Done."
