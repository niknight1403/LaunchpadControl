#!/usr/bin/env bash
# The one command CI runs and you should run before pushing.
#
#   tools/ci/check.sh
#
# Needs: node 20+, typescript + esbuild (npm install), g++ 12+.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "── type check (strict, RN shims) ─────────────────────────────"
npx tsc -p tools/ci/tsconfig.json

echo "── logic tests (TypeScript) ──────────────────────────────────"
mkdir -p .tmp
npx esbuild scripts/selftest.ts --bundle --platform=node --format=cjs --outfile=.tmp/selftest.cjs > /dev/null
node .tmp/selftest.cjs

echo "── core tests (C++, host compiled) ───────────────────────────"
g++ -std=c++20 -O2 -Wall -Wextra -Wno-unused-parameter -Iandroid/app/src/main/cpp \
  android/app/src/main/cpp/tests/core_selftest.cpp -o /tmp/auragrid_core_selftest
/tmp/auragrid_core_selftest

echo
echo "all checks green"
