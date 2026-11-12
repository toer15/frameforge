const { test } = require('node:test');
const assert = require('node:assert/strict');
const scanjob = require('../src/scanjob');

// The scan results popup used to repeat every detection Defender had ever made, including the ones the user had
// already quarantined or deleted. Only what is new should come up the next time.
test('a scan only lists new detections: handled and already-found ones stay out', () => {
  const history = [
    { file: 'C:\\Users\\Me\\Downloads\\old.exe', threat: 'Trojan:Win32/Old' },
    { file: 'C:\\Users\\Me\\Downloads\\kept.exe', threat: 'PUA:Win32/Kept' },
    { file: 'C:\\Users\\Me\\Downloads\\new.exe', threat: 'Trojan:Win32/New' },
    { file: 'c:\\users\\me\\downloads\\FOUND.EXE', threat: 'Trojan:Win32/Found' },
  ];
  const handled = new Set([scanjob._keyOf({ file: 'C:\\Users\\Me\\Downloads\\old.exe', threat: 'Trojan:Win32/Old' })]);
  const foundNow = new Set([scanjob._keyOf({ file: 'c:\\users\\me\\downloads\\FOUND.EXE', threat: 'Trojan:Win32/Found' })]);
  const left = scanjob._onlyNew(history, foundNow, handled).map((h) => h.file);
  assert.deepEqual(left, ['C:\\Users\\Me\\Downloads\\kept.exe', 'C:\\Users\\Me\\Downloads\\new.exe']);
});

test('the detection key ignores case, so Windows path casing never makes an old threat look new', () => {
  assert.equal(
    scanjob._keyOf({ file: 'C:\\Users\\Me\\A.EXE', threat: 'Trojan:Win32/A' }),
    scanjob._keyOf({ file: 'c:\\users\\me\\a.exe', threat: 'Trojan:Win32/A' })
  );
});

test('this scan hides handled detections, but shows one that is active again after quarantine or delete', () => {
  const item = (id, status, verdict = 'real') => ({ id, status, verdict, file: `C:\\Users\\Me\\${id}.exe`, threat: `Trojan:Win32/${id}` });
  const items = [item('quarantined', 'active'), item('deleted', 'active'), item('kept', 'active'), item('allowed', 'active'), item('new', 'active')];
  const key = (id) => scanjob._keyOf({ file: `C:\\Users\\Me\\${id}.exe`, threat: `Trojan:Win32/${id}` });
  const handled = {
    [key('quarantined')]: { action: 'quarantine' },
    [key('deleted')]: { action: 'delete' },
    [key('kept')]: { action: 'keep' },
    [key('allowed')]: { action: 'allow' },
  };
  assert.deepEqual(scanjob._unseen(items, handled).map((i) => i.id), ['quarantined', 'deleted', 'new']);
});

test('a kept or allowed detection stays out of later scans even if it is still on disk', () => {
  const seen = { file: 'C:\\Users\\Me\\kept.exe', threat: 'PUA:Win32/Kept', status: 'active' };
  const handled = { [scanjob._keyOf(seen)]: { action: 'keep', status: 'active' } };
  assert.deepEqual(scanjob._unseen([seen], handled), []);
});
