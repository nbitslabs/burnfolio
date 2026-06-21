#!/usr/bin/env bash
set -euo pipefail

BASE="${BURNFOLIO_SERVER:-https://burnfolio.ai}"
PROVIDERS="${BURNFOLIO_SMOKE_PROVIDERS:-pi}"
STAMP="$(date +%s)"
HANDLE="smoke${STAMP}"
TAKEN_HANDLE="${HANDLE}taken"
ORG="smokeorg${STAMP}"
TMPDIR="${TMPDIR:-/tmp}"
COOKIE="${TMPDIR}/burnfolio-smoke-${STAMP}.cookies"
COOKIE2="${TMPDIR}/burnfolio-smoke-${STAMP}.second.cookies"
SIGNUP="${TMPDIR}/burnfolio-smoke-${STAMP}.signup.json"
SIGNUP2="${TMPDIR}/burnfolio-smoke-${STAMP}.signup2.json"
MACHINE2="${TMPDIR}/burnfolio-smoke-${STAMP}.machine2.json"
LOGIN="${TMPDIR}/burnfolio-smoke-${STAMP}.login.json"
CONFLICT="${TMPDIR}/burnfolio-smoke-${STAMP}.conflict.json"
EMBED_DEMO="${TMPDIR}/burnfolio-smoke-${STAMP}.embed.html"

if [ ! -x ./bin/pyro ]; then
  make build >/dev/null
fi

echo "base=${BASE}"
echo "handle=${HANDLE}"

curl -fsS -c "${COOKIE}" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"${HANDLE}\",\"machine_name\":\"smoke one\"}" \
  "${BASE}/api/signup" >"${SIGNUP}"

ACCOUNT="$(jq -r '.account.account_number' "${SIGNUP}")"
ACCOUNT_KEY="$(jq -r '.account_key' "${SIGNUP}")"
TOKEN1="$(jq -r '.machine.token' "${SIGNUP}")"

if [ "${#ACCOUNT}" -lt 16 ]; then
  echo "account number is too short: ${ACCOUNT}" >&2
  exit 1
fi
if [ "${#ACCOUNT_KEY}" -lt 32 ]; then
  echo "account key is too short" >&2
  exit 1
fi

curl -fsS -b "${COOKIE}" -c "${COOKIE}" -X POST "${BASE}/api/logout" >/dev/null
curl -fsS -c "${COOKIE}" \
  -H 'content-type: application/json' \
  -d "{\"account_number\":\"${ACCOUNT}\",\"account_key\":\"${ACCOUNT_KEY}\"}" \
  "${BASE}/api/account-login" >"${LOGIN}"

jq -e --arg account "${ACCOUNT}" '.account.account_number == $account' "${LOGIN}" >/dev/null

curl -fsS -c "${COOKIE2}" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"${TAKEN_HANDLE}\",\"machine_name\":\"smoke taken\"}" \
  "${BASE}/api/signup" >"${SIGNUP2}"

CONFLICT_STATUS="$(curl -sS -o "${CONFLICT}" -w "%{http_code}" -b "${COOKIE}" \
  -H 'content-type: application/json' \
  -d "{\"handle\":\"${TAKEN_HANDLE}\"}" \
  "${BASE}/api/handles")"
if [ "${CONFLICT_STATUS}" != "409" ]; then
  echo "handle conflict returned ${CONFLICT_STATUS}, want 409" >&2
  cat "${CONFLICT}" >&2
  exit 1
fi
curl -fsS "${BASE}/${HANDLE}" >/dev/null

curl -fsS -b "${COOKIE}" \
  -H 'content-type: application/json' \
  -d '{"name":"smoke two"}' \
  "${BASE}/api/machines" >"${MACHINE2}"

TOKEN2="$(jq -r '.machine.token' "${MACHINE2}")"

./bin/pyro -providers "${PROVIDERS}" -profile "${HANDLE}" -machine "${TOKEN1}" -server "${BASE}" >/dev/null
TOTAL_ONE="$(curl -fsS "${BASE}/api/profiles/${HANDLE}/stats" | jq -r '.total_tokens')"
if [ "${TOTAL_ONE}" -le 0 ]; then
  echo "first sync did not increase total" >&2
  exit 1
fi

./bin/pyro -providers "${PROVIDERS}" -profile "${HANDLE}" -machine "${TOKEN1}" -server "${BASE}" >/dev/null
TOTAL_DEDUPED="$(curl -fsS "${BASE}/api/profiles/${HANDLE}/stats" | jq -r '.total_tokens')"
if [ "${TOTAL_DEDUPED}" != "${TOTAL_ONE}" ]; then
  echo "dedupe failed: ${TOTAL_ONE} -> ${TOTAL_DEDUPED}" >&2
  exit 1
fi

./bin/pyro -providers "${PROVIDERS}" -profile "${HANDLE}" -machine "${TOKEN2}" -server "${BASE}" >/dev/null
TOTAL_TWO="$(curl -fsS "${BASE}/api/profiles/${HANDLE}/stats" | jq -r '.total_tokens')"
EXPECTED_TWO="$(( TOTAL_ONE * 2 ))"
if [ "${TOTAL_TWO}" != "${EXPECTED_TWO}" ]; then
  echo "multi-machine aggregate failed: expected ${EXPECTED_TWO}, got ${TOTAL_TWO}" >&2
  exit 1
fi

curl -fsS -b "${COOKIE}" \
  -H 'content-type: application/json' \
  -d "{\"handle\":\"${ORG}\",\"name\":\"Smoke Org\"}" \
  "${BASE}/api/orgs" >/dev/null

ORG_TOTAL="$(curl -fsS "${BASE}/api/profiles/${ORG}/stats" | jq -r '.total_tokens')"
if [ "${ORG_TOTAL}" != "${TOTAL_TWO}" ]; then
  echo "org rollup failed: expected ${TOTAL_TWO}, got ${ORG_TOTAL}" >&2
  exit 1
fi

SCRIPT_BODY="$(curl -fsS "${BASE}/embed/${ORG}/script.js")"
SVG_BODY="$(curl -fsS "${BASE}/embed/${ORG}.svg")"
case "${SCRIPT_BODY}" in
  *"<iframe"*) ;;
  *) echo "iframe embed script did not include iframe" >&2; exit 1 ;;
esac
case "${SVG_BODY}" in
  *"<svg"*) ;;
  *) echo "svg embed did not include svg root" >&2; exit 1 ;;
esac

sed -e "s|BURNFOLIO_ORIGIN|${BASE}|g" -e "s|YOUR_PROFILE|${ORG}|g" \
  examples/embed.html >"${EMBED_DEMO}"
grep -q "${BASE}/embed/${ORG}/script.js" "${EMBED_DEMO}"
grep -q "${BASE}/embed/${ORG}.svg" "${EMBED_DEMO}"

cat <<EOF
ok=true
account=${ACCOUNT}
handle=${HANDLE}
org=${ORG}
first_machine_total=${TOTAL_ONE}
two_machine_total=${TOTAL_TWO}
EOF
