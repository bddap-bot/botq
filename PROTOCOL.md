# botq dashboard protocol, version 0

The contract between this page and a `botq dash` endpoint. The page depends on
nothing else; any server that speaks this protocol can serve it.

## Token

`botq dash-token` prints base64url (no padding) of a JSON object:

| field         | required | meaning                                   |
|---------------|----------|-------------------------------------------|
| `endpoint_id` | yes      | the endpoint's iroh `EndpointId`          |
| `relay_url`   | no       | its iroh relay; discovered when absent    |
| `secret`      | yes      | the shared auth secret                    |

## Transport

An iroh connection to `endpoint_id` with ALPN `botq-dash/0`. The client opens one
bidirectional stream and sends every message on it. Each message is one frame: a
little-endian `u32` byte length, then that many bytes of UTF-8 JSON.

## Session

1. `{"auth": "<secret>"}` → `{"ok": true}`, or `{"ok": false}` and the session is
   over.
2. `{"op": "get_ui"}` → `{"ui_b64": "<base64url>"}`: the source of an ES module
   whose default export is `async (conn, root)`. The page imports it and calls it
   with `root`, a DOM element, and `conn`:
   - `conn.subscribe(kind, cb)` sends `{"op": "sub_<kind>"}` and calls `cb` with
     every frame the server sends from then on;
   - `conn.send(obj)` sends one frame and awaits no reply.

   `docs/ui/bundle.js` is the reference module.
3. `{"op": "sub_jobs"}`: the server replies with `{"jobs": [Job, …]}`, then pushes
   any of
   - `{"job_delta": Job}` — a job's full new state, keyed by `id`;
   - `{"panels": [Panel, …]}` — the full panel set;
   - `{"panel_delta": Panel}` — one panel's new state, keyed by `name`;
   - `{"panel_removed": "<name>"}`.

After `sub_jobs` the client sends only reply-free writes, `{"op": "send_triage" |
"instruct", "job_id": <int>, "text": "<string>"}`: a note filed to the queue's
triage inbox, or an instruction to the worker holding a `claimed` job.

## Job

Every field except `id` and `status` is optional.

| field | type | meaning |
|---|---|---|
| `id` | int | |
| `status` | string | `queued` `blocked` `deferred` `claimed` `verifying` `resolved` `dropped` |
| `type`, `model`, `claimed_by`, `session_id` | string | |
| `priority`, `tokens_spent` | int | |
| `prompt`, `completion`, `result`, `verdict` | string | the brief, its summary, the worker's result, the gate's verdict |
| `depends_on` | int[] | job ids |
| `fork_source` | int or string | the session this job forked; empty when fresh |
| `created_at`, `claimed_at`, `last_heartbeat`, `resolved_at` | epoch seconds | |
| `remediation` | string | `unremediated` or `remediated`, for a failed job |
| `remediation_fix`, `remediation_requeue`, `remediated_by` | string | how it was remediated |
| `log` | LogEntry[] | |

A LogEntry is `{"kind", "content", "created_at"}`: `kind` `message` is a note sent
to the job, `image` a `data:image/…` URL, `svg` SVG source, anything else text.

## Panel

`{"name", "html", "ran_at", "error"}`: a named HTML fragment the server renders
periodically, `ran_at` in epoch seconds, `error` set when the last run failed.
