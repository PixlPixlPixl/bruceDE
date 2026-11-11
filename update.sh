#!/usr/bin/env sh
# Thin wrapper: every step and its up-to-date checks live in scripts/icebox.mjs.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$root/scripts/icebox.mjs" update "$@"
