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
