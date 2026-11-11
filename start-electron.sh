#!/usr/bin/env sh
# Thin wrapper: installs/builds only what is missing, then runs `theia start`.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$root/scripts/icebox.mjs" start electron "$@"
