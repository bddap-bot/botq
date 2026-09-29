# Dev shell for botq-dash-wasm — the browser (wasm32) iroh client whose bindgen
# output ships in ../docs (botq_dash_wasm.js + botq_dash_wasm_bg.wasm).
#
# Pinned nixpkgs + oxalica rust-overlay for a rust toolchain that includes
# the wasm32-unknown-unknown std and a matching wasm-bindgen-cli (=0.2.121, which the
# Cargo.toml pins wasm-bindgen to). clang_multi: iroh's tls-ring dep compiles `ring`,
# whose C sources must be built FOR wasm32 — that needs a 32-bit-capable clang (per n0
# wasm troubleshooting discussion #3200).
#
# Two build gotchas the shellHook handles so a build is turnkey (both bit us once):
#   - stdenv sets CC to the gcc cc-wrapper; ring's build.rs would then compile its C
#     for the HOST, leaking x86 .o files into the wasm rlib ("neither Wasm object file
#     nor LLVM bitcode" link errors). Force CC=clang.
#   - the nix cc-wrapper injects `-fzero-call-used-regs=used-gpr` (a hardening flag)
#     which clang rejects for the wasm32 target. NIX_HARDENING_ENABLE="" drops it.
let
  rustOverlay = import (builtins.fetchTarball {
    url = "https://github.com/oxalica/rust-overlay/archive/49b6548d31019e8bfe9d4415193ac1df3c48f53a.tar.gz";
    sha256 = "19rs2qj207sgnz8k60ll2hvxyc7mwmghqpmx6s1r8z30mh6zj3iw";
  });
  nixpkgs = builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/e2587caef70cea85dd97d7daab492899902dbf5d.tar.gz";
    sha256 = "14jrgz4z2m8n1c8qwcla44kdy9kd7x0xnwfyrajnyvnhkxbnnqf1";
  };
  pkgs = import nixpkgs { overlays = [ rustOverlay ]; };
  rust = pkgs.rust-bin.stable.latest.default.override {
    targets = [ "wasm32-unknown-unknown" ];
  };
in
pkgs.mkShell {
  buildInputs = [
    rust
    pkgs.wasm-bindgen-cli   # 0.2.121 in this pin — Cargo.toml pins wasm-bindgen to match
    pkgs.binaryen           # wasm-opt (optional; the bindgen output already ships as-is)
    pkgs.clang_multi        # 32-bit-capable clang for ring's build.rs
    pkgs.pkg-config
  ];
  shellHook = ''
    export CC=clang
    export CC_wasm32_unknown_unknown=clang
    export NIX_HARDENING_ENABLE=""
  '';
}
