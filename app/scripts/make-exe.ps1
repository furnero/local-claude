# Builds dist\LocalClaude\LocalClaude.exe: Electron's runtime under its own name, icon and version, so
# Windows shows "Local Claude" (not "Electron") in Task Manager, the taskbar, Alt+Tab and Start.
# The app's code and its runtime packages are copied into resources\app, so the dist\LocalClaude folder
# runs on its own (move it anywhere). Build again after code changes:
#   npm run make-exe        (or: powershell -ExecutionPolicy Bypass -File scripts\make-exe.ps1)
param([string]$Out)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
# node and npm are started by name below. Node.js can be installed without being on the search
# path: then its usual folder is put on this run's path.
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  $nodeDir = Join-Path $env:ProgramFiles 'nodejs'
  if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) { throw 'Node.js was not found. Install it from nodejs.org (or run install\install.cmd, which does that) and try again.' }
  $env:Path = $nodeDir + ';' + $env:Path
}
$runtime = Join-Path $root 'node_modules\electron\dist'
if (-not (Test-Path (Join-Path $runtime 'electron.exe'))) {
  # Since Electron 44 "npm install" no longer downloads the program itself; Electron fetches it on
  # first use. On a fresh install nothing has used it yet, so fetch it here with Electron's own script.
  $fetch = Join-Path $root 'node_modules\electron\install.js'
  if (-not (Test-Path $fetch)) { throw "Electron isn't installed in $root (run npm install first)." }
  Write-Output 'Downloading the Electron program (about 120 MB, once) ...'
  & node $fetch
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $runtime 'electron.exe'))) { throw "Electron could not be downloaded into $root\node_modules\electron\dist. Check the internet connection and run this again." }
}
$icons = Join-Path $root 'assets\icons'
$sizes = [int[]](16, 20, 24, 32, 40, 48, 64, 128, 256)
foreach ($s in $sizes) { if (-not (Test-Path (Join-Path $icons "$s.png"))) { throw "assets\icons\$s.png is missing (run: node scripts\make-icon.js)." } }
if (-not $Out) { $Out = Join-Path $root 'dist\LocalClaude' }
$Out = [IO.Path]::GetFullPath($Out)
$exe = Join-Path $Out 'LocalClaude.exe'

# a running LocalClaude.exe keeps the files locked
$running = @(Get-CimInstance Win32_Process -Filter "Name='LocalClaude.exe'" | Where-Object { $_.ExecutablePath -eq $exe })
if ($running.Count) { throw "LocalClaude.exe is running from $Out. Close Local Claude and build again." }

# Start from an empty folder, so nothing of an older Electron is left behind. Only a folder this
# script made (it holds LocalClaude.exe) or an empty one is ever removed.
if (Test-Path $Out) {
  if (-not (Test-Path $exe) -and @(Get-ChildItem $Out -Force).Count) { throw "$Out already exists and isn't a Local Claude build; pass another -Out." }
  # empty it instead of removing it: a program the app started (Ollama) can still have this folder
  # as its working folder, which blocks removing the folder itself but not its contents
  Get-ChildItem $Out -Force | Remove-Item -Recurse -Force
}
New-Item -ItemType Directory -Force $Out | Out-Null
Copy-Item (Join-Path $runtime '*') $Out -Recurse
Rename-Item (Join-Path $Out 'electron.exe') 'LocalClaude.exe'
Remove-Item (Join-Path $Out 'resources\default_app.asar') -ErrorAction SilentlyContinue
# the development signature belongs to the original electron.exe and is useless for the new exe
Remove-Item (Join-Path $Out 'electron.exe.sig') -ErrorAction SilentlyContinue

# resources\app: Electron runs this instead of its default app. Same name as the project's
# package.json, so Aster keeps its profile folder (%APPDATA%\Aster).
$app = Join-Path $Out 'resources\app'
New-Item -ItemType Directory -Force $app | Out-Null
$utf8 = New-Object Text.UTF8Encoding $false
$appPkg = [ordered]@{ name = $pkg.name; productName = $pkg.productName; version = $pkg.version; description = $pkg.description; main = 'src/main/main.js'; private = $true }
[IO.File]::WriteAllText((Join-Path $app 'package.json'), ($appPkg | ConvertTo-Json), $utf8)
Copy-Item (Join-Path $root 'src') (Join-Path $app 'src') -Recurse
New-Item -ItemType Directory -Force (Join-Path $app 'assets') | Out-Null
Copy-Item (Join-Path $root 'assets\icon.ico') (Join-Path $app 'assets\icon.ico')
Copy-Item (Join-Path $root 'assets\icon.png') (Join-Path $app 'assets\icon.png')

# the packages the main process needs at run time (the renderer's libraries are already bundled
# into src\renderer\vendor by scripts\vendor.js)
$listing = & npm.cmd ls --omit=dev --all --parseable --prefix $root 2>$null
$nm = Join-Path $root 'node_modules'
$copied = 0
foreach ($line in $listing) {
  if (-not $line) { continue }
  # Only the part from "node_modules\" on is used. The start of the path cannot be trusted: npm
  # replaces anything in its output that looks like a secret (a long ID in a folder name) with ***.
  $i = $line.IndexOf('\node_modules\', [StringComparison]::OrdinalIgnoreCase)
  if ($i -lt 0) { continue }
  $rel = $line.Substring($i + 1)
  $dir = Join-Path $root $rel
  if (-not (Test-Path $dir)) { continue }
  $dest = Join-Path $app $rel
  if (Test-Path $dest) { continue }
  # Copy the package without its nested node_modules (those are listed separately). robocopy and
  # not Copy-Item: some packages have file names so long that a deep install folder goes past
  # the 260 characters Copy-Item can handle.
  & robocopy.exe $dir $dest /E /XD node_modules /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying the package $rel failed (robocopy $LASTEXITCODE)." }
  $copied++
}
if ($copied -lt 5) { throw "Only $copied runtime packages were found; is npm on PATH and node_modules complete?" }

# Icon and version resources, written with the Windows resource API (no extra tools needed).
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class AsterStamp {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool EndUpdateResource(IntPtr h, bool discard);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
  [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr FindResourceEx(IntPtr h, IntPtr type, IntPtr name, ushort lang);
  [DllImport("kernel32.dll")] static extern IntPtr LoadResource(IntPtr h, IntPtr res);
  [DllImport("kernel32.dll")] static extern IntPtr LockResource(IntPtr data);
  const int RT_ICON = 3, RT_GROUP_ICON = 14, RT_VERSION = 16;
  const ushort LANG = 1033; // electron.exe keeps its icon (group #1) and version (#1) in en-US

  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }

  // ids of the images icon group #1 uses now
  static List<int> OldIconIds(string exe) {
    var ids = new List<int>();
    IntPtr h = LoadLibraryEx(exe, IntPtr.Zero, 0x2 | 0x20); // as data file / image resource
    if (h == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      IntPtr res = FindResourceEx(h, (IntPtr)RT_GROUP_ICON, (IntPtr)1, LANG);
      if (res != IntPtr.Zero) {
        IntPtr mem = LockResource(LoadResource(h, res));
        int count = Marshal.ReadInt16(mem, 4);
        for (int i = 0; i < count; i++) ids.Add((ushort)Marshal.ReadInt16(mem, 6 + i * 14 + 12));
      }
    } finally { FreeLibrary(h); }
    return ids;
  }

  static void Pad(BinaryWriter w) { while (w.BaseStream.Position % 4 != 0) w.Write((byte)0); }

  // one node of a VS_VERSIONINFO tree: length, value length, type, key, value, children
  static byte[] Block(string key, int valueLength, int type, byte[] value, List<byte[]> children) {
    var ms = new MemoryStream();
    var w = new BinaryWriter(ms);
    w.Write((ushort)0); w.Write((ushort)valueLength); w.Write((ushort)type);
    w.Write(Encoding.Unicode.GetBytes(key + "\0"));
    Pad(w);
    if (value != null) w.Write(value);
    if (children != null) foreach (var c in children) { Pad(w); w.Write(c); }
    byte[] b = ms.ToArray();
    b[0] = (byte)(b.Length & 0xFF); b[1] = (byte)(b.Length >> 8);
    return b;
  }

  static byte[] VersionInfo(string[] keys, string[] values, int[] v) {
    var fixedInfo = new MemoryStream();
    var f = new BinaryWriter(fixedInfo);
    uint hi = (uint)((v[0] << 16) | v[1]), lo = (uint)((v[2] << 16) | v[3]);
    f.Write(0xFEEF04BDu); f.Write(0x00010000u); f.Write(hi); f.Write(lo); f.Write(hi); f.Write(lo);
    f.Write(0x3Fu); f.Write(0u); f.Write(0x00040004u); f.Write(1u); f.Write(0u); f.Write(0u); f.Write(0u); // NT app
    var strings = new List<byte[]>();
    for (int i = 0; i < keys.Length; i++)
      strings.Add(Block(keys[i], values[i].Length + 1, 1, Encoding.Unicode.GetBytes(values[i] + "\0"), null));
    var table = Block("040904B0", 0, 1, null, strings); // en-US, Unicode
    var stringInfo = Block("StringFileInfo", 0, 1, null, new List<byte[]> { table });
    var translation = Block("Translation", 4, 0, new byte[] { 0x09, 0x04, 0xB0, 0x04 }, null);
    var varInfo = Block("VarFileInfo", 0, 1, null, new List<byte[]> { translation });
    return Block("VS_VERSION_INFO", 52, 0, fixedInfo.ToArray(), new List<byte[]> { stringInfo, varInfo });
  }

  // pngs[i] is the image drawn for sizes[i] (each size is drawn on its own, see make-icon.js)
  public static void Stamp(string exe, string[] pngs, int[] sizes, string[] keys, string[] values, int[] version) {
    var oldIds = OldIconIds(exe);
    var images = new List<byte[]>();
    foreach (string p in pngs) images.Add(File.ReadAllBytes(p));
    var grp = new MemoryStream();
    var g = new BinaryWriter(grp);
    g.Write((ushort)0); g.Write((ushort)1); g.Write((ushort)images.Count);
    for (int i = 0; i < images.Count; i++) {
      byte px = (byte)(sizes[i] >= 256 ? 0 : sizes[i]);
      g.Write(px); g.Write(px); g.Write((byte)0); g.Write((byte)0);
      g.Write((ushort)1); g.Write((ushort)32); g.Write((uint)images[i].Length); g.Write((ushort)(i + 1));
    }
    byte[] ver = VersionInfo(keys, values, version);
    byte[] dir = grp.ToArray();

    IntPtr h = BeginUpdateResource(exe, false);
    if (h == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    bool ok = false;
    try {
      foreach (int id in oldIds) if (id > images.Count) Check(UpdateResource(h, (IntPtr)RT_ICON, (IntPtr)id, LANG, null, 0));
      for (int i = 0; i < images.Count; i++) Check(UpdateResource(h, (IntPtr)RT_ICON, (IntPtr)(i + 1), LANG, images[i], (uint)images[i].Length));
      Check(UpdateResource(h, (IntPtr)RT_GROUP_ICON, (IntPtr)1, LANG, dir, (uint)dir.Length));
      Check(UpdateResource(h, (IntPtr)RT_VERSION, (IntPtr)1, LANG, ver, (uint)ver.Length));
      ok = true;
    } finally {
      bool written = EndUpdateResource(h, !ok);
      if (ok && !written) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@

$electron = (Get-Item (Join-Path $runtime 'electron.exe')).VersionInfo.ProductVersion
$version = [int[]](@(($pkg.version -split '[.+-]')[0..2] | ForEach-Object { [int]$_ }) + 0)
$info = [ordered]@{
  FileDescription  = $pkg.productName   # the name Task Manager shows
  ProductName      = $pkg.productName
  InternalName     = $pkg.productName
  OriginalFilename = 'LocalClaude.exe'
  FileVersion      = $pkg.version
  ProductVersion   = $pkg.version
  Comments         = "Claude on your own API key. Runs on Electron $electron"
}
$pngs = [string[]]($sizes | ForEach-Object { Join-Path $icons "$_.png" })
[AsterStamp]::Stamp($exe, $pngs, $sizes, [string[]]$info.Keys, [string[]]$info.Values, $version)
$vi = (Get-Item $exe).VersionInfo
if ($vi.FileDescription -ne $pkg.productName) { throw "The new name didn't stick (FileDescription is '$($vi.FileDescription)')." }

$mb = [math]::Round((Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Output "Built $exe ($mb MB, Electron $electron)."
