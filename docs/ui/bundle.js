// botq dashboard UI — served over the iroh tunnel by `botq dash` (GET_UI), so it
// iterates with no GH-Pages redeploy. Default-export is the entry the bootstrap
// calls with a `conn` ({ request, subscribe }) and the mount element.
//
// It subscribes to the job stream: the first frame is the full `{jobs:[…]}`
// snapshot, then each `{job_delta:<row>}` patches one row in place. Rows are kept
// in an id→row map and the table is re-rendered on every change.

// Keyed by botq's `Status::tag()` values (the closed enum the server emits). An
// unknown status still renders — it just sorts last and uses the fallback color.
const STATE_ORDER = {
  queued: 0, blocked: 1, deferred: 2, claimed: 3,
  verifying: 4, resolved: 5, dropped: 6,
};
const STATE_COLOR = {
  queued: '#9a9a9a', blocked: '#b07cc6', deferred: '#c9a227', claimed: '#4a90d9',
  verifying: '#c9a227', resolved: '#5ec27a', dropped: '#e0584e',
};

const fmtTime = (epoch) => {
  if (!epoch) return '';
  const d = new Date(epoch * 1000);
  const now = Date.now() / 1000;
  const age = now - epoch;
  if (age < 60) return `${Math.floor(age)}s ago`;
  if (age < 3600) return `${Math.floor(age / 60)}m ago`;
  if (age < 86400) return `${Math.floor(age / 3600)}h ago`;
  return d.toISOString().slice(0, 16).replace('T', ' ');
};

const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of [].concat(children)) n.append(c);
  return n;
};

export default async function mount(conn, root) {
  root.append(el('style', { textContent: `
    #botq-summary { color: #9a9a9a; font-size: 12px; margin: 4px 0 10px; }
    #botq-summary b { color: #e6e6e6; }
    table.botq { border-collapse: collapse; width: 100%; font-size: 13px; }
    table.botq th, table.botq td {
      text-align: left; padding: 5px 8px; border-bottom: 1px solid #1f1f23;
      white-space: nowrap; vertical-align: top;
    }
    table.botq th { color: #8a8a8a; font-weight: 600; position: sticky; top: 0; background: #0b0b0c; }
    table.botq td.wrap { white-space: normal; max-width: 360px; color: #b9b9b9; }
    table.botq tr:hover td { background: #141416; }
    .st { font-weight: 600; }
    .pri-beef { color: #d98c4a; }
    .mono-dim { color: #7a7a7a; }
    .verdict-rejected { color: #e0584e; }
    .verdict-accepted { color: #5ec27a; }
  ` }));

  const summary = el('div', { id: 'botq-summary' });
  const tbody = el('tbody');
  const table = el('table', { className: 'botq' }, [
    el('thead', {}, el('tr', {}, [
      'id', 'type', 'state', 'pri', 'completion', 'tokens', 'created', 'updated', 'verdict',
    ].map((h) => el('th', { textContent: h })))),
    tbody,
  ]);
  root.append(summary, table);

  const jobs = new Map();

  const lastTouch = (j) =>
    j.resolved_at || j.last_heartbeat || j.claimed_at || j.created_at || 0;

  const render = () => {
    const rows = [...jobs.values()].sort((a, b) => {
      // Active work first (by state), then newest id.
      const sa = STATE_ORDER[a.status] ?? 9;
      const sb = STATE_ORDER[b.status] ?? 9;
      if (sa !== sb) return sa - sb;
      return b.id - a.id;
    });

    const counts = {};
    for (const j of jobs.values()) counts[j.status] = (counts[j.status] || 0) + 1;
    const order = Object.keys(STATE_ORDER).filter((s) => counts[s]);
    // Built from elements + textContent (never innerHTML) so no job-derived string
    // can ever become markup — the page holds the auth token, so the summary keeps
    // the same XSS-proof discipline as the table below.
    summary.textContent = '';
    summary.append(el('span', {}, [el('b', { textContent: String(jobs.size) }), ' jobs   ']));
    for (const s of order) {
      const dot = el('span', { textContent: '●', style: `color:${STATE_COLOR[s] || '#9a9a9a'}` });
      summary.append(el('span', {}, [dot, ` ${s} `, el('b', { textContent: String(counts[s]) }), '   ']));
    }

    tbody.replaceChildren();
    for (const j of rows) {
      const verdictCls =
        typeof j.verdict === 'string' && j.verdict.startsWith('rejected') ? 'verdict-rejected'
        : j.verdict === 'accepted' ? 'verdict-accepted' : '';
      tbody.append(el('tr', {}, [
        el('td', { textContent: j.id }),
        el('td', { textContent: j.type || '' }),
        el('td', {}, el('span', {
          className: 'st', textContent: j.status,
          style: `color:${STATE_COLOR[j.status] || '#e6e6e6'}`,
        })),
        el('td', { className: j.priority === 'beef' ? 'pri-beef' : 'mono-dim', textContent: j.priority || '' }),
        el('td', { className: 'wrap', textContent: j.completion || '' }),
        el('td', { className: 'mono-dim', textContent: j.tokens_spent ? j.tokens_spent.toLocaleString() : '' }),
        el('td', { className: 'mono-dim', textContent: fmtTime(j.created_at), title: j.created_at ? new Date(j.created_at * 1000).toISOString() : '' }),
        el('td', { className: 'mono-dim', textContent: fmtTime(lastTouch(j)) }),
        el('td', { className: verdictCls, textContent: typeof j.verdict === 'string' ? j.verdict : '' }),
      ]));
    }
  };

  // Re-render timestamps every 30s even with no deltas, so "Ns ago" stays honest.
  const ticker = setInterval(render, 30000);

  try {
    await conn.subscribe('jobs', (msg) => {
      if (msg.jobs) {
        jobs.clear();
        for (const j of msg.jobs) jobs.set(j.id, j);
      } else if (msg.job_delta) {
        jobs.set(msg.job_delta.id, msg.job_delta);
      }
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
