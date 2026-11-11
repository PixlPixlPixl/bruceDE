#!/usr/bin/env sh
# Thin wrapper: reports what is installed, built and up to date.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$root/scripts/icebox.mjs" status "$@"
