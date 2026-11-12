// A stand-in "game" for the FPS limiter test: a window that presents Direct3D 11 frames as fast as it can and
// prints how many it managed each second. Compiled on the test machine with the C# compiler that ships with Windows.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class TestGame {
  [StructLayout(LayoutKind.Sequential)] struct Rational { public uint N, D; }
  [StructLayout(LayoutKind.Sequential)] struct ModeDesc { public uint Width, Height; public Rational Refresh; public uint Format, ScanlineOrdering, Scaling; }
  [StructLayout(LayoutKind.Sequential)] struct SampleDesc { public uint Count, Quality; }
  [StructLayout(LayoutKind.Sequential)] struct SwapChainDesc { public ModeDesc BufferDesc; public SampleDesc Sample; public uint BufferUsage, BufferCount; public IntPtr OutputWindow; public int Windowed; public uint SwapEffect, Flags; }

  [DllImport("d3d11.dll")]
  static extern int D3D11CreateDeviceAndSwapChain(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint nLevels, uint sdk, ref SwapChainDesc desc, out IntPtr swap, out IntPtr dev, out int level, out IntPtr ctx);

  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PresentFn(IntPtr self, uint sync, uint flags);

  [STAThread]
  static int Main(string[] args) {
    int secs = args.Length > 0 ? int.Parse(args[0]) : 12;
    var form = new Form { Text = "FrameForge test game", Width = 640, Height = 360 };
    form.Show();
    var d = new SwapChainDesc();
    d.BufferDesc.Width = 640; d.BufferDesc.Height = 360; d.BufferDesc.Format = 28; // R8G8B8A8_UNORM
    d.BufferDesc.Refresh.N = 0; d.BufferDesc.Refresh.D = 1;
    d.Sample.Count = 1; d.BufferUsage = 0x20; d.BufferCount = 1; d.OutputWindow = form.Handle; d.Windowed = 1; d.SwapEffect = 0;
    IntPtr swap = IntPtr.Zero, dev, ctx; int level; int hr = -1;
    foreach (int driver in new[] { 1, 5 }) { // a real graphics card, else Windows' software renderer (WARP)
      hr = D3D11CreateDeviceAndSwapChain(IntPtr.Zero, driver, IntPtr.Zero, 0, IntPtr.Zero, 0, 7, ref d, out swap, out dev, out level, out ctx);
      if (hr >= 0) { Console.WriteLine("D3D driver type " + driver); break; }
    }
    if (hr < 0) { Console.WriteLine("D3D FAILED 0x" + hr.ToString("X")); return 2; }
    IntPtr vtbl = Marshal.ReadIntPtr(swap);
    var present = (PresentFn)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtbl, 8 * IntPtr.Size), typeof(PresentFn)); // IDXGISwapChain::Present
    var sw = Stopwatch.StartNew(); long last = 0; int n = 0;
    while (sw.ElapsedMilliseconds < secs * 1000) {
      present(swap, 0, 0); n++;
      Application.DoEvents();
      long t = sw.ElapsedMilliseconds;
      if (t - last >= 1000) { Console.WriteLine("FPS " + (int)Math.Round(n * 1000.0 / (t - last))); Console.Out.Flush(); n = 0; last = t; }
    }
    return 0;
  }
}
