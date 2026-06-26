# botq dashboard

A live, mobile-friendly view of the [botq](https://github.com/bddap/bothouse) job
queue — served not from a server but straight off the machine running the queue,
over an end-to-end-encrypted [iroh](https://iroh.computer) tunnel.

This repo (GitHub Pages, served from `docs/`) is only a **thin, stable bootstrap**:
it loads a small wasm iroh client, dials the `botq dash` endpoint by its public
key, authenticates with a shared secret, and pulls the *actual* dashboard UI down
the tunnel. So the UI iterates on the machine — improving the dashboard never means
touching this page. Everything past the page load is encrypted to the exact node in
your token: no server, no CA, no DNS to trust (the GitHub Pages TLS is the only
classical trust root, and only for this one static page).

## Use it

1. On the machine running botq: `botq dash` (the long-lived endpoint) and
   `botq dash-token` (prints your token — it embeds the node's public key, its
   relay, and the auth secret; treat it like a password).
2. Open the Pages URL, paste the token, **Connect**. The token is saved locally so a
   reload reconnects; **Forget token** clears it.
3. On a phone: open the URL, paste, then **Add to Home Screen** for an app-like
   launcher (PWA — no service worker in v1).

The page shows every job with its id, type, state, priority, completion brief,
tokens, timestamps, and gate verdict, updating live as the queue moves.
