using System.Diagnostics;
using System.Net;
using System.Reflection;

// WaveFlow launcher: serves the embedded web app on a local port (127.0.0.1 only) and opens the browser.
// Nothing is sent anywhere; the analysis runs in the browser tab. Close this window to stop.
var asm = Assembly.GetExecutingAssembly();
var files = asm.GetManifestResourceNames().Where(n => n.StartsWith("www/")).ToDictionary(n => n[4..].Replace('\\', '/'), n => n);
if (!files.ContainsKey("index.html")) { Console.WriteLine("The web app is not embedded: run build-exe.ps1."); return 1; }

var mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
  [".html"] = "text/html; charset=utf-8", [".js"] = "text/javascript; charset=utf-8", [".mjs"] = "text/javascript; charset=utf-8",
  [".css"] = "text/css; charset=utf-8", [".json"] = "application/json", [".svg"] = "image/svg+xml", [".png"] = "image/png",
  [".ico"] = "image/x-icon", [".wasm"] = "application/wasm", [".map"] = "application/json", [".txt"] = "text/plain; charset=utf-8",
};

HttpListener? listener = null;
int port = 0;
for (int p = 5193; p < 5293 && listener == null; p++) {
  var l = new HttpListener();
  l.Prefixes.Add($"http://127.0.0.1:{p}/");
  try { l.Start(); listener = l; port = p; } catch (HttpListenerException) { l.Close(); }
}
if (listener == null) { Console.WriteLine("No free port between 5193 and 5292."); return 1; }

var url = $"http://127.0.0.1:{port}/";
Console.WriteLine($"WaveFlow is running at {url}");
Console.WriteLine("Your audio stays in the browser tab; nothing is uploaded. Close this window to quit.");
try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { Console.WriteLine("Open the address above in your browser."); }

while (true) {
  HttpListenerContext ctx;
  try { ctx = await listener.GetContextAsync(); } catch { break; }
  _ = Task.Run(() => {
    try {
      var path = Uri.UnescapeDataString(ctx.Request.Url!.AbsolutePath).TrimStart('/');
      if (path == "") path = "index.html";
      // unknown paths fall back to the app shell
      var key = files.ContainsKey(path) ? path : "index.html";
      using var s = asm.GetManifestResourceStream(files[key])!;
      ctx.Response.ContentType = mime.TryGetValue(Path.GetExtension(key), out var m) ? m : "application/octet-stream";
      ctx.Response.ContentLength64 = s.Length;
      ctx.Response.Headers["Cache-Control"] = "no-cache";
      s.CopyTo(ctx.Response.OutputStream);
    } catch { ctx.Response.StatusCode = 500; }
    finally { ctx.Response.Close(); }
  });
}
return 0;
