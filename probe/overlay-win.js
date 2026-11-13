// Temporary probe (Windows CI): which way of resizing a transparent, non-resizable, click-through window works,
// and is the window still transparent afterwards? Run with: electron probe/overlay-win.js
const { app, BrowserWindow, screen } = require('electron');
const { execFileSync } = require('child_process');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function pixels(points) {
  const script = `Add-Type -AssemblyName System.Drawing; $pts = @(${points.map(([x, y]) => `@(${x},${y})`).join(',')}); $out = @(); foreach ($p in $pts) { $b = New-Object System.Drawing.Bitmap 1,1; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($p[0], $p[1], 0, 0, (New-Object System.Drawing.Size 1,1)); $c = $b.GetPixel(0,0); $out += ('' + $c.R + ',' + $c.G + ',' + $c.B) }; $out -join ' | '`;
  try { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim(); } catch (e) { return 'capture failed: ' + String(e.message).slice(0, 200); }
}
const name = (rgb) => { const [r, g, b] = rgb.split(',').map(Number); return r > 200 && g < 60 && b < 60 ? 'RED(backdrop)' : g > 200 && r < 60 && b < 60 ? 'GREEN(content)' : b > 200 && r < 60 && g < 60 ? 'BLUE(content)' : `other(${rgb})`; };

const page = (w, h) => 'data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent;overflow:hidden"><div style="position:absolute;left:0;top:0;width:60px;height:40px;background:#00ff00"></div><div style="position:absolute;left:${w - 60}px;top:${h - 40}px;width:60px;height:40px;background:#0000ff"></div></body>`);

const METHODS = {
  setSize: (w, W, H) => w.setSize(W, H),
  setBounds: (w, W, H) => w.setBounds({ x: 150, y: 150, width: W, height: H }),
  setContentSize: (w, W, H) => w.setContentSize(W, H),
  minmaxThenSetSize: (w, W, H) => { w.setMinimumSize(W, H); w.setMaximumSize(W, H); w.setSize(W, H); },
  toggleResizable: (w, W, H) => { w.setResizable(true); w.setSize(W, H); w.setResizable(false); },
  createdResizable: (w, W, H) => w.setSize(W, H),
};

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  console.log('display', JSON.stringify(d.bounds), 'scale', d.scaleFactor);
  const back = new BrowserWindow({ x: 100, y: 100, width: 700, height: 500, frame: false, backgroundColor: '#ff0000', show: true });
  await back.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#ff0000"></body>'));
  await delay(1500);
  console.log('backdrop pixel', name(pixels([[400, 300]])));
  const W = 400, H = 120;
  for (const [label, fn] of Object.entries(METHODS)) {
    const win = new BrowserWindow({ x: 150, y: 150, width: 280, height: 320, frame: false, transparent: true, resizable: label === 'createdResizable', movable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    await win.loadURL(page(W, H));
    win.showInactive();
    await delay(900);
    const before = win.getSize();
    const p0 = pixels([[160, 160], [300, 300]]).split(' | ').map(name);
    let err = '';
    try { fn(win, W, H); } catch (e) { err = String(e.message); }
    await delay(1200);
    const after = win.getSize();
    // green box (top-left content), a transparent spot inside the new size, the blue box at the new bottom-right, a spot below the new height (old window area)
    const p1 = pixels([[160, 160], [330, 200], [150 + W - 30, 150 + H - 20], [200, 150 + H + 100]]).split(' | ').map(name);
    console.log(`${label.padEnd(18)} size ${before.join('x')} -> ${after.join('x')} ${err ? 'ERR ' + err : ''}| before: content=${p0[0]} empty=${p0[1]} | after: content=${p1[0]} empty=${p1[1]} newCorner=${p1[2]} belowNewHeight=${p1[3]} | resizable=${win.isResizable()}`);
    win.destroy();
    await delay(400);
  }
  app.quit();
});
