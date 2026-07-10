// botq dashboard UI — served over the iroh tunnel by `botq dash` (GET_UI), so it
// iterates with no GH-Pages redeploy. Default-export is the entry the bootstrap
// calls with a `conn` ({ subscribe, send }) and the mount element. `send(obj)` is a
// fire-and-forget owner→server write (no reply) — used for the detail view's two
// owner controls: send a message to the triage queue, and instruct a running worker.
// The detail view renders the job's MESSAGE THREAD (bothouse#162): log rows with
// kind==='message' — owner posts from this page, hub/gate inbox entries, delivery
// bounces — shown above the compose boxes so a reply is visible to the human.
//
// It subscribes to the job stream: the first frame is the full `{jobs:[…]}`
// snapshot, then each `{job_delta:<row>}` patches one row in place. Rows are kept
// in an id→row map. Two views over that map: a filtered card LIST and, when a card
// is tapped, a full-screen DETAIL overlay with every field + links to/from deps.
//
// XSS discipline: the page holds the auth token, and job fields (completion,
// result, verdict, type) are agent-authored. EVERYTHING is built from elements +
// textContent — never innerHTML — so no job-derived string can become markup.

const STATE_ORDER = {
  queued: 0, blocked: 1, deferred: 2, claimed: 3,
  verifying: 4, resolved: 5, dropped: 6,
};
const STATE_COLOR = {
  queued: '#9a9a9a', blocked: '#b07cc6', deferred: '#c9a227', claimed: '#4a90d9',
  verifying: '#c9a227', resolved: '#5ec27a', dropped: '#e0584e',
};

const fmtAge = (epoch) => {
  if (!epoch) return '';
  const age = Date.now() / 1000 - epoch;
  if (age < 60) return `${Math.floor(age)}s ago`;
  if (age < 3600) return `${Math.floor(age / 60)}m ago`;
  if (age < 86400) return `${Math.floor(age / 3600)}h ago`;
  return `${Math.floor(age / 86400)}d ago`;
};
const fmtAbs = (epoch) =>
  epoch ? new Date(epoch * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '';

const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of [].concat(children)) if (c != null) n.append(c);
  return n;
};

const STYLE = `
  #botq-bar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:2px 0 10px; }
  #botq-search { flex:1 1 160px; min-width:120px; background:#141416; color:#e6e6e6;
    border:1px solid #2a2a2e; border-radius:6px; padding:9px 9px; font:inherit; min-height:38px; }
  #botq-type { background:#141416; color:#e6e6e6; border:1px solid #2a2a2e;
    border-radius:6px; padding:9px; font:inherit; min-height:38px; max-width:46vw; }
  .botq-chip { cursor:pointer; user-select:none; border:1px solid #2a2a2e; border-radius:999px;
    display:inline-flex; align-items:center; gap:3px; min-height:34px;
    padding:6px 12px; font-size:12px; color:#cfcfcf; background:#141416; white-space:nowrap; }
  .botq-chip.active { border-color:#5a5; color:#fff; background:#18241a; }
  .botq-chip .ct { color:#8a8a8a; margin-left:4px; }
  #botq-count { color:#7a7a7a; font-size:12px; margin-left:auto; }
  .botq-list { display:flex; flex-direction:column; gap:6px; }
  .botq-empty { color:#7a7a7a; padding:24px 4px; text-align:center; }
  .botq-card { display:flex; gap:10px; align-items:flex-start; cursor:pointer; background:#141416;
    border:1px solid #1f1f23; border-radius:8px; padding:11px 12px; }
  .botq-card:hover { background:#1a1a1e; }
  .botq-card:active { background:#202026; }
  .botq-card .main { flex:1 1 auto; min-width:0; }
  .botq-card .head { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; }
  .botq-card .jid { font-weight:600; }
  .botq-card .ty { color:#9a9a9a; }
  .botq-card .completion { color:#b9b9b9; margin-top:3px; overflow:hidden; text-overflow:ellipsis;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .botq-card .side { text-align:right; white-space:nowrap; font-size:12px; color:#7a7a7a; flex:0 0 auto; }
  .st { font-weight:600; }
  .pri-beef { color:#d98c4a; } .pri-quick { color:#7a7a7a; } .mono-dim { color:#7a7a7a; }
  .verdict-rejected { color:#e0584e; } .verdict-accepted { color:#5ec27a; }
  /* detail overlay */
  .botq-detail { position:fixed; inset:0; background:#0b0b0c; overflow:auto;
    padding:max(env(safe-area-inset-top),12px) 14px calc(env(safe-area-inset-bottom) + 28px); z-index:10; }
  .botq-detail .bar { display:flex; gap:10px; align-items:center; margin:0 0 14px;
    position:sticky; top:0; background:#0b0b0c; padding:8px 0; }
  .botq-detail h2 { font-size:15px; margin:0; }
  .botq-detail dl { display:grid; grid-template-columns:max-content 1fr; gap:7px 14px; margin:0; max-width:820px; }
  .botq-detail dt { color:#8a8a8a; }
  .botq-detail dd { margin:0; color:#e6e6e6; word-break:break-word; white-space:pre-wrap; }
  .botq-detail dd.block { background:#141416; border:1px solid #1f1f23; border-radius:6px; padding:8px;
    max-height:46vh; overflow:auto; }
  .botq-detail dd.block summary { cursor:pointer; color:#9a9a9a; white-space:normal; }
  .botq-detail .links { display:flex; flex-wrap:wrap; gap:6px; }
  .dep-link { cursor:pointer; border:1px solid #2a2a2e; border-radius:6px; padding:7px 11px;
    display:inline-flex; align-items:center; min-height:36px;
    color:#7db3e6; background:#141416; font-size:13px; }
  .dep-link:hover { background:#1a1a1e; }
  .dep-missing { color:#7a7a7a; border-style:dashed; cursor:default; }
  .botq-detail button.primary { min-height:40px; }
  /* per-job log panel */
  .log-head { color:#8a8a8a; font-weight:600; margin:18px 0 8px; }
  .log-list { display:flex; flex-direction:column; gap:8px; max-width:820px; }
  .log-entry { background:#141416; border:1px solid #1f1f23; border-radius:6px; padding:8px 10px; }
  .log-meta { display:flex; gap:8px; align-items:center; color:#7a7a7a; font-size:11px; margin-bottom:4px; }
  .log-kind { color:#7db3e6; }
  .log-text { white-space:pre-wrap; word-break:break-word; color:#cfcfcf; margin:0; }
  .log-img { max-width:100%; height:auto; border-radius:4px; background:#fff; }
  /* message-thread entries (bothouse#162): the same card as a log row, accented so
     the conversation reads as a thread; sender identity lives in the content text */
  .msg-entry { border-left:3px solid #7db3e6; }
  /* owner→server control boxes (send to triage / instruct worker) */
  .ctl-head { color:#8a8a8a; font-weight:600; margin:18px 0 8px; }
  .ctl-box { display:flex; flex-direction:column; gap:7px; max-width:820px; margin-bottom:14px; }
  .ctl-box .label { color:#9a9a9a; font-size:12px; }
  .ctl-box textarea { width:100%; min-height:56px; resize:vertical; background:#141416; color:#e6e6e6;
    border:1px solid #2a2a2e; border-radius:6px; padding:9px; font:inherit; }
  .ctl-box .actions { display:flex; gap:8px; align-items:center; }
  .ctl-box button { background:#1d1d20; color:#e6e6e6; border:1px solid #34343a; border-radius:6px;
    padding:9px 13px; font:inherit; cursor:pointer; min-height:38px; }
  .ctl-box button:hover { background:#26262b; }
  .ctl-box button:disabled { opacity:.5; cursor:default; }
  .ctl-status { font-size:12px; color:#7a7a7a; }
  .ctl-status.ok { color:#5ec27a; } .ctl-status.err { color:#e0584e; }
  /* pluggable panels: operator-configured command output (HTML), each framed in a
     sandboxed iframe so it can't run script or disturb the dashboard's layout/JS */
  .botq-panels { display:flex; flex-direction:column; gap:8px; margin:0 0 12px; }
  .panel-box { border:1px solid #1f1f23; border-radius:8px; background:#0e0e10; overflow:hidden; }
  .panel-head { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; padding:8px 10px;
    background:#141416; border-bottom:1px solid #1f1f23; }
  .panel-name { font-weight:600; }
  .panel-meta { color:#7a7a7a; font-size:11px; }
  .panel-badge { color:#e0584e; font-size:11px; margin-left:auto; max-width:60vw;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .panel-frame { width:100%; border:0; height:160px; background:#0b0b0c; display:block; }
  .panel-err { color:#e0584e; padding:10px; white-space:pre-wrap; word-break:break-word; }
  @media (max-width:540px) {
    .botq-detail dl { grid-template-columns:1fr; gap:1px 0; }
    .botq-detail dt { margin-top:9px; }
  }
`;

export default async function mount(conn, root) {
  root.append(el('style', { textContent: STYLE }));

  // --- view state ---
  const jobs = new Map();
  const panels = new Map();     // name → latest panel render (operator-configured command HTML)
  let text = '';
  const stateSel = new Set();   // empty ⇒ all states
  let typeSel = '';             // '' ⇒ all types
  let openId = null;            // null ⇒ list; else the job id whose detail is shown
  let lastDetailSig = null;     // skip detail rebuilds (and scroll jumps) when unchanged
  // Owner control-box drafts, preserved across detail rebuilds so a live job's deltas
  // don't wipe half-typed input. Reset when the open job changes (`ctlForJob`).
  let ctlForJob = null;
  const ctlDraft = { send_triage: '', instruct: '' };
  // True while a control-box send is in flight. The render() guard skips detail
  // rebuilds during it: a delta arriving mid-`await conn.send` would otherwise
  // replaceChildren and detach the status/button nodes `submit()` writes to once the
  // await resolves (the textarea is already blurred by the click, so the typing-guard
  // alone doesn't cover this). The deferred delta lands on the next tick after.
  let ctlBusy = false;

  // --- filter bar ---
  const search = el('input', {
    id: 'botq-search', type: 'search', placeholder: 'filter id / type / completion…',
    autocomplete: 'off', spellcheck: false,
  });
  search.addEventListener('input', () => { text = search.value.trim().toLowerCase(); render(); });

  const typeFx = el('select', { id: 'botq-type' });
  typeFx.addEventListener('change', () => { typeSel = typeFx.value; render(); });

  const chips = el('div', { className: 'botq-chip-row', style: 'display:flex;flex-wrap:wrap;gap:6px;' });
  const count = el('span', { id: 'botq-count' });
  const bar = el('div', { id: 'botq-bar' }, [search, typeFx, chips, count]);

  // Pluggable panels region — above the filter bar so a status panel (e.g. quota) is
  // the first thing seen. Shown only in list view (hidden behind the detail overlay).
  const panelsRegion = el('div', { className: 'botq-panels', style: 'display:none' });

  const list = el('div', { className: 'botq-list' });
  const detail = el('div', { className: 'botq-detail', style: 'display:none' });
  root.append(panelsRegion, bar, list, detail);

  // --- helpers ---
  const matches = (j) => {
    if (stateSel.size && !stateSel.has(j.status)) return false;
    if (typeSel && j.type !== typeSel) return false;
    if (text) {
      const hay = `${j.id} ${j.type || ''} ${j.status || ''} ${j.priority || ''} ${j.model || ''} ${j.remediation || ''} ${j.completion || ''}`.toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  };
  const lastTouch = (j) => j.resolved_at || j.last_heartbeat || j.claimed_at || j.created_at || 0;
  const depsOf = (j) => (Array.isArray(j.depends_on) ? j.depends_on : []);
  const dependentsOf = (id) =>
    [...jobs.values()].filter((j) => depsOf(j).includes(id)).map((j) => j.id);
  const stateDot = (s) => el('span', { textContent: '●', style: `color:${STATE_COLOR[s] || '#9a9a9a'}` });

  // Detail is a history entry so Android's system Back closes it (instead of exiting
  // the PWA). Opening from the list pushes one entry; navigating detail→detail (dep
  // links) replaces it, so Back always returns to the list in one step. The back
  // button just pops; popstate is the single place that applies the resulting view.
  const open = (id) => {
    if (openId == null) history.pushState({ botqJob: id }, '');
    else history.replaceState({ botqJob: id }, '');
    openId = id; render();
  };
  const close = () => {
    if (openId != null && history.state && history.state.botqJob != null) history.back();
    else { openId = null; render(); }
  };
  window.addEventListener('popstate', (e) => {
    const id = e.state && e.state.botqJob;
    openId = (id != null && jobs.has(id)) ? id : null;
    render();
  });

  // Deep-link: `…/#/job/<N>` opens job N. A HASH route (not a path) because GH-Pages
  // has no server-side routing — the hash survives the bootstrap's auth + get_ui
  // untouched and needs no 404 fallback. Read the target once; apply it as soon as
  // that job is in the map (first snapshot, or a later delta), then stop. Read-only:
  // navigating the detail uses history state (above), not the hash, so we never write
  // it back — the hash is just the entry point the hub's link carries. `hashchange`
  // lets the owner retarget from the address bar within the same authed session.
  const hashJobId = () => {
    const m = /^#\/job\/(\d+)$/.exec(location.hash);
    return m ? Number(m[1]) : null;
  };
  let pendingDeepLink = hashJobId();
  const applyDeepLink = () => {
    if (pendingDeepLink != null && jobs.has(pendingDeepLink)) { open(pendingDeepLink); pendingDeepLink = null; }
  };
  window.addEventListener('hashchange', () => { pendingDeepLink = hashJobId(); applyDeepLink(); });

  // A clickable pill that jumps to job `id`'s detail (or shows it greyed if the row
  // isn't in view yet — e.g. a dep that hasn't streamed).
  const depLink = (id) => {
    if (!jobs.has(id)) return el('span', { className: 'dep-link dep-missing', textContent: `#${id}` });
    const j = jobs.get(id);
    const p = el('span', {
      className: 'dep-link', textContent: `#${id} ${j.type || ''}`.trim(),
      title: j.completion || '',
    });
    p.addEventListener('click', () => open(id));
    return p;
  };

  // --- list view ---
  const renderChips = () => {
    const counts = {};
    for (const j of jobs.values()) counts[j.status] = (counts[j.status] || 0) + 1;
    chips.replaceChildren();
    for (const s of Object.keys(STATE_ORDER)) {
      if (!counts[s]) continue;
      const c = el('span', { className: 'botq-chip' + (stateSel.has(s) ? ' active' : '') }, [
        stateDot(s), ` ${s}`, el('span', { className: 'ct', textContent: String(counts[s]) }),
      ]);
      c.addEventListener('click', () => {
        if (stateSel.has(s)) stateSel.delete(s); else stateSel.add(s);
        render();
      });
      chips.append(c);
    }
  };

  const renderTypeOptions = () => {
    const types = [...new Set([...jobs.values()].map((j) => j.type).filter(Boolean))].sort();
    if (!types.includes(typeSel)) typeSel = '';   // selected type vanished
    typeFx.replaceChildren(el('option', { value: '', textContent: 'all types' }));
    for (const t of types) typeFx.append(el('option', { value: t, textContent: t, selected: t === typeSel }));
    typeFx.value = typeSel;
  };

  const renderList = () => {
    const rows = [...jobs.values()].filter(matches).sort((a, b) => {
      const sa = STATE_ORDER[a.status] ?? 9, sb = STATE_ORDER[b.status] ?? 9;
      return sa !== sb ? sa - sb : b.id - a.id;
    });
    count.textContent = `${rows.length}/${jobs.size}`;
    list.replaceChildren();
    if (!rows.length) { list.append(el('div', { className: 'botq-empty', textContent: jobs.size ? 'no jobs match the filter' : 'waiting for jobs…' })); return; }
    for (const j of rows) {
      const verdictCls = typeof j.verdict === 'string' && j.verdict.startsWith('rejected') ? 'verdict-rejected'
        : j.verdict === 'accepted' ? 'verdict-accepted' : 'mono-dim';
      const card = el('div', { className: 'botq-card' }, [
        el('div', { className: 'main' }, [
          el('div', { className: 'head' }, [
            el('span', { className: 'jid', textContent: `#${j.id}` }),
            el('span', { className: 'ty', textContent: j.type || '' }),
            el('span', { className: 'st', style: `color:${STATE_COLOR[j.status] || '#e6e6e6'}`, textContent: j.status || '' }),
            el('span', { className: j.priority === 'beef' ? 'pri-beef' : 'pri-quick', textContent: j.priority || '' }),
            // Explicit model route (bothouse#132) — present ONLY on a routed job, so the
            // badge itself is the "this is not fable" marker (absent = fable default).
            j.model
              ? el('span', { style: 'color:#c792ea;font-weight:600;font-size:11px', textContent: j.model })
              : null,
            // An UNREMEDIATED drop (botq#remediation) gets a loud badge so it can't hide
            // in the list — it stays flagged until `botq remediate`, independent of any ack.
            j.remediation === 'unremediated'
              ? el('span', { style: 'color:#e0584e;font-weight:600;font-size:11px', textContent: '⚠ unremediated' })
              : null,
          ]),
          j.completion ? el('div', { className: 'completion', textContent: j.completion }) : null,
        ]),
        el('div', { className: 'side' }, [
          el('div', { textContent: fmtAge(lastTouch(j)) }),
          typeof j.verdict === 'string' ? el('div', { className: verdictCls, textContent: j.verdict.length > 22 ? j.verdict.slice(0, 21) + '…' : j.verdict }) : null,
        ]),
      ]);
      card.addEventListener('click', () => open(j.id));
      list.append(card);
    }
  };

  // --- detail view ---
  const row = (dl, label, value, opts = {}) => {
    if (value == null || value === '') return;
    dl.append(el('dt', { textContent: label }));
    dl.append(el('dd', Object.assign({ textContent: String(value) }, opts.block ? { className: 'block' } : {})));
  };
  const linkRow = (dl, label, ids) => {
    if (!ids || !ids.length) return;
    dl.append(el('dt', { textContent: label }));
    dl.append(el('dd', {}, el('div', { className: 'links' }, ids.map(depLink))));
  };

  // Render ONE log entry's content, SANDBOXED by kind. The content is agent-authored
  // and UNTRUSTED: `text` (and any unknown kind) goes through textContent (never parsed
  // as markup); `image`/`svg` go through an <img> — an <img>-loaded SVG cannot execute
  // script (non-interactive by spec), and a non-`data:image` URL or empty svg falls
  // back to escaped text, so no javascript:/http: src is ever honored. The page's CSP
  // (img-src 'self' data:) further blocks any external subresource fetch.
  const renderLogContent = (e) => {
    if (e.kind === 'image' && /^data:image\//i.test(e.content || '')) {
      return el('img', { className: 'log-img', src: e.content, loading: 'lazy', alt: 'log image' });
    }
    if (e.kind === 'svg' && typeof e.content === 'string' && e.content) {
      const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(e.content);
      return el('img', { className: 'log-img', src, loading: 'lazy', alt: 'log svg' });
    }
    return el('p', { className: 'log-text', textContent: e.content || '' });
  };
  const renderLogEntry = (e) => el('div', { className: 'log-entry' }, [
    el('div', { className: 'log-meta' }, [
      el('span', { textContent: fmtAge(e.created_at), title: fmtAbs(e.created_at) }),
      e.kind && e.kind !== 'text' ? el('span', { className: 'log-kind', textContent: e.kind }) : null,
    ]),
    renderLogContent(e),
  ]);
  // A thread message (kind==='message'): always text, sender label leads the content
  // ("📨 owner (dash) → …", "📨 hub → worker: …", "⛔ not delivered — …"), so no
  // kind badge — the accent border marks it as conversation.
  const renderMsgEntry = (e) => el('div', { className: 'log-entry msg-entry' }, [
    el('div', { className: 'log-meta' }, [
      el('span', { textContent: fmtAge(e.created_at), title: fmtAbs(e.created_at) }),
    ]),
    el('p', { className: 'log-text', textContent: e.content || '' }),
  ]);

  // One owner→server control box: a labelled textarea + a send button + a status line.
  // `op` is the write op (`send_triage` | `instruct`); the draft persists in `ctlDraft`
  // so a rebuild (a live delta) can't wipe in-progress input. `conn.send` is
  // fire-and-forget, so the button just reflects sent/failed — there's no reply to
  // await. On success the draft clears and the instruct's own job_log mirror will flow
  // back through the normal subscription.
  const controlBox = (j, op, label, placeholder, buttonText) => {
    const status = el('span', { className: 'ctl-status' });
    // Announce send/error to assistive tech, and (on a phone) keep the line live even
    // when it's below the fold after the keyboard dismisses.
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const ta = el('textarea', { placeholder, value: ctlDraft[op] || '', spellcheck: true });
    ta.addEventListener('input', () => { ctlDraft[op] = ta.value; });
    // NB: deliberately NO blur→render here. It looks tempting (apply a delta deferred by
    // the typing-guard the moment focus leaves), but blur fires on the mousedown that
    // begins a "send" CLICK — a synchronous render() would replaceChildren and detach
    // the very button mid-click (losing the click) and the status nodes submit() writes
    // to. The next subscription delta (a claimed job heartbeats often) or the 30s ticker
    // re-renders instead; the only residual is typing an instruct as the worker resolves,
    // which lands a harmless unconsumed inbox row.
    const btn = el('button', { textContent: buttonText });
    const submit = async () => {
      const text = ta.value.trim();
      if (!text) { status.textContent = 'nothing to send'; status.className = 'ctl-status err'; return; }
      btn.disabled = true; ctlBusy = true; status.textContent = 'sending…'; status.className = 'ctl-status';
      try {
        await conn.send({ op, job_id: j.id, text });
        status.textContent = 'sent ✓'; status.className = 'ctl-status ok';
        ta.value = ''; ctlDraft[op] = '';
      } catch (e) {
        status.textContent = `error: ${e && e.message ? e.message : e}`; status.className = 'ctl-status err';
      } finally { btn.disabled = false; ctlBusy = false; }
    };
    btn.addEventListener('click', submit);
    return el('div', { className: 'ctl-box' }, [
      el('div', { className: 'label', textContent: label }),
      ta,
      el('div', { className: 'actions' }, [btn, status]),
    ]);
  };

  const renderDetail = (j) => {
    // Capture the prompt <details> open state BEFORE replaceChildren discards it —
    // a live delta rebuild must not collapse a prompt the owner is reading. Reset
    // (like the drafts) when the open job changes.
    const promptOpen = ctlForJob === j.id && !!detail.querySelector('dd.block details')?.open;
    // Drafts are per-job: switching to a different job's detail starts fresh.
    if (ctlForJob !== j.id) { ctlDraft.send_triage = ''; ctlDraft.instruct = ''; ctlForJob = j.id; }
    const back = el('button', { className: 'primary', textContent: '‹ back' });
    back.addEventListener('click', close);
    const dl = el('dl');
    row(dl, 'id', `#${j.id}`);
    row(dl, 'type', j.type);
    row(dl, 'priority', j.priority);
    if (j.model) row(dl, 'model', `${j.model} (explicit route, bothouse#132)`);
    row(dl, 'status', j.status);
    // Remediation disposition (botq#remediation): present only on a hub-facing drop.
    // 'unremediated' = a drop still needing a root-cause+fix+requeue (run `botq
    // remediate`); 'remediated' shows the fix ref + requeue disposition + who.
    if (j.remediation === 'unremediated') {
      row(dl, 'remediation', 'UNREMEDIATED — needs `botq remediate`');
    } else if (j.remediation === 'remediated') {
      const parts = [j.remediation_fix, j.remediation_requeue, j.remediated_by && `by ${j.remediated_by}`]
        .filter(Boolean).join(' · ');
      row(dl, 'remediation', `remediated${parts ? ' — ' + parts : ''}`);
    }
    row(dl, 'verdict', typeof j.verdict === 'string' ? j.verdict : '');
    row(dl, 'completion', j.completion, { block: true });
    // The payload prompt — the job's full description (bddap/bothouse#151). Gated on
    // field PRESENCE, not truthiness: null/'' = a payload-invariant violation on a
    // current server (render the placeholder), absent = a pre-#151 server (render
    // nothing). Plain text via textContent per the XSS discipline; collapsed behind
    // <details> when long so the metadata grid stays scannable. The open state is
    // preserved across rebuilds via `promptOpen` (captured above) — same spirit as
    // the scrollTop preservation, else a heartbeat delta snaps it shut mid-read.
    if ('prompt' in j) {
      const text = j.prompt || '(payload has no prompt)';
      dl.append(el('dt', { textContent: 'prompt' }));
      const body = text.length > 500
        ? el('details', { open: promptOpen }, [
            // slice by code point (spread), not code unit, so an emoji straddling the
            // cut can't render as a lone surrogate; 241 units always cover 120 points.
            el('summary', { textContent: [...text.slice(0, 241)].slice(0, 120).join('').replace(/\s+/g, ' ') + '…' }),
            el('div', { textContent: text }),
          ])
        : el('span', { textContent: text });
      dl.append(el('dd', { className: 'block' }, body));
    }
    // Fork lineage: a thin prompt is self-explaining when the worker forked a
    // transcript (context rides the fork). Presence-gated like `prompt`.
    if ('fork_source' in j) row(dl, 'origin', j.fork_source ? `fork of ${j.fork_source}` : 'fresh');
    row(dl, 'result', j.result, { block: true });
    row(dl, 'tokens', j.tokens_spent ? j.tokens_spent.toLocaleString() : '');
    row(dl, 'claimed by', j.claimed_by);
    row(dl, 'session', j.session_id);
    linkRow(dl, 'depends on', depsOf(j));
    linkRow(dl, 'dependents', dependentsOf(j.id));
    for (const [label, key] of [['created', 'created_at'], ['claimed', 'claimed_at'], ['heartbeat', 'last_heartbeat'], ['resolved', 'resolved_at']]) {
      if (j[key]) row(dl, label, `${fmtAbs(j[key])}  (${fmtAge(j[key])})`);
    }
    const sections = [
      el('div', { className: 'bar' }, [back, el('h2', { textContent: `job #${j.id}` })]),
      dl,
    ];
    // Message THREAD (bothouse#162), then owner controls, then the ordinary log —
    // all ABOVE the log so they stay reachable on a phone without scrolling past a
    // long live tail. Thread entries are the kind==='message' log rows (keyed on
    // the kind tag — structure, not emoji matching): owner posts from this page,
    // hub/gate inbox entries, and delivery bounces, each echoing back through the
    // normal subscription the moment it lands — a reply is visible right here.
    const logs = Array.isArray(j.log) ? j.log : [];
    const msgs = logs.filter((e) => e.kind === 'message');
    const rest = logs.filter((e) => e.kind !== 'message');
    if (msgs.length) {
      sections.push(el('div', { className: 'log-head', textContent: `messages (${msgs.length})` }));
      sections.push(el('div', { className: 'log-list' }, msgs.map(renderMsgEntry)));
    }
    // Owner controls (owner→server writes, post-auth). A triage MESSAGE attaches to
    // any job (a note for the hub). An INSTRUCT only reaches a RUNNING worker (it
    // drains its inbox with `botq inbox` between steps), so it's offered only while
    // `claimed` (the literal mirrors `Status::Claimed.tag()` on the Rust side —
    // search there if the tag is renamed); the server bounces an instruct that
    // races a job going terminal, and the bounce shows up in the thread above.
    sections.push(el('div', { className: 'ctl-head', textContent: 'owner controls' }));
    sections.push(controlBox(j, 'send_triage', 'send a message to the triage queue',
      'a note for the hub about this job…', 'send to triage'));
    if (j.status === 'claimed') {
      sections.push(controlBox(j, 'instruct', 'instruct / redirect the running worker',
        'an instruction the worker will pick up between steps…', 'instruct worker'));
    } else {
      sections.push(el('div', { className: 'ctl-box' }, [
        el('div', { className: 'label', textContent: `instruct: unavailable (worker runs only while claimed; this job is ${j.status})` }),
      ]));
    }
    if (rest.length) {
      sections.push(el('div', { className: 'log-head', textContent: `log (${rest.length})` }));
      sections.push(el('div', { className: 'log-list' }, rest.map(renderLogEntry)));
    }
    detail.replaceChildren(...sections);
  };

  // --- pluggable panels ---
  // A panel's HTML is operator-authored (the command is configured by an owner with
  // full machine access), but we still frame it in a SANDBOXED iframe so it can neither
  // run script in the dashboard's origin (the page holds the auth token) nor disturb
  // the surrounding layout/JS. `sandbox="allow-same-origin"` WITHOUT `allow-scripts`:
  // no script can execute in the frame at all, so the same-origin grant is inert for
  // the child — it exists only so the PARENT may read the rendered document to auto-size
  // the frame to its content. This is the same "let the browser's sandbox enforce
  // isolation, never innerHTML untrusted-ish markup ourselves" approach the per-kind log
  // rendering uses (text→textContent, image/svg→<img>); HTML's right primitive is the
  // iframe. The page CSP (img-src 'self' data:) still applies inside the frame.
  const renderPanelBody = (p) => {
    if (p.error && !p.html) return el('div', { className: 'panel-err', textContent: p.error });
    const frame = el('iframe', { className: 'panel-frame', loading: 'lazy', title: p.name });
    frame.setAttribute('sandbox', 'allow-same-origin');     // set BEFORE srcdoc so it governs the load
    frame.srcdoc = p.html || '';
    frame.addEventListener('load', () => {
      try {
        const h = frame.contentWindow.document.body.scrollHeight;
        if (h) frame.style.height = Math.min(h + 4, 640) + 'px';   // fit content, capped (then scrolls)
      } catch { /* measurement blocked — keep the default height */ }
    });
    return frame;
  };
  const renderPanel = (p) => {
    const head = el('div', { className: 'panel-head' }, [
      el('span', { className: 'panel-name', textContent: p.name }),
      el('span', { className: 'panel-meta', textContent: p.ran_at ? `ran ${fmtAge(p.ran_at)}` : 'pending…' }),
    ]);
    if (p.error) head.append(el('span', { className: 'panel-badge', textContent: `⚠ ${p.error}`, title: p.error }));
    return el('div', { className: 'panel-box' }, [head, renderPanelBody(p)]);
  };
  // Visibility is gated by view (list only) AND non-emptiness, applied from both the
  // top-level render() and renderPanels() so either trigger keeps it correct.
  const applyPanelVisibility = () => {
    panelsRegion.style.display = (openId == null && panels.size) ? '' : 'none';
  };
  // Rebuild the whole region on any panel change. Panels update on their own (slow)
  // cadence, so the rare iframe reload is a non-issue; jobs deltas never call this.
  const renderPanels = () => {
    const rows = [...panels.values()].sort((a, b) => a.name.localeCompare(b.name));
    panelsRegion.replaceChildren(...rows.map(renderPanel));
    applyPanelVisibility();
  };

  // --- top-level render: pick a view, keep chrome current ---
  const render = () => {
    renderChips();
    renderTypeOptions();
    if (openId != null && jobs.has(openId)) {
      bar.style.display = list.style.display = 'none';
      detail.style.display = '';
      // Only rebuild when the open job's data actually changed, and preserve scroll
      // across the rebuild — otherwise a live job's deltas (or the 30s ticker) would
      // snap a phone reader back to the top mid-read.
      const j = jobs.get(openId);
      // Include dependents (a whole-map derivation, not part of `j`) so the detail
      // rebuilds when a NEW job starts depending on the open one.
      const sig = openId + ' ' + JSON.stringify(j) + ' deps:' + dependentsOf(openId).join(',');
      // Don't rebuild while the owner is typing in a control box — a rebuild replaces
      // the textarea node, dropping focus/caret mid-instruction. `lastDetailSig` stays
      // stale so the deferred delta is applied on the next render after they blur/submit
      // (drafts are preserved either way, but skipping also keeps focus).
      const typing = detail.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA';
      if (sig !== lastDetailSig && !typing && !ctlBusy) {
        const top = detail.scrollTop;
        renderDetail(j);
        detail.scrollTop = top;
        lastDetailSig = sig;
      }
    } else {
      if (openId != null && !jobs.has(openId)) openId = null;  // detail target gone
      lastDetailSig = null;
      detail.style.display = 'none';
      bar.style.display = ''; list.style.display = '';
      renderList();
    }
    applyPanelVisibility();   // panels show only in list view; keep that in sync with the view
  };

  // Re-render every 30s so the "Ns ago" stamps stay honest with no deltas.
  const ticker = setInterval(render, 30000);

  try {
    await conn.subscribe('jobs', (msg) => {
      // Jobs and panels share the one subscription (the protocol multiplexes a single
      // bi-stream). Job frames re-render the list; panel frames rebuild only the panels
      // region (no need to touch the job list) — see the server's `subscribe`.
      if (msg.jobs) { jobs.clear(); for (const j of msg.jobs) jobs.set(j.id, j); render(); applyDeepLink(); }
      else if (msg.job_delta) { jobs.set(msg.job_delta.id, msg.job_delta); render(); applyDeepLink(); }
      else if (msg.panels) { panels.clear(); for (const p of msg.panels) panels.set(p.name, p); renderPanels(); }
      else if (msg.panel_delta) { panels.set(msg.panel_delta.name, msg.panel_delta); renderPanels(); }
      else if (msg.panel_removed) { panels.delete(msg.panel_removed); renderPanels(); }
    });
  } catch (e) {
    clearInterval(ticker);
    root.append(el('div', {
      style: 'color:#e0584e;margin-top:10px',
      textContent: `subscription ended: ${e && e.message ? e.message : e}`,
    }));
  }
}
