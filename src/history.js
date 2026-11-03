// Append-only history, written only when the board digest actually changes.
// One entry per transition: {ts, date, dest, dep, stops, dur, seats, allin}.
// This is what keeps us inside KV's 1,000 writes/day budget: a quiet board
// produces exactly one write per sweep, and zero history rows.

const HISTORY_CAP = 4000;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function digestRows(rows) {
  const canon = rows
    .slice()
    .sort((a, b) => (a.date + a.dest + a.dep).localeCompare(b.date + b.dest + b.dep))
    .map((r) => [r.date, r.dest, r.dep, r.stops, r.dur, r.seats, r.allin].join('|'))
    .join(';');
  return fnv1a(canon);
}

const keyOf = (r) => `${r.date}|${r.dest}|${r.dep}`;

export function appendTransitions(state, rows, ts) {
  const digest = digestRows(rows);
  if (state.digest === digest) {
    return { changed: false, added: 0, digest };
  }
  const prev = new Set((state.lastRows || []).map(keyOf));
  const added = rows
    .filter((r) => !prev.has(keyOf(r)))
    .map((r) => ({
      ts,
      date: r.date,
      dest: r.dest,
      dep: r.dep,
      stops: r.stops,
      dur: r.dur,
      seats: r.seats,
      allin: r.allin,
    }));

  state.history = (state.history || []).concat(added).slice(-HISTORY_CAP);
  state.lastRows = rows.map((r) => ({ date: r.date, dest: r.dest, dep: r.dep }));
  state.digest = digest;
  return { changed: true, added: added.length, digest };
}

// First-seen timestamps are the raw material for release timing. They are kept
// separately from `history` because history is capped at 4,000 entries and a busy
// week would evict exactly the oldest first-seen values the model depends on.
export function recordFirstSeen(state, rows, ts) {
  state.firstSeen = state.firstSeen || {};
  for (const r of rows) {
    if (!r || !r.date || !r.dest || !r.dep) continue;
    const k = `${r.date}|${r.dest}|${r.dep}`;
    if (!state.firstSeen[k] || ts < state.firstSeen[k]) state.firstSeen[k] = ts;
  }
  const keys = Object.keys(state.firstSeen);
  if (keys.length > 800) {
    const drop = keys.sort((a, b) => state.firstSeen[a] - state.firstSeen[b]).slice(0, keys.length - 800);
    for (const k of drop) delete state.firstSeen[k];
  }
}

// Record what we observed this sweep, so frequency can use honest denominators.
export function recordObservation(state, dateISO, rows) {
  state.observed = state.observed || {};
  state.days = state.days || {};
  state.observed[dateISO] = 1;

  const openDests = new Set(rows.map((r) => r.dest));
  for (const route of Object.keys(state.seenDests || {})) {
    if (!openDests.has(route)) state.days[`${route}|${dateISO}`] = 0;
  }
  for (const dest of openDests) {
    state.days[`${dest}|${dateISO}`] = 1;
    state.seenDests = state.seenDests || {};
    state.seenDests[dest] = 1;
  }

  // keep the observation window bounded
  const dates = Object.keys(state.observed).sort();
  if (dates.length > 400) {
    const drop = new Set(dates.slice(0, dates.length - 400));
    for (const d of drop) delete state.observed[d];
    for (const k of Object.keys(state.days)) {
      const d = k.split('|')[1];
      if (drop.has(d)) delete state.days[k];
    }
  }
}
