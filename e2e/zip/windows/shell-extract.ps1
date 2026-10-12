<#
.SYNOPSIS
  Extract a zip with Windows Explorer's own zip handler (the shell's
  "Compressed (zipped) Folders", zipfldr.dll), the closest automatable
  stand-in for double-clicking a zip and dragging its contents out.

.DESCRIPTION
  Shell.Application's Folder.CopyHere is asynchronous: it returns at once
  and copies on a background thread of this process, so this script polls
  until the destination holds the expected number of files and bytes and
  every file can be opened exclusively (Explorer no longer writes it), or
  the timeout passes. The process must stay alive until then.

  Exit codes: 0 done, 2 timed out (the caller still compares what is there),
  3 the shell zip handler is missing or could not open the zip.

  Used by run-readers.mjs (reader "explorer"). Keep this file ASCII:
  Windows PowerShell 5.1 reads a script without a BOM as ANSI.

.EXAMPLE
  powershell -NoProfile -STA -File shell-extract.ps1 -Zip C:\t\a.zip -Dest C:\t\out -Files 3 -Bytes 1234
  powershell -NoProfile -STA -File shell-extract.ps1 -Probe
#>
param(
  [string] $Zip,
  [string] $Dest,
  [int] $Files = -1,
  [long] $Bytes = -1,
  [int] $TimeoutSec = 600,
  # Give up early when nothing changes for this long (0: never). Only for
  # small archives: on a big one the handler may work for minutes before the
  # first byte shows up in the destination.
  [int] $StallSec = 0,
  [switch] $Probe
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# CLSID of the "Compressed (zipped) Folder" shell extension (zipfldr.dll).
$CompressedFolder = 'Registry::HKEY_CLASSES_ROOT\CLSID\{E88DCCE0-B7B3-11d1-A9F0-00AA0060FA31}'

function Fail-Handler([string] $Message) {
  [Console]::Error.WriteLine("shell-extract: $Message")
  [Console]::Error.WriteLine('shell-extract: Windows Explorer''s zip handler (zipfldr.dll, "Compressed (zipped) Folders") is needed for this reader. On Server Core or an image without the desktop shell it is missing; this reader cannot run there.')
  exit 3
}

if (-not (Test-Path -LiteralPath $CompressedFolder)) {
  Fail-Handler "the CompressedFolder CLSID is not registered ($CompressedFolder)."
}
try {
  $shell = New-Object -ComObject Shell.Application
} catch {
  Fail-Handler "cannot create Shell.Application: $($_.Exception.Message)"
}

if ($Probe) {
  $os = Get-CimInstance Win32_OperatingSystem
  $dll = Join-Path $env:SystemRoot 'System32\zipfldr.dll'
  $version = if (Test-Path -LiteralPath $dll) { (Get-Item -LiteralPath $dll).VersionInfo.FileVersion } else { 'missing' }
  Write-Output "$($os.Caption) $($os.Version), zipfldr.dll $version"
  exit 0
}

if (-not $Zip -or -not $Dest -or $Files -lt 0 -or $Bytes -lt 0) {
  [Console]::Error.WriteLine('usage: shell-extract.ps1 -Zip <zip> -Dest <dir> -Files <n> -Bytes <n> [-TimeoutSec <s>] [-StallSec <s>] | -Probe')
  exit 64
}

$Zip = [System.IO.Path]::GetFullPath($Zip)
$Dest = [System.IO.Path]::GetFullPath($Dest)
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$source = $shell.NameSpace($Zip)
if ($null -eq $source) { Fail-Handler "Shell.Application.NameSpace() returned nothing for $Zip (the shell does not open it as a folder)." }
$target = $shell.NameSpace($Dest)
if ($null -eq $target) { [Console]::Error.WriteLine("shell-extract: cannot open the destination $Dest"); exit 3 }
$items = $source.Items()
if ($items.Count -eq 0) { Fail-Handler "the shell lists no items in $Zip." }

# 0x4 FOF_SILENT (no progress UI), 0x10 FOF_NOCONFIRMATION (yes to all),
# 0x200 FOF_NOCONFIRMMKDIR, 0x400 FOF_NOERRORUI (an error must not wait for a
# click on an invisible dialog). The zip handler may ignore some of them.
$target.CopyHere($items, 0x614)

function Get-State {
  $found = @(Get-ChildItem -LiteralPath $Dest -Recurse -File -Force -ErrorAction SilentlyContinue)
  $sum = [long] 0
  foreach ($f in $found) { $sum += $f.Length }
  [pscustomobject] @{ Files = $found; Count = $found.Count; Bytes = $sum }
}

function Test-AllClosed($found) {
  foreach ($f in $found) {
    try {
      $stream = [System.IO.File]::Open($f.FullName, 'Open', 'Read', 'None')
      $stream.Dispose()
    } catch {
      return $false
    }
  }
  return $true
}

$started = Get-Date
$deadline = $started.AddSeconds($TimeoutSec)
$last = ''
$lastChange = $started
$lastReport = $started
while ($true) {
  $state = Get-State
  $now = Get-Date
  $key = "$($state.Count)/$($state.Bytes)"
  if ($key -ne $last) { $last = $key; $lastChange = $now }
  if ($state.Count -eq $Files -and $state.Bytes -eq $Bytes -and ($now - $lastChange).TotalSeconds -ge 2 -and (Test-AllClosed $state.Files)) {
    Write-Output ("shell-extract: done in {0:N1} s: {1} files, {2} bytes" -f ($now - $started).TotalSeconds, $state.Count, $state.Bytes)
    exit 0
  }
  if ($StallSec -gt 0 -and ($now - $lastChange).TotalSeconds -ge $StallSec) {
    Write-Output ("shell-extract: nothing changed for {0} s, stopped with {1} of {2} files and {3} of {4} bytes" -f $StallSec, $state.Count, $Files, $state.Bytes, $Bytes)
    exit 2
  }
  if ($now -gt $deadline) {
    Write-Output ("shell-extract: timed out after {0} s with {1} of {2} files and {3} of {4} bytes" -f $TimeoutSec, $state.Count, $Files, $state.Bytes, $Bytes)
    exit 2
  }
  if (($now - $lastReport).TotalSeconds -ge 30) {
    Write-Output ("shell-extract: {0:N0} s: {1} of {2} files, {3} of {4} bytes" -f ($now - $started).TotalSeconds, $state.Count, $Files, $state.Bytes, $Bytes)
    $lastReport = $now
  }
  Start-Sleep -Milliseconds 500
}
