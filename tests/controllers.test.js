const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/controllers');

test('known controllers are named and sorted into Xbox / PlayStation families', () => {
  assert.deepEqual(c.classify('054c', '0ce6'), { name: 'DualSense', family: 'playstation', model: 'dualsense' });
  assert.deepEqual(c.classify('054c', '0df2'), { name: 'DualSense Edge', family: 'playstation', model: 'dualsense-edge' });
  assert.equal(c.classify('045e', '0b12').family, 'xbox');
  assert.equal(c.classify('2dc8', '3106', 'Xbox compatible pad').family, 'xbox');
  assert.equal(c.classify('1234', '5678', 'HID-compliant game controller').family, 'other');
});

test('output from Windows turns into one entry per pad, and XInput means games see Xbox', () => {
  const lines = [
    'DEV=054C:0DF2|MEDIA|DualSense Edge Wireless Controller|USB\\VID_054C&PID_0DF2&MI_00\\9&AA',
    'DEV=054C:0DF2|HIDClass|HID-compliant game controller|HID\\VID_054C&PID_0DF2&MI_03\\A&40',
    'DEV=0B05:19AF|HIDClass|AURA LED Controller|USB\\VID_0B05&PID_19AF\\x',
  ];
  const r = c.parse(['XI='].concat(lines).join('\n'));
  assert.equal(r.devices.length, 1);
  assert.equal(r.devices[0].name, 'DualSense Edge');
  assert.equal(r.devices[0].connection, 'USB cable');
  assert.deepEqual(r.xinput, []);
  assert.deepEqual(c.parse(['XI=0:1;'].concat(lines).join('\n')).xinput, [0]);
});
