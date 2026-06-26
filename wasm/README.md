# botq-dash-wasm

The browser (wasm32) iroh client for the botq dashboard. Built output ships in
[`../docs`](../docs) (`botq_dash_wasm.js` + `botq_dash_wasm_bg.wasm`), which GitHub
Pages serves; the `index.html` bootstrap imports it to dial the native `botq dash`
endpoint over iroh and run the dashboard UI.

Exports (`src/lib.rs`): `init`, `connect(ticket)`, `send(bytes)` (request→response),
`recv()` (one pushed frame), and `send_only(bytes)` (fire-and-forget owner→server
write — used while subscribed for `send_triage` / `instruct`, since it awaits no reply
and so can't race the subscription's recv loop).

## Rebuild

```
nix-shell shell.nix --run ./build.sh
```

This compiles for `wasm32-unknown-unknown`, runs `wasm-bindgen --target web`, and
copies the result into `../docs`. The `shell.nix` shellHook bakes in the two build
gotchas (force `CC=clang`; `NIX_HARDENING_ENABLE=""` to drop a hardening flag clang
rejects for wasm) — see its header comment.

The wasm-bindgen-cli version (nixpkgs pin) MUST match the `wasm-bindgen` crate version
(`=0.2.121` in `Cargo.toml`), or the glue and module disagree at load.
