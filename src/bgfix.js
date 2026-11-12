// Fix mode on its own: when a problem is tried, when it is tried again, and what the list says about it.
//
// Kept apart from main.js so the rules can be tested without Windows:
//   - a fix that didn't stick is retried after 5 minutes, then 30 minutes, then every 6 hours;
//   - an attempt only counts when something was actually tried;
//   - a problem that disappears and comes back later starts fresh;
//   - every problem says, in one sentence, whether FrameForge will fix it by itself and what it is waiting for.

const IDLE_MIN = 5; // "you've been away": minutes without mouse or keyboard before CPU-heavy fixes run
const RETRY = [5 * 60 * 1000, 30 * 60 * 1000, 6 * 60 * 60 * 1000];

/** How long to wait after the n-th failed attempt. */
const delayAfter = (n) => RETRY[Math.min(Math.max(n, 1), RETRY.length) - 1];

class Attempts {
  constructor() {
    this.map = new Map(); // problem id -> { n: failed attempts so far, at: time of the last one }
  }
  get(id) {
    return this.map.get(id) || null;
  }
  /** May this problem be tried now? */
  due(id, now = Date.now()) {
    const t = this.map.get(id);
    return !t || now - t.at >= delayAfter(t.n);
  }
  /** After a real attempt: fixed problems are forgotten, the rest wait longer each time. */
  record(id, fixed, now = Date.now()) {
    if (fixed) this.map.delete(id);
    else this.map.set(id, { n: ((this.map.get(id) || {}).n || 0) + 1, at: now });
  }
  /** Forget problems that are no longer in the list, so one that returns next week is tried at once. */
  keepOnly(ids) {
    const keep = new Set(ids);
    for (const id of [...this.map.keys()]) if (!keep.has(id)) this.map.delete(id);
  }
}

/** Is this the right moment for a problem of this kind? ('game' any time, 'quiet' no game, 'idle' away from the PC) */
function momentOk(it, { game, idleMin }) {
  if (!it.bg || !it.strategies || !it.strategies.length) return false;
  return it.bg === 'game' || (it.bg === 'quiet' && !game) || (it.bg === 'idle' && !game && idleMin >= IDLE_MIN);
}

const span = (ms) => {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 90 ? `${Math.round(m / 60)} hours` : `${m} minute${m === 1 ? '' : 's'}`;
};

/**
 * One sentence per problem. kind: 'soon' (about to fix it), 'wait' (will, later), 'you' (needs a click or hands).
 * @param {object} it   a Fix mode item
 * @param {object} c    { autoFix, autoRestart, mayRestart, admin, game, idleMin, attempt, stuck, now }
 */
function whenFixed(it, c) {
  const now = c.now || Date.now();
  if (it.restartItem) {
    if (!c.autoRestart) return { kind: 'you', text: 'Waiting for you: restart when it suits you. FrameForge finishes by itself afterwards.' };
    if (!c.mayRestart) return { kind: 'you', text: 'Waiting for you: FrameForge already restarted this PC in the last 3 hours, so it won’t do it again by itself.' };
    return { kind: 'wait', text: 'FrameForge restarts by itself once you’ve been away for 20 minutes and no game is running — or press Restart now.' };
  }
  if (it.id === 'not_admin') return { kind: 'you', text: 'Waiting for you: press Restart as administrator. Windows asks you to confirm, and FrameForge can’t answer that for you.' };
  if (!it.strategies || !it.strategies.length) {
    return { kind: 'you', text: it.manual ? 'Needs you: this can’t be changed from inside Windows. The steps are under “How to fix it”.' : 'Nothing FrameForge can change here — this one is for your information.' };
  }
  if (!it.bg) return { kind: 'you', text: 'Waiting for you: this one starts a large download or needs administrator rights, so FrameForge asks first. Press Fix it.' };
  if (!c.autoFix) return { kind: 'you', text: 'Waiting for you: “Fix problems by itself” is switched off. Press Fix it, or switch it on above.' };
  if (!c.admin) return { kind: 'you', text: 'Waiting for administrator rights — see “FrameForge isn’t running as administrator” in this list.' };
  if (it.bg !== 'game' && c.game) return { kind: 'wait', text: 'Waiting until your game is closed, so nothing flickers or stutters while you play.' };
  if (it.bg === 'idle' && c.idleMin < IDLE_MIN) {
    return { kind: 'wait', text: `This keeps the processor busy for a few minutes, so FrameForge does it by itself once you’ve been away for ${IDLE_MIN} minutes — or press Fix it to do it now.` };
  }
  if (c.stuck) {
    const n = Math.max(c.stuck.n || 1, 1);
    const said = String(c.stuck.message || '').trim();
    return {
      kind: 'wait',
      text: `FrameForge tried ${n === 1 ? 'once' : `${n} times`} and this is still here${said ? ` — Windows said: “${said.replace(/[.。]+$/, '')}”` : ''}. It keeps trying by itself every few hours; press Fix it to try again right now.`,
    };
  }
  const t = c.attempt;
  if (t) {
    const left = t.at + delayAfter(t.n) - now;
    if (left > 0) return { kind: 'wait', text: `FrameForge tried ${t.n === 1 ? 'once' : `${t.n} times`} and it didn’t stick. It tries again by itself in ${span(left)} — or press Fix it.` };
  }
  return { kind: 'soon', text: 'FrameForge is fixing this by itself — it starts within a minute.' };
}

module.exports = { Attempts, whenFixed, momentOk, delayAfter, IDLE_MIN, RETRY };
