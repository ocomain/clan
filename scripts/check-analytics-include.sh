#!/usr/bin/env bash
# scripts/check-analytics-include.sh
#
# Fails (exit 1) if any public *.html page lacks the shared analytics
# loader include:
#   <script defer src="/js/analytics-deferred.js" ...></script>
#
# Excluded on purpose:
#   members/admin/*   admin tools are never tracked
#   email-*           email templates / previews, not web pages
#   node_modules/     third-party code
#
# Usage: bash scripts/check-analytics-include.sh   (from the repo root)

set -euo pipefail
cd "$(dirname "$0")/.."

missing=0
total=0
while IFS= read -r -d '' f; do
  total=$((total + 1))
  if ! grep -Eq '<script[^>]*src="/js/analytics-deferred\.js"' "$f"; then
    echo "MISSING analytics include: ${f#./}"
    missing=$((missing + 1))
  fi
done < <(find . -type f -name '*.html' \
  -not -path './node_modules/*' \
  -not -path '*/node_modules/*' \
  -not -path './.git/*' \
  -not -path './members/admin/*' \
  -not -path './email-*' \
  -not -path '*/email-*' \
  -print0)

if [ "$missing" -gt 0 ]; then
  echo "FAIL: $missing of $total pages lack /js/analytics-deferred.js"
  exit 1
fi
echo "OK: all $total pages include /js/analytics-deferred.js"
