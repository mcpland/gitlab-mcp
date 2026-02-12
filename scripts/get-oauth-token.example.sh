#!/usr/bin/env bash
set -euo pipefail

# Example external token script for GITLAB_TOKEN_SCRIPT.
# The MCP server accepts either:
# 1) Raw token on stdout
# 2) JSON: {"access_token":"..."} or {"token":"..."}

if [[ -n "${GITLAB_OAUTH_ACCESS_TOKEN:-}" ]]; then
  printf '{"access_token":"%s"}\n' "${GITLAB_OAUTH_ACCESS_TOKEN}"
  exit 0
fi

echo "GITLAB_OAUTH_ACCESS_TOKEN is not set" >&2
exit 1
