#!/usr/bin/env bash
set -euo pipefail

BASE="${BURNFOLIO_SERVER:-https://burnfolio.ai}"
PROFILE="${BURNFOLIO_PROFILE:-}"
MACHINE="${BURNFOLIO_MACHINE:-}"
SECOND_MACHINE="${BURNFOLIO_SECOND_MACHINE:-}"
ORG="${BURNFOLIO_ORG:-}"
PROVIDERS="${BURNFOLIO_PROVIDERS:-amp,claude,codebuff,codex,copilot,droid,gemini,goose,hermes,kilo,kimi,openclaw,opencode,pi,qwen}"
EXPECT_SECOND_INCREASE="${BURNFOLIO_EXPECT_SECOND_INCREASE:-0}"
EXPECT_ORG_MATCH="${BURNFOLIO_EXPECT_ORG_MATCH:-0}"
TMPDIR="${TMPDIR:-/tmp}"
STAMP="$(date +%s)"
PROFILE_HTML="${TMPDIR}/burnfolio-verify-${STAMP}.profile.html"
EMBED_DEMO="${TMPDIR}/burnfolio-verify-${STAMP}.embed.html"

if [ -z "${PROFILE}" ] || [ -z "${MACHINE}" ]; then
  echo "set BURNFOLIO_PROFILE and BURNFOLIO_MACHINE" >&2
  exit 2
fi

if [ ! -x ./bin/pyro ]; then
  make build >/dev/null
fi

profile_total() {
  curl -fsS "${BASE}/api/profiles/$1/stats" | jq -r '.total_tokens'
}

echo "base=${BASE}"
echo "profile=${PROFILE}"
echo "providers=${PROVIDERS}"

./bin/pyro --providers "${PROVIDERS}" --profile "${PROFILE}" --machine "${MACHINE}" --server "${BASE}" >/dev/null
TOTAL_ONE="$(profile_total "${PROFILE}")"
if [ "${TOTAL_ONE}" -le 0 ]; then
  echo "first sync did not produce a positive public total" >&2
  exit 1
fi

./bin/pyro --providers "${PROVIDERS}" --profile "${PROFILE}" --machine "${MACHINE}" --server "${BASE}" >/dev/null
TOTAL_DEDUPED="$(profile_total "${PROFILE}")"
if [ "${TOTAL_DEDUPED}" != "${TOTAL_ONE}" ]; then
  echo "dedupe failed: ${TOTAL_ONE} -> ${TOTAL_DEDUPED}" >&2
  exit 1
fi

curl -fsS "${BASE}/${PROFILE}" >"${PROFILE_HTML}"
grep -q "Token burn graph" "${PROFILE_HTML}"

SCRIPT_BODY="$(curl -fsS "${BASE}/embed/${PROFILE}/script.js")"
SVG_BODY="$(curl -fsS "${BASE}/embed/${PROFILE}.svg")"
case "${SCRIPT_BODY}" in
  *"<iframe"*) ;;
  *) echo "iframe embed script did not include iframe" >&2; exit 1 ;;
esac
case "${SVG_BODY}" in
  *"<svg"*) ;;
  *) echo "svg embed did not include svg root" >&2; exit 1 ;;
esac

sed -e "s|BURNFOLIO_ORIGIN|${BASE}|g" -e "s|YOUR_PROFILE|${PROFILE}|g" \
  examples/embed.html >"${EMBED_DEMO}"
grep -q "${BASE}/embed/${PROFILE}/script.js" "${EMBED_DEMO}"
grep -q "${BASE}/embed/${PROFILE}.svg" "${EMBED_DEMO}"

if [ -n "${SECOND_MACHINE}" ]; then
  ./bin/pyro --providers "${PROVIDERS}" --profile "${PROFILE}" --machine "${SECOND_MACHINE}" --server "${BASE}" >/dev/null
  TOTAL_TWO="$(profile_total "${PROFILE}")"
  if [ "${TOTAL_TWO}" -lt "${TOTAL_DEDUPED}" ]; then
    echo "second machine lowered profile total: ${TOTAL_DEDUPED} -> ${TOTAL_TWO}" >&2
    exit 1
  fi
  if [ "${EXPECT_SECOND_INCREASE}" = "1" ] && [ "${TOTAL_TWO}" -le "${TOTAL_DEDUPED}" ]; then
    echo "second machine did not increase profile total: ${TOTAL_DEDUPED} -> ${TOTAL_TWO}" >&2
    exit 1
  fi
else
  TOTAL_TWO="${TOTAL_DEDUPED}"
fi

if [ -n "${ORG}" ]; then
  ORG_TOTAL="$(profile_total "${ORG}")"
  curl -fsS "${BASE}/${ORG}" >/dev/null
  if [ "${EXPECT_ORG_MATCH}" = "1" ] && [ "${ORG_TOTAL}" != "${TOTAL_TWO}" ]; then
    echo "org total did not match profile total: ${ORG_TOTAL} != ${TOTAL_TWO}" >&2
    exit 1
  fi
else
  ORG_TOTAL=""
fi

cat <<EOF
ok=true
profile=${PROFILE}
total_after_first_sync=${TOTAL_ONE}
total_after_dedupe=${TOTAL_DEDUPED}
total_after_second_machine=${TOTAL_TWO}
org=${ORG}
org_total=${ORG_TOTAL}
EOF
