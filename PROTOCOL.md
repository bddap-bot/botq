# botq dashboard protocol, version 0

The contract between this page and a `botq dash` endpoint. Any server that speaks
it can serve the page.

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

   The endpoint packages the UI module with its server release. This bootstrap
   has no separate dashboard implementation. Each connection selects one
   subscription; switching subscriptions requires reconnecting.
3. Select `sub_jobs` or `sub_history` (described below).

### Queue subscription

`{"op": "sub_jobs"}`: the server replies with `{"jobs": [Job, …]}`, then pushes
   any of
   - `{"job_delta": Job}` — a job's full new state, keyed by `id`;
   - `{"panels": [Panel, …]}` — the full panel set;
   - `{"panel_delta": Panel}` — one panel's new state, keyed by `name`;
   - `{"panel_removed": "<name>"}`.

After `sub_jobs` the client sends only reply-free writes, `{"op": "send_triage" |
"instruct", "job_id": <int>, "text": "<string>"}`: a note about the job for
whoever triages the queue, or an instruction to the agent running a `claimed`
job.

### History subscription

`{"op":"sub_history"}` sends a full snapshot immediately, then checks every
five seconds and sends another full snapshot only when its serialized contents
change. The initial range is the 24 hours ending at subscription time; it does
not advance automatically.

```json
{"history":{"range":{"start":1790395200,"end":1790420400},"rows":[],"truncated":false}}
```

While subscribed, `conn.send({op: 'history_range', start, end})` selects a new
range and causes a fresh snapshot, even if unchanged. Bounds are integer Unix
seconds: `start >= 0`, `end > start`, and at most 31 days apart. Invalid JSON,
operations, or ranges return `{"error":"<message>"}` without changing the range
or ending the subscription. History control frames exceeding 1024 bytes close
the stream. Queue instructions are not supported on this subscription.

Rows are ordered by claim time (enqueue time when absent), then id. At most
10,000 rows are returned; `truncated: true` means narrow the range. Rows include
queue wait overlapping the window and can have execution outside the window;
clients clip plotted intervals and keep missing claims in a table.

| row field | type | meaning |
|---|---|---|
| `id` | int | job id |
| `issue` | string or null | validated `owner/repository#number` issue key |
| `class` | string | job type |
| `enqueued` | epoch seconds | creation time |
| `claimed` | epoch seconds or null | latest recorded claim; earlier attempts are unavailable |
| `ended` | epoch seconds or null | recorded or estimated end; null for live runs or unavailable end times |
| `end_kind` | string | `live`, `resolved`, or `estimated` |
| `verdict` | string | `accepted`, `failed`, `dropped`, `cancelled`, `running`, or `unknown` |
| `ram_cap_mb` | int or null | execution cap; currently null because it was not recorded |
| `ram_reserved_mb` | int or null | maximum reservation sampled for this claim |
| `ram_peak_mb` | int or null | recorded job peak memory |

For non-live rows, the end uses resolution time, then the last heartbeat, gate
evaluation time, or claim time, in that order. An absent resolution time is
marked estimated. History projects existing ledger metadata only: no payload,
instruction, result text, log content, or verdict details are sent.

## Job

Every field except `id` and `status` is optional.

| field | type | meaning |
|---|---|---|
| `id` | int | |
| `status` | string | `queued` `blocked` `deferred` `claimed` `verifying` `resolved` `dropped` |
| `type`, `model`, `claimed_by`, `session_id` | string | |
| `priority` | string or int | `beef` is highlighted |
| `tokens_spent` | int | |
| `prompt`, `completion`, `result`, `verdict` | string | the task, a one-line summary, the worker's report, the acceptance check's verdict |
| `depends_on` | int[] | job ids |
| `fork_source` | int or string | what this job's session forked from; empty when fresh |
| `created_at`, `claimed_at`, `last_heartbeat`, `resolved_at` | epoch seconds | |
| `remediation` | string | `unremediated` or `remediated` |
| `remediation_fix`, `remediation_requeue`, `remediated_by` | string | how it was remediated |
| `log` | LogEntry[] | |

A LogEntry is `{"kind", "content", "created_at"}`: `kind` `message` is a note sent
to the job, `image` a `data:image/…` URL, `svg` SVG source, anything else text.

## Panel

`{"name", "html", "ran_at", "error"}`: a named HTML fragment the server renders
periodically, `ran_at` in epoch seconds, `error` set when the last run failed.
