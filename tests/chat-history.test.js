const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

function fixture() {
  const dir = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-chat-history-'));
  const file = path.join(dir, 'chat.json');
  const messages = [
    { role: 'user', content: 'Original user question' },
    { role: 'assistant', content: [{ type: 'text', text: 'Original reply' }, { type: 'tool_use', id: 'tool-1', name: 'rescan_pc', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Tool reply' }] },
    { role: 'user', content: [{ type: 'text', text: 'Another question' }] },
  ];
  fs.writeFileSync(file, JSON.stringify({ messages }));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ai.js'), 'utf8'), {
    require: (id) => id === 'electron' ? { app: { getPath: () => dir } } : id === './store' ? { settings: { get: () => ({}) } } : require(id),
    module, process: { env: {} }, Buffer,
  });
  return { api: module.exports, file };
}

test('legacy user messages receive stable IDs and edits persist without altering replies or tools', () => {
  const { api } = fixture();
  const initial = api.loadChat();
  const id = initial.messages[0].id;
  assert.ok(id);
  assert.equal(api.loadChat().messages[0].id, id);
  assert.equal(initial.messages[2].id, undefined);
  assert.equal(api.changeMessage(id, '  Revised question\nwith a second line  ').ok, true);
  const saved = api.loadChat();
  assert.equal(saved.messages[0].content[0].text, 'Revised question\nwith a second line');
  assert.equal(JSON.stringify(saved.messages.slice(1)), JSON.stringify(initial.messages.slice(1)));
  assert.equal(api.changeMessage(id, '  ').ok, false);
  assert.equal(api.changeMessage('missing', 'text').ok, false);
});

test('deleting removes the original text and keeps subsequent replies and tool pairs valid', () => {
  const { api, file } = fixture();
  const initial = api.loadChat();
  const id = initial.messages[0].id;
  assert.equal(api.changeMessage(id, null, true).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8').includes('Original user question'), false);
  const saved = api.loadChat();
  assert.equal(saved.messages[0].deleted, true);
  assert.equal(JSON.stringify(saved.messages.slice(1)), JSON.stringify(initial.messages.slice(1)));
  assert.equal(api.changeMessage(id, 'Cannot resurrect it').ok, false);
  const request = api.modelHistory(saved.messages);
  assert.equal(request[0].role, 'user');
  assert.match(request[0].content[0].text, /deleted/);
  assert.equal(request[1].content[1].id, request[2].content[0].tool_use_id);
  for (const message of request) assert.equal(Object.keys(message).sort().join(','), 'content,role');
});
