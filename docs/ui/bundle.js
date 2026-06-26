// botq dashboard UI — served over the iroh tunnel by `botq dash` (GET_UI), so it
// iterates with no GH-Pages redeploy. Default-export is the entry the bootstrap
// calls with a `conn` ({ subscribe }) and the mount element.
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
  .botq-detail .links { display:flex; flex-wrap:wrap; gap:6px; }
  .dep-link { cursor:pointer; border:1px solid #2a2a2e; border-radius:6px; padding:7px 11px;
    display:inline-flex; align-items:center; min-height:36px;
    color:#7db3e6; background:#141416; font-size:13px; }
  .dep-link:hover { background:#1a1a1e; }
  .dep-missing { color:#7a7a7a; border-style:dashed; cursor:default; }
  .botq-detail button.primary { min-height:40px; }
  @media (max-width:540px) {
    .botq-detail dl { grid-template-columns:1fr; gap:1px 0; }
    .botq-detail dt { margin-top:9px; }
  }
`;

export default async function mount(conn, root) {
  root.append(el('style', { textContent: STYLE }));

  // --- view state ---
  const jobs = new Map();
  let text = '';
  const stateSel = new Set();   // empty ⇒ all states
  let typeSel = '';             // '' ⇒ all types
  let openId = null;            // null ⇒ list; else the job id whose detail is shown
  let lastDetailSig = null;     // skip detail rebuilds (and scroll jumps) when unchanged

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

  const list = el('div', { className: 'botq-list' });
  const detail = el('div', { className: 'botq-detail', style: 'display:none' });
  root.append(bar, list, detail);

  // --- helpers ---
  const matches = (j) => {
    if (stateSel.size && !stateSel.has(j.status)) return false;
    if (typeSel && j.type !== typeSel) return false;
    if (text) {
      const hay = `${j.id} ${j.type || ''} ${j.status || ''} ${j.priority || ''} ${j.completion || ''}`.toLowerCase();
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

  const renderDetail = (j) => {
    const back = el('button', { className: 'primary', textContent: '‹ back' });
    back.addEventListener('click', close);
    const dl = el('dl');
    row(dl, 'id', `#${j.id}`);
    row(dl, 'type', j.type);
    row(dl, 'priority', j.priority);
    row(dl, 'status', j.status);
    row(dl, 'verdict', typeof j.verdict === 'string' ? j.verdict : '');
    row(dl, 'completion', j.completion, { block: true });
    row(dl, 'result', j.result, { block: true });
    row(dl, 'tokens', j.tokens_spent ? j.tokens_spent.toLocaleString() : '');
    row(dl, 'claimed by', j.claimed_by);
    row(dl, 'session', j.session_id);
    linkRow(dl, 'depends on', depsOf(j));
    linkRow(dl, 'dependents', dependentsOf(j.id));
    for (const [label, key] of [['created', 'created_at'], ['claimed', 'claimed_at'], ['heartbeat', 'last_heartbeat'], ['resolved', 'resolved_at']]) {
      if (j[key]) row(dl, label, `${fmtAbs(j[key])}  (${fmtAge(j[key])})`);
    }
    detail.replaceChildren(
      el('div', { className: 'bar' }, [back, el('h2', { textContent: `job #${j.id}` })]),
      dl,
    );
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
      if (sig !== lastDetailSig) {
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
  };

  // Re-render every 30s so the "Ns ago" stamps stay honest with no deltas.
  const ticker = setInterval(render, 30000);

  try {
    await conn.subscribe('jobs', (msg) => {
      if (msg.jobs) { jobs.clear(); for (const j of msg.jobs) jobs.set(j.id, j); }
      else if (msg.job_delta) jobs.set(msg.job_delta.id, msg.job_delta);
      render();
    });
  } catch (e) {
    clearInterval(ticker);
    root.append(el('div', {
      style: 'color:#e0584e;margin-top:10px',
      textContent: `subscription ended: ${e && e.message ? e.message : e}`,
    }));
  }
}
