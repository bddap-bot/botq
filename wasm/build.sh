#!/usr/bin/env bash
# Rebuild the dashboard wasm client and refresh the shipped artifacts in ../docs.
# Run from inside `nix-shell shell.nix` (the shellHook sets the CC/hardening env the
# ring build needs). Idempotent: same source ⇒ same bytes the dashboard serves.
set -euo pipefail
cd "$(dirname "$0")"

cargo build --release --target wasm32-unknown-unknown

# wasm-bindgen glue for the browser (`--target web`): emits pkg/botq_dash_wasm.js +
# pkg/botq_dash_wasm_bg.wasm. We ship the bindgen output directly — cargo's
# opt-level="z" + lto already minimize it, and a wasm-opt pass measured LARGER, so
# there's no opt step in the shipped path.
wasm-bindgen --target web --out-dir pkg \
  target/wasm32-unknown-unknown/release/botq_dash_wasm.wasm

cp pkg/botq_dash_wasm.js pkg/botq_dash_wasm_bg.wasm ../docs/
echo "refreshed ../docs/botq_dash_wasm.{js,wasm}"
