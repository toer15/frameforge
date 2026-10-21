// The AI chat. Runs in the main process so the API key never reaches the page.
//
// Providers:
//   claude — Anthropic's Claude via the Messages API, with the user's own API key (smartest; can take
//            actions in FrameForge through tools, each one approved by the user first)
//   ollama — a free local model through Ollama (answers only, no actions)
//
// Every message is sent with a fresh snapshot of the PC (hardware, live sensors, preset, and the full
// "What FrameForge changed" list), so the AI can answer about this exact machine.
const { net, safeStorage, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { settings } = require('./store');

const API_URL = process.env.FRAMEFORGE_AI_URL || 'https://api.anthropic.com/v1/messages'; // override only for testing
const MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 — smartest (recommended)' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 — fast and smart' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 — fastest, cheapest' },
];

// ---------- API key, encrypted with Windows' own per-user encryption (DPAPI) ----------
function setKey(key) {
  const k = String(key || '').trim();
  if (!k) {
    settings.set({ aiKeyEnc: null });
    return false;
  }
  const enc = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(k).toString('base64') : 'plain:' + Buffer.from(k).toString('base64');
  settings.set({ aiKeyEnc: enc });
  return true;
}
function getKey() {
  const e = settings.get().aiKeyEnc;
  if (!e) return null;
  try {
    if (e.startsWith('plain:')) return Buffer.from(e.slice(6), 'base64').toString();
    return safeStorage.decryptString(Buffer.from(e, 'base64'));
  } catch {
    return null;
  }
}

// ---------- Saved conversation ----------
const chatFile = () => path.join(app.getPath('userData'), 'chat.json');
function loadChat() {
  try {
    return JSON.parse(fs.readFileSync(chatFile(), 'utf8'));
  } catch {
    return { messages: [] };
  }
}
function saveChat(c) {
  // Keep the last 60 turns so requests stay fast and cheap.
  c.messages = c.messages.slice(-60);
  while (c.messages.length && c.messages[0].role !== 'user') c.messages.shift();
  fs.writeFileSync(chatFile(), JSON.stringify(c));
}

// ---------- What the AI may do in the app ----------
const TOOLS = [
  {
    name: 'set_preset',
    description: 'Switch FrameForge to another goal preset. If Auto Mode is on, the PC is re-tuned for it right away. Presets: competitive, performance, balanced, graphics.',
    input_schema: { type: 'object', properties: { preset: { type: 'string', enum: ['competitive', 'performance', 'balanced', 'graphics'] } }, required: ['preset'] },
    approve: (i) => `Switch your goal to ${({ competitive: 'Competitive', performance: 'Best performance', balanced: 'Balanced', graphics: 'Best graphics' })[i.preset] || i.preset}${settings.get().autoMode ? ' and re-tune your PC for it now' : ''}`,
  },
  {
    name: 'start_auto_mode',
    description: 'Turn on Auto Mode, which applies the current preset’s changes to the PC. Use only when the user asks for it.',
    input_schema: { type: 'object', properties: {} },
    approve: () => 'Turn on Auto Mode and tune your PC with the current preset',
  },
  {
    name: 'undo_all_changes',
    description: 'Undo every active change FrameForge made, putting the PC back how it was. Use only when the user asks for it.',
    input_schema: { type: 'object', properties: {} },
    approve: () => 'Undo all of FrameForge’s active changes on your PC',
  },
  {
    name: 'stop_auto_mode',
    description: 'Stop an Auto Mode run that is in progress (keeps what is already done).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'open_driver_app',
    description: 'Open the graphics driver app (AMD Software, NVIDIA app or Intel Graphics Software) so the user can follow the driver checklist.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'fix_problem',
    description: 'Actually fix one problem from the Fix mode list (see fixModeProblems in the snapshot). Pass its id. FrameForge tries every fix it knows for that problem in order, checks after each one whether the problem is really gone, and the problem disappears from the list when it is. The result says fixed true/false; if false, explain manualSteps to the user. Optionally pass one specific action id from the problem’s fixActions.',
    input_schema: { type: 'object', properties: { problem_id: { type: 'string' }, action: { type: 'string' } }, required: ['problem_id'] },
    approve: (i) => `Fix this problem: ${i.problem_id.replace(/^(step|insight|tool)_/, '').replace(/_/g, ' ')}${i.action ? ` (${i.action.split(':')[0]})` : ''}`,
  },
  {
    name: 'fix_everything',
    description: 'Run Fix mode’s “Fix everything automatically”: fix every problem in the list that FrameForge can fix, verify each one, and report what was fixed and what still needs the user. May restart the app as administrator or the PC (with a cancellable countdown) if a fix needs it. Use when the user asks you to fix everything / all problems.',
    input_schema: { type: 'object', properties: {} },
    approve: () => 'Fix everything FrameForge can fix on your PC (it may need to restart the app or the PC)',
  },
  {
    name: 'run_repair',
    description: 'Run a repair tool: shader_cache (stutter after driver updates), network (lag/connection problems, needs restart), system_files (DISM + SFC for crashes/corruption, 10–30 min), restore_points (turn on System Protection).',
    input_schema: { type: 'object', properties: { repair: { type: 'string', enum: ['shader_cache', 'network', 'system_files', 'restore_points'] } }, required: ['repair'] },
    approve: (i) => ({ shader_cache: 'Clear the DirectX, NVIDIA and AMD shader caches', network: 'Reset your network settings (needs a restart)', system_files: 'Repair Windows system files with DISM and SFC (10–30 min)', restore_points: 'Turn on System Protection for your system drive' })[i.repair] || `Run repair ${i.repair}`,
  },
  {
    name: 'set_tweak',
    description: 'Switch one tweak from the Tweaks tab on or off (ids are in tweaksTab in the snapshot). Every change can be undone.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, on: { type: 'boolean' } }, required: ['id', 'on'] },
    approve: (i) => `${i.on ? 'Turn on' : 'Turn off'} the tweak “${(require('./optimizer').TWEAKS.find((t) => t.id === i.id) || {}).name || i.id}”`,
  },
  {
    name: 'open_chris_titus',
    description: 'Open Chris Titus Tech’s Windows Utility (winutil) in its own window so the user can pick tweaks, install apps, or use its Undo / Windows Update fixes.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'rescan_pc',
    description: 'Scan the hardware again and return the fresh results.',
    input_schema: { type: 'object', properties: {} },
  },
];

function systemPrompt(ctx) {
  return `You are the AI assistant built into FrameForge, a Windows app that tunes gaming PCs (made by TwicyTom). You chat with the PC's owner inside the app.

How to answer:
- Answer about THIS PC using the live snapshot below — it has the hardware, sensors, preset, settings and the full list of what FrameForge changed with exact before → after values. Quote those values when asked what changed.
- Be clear, friendly and specific. Use short paragraphs and lists. Explain technical terms simply. Match the user's language (they may write in Norwegian or English).
- Be honest about limits: RAM speed (XMP/EXPO) can only be set in the BIOS; FrameForge never applies made-up overclock/undervolt/voltage numbers — it uses vendors' own auto-tuners (NVIDIA Automatic Tuning, AMD Auto Undervolt/Overclock); it never raises voltages. Don't claim FrameForge did something that isn't in the snapshot.
- If a temperature is high, say what's normal (CPU under ~85 °C, GPU core under ~83 °C while gaming is typically fine; AMD hot spot can run ~20 °C above core) and suggest real fixes (dust, fan curve, airflow, undervolting via the vendor auto-tuner).
- When something failed or is wrong (see fixModeProblems), explain the cause in plain words and offer to fix it with fix_problem (fixes one problem for real and verifies it — fixed true means it is gone from the Fix mode list), fix_everything (all of them), or run_repair. When the user asks you to fix something, do it with the tool right away instead of only explaining, then tell them honestly whether the result says it is fixed. For things only fixable in the BIOS (RAM XMP/EXPO, single RAM stick), give exact, step-by-step BIOS instructions for their motherboard brand if known.
- You can take actions with your tools, but only when the user asks for that kind of change (or agrees to your offer). The user approves each one in the app. Never suggest disabling security features or running unknown "FPS booster" software.

Live snapshot of this PC (JSON, taken just now):
${JSON.stringify(ctx, null, 1)}`;
}

// ---------- Streaming helpers ----------
async function* sseEvents(res, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    if (signal && signal.aborted) throw new Error('aborted');
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (data) {
        try {
          yield JSON.parse(data);
        } catch {}
      }
    }
  }
}

function friendlyApiError(status, body) {
  const msg = (body && body.error && body.error.message) || '';
  if (status === 401) return 'That API key isn’t valid. Check it in Settings › AI chat (it starts with sk-ant-).';
  if (status === 403) return 'This API key isn’t allowed to use that model. Pick another model in Settings › AI chat.';
  if (/credit balance/i.test(msg)) return 'Your Anthropic account is out of credit. Add credit at console.anthropic.com › Billing, then try again.';
  if (status === 429) return 'Too many messages too fast — wait a few seconds and try again.';
  if (status === 529 || status === 503) return 'Claude is very busy right now. Try again in a minute.';
  if (status === 404) return 'That model isn’t available on your account. Pick another model in Settings › AI chat.';
  return `Claude answered with an error (${status}). ${msg}`.trim();
}

/**
 * One Claude turn, streaming text to `onText`, running approved tools, looping until Claude is done.
 * history: Claude-format messages; returns the new assistant/tool messages to append.
 */
async function runClaude({ history, ctx, onText, onTool, askApproval, runTool, signal }) {
  const key = getKey();
  if (!key) throw new Error('Add your Claude API key in Settings › AI chat to start chatting.');
  const model = settings.get().aiModel || MODELS[0].id;
  const added = [];
  for (let round = 0; round < 6; round++) {
    const res = await net.fetch(API_URL, {
      method: 'POST',
      signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        stream: true,
        system: systemPrompt(ctx()),
        tools: TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
        messages: [...history, ...added],
      }),
    });
    if (!res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch {}
      throw new Error(friendlyApiError(res.status, body));
    }
    const blocks = [];
    let stop = null;
    for await (const ev of sseEvents(res, signal)) {
      if (ev.type === 'content_block_start') {
        blocks[ev.index] = ev.content_block.type === 'tool_use' ? { ...ev.content_block, _json: '' } : { type: 'text', text: '' };
      } else if (ev.type === 'content_block_delta') {
        const b = blocks[ev.index];
        if (!b) continue;
        if (ev.delta.type === 'text_delta') {
          b.text += ev.delta.text;
          onText(ev.delta.text);
        } else if (ev.delta.type === 'input_json_delta') {
          b._json += ev.delta.partial_json;
        }
      } else if (ev.type === 'message_delta') {
        stop = ev.delta && ev.delta.stop_reason;
      } else if (ev.type === 'error') {
        throw new Error(friendlyApiError(529, ev));
      }
    }
    const content = blocks.filter(Boolean).map((b) => {
      if (b.type !== 'tool_use') return b;
      let input = {};
      try {
        input = b._json ? JSON.parse(b._json) : {};
      } catch {}
      return { type: 'tool_use', id: b.id, name: b.name, input };
    }).filter((b) => b.type !== 'text' || b.text);
    added.push({ role: 'assistant', content });
    if (stop !== 'tool_use') break;

    // Run each tool Claude asked for — the user approves anything that changes the PC.
    const results = [];
    for (const b of content.filter((c) => c.type === 'tool_use')) {
      const def = TOOLS.find((t) => t.name === b.name);
      let out;
      if (!def) out = { is_error: true, content: 'Unknown tool.' };
      else {
        const label = def.approve ? def.approve(b.input) : null;
        const ok = label ? await askApproval({ id: b.id, label }) : true;
        if (!ok) out = { content: 'The user chose not to allow this.' };
        else {
          onTool({ id: b.id, label: label || b.name, status: 'running' });
          try {
            out = { content: JSON.stringify(await runTool(b.name, b.input)) };
            onTool({ id: b.id, label: label || b.name, status: 'done' });
          } catch (e) {
            out = { is_error: true, content: String(e.message || e) };
            onTool({ id: b.id, label: label || b.name, status: 'error' });
          }
        }
      }
      results.push({ type: 'tool_result', tool_use_id: b.id, ...out });
    }
    added.push({ role: 'user', content: results });
    onText('\n\n');
  }
  return added;
}

/** Ollama (local, free): answers only. */
async function runOllama({ history, ctx, onText, signal }) {
  const s = settings.get();
  const base = (s.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const msgs = [{ role: 'system', content: systemPrompt(ctx()) }];
  for (const m of history) {
    const text = typeof m.content === 'string' ? m.content : m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (text) msgs.push({ role: m.role, content: text });
  }
  let res;
  try {
    res = await net.fetch(`${base}/api/chat`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: s.ollamaModel || 'llama3.1', messages: msgs, stream: true }) });
  } catch {
    throw new Error('Ollama isn’t running on this PC yet. Press “Install” at the top right of the chat — FrameForge installs and starts it for you.');
  }
  if (!res.ok) throw new Error(res.status === 404 ? `The model “${s.ollamaModel || 'llama3.1'}” isn’t downloaded yet. Press “Install” at the top right of the chat — FrameForge downloads it for you.` : `Ollama answered with an error (${res.status}).`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        const t = (j.message && j.message.content) || '';
        if (t) {
          full += t;
          onText(t);
        }
      } catch {}
    }
  }
  return [{ role: 'assistant', content: [{ type: 'text', text: full }] }];
}

module.exports = { MODELS, setKey, getKey, loadChat, saveChat, runClaude, runOllama, sseEvents, TOOLS };
