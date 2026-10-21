const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(options = {}) {
  let models = ['llama3.1:latest', 'llama3.1:70b', 'qwen2.5:latest'];
  const calls = [];
  let lists = 0;
  let release;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/localai.js'), 'utf8'), {
    require: (id) => {
      if (id === 'electron') return { net: { fetch: async (url, args = {}) => {
        const endpoint = new URL(url).pathname;
        const body = args.body ? JSON.parse(args.body) : null;
        calls.push({ endpoint, method: args.method || 'GET', body });
        if (endpoint === '/api/version') return new Response('{}');
        if (endpoint === '/api/tags') {
          lists++;
          if (options.listFailure && lists > 1) return new Response('{}', { status: 500 });
          return Response.json({ models: models.map((name) => ({ name })) });
        }
        if (endpoint === '/api/generate') {
          if (options.hold) await new Promise((resolve) => { release = resolve; });
          return new Response('{}');
        }
        if (endpoint === '/api/delete') {
          assert.equal(args.method, 'DELETE');
          if (options.deleteFailure) return new Response('{}', { status: 500 });
          if (!options.keepModel) models = models.filter((name) => name !== body.model);
          return new Response('{}');
        }
        throw Error('Unexpected request: ' + url);
      } } };
      if (id === './util') return { DEMO: false, IS_WIN: true, run: () => { throw Error('OS commands are not expected'); } };
      if (id === './store') return { settings: { get: () => ({}) } };
      if (id === './tools') return {};
      return require(id);
    },
    module, process, AbortSignal, AbortController, setTimeout, TextDecoder,
  });
  return { api: module.exports, calls, models: () => models, release: () => release && release() };
}

test('uninstall unloads and deletes the exact selected tag, then verifies removal', async () => {
  const { api, calls, models } = fixture();
  assert.equal((await api.uninstall('llama3.1')).ok, true);
  assert.deepEqual(models(), ['llama3.1:70b', 'qwen2.5:latest']);
  assert.deepEqual(calls.find((c) => c.endpoint === '/api/generate').body, { model: 'llama3.1:latest', keep_alive: 0, stream: false });
  assert.equal(calls.find((c) => c.endpoint === '/api/delete').body.model, 'llama3.1:latest');
  assert.equal((await api.uninstall('missing-model')).ok, true);
});

test('uninstall reports delete failures, retained models and unverifiable removal honestly', async () => {
  for (const options of [{ deleteFailure: true }, { keepModel: true }, { listFailure: true }]) {
    const { api } = fixture(options);
    assert.equal((await api.uninstall('llama3.1')).ok, false);
    assert.equal(api.removing(), false);
  }
});

test('uninstall rejects invalid names and overlapping model operations', async () => {
  const { api, calls, release } = fixture({ hold: true });
  assert.equal((await api.uninstall('../bad name')).ok, false);
  assert.equal(calls.length, 0);
  const pending = api.uninstall('llama3.1');
  for (let i = 0; i < 20 && !calls.some((c) => c.endpoint === '/api/generate'); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(api.removing(), true);
  assert.equal((await api.uninstall('qwen2.5')).busy, true);
  assert.equal((await api.install('qwen2.5')).busy, true);
  release();
  assert.equal((await pending).ok, true);
});
