/**
 * The long-lived PowerShell helper (PLAN.md §9.5). Starting PowerShell costs about a second,
 * so one process stays up and answers JSON-line requests on stdin in milliseconds.
 *
 * It only ever asks for metadata: directory listings (names + attributes), GetAttributes, and
 * volume/disk details. Nothing here opens a file, so it cannot trigger a cloud download.
 * The M0 probe confirmed these calls work without admin rights on the owner's PC.
 *
 * Windows PowerShell 5.1 compatible. JavaScriptSerializer (fast) is used where it exists;
 * ConvertTo/From-Json is the fallback (PowerShell 7, used by the tests on Linux).
 */
export const WINDOWS_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$ser = $null
try {
  Add-Type -AssemblyName System.Web.Extensions
  $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $ser.MaxJsonLength = [int]::MaxValue
} catch { $ser = $null }

function To-Json($obj) {
  if ($ser) { return $ser.Serialize($obj) }
  return (ConvertTo-Json -InputObject $obj -Compress -Depth 6)
}
function From-Json([string]$text) {
  if ($ser) { return $ser.DeserializeObject($text) }
  return (ConvertFrom-Json -InputObject $text)
}

$epoch = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)
function Get-Listing([string]$path) {
  # One row per entry: name, attributes, size, modified ms, created ms. All of it comes from
  # the directory listing (FindFirstFile data); no file is opened.
  $entries = (New-Object System.IO.DirectoryInfo($path)).GetFileSystemInfos()
  $out = New-Object System.Collections.ArrayList
  foreach ($e in $entries) {
    $len = 0
    if ($e -is [System.IO.FileInfo]) { $len = [long]$e.Length }
    [void]$out.Add(@(
      $e.Name,
      [int]$e.Attributes,
      $len,
      [long](($e.LastWriteTimeUtc - $epoch).TotalMilliseconds),
      [long](($e.CreationTimeUtc - $epoch).TotalMilliseconds)
    ))
  }
  return ,$out.ToArray()
}

function Get-VolumeDetails([string]$path) {
  $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($path))
  $r = @{ root = $root; letter = $null; volumeId = $null; serial = $null; label = $null; driveType = $null; busType = $null; fileSystem = $null }
  $m = [regex]::Match($root, '^([A-Za-z]):\\?$')
  if (-not $m.Success) { return $r }
  $letter = $m.Groups[1].Value.ToUpperInvariant()
  $r.letter = $letter
  try {
    $v = Get-CimInstance -ClassName Win32_Volume -Filter ("DriveLetter='" + $letter + ":'") | Select-Object -First 1
    if ($v) {
      $r.volumeId = [string]$v.DeviceID
      if ($null -ne $v.SerialNumber) { $r.serial = ('{0:X8}' -f [uint32]$v.SerialNumber) }
      $r.label = [string]$v.Label
      $r.driveType = [int]$v.DriveType
      $r.fileSystem = [string]$v.FileSystem
    }
  } catch { }
  try {
    $disk = Get-Partition -DriveLetter $letter | Get-Disk
    $r.busType = [string]$disk.BusType
  } catch { }
  return $r
}

function Find-VolumeLetter([string]$volumeId) {
  $v = Get-CimInstance -ClassName Win32_Volume | Where-Object { $_.DeviceID -eq $volumeId } | Select-Object -First 1
  if ($v -and $v.DriveLetter) { return ([string]$v.DriveLetter + '\') }
  return $null
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = $null
  try {
    $req = From-Json $line
    $id = $req.id
    $result = $null
    switch ([string]$req.op) {
      'list'   { $result = Get-Listing ([string]$req.path) }
      'file'   { $result = [int][System.IO.File]::GetAttributes([string]$req.path) }
      'volume' { $result = Get-VolumeDetails ([string]$req.path) }
      'find'   { $result = Find-VolumeLetter ([string]$req.volumeId) }
      'ping'   { $result = 'pong' }
      default  { throw ('unknown op ' + $req.op) }
    }
    [Console]::Out.WriteLine((To-Json @{ id = $id; ok = $true; result = $result }))
  } catch {
    [Console]::Out.WriteLine((To-Json @{ id = $id; ok = $false; error = $_.Exception.Message }))
  }
  [Console]::Out.Flush()
}
`;
