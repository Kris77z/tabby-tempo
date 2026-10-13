#!/usr/bin/env bash
set -euo pipefail
mode="${1:-}"
[[ "$mode" == gateway || "$mode" == runtime || "$mode" == frontend ]] || exit 64
response_file=$(mktemp)
trap 'rm -- "$response_file"' EXIT
deadline=$((SECONDS + 300))
while ((SECONDS < deadline)); do
  if [[ "$mode" == gateway ]]; then
    if curl --fail --silent --max-time 2 http://127.0.0.1:3437/health --output "$response_file" \
      && jq -e '.ready == true and (.models | sort) == ["kimi-k2.6", "kimi-k3"]' "$response_file" >/dev/null \
      && curl --fail --silent --max-time 2 http://127.0.0.1:3436/v1/models --output "$response_file" \
      && jq -e '([.data[].id] | sort) == ["cheap/kimi-k2.6", "strong/kimi-k3"]' "$response_file" >/dev/null; then
      exit 0
    fi
  elif [[ "$mode" == runtime ]]; then
    status=$(curl --silent --max-time 2 --output "$response_file" --write-out '%{http_code}' http://127.0.0.1:8794/agents || true)
    if [[ "$status" == 401 ]] && jq -e '.error == "HOSTED_AUTH_REQUIRED"' "$response_file" >/dev/null; then exit 0; fi
  else
    status=$(curl --silent --max-time 2 --output "$response_file" --write-out '%{http_code}' \
      -H 'Host: tempo.tabbyai.xyz' -H 'X-Forwarded-Host: tempo.tabbyai.xyz' -H 'X-Forwarded-Proto: https' \
      http://127.0.0.1:3028/api/hosted/agents || true)
    if [[ "$status" == 401 ]] && jq -e '.error == "HOSTED_AUTH_REQUIRED"' "$response_file" >/dev/null; then exit 0; fi
  fi
  sleep 1
done
printf 'Readiness timed out: %s\n' "$mode" >&2
exit 1
