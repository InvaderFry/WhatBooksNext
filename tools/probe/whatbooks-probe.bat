@echo off
rem ===========================================================================
rem  whatBooksNext - Milestone 0 Windows probe
rem
rem  READ-ONLY. This script:
rem    - lists the folders you name and reads file NAMES, SIZES, DATES and
rem      ATTRIBUTES only. It never opens, reads, copies, moves, renames or
rem      changes any file in them, and never creates anything in them.
rem    - never reads the contents of online-only iCloud files, so it cannot
rem      trigger a download.
rem    - writes exactly one file: a plain-text report next to this script
rem      (or, if this script sits inside one of your library folders, on your
rem      Desktop instead).
rem    - sends nothing anywhere. You decide what to share.
rem
rem  It runs PowerShell with "-NoProfile -ExecutionPolicy Bypass" for THIS
rem  script only. That does not change any setting on your PC; it just lets
rem  the PowerShell part below run without being signed.
rem
rem  The PowerShell part is plain text at the bottom of this file, so you can
rem  read exactly what it does before running it.
rem ===========================================================================

setlocal
set "WBP_SELF=%~f0"
set "WBP_DIR=%~dp0"
title whatBooksNext probe

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:WBP_SELF); $m='#'+'#PS-BEGIN'; $i=$s.IndexOf($m); if($i -lt 0){Write-Host 'Could not find the PowerShell part of this file.'; exit 1}; & ([ScriptBlock]::Create($s.Substring($i)))"

echo.
pause
endlocal
goto :eof

##PS-BEGIN
# ---------------------------------------------------------------------------
# PowerShell part. Windows PowerShell 5.1 compatible (no PowerShell 7 syntax).
# Only metadata calls are used: directory listing (names, sizes, dates,
# attributes) and GetAttributes. Nothing here opens a file's contents.
# ---------------------------------------------------------------------------

$ProbeVersion = '1'

# Formats the app will handle (PLAN.md section 9.1). Everything else is only counted.
$BookExts = @('.epub', '.pdf', '.cbz', '.cbr', '.mobi', '.azw3', '.cb7')

# Windows file attribute bits. .NET's FileAttributes enum has no names for the
# recall bits, so PowerShell would print them as a bare number; we name them here.
$AttrBits = @(
    @{ Bit = 0x00000001; Name = 'ReadOnly' },
    @{ Bit = 0x00000002; Name = 'Hidden' },
    @{ Bit = 0x00000004; Name = 'System' },
    @{ Bit = 0x00000010; Name = 'Directory' },
    @{ Bit = 0x00000020; Name = 'Archive' },
    @{ Bit = 0x00000040; Name = 'Device' },
    @{ Bit = 0x00000080; Name = 'Normal' },
    @{ Bit = 0x00000100; Name = 'Temporary' },
    @{ Bit = 0x00000200; Name = 'SparseFile' },
    @{ Bit = 0x00000400; Name = 'ReparsePoint' },
    @{ Bit = 0x00000800; Name = 'Compressed' },
    @{ Bit = 0x00001000; Name = 'Offline' },
    @{ Bit = 0x00002000; Name = 'NotContentIndexed' },
    @{ Bit = 0x00004000; Name = 'Encrypted' },
    @{ Bit = 0x00008000; Name = 'IntegrityStream' },
    @{ Bit = 0x00010000; Name = 'Virtual' },
    @{ Bit = 0x00020000; Name = 'NoScrubData' },
    @{ Bit = 0x00040000; Name = 'RecallOnOpen' },
    @{ Bit = 0x00080000; Name = 'Pinned' },
    @{ Bit = 0x00100000; Name = 'Unpinned' },
    @{ Bit = 0x00400000; Name = 'RecallOnDataAccess' }
)
$BIT_RECALL_ON_DATA_ACCESS = 0x00400000
$BIT_RECALL_ON_OPEN        = 0x00040000
$BIT_OFFLINE               = 0x00001000
$BIT_PINNED                = 0x00080000
$BIT_UNPINNED              = 0x00100000
$BIT_REPARSE               = 0x00000400
$BIT_DIRECTORY             = 0x00000010
# PLAN.md 9.5: any of these three bits means "placeholder" (online-only).
$PlaceholderMask = $BIT_RECALL_ON_DATA_ACCESS -bor $BIT_RECALL_ON_OPEN -bor $BIT_OFFLINE

# Quality tags ignored when comparing names (PLAN.md 11.1).
$QualityTagRegex = '(?<![a-z0-9])(?:hd|hq|hi-?res|high-?res)(?![a-z0-9])'

$Report = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$text = '') { [void]$Report.Add($text) }
function Add-Heading([string]$text) {
    Add-Line ''
    Add-Line ('=' * 78)
    Add-Line $text
    Add-Line ('=' * 78)
}

function Get-AttrNames([long]$value) {
    $names = @()
    foreach ($b in $AttrBits) { if (($value -band $b.Bit) -ne 0) { $names += $b.Name } }
    $known = 0
    foreach ($b in $AttrBits) { $known = $known -bor $b.Bit }
    $rest = $value -band (-bnot [long]$known)
    if ($rest -ne 0) { $names += ('unnamed 0x{0:X}' -f $rest) }
    if ($names.Count -eq 0) { return '(none)' }
    return ($names -join ', ')
}

function Get-StateName([long]$attr) {
    if (($attr -band $PlaceholderMask) -ne 0) { return 'placeholder' }
    return 'local'
}

function Format-Attr([long]$value) { return ('0x{0:X8} ({1})' -f $value, $value) }

function Clean-PathInput([string]$text) {
    if ($null -eq $text) { return '' }
    $t = $text.Trim()
    # Drag-and-drop and "Copy as path" wrap the path in double quotes.
    if ($t.Length -ge 2 -and $t.StartsWith('"') -and $t.EndsWith('"')) { $t = $t.Substring(1, $t.Length - 2) }
    return $t.Trim()
}

function Normalize-Dir([string]$path) {
    $full = [System.IO.Path]::GetFullPath($path)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { $full = $full.TrimEnd('\', '/') }
    return $full
}

function Test-IsUnder([string]$child, [string]$parent) {
    $c = $child.Replace('/', '\').TrimEnd('\') + '\'
    $p = $parent.Replace('/', '\').TrimEnd('\') + '\'
    return $c.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)
}

function Ask-YesNo([string]$question, [bool]$default) {
    $hint = '(y/N)'
    if ($default) { $hint = '(Y/n)' }
    $a = Read-Host "$question $hint"
    if ($null -eq $a) { return $default }
    $a = $a.Trim().ToLowerInvariant()
    if ($a -eq '') { return $default }
    return ($a -eq 'y' -or $a -eq 'yes')
}

function Get-Pct([double]$part, [double]$whole) {
    if ($whole -le 0) { return '-' }
    return ('{0:0.0}%' -f (100.0 * $part / $whole))
}

function Get-BaseInfo([string]$name) {
    $base = [System.IO.Path]::GetFileNameWithoutExtension($name).ToLowerInvariant()
    $hasTag = [regex]::IsMatch($base, $QualityTagRegex)
    $stripped = $base
    if ($hasTag) { $stripped = [regex]::Replace($base, $QualityTagRegex, '') }
    $key = [regex]::Replace($stripped, '[^\p{L}\p{N}]', '')
    if ($key -eq '') { $key = [regex]::Replace($base, '[^\p{L}\p{N}]', '') }
    return New-Object psobject -Property @{ Key = $key; HasTag = $hasTag }
}

# ---------------------------------------------------------------------------
# Volume / drive identity (PLAN.md 9.4)
# ---------------------------------------------------------------------------
function Get-VolumeLines([string]$path) {
    $lines = @()
    $pathRoot = [System.IO.Path]::GetPathRoot($path)
    $m = [regex]::Match($pathRoot, '^([A-Za-z]):\\?$')
    if (-not $m.Success) {
        $lines += "  Drive letter:        none (network or UNC path: $(if ($pathRoot.StartsWith('\\')) { 'network share' } else { 'unknown' }))"
        return $lines
    }
    $letter = $m.Groups[1].Value.ToUpperInvariant()
    $lines += "  Drive letter:        $($letter):"

    try {
        $v = Get-CimInstance -ClassName Win32_Volume -Filter "DriveLetter='$($letter):'" -ErrorAction Stop | Select-Object -First 1
        if ($v) {
            $types = @{ 0 = 'unknown'; 1 = 'no root directory'; 2 = 'removable'; 3 = 'fixed (local)'; 4 = 'network'; 5 = 'CD/DVD'; 6 = 'RAM disk' }
            $serial = '-'
            if ($null -ne $v.SerialNumber) { $serial = ('{0:X8}' -f [uint32]$v.SerialNumber) }
            $lines += "  Volume label:        $(if ($v.Label) { $v.Label } else { '(no label)' })"
            $lines += "  Volume id (GUID):    $($v.DeviceID)"
            $lines += "  Volume serial:       $serial"
            $lines += "  Drive type:          $($types[[int]$v.DriveType]) [$($v.DriveType)]"
            $lines += "  File system:         $($v.FileSystem)"
            if ($v.Capacity) { $lines += ('  Capacity:            {0:0.0} GB' -f ($v.Capacity / 1GB)) }
        } else {
            $lines += '  Win32_Volume:        no entry for this letter'
        }
    } catch {
        $lines += "  Win32_Volume:        not available ($($_.Exception.Message))"
    }

    try {
        $vol = Get-Volume -DriveLetter $letter -ErrorAction Stop
        $lines += "  Get-Volume UniqueId: $($vol.UniqueId)"
        $lines += "  Get-Volume type:     $($vol.DriveType)"
    } catch {
        $lines += "  Get-Volume:          not available ($($_.Exception.Message))"
    }

    try {
        $part = Get-Partition -DriveLetter $letter -ErrorAction Stop
        $disk = $part | Get-Disk -ErrorAction Stop
        $lines += "  Partition GUID:      $(if ($part.Guid) { $part.Guid } else { '(none - MBR disk)' })"
        $lines += "  Disk bus type:       $($disk.BusType)"
        $lines += "  Disk partition style: $($disk.PartitionStyle)"
    } catch {
        $lines += "  Partition/disk info: not available ($($_.Exception.Message))"
    }
    return $lines
}

# ---------------------------------------------------------------------------
# Folder listing. Uses DirectoryInfo.GetFileSystemInfos(), which returns names,
# sizes, dates and attributes from the directory listing itself. It never opens
# a file, so it cannot trigger an iCloud download.
# ---------------------------------------------------------------------------
function Get-LinkType($entry) {
    try { return [string]$entry.LinkType } catch { return '' }
}

function Scan-Root([string]$root, $seenPaths) {
    $result = New-Object psobject -Property @{
        Files = (New-Object System.Collections.Generic.List[object])
        DirsListed = 0
        DirErrors = @{}
        LinksSkipped = 0
        ReparseDirsFollowed = 0
        DuplicatePathsSkipped = 0
        DepthLimitHits = 0
        StoppedAtDirCap = $false
        Seconds = 0.0
    }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $stack = New-Object System.Collections.Generic.Stack[object]
    $stack.Push(@($root, 0))
    $lastShown = 0
    while ($stack.Count -gt 0) {
        $item = $stack.Pop()
        $dir = $item[0]; $depth = $item[1]
        try {
            $entries = (New-Object System.IO.DirectoryInfo($dir)).GetFileSystemInfos()
        } catch {
            $kind = $_.Exception.GetType().Name
            if ($_.Exception.InnerException) { $kind = $_.Exception.InnerException.GetType().Name }
            $result.DirErrors[$kind] = 1 + $result.DirErrors[$kind]
            continue
        }
        $result.DirsListed++
        # Belt and braces against link loops we could not recognise.
        if ($result.DirsListed -ge 200000) { $result.StoppedAtDirCap = $true; break }
        foreach ($e in $entries) {
            $attr = [long][int]$e.Attributes
            if (($attr -band $BIT_DIRECTORY) -ne 0) {
                if (($attr -band $BIT_REPARSE) -ne 0) {
                    # Junctions and symlinks are skipped (loop protection). Other reparse
                    # directories (cloud-sync placeholders, e.g. iCloud folders) are followed.
                    $lt = Get-LinkType $e
                    if ($lt -eq 'Junction' -or $lt -eq 'SymbolicLink') { $result.LinksSkipped++; continue }
                    $result.ReparseDirsFollowed++
                }
                if ($depth -ge 64) { $result.DepthLimitHits++; continue }
                $stack.Push(@($e.FullName, ($depth + 1)))
                continue
            }
            if (-not $seenPaths.Add($e.FullName)) { $result.DuplicatePathsSkipped++; continue }
            $result.Files.Add((New-Object psobject -Property @{
                Root = $root
                Dir = $dir
                Name = $e.Name
                FullLength = $e.FullName.Length
                Ext = $e.Extension.ToLowerInvariant()
                Size = [long]$e.Length
                Attr = $attr
                Modified = $e.LastWriteTime
                Created = $e.CreationTime
            }))
        }
        if ($result.Files.Count - $lastShown -ge 2000) {
            $lastShown = $result.Files.Count
            Write-Host ("    ... {0} files so far" -f $lastShown)
        }
    }
    $sw.Stop()
    $result.Seconds = $sw.Elapsed.TotalSeconds
    return $result
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
$started = Get-Date
$fatal = $null
$roots = New-Object System.Collections.Generic.List[string]
$unreachable = New-Object System.Collections.Generic.List[string]
$scans = @{}
$allFiles = New-Object System.Collections.Generic.List[object]
$onlineChecks = @()
$includeSample = $false

Write-Host ''
Write-Host 'whatBooksNext - Windows probe (read-only)'
Write-Host '-----------------------------------------'
Write-Host 'This looks at file names, sizes, dates and attributes in your library folders.'
Write-Host 'It never opens your files and never downloads anything from iCloud.'
Write-Host 'It writes one plain-text report, which you can read before sharing.'
Write-Host ''

try {
    # --- 1. Library folders --------------------------------------------------
    Write-Host 'Step 1 of 4: your library folders.'
    Write-Host 'Type or paste each folder where your ebooks and comics live (external drive,'
    Write-Host 'iCloud Drive, anywhere else). You can also drag a folder into this window.'
    Write-Host 'Press Enter on an empty line when you have added them all.'
    Write-Host ''
    while ($true) {
        $raw = Read-Host ("Folder {0} (or just Enter when done)" -f ($roots.Count + $unreachable.Count + 1))
        $in = Clean-PathInput $raw
        if ($in -eq '') {
            if ($roots.Count -gt 0) { break }
            if ($null -eq $raw) { break }  # no more input at all
            Write-Host '  Please add at least one folder that exists.'
            continue
        }
        if (-not [System.IO.Directory]::Exists($in)) {
            Write-Host '  Cannot find that folder right now (drive not connected, or a typo?).'
            Write-Host '  It will be listed in the report as "not reachable".'
            $unreachable.Add($in)
            continue
        }
        $norm = Normalize-Dir $in
        $dup = $false
        foreach ($r in $roots) { if ([string]::Equals($r, $norm, [System.StringComparison]::OrdinalIgnoreCase)) { $dup = $true } }
        if ($dup) { Write-Host '  Already added.'; continue }
        $roots.Add($norm)
        Write-Host "  Added."
    }
    if ($roots.Count -eq 0) { throw 'No reachable folders were given, so there is nothing to look at.' }

    # --- 2. List the folders -------------------------------------------------
    Write-Host ''
    Write-Host 'Step 2 of 4: listing files (names, sizes, dates, attributes only)...'
    $seenPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $n = 0
    foreach ($r in $roots) {
        $n++
        Write-Host ("  Folder {0} of {1}" -f $n, $roots.Count)
        $scan = Scan-Root $r $seenPaths
        $scans[$r] = $scan
        foreach ($f in $scan.Files) { $allFiles.Add($f) }
        Write-Host ("    {0} files in {1:0.0} s" -f $scan.Files.Count, $scan.Seconds)
    }

    # --- 3. Known online-only files ------------------------------------------
    Write-Host ''
    Write-Host 'Step 3 of 4: files you know are online-only in iCloud.'
    Write-Host 'Pick 2-3 files that show a CLOUD icon (not a green tick) in File Explorer.'
    Write-Host 'To get a path: Shift + right-click the file, choose "Copy as path", paste here.'
    Write-Host 'Only the file attributes are read - the file is not opened or downloaded.'
    Write-Host 'If you do not use iCloud, just press Enter to skip.'
    Write-Host ''
    $checkPaths = @()
    for ($k = 1; $k -le 3; $k++) {
        $p = Clean-PathInput (Read-Host ("Online-only file {0} (or just Enter to skip)" -f $k))
        if ($p -eq '') { break }
        $checkPaths += $p
    }
    foreach ($p in $checkPaths) {
        $c = New-Object psobject -Property @{ Path = $p; Ext = [System.IO.Path]::GetExtension($p).ToLowerInvariant(); Found = $false; Before = $null; After = $null; Error = $null; InLibrary = $false }
        foreach ($r in $roots) { if (Test-IsUnder $p $r) { $c.InLibrary = $true } }
        try {
            # File.Exists and File.GetAttributes only ask for metadata; neither opens the file.
            if ([System.IO.File]::Exists($p)) {
                $c.Found = $true
                $c.Before = [long][int][System.IO.File]::GetAttributes($p)
            }
        } catch { $c.Error = $_.Exception.Message }
        $onlineChecks += $c
    }
    if (@($onlineChecks | Where-Object { $_.Found }).Count -gt 0) {
        Write-Host '  Waiting 10 seconds, then checking the files are still online-only...'
        Start-Sleep -Seconds 10
        foreach ($c in $onlineChecks) {
            if (-not $c.Found) { continue }
            try { $c.After = [long][int][System.IO.File]::GetAttributes($c.Path) } catch { $c.Error = $_.Exception.Message }
        }
    }

    # --- 4. Optional filename sample -----------------------------------------
    Write-Host ''
    Write-Host 'Step 4 of 4: optional filename sample.'
    Write-Host 'A random sample of up to 300 book filenames (names only, no folders) helps'
    Write-Host 'test the filename parser. You can edit or delete them in the report before sharing.'
    $includeSample = Ask-YesNo 'Add the sample to the report?' $false
} catch {
    $fatal = $_.Exception.Message
}

# ---------------------------------------------------------------------------
# Build the report
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'Writing the report...'

Add-Line 'whatBooksNext - Windows probe report'
Add-Line ("Probe version {0}, run {1}" -f $ProbeVersion, $started.ToString('yyyy-MM-dd HH:mm'))
Add-Line ''
Add-Line 'This report contains counts, attribute numbers and drive details. It contains no'
Add-Line 'file or folder names, except the optional filename sample at the very end.'
Add-Line 'Read it through, edit or delete anything you prefer to keep private, then paste'
Add-Line 'it into the chat.'

if ($fatal) {
    Add-Line ''
    Add-Line "NOTE: the probe stopped early: $fatal"
}

Add-Heading '1. This PC'
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    Add-Line "Windows:            $($os.Caption) (build $($os.BuildNumber))"
} catch { Add-Line "Windows:            $([Environment]::OSVersion.VersionString)" }
Add-Line "PowerShell:         $($PSVersionTable.PSVersion)"
Add-Line "CPU cores:          $([Environment]::ProcessorCount)"
try {
    $lp = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction Stop).LongPathsEnabled
    Add-Line "Long paths enabled: $(if ($lp -eq 1) { 'yes' } else { 'no' })"
} catch { Add-Line 'Long paths enabled: unknown (setting not present - usually means no)' }
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $nodeVer = '?'
    try { $nodeVer = (& node --version 2>$null) } catch { }
    Add-Line "Node.js:            $nodeVer"
} else { Add-Line 'Node.js:            not installed (needed from Milestone 1 - you will be told when)' }
$icloudProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(iCloudDrive|iCloudServices|iCloudHome|iCloud)$' } | ForEach-Object { $_.ProcessName } | Sort-Object -Unique)
Add-Line "iCloud running:     $(if ($icloudProcs.Count -gt 0) { 'yes (' + ($icloudProcs -join ', ') + ')' } else { 'no iCloud process found' })"
$defaultICloud = ''
if ($env:USERPROFILE) { $defaultICloud = Join-Path $env:USERPROFILE 'iCloudDrive' }
Add-Line "Default iCloud Drive folder exists: $(if ($defaultICloud -and [System.IO.Directory]::Exists($defaultICloud)) { 'yes' } else { 'no' })"
$oneDriveSet = [bool]$env:OneDrive
Add-Line "OneDrive configured: $(if ($oneDriveSet) { 'yes' } else { 'no' })"

Add-Heading '2. Folders'
if ($unreachable.Count -gt 0) {
    Add-Line "$($unreachable.Count) folder(s) you named could not be reached (drive not connected or typo)."
    Add-Line 'They were skipped, not treated as empty.'
    $u = 0
    foreach ($p in $unreachable) {
        $u++
        $pr = [System.IO.Path]::GetPathRoot($p)
        Add-Line ("  Unreachable folder {0}: drive part '{1}'" -f $u, $pr)
    }
    Add-Line ''
}
$fi = 0
$overlaps = 0
foreach ($r in $roots) { foreach ($r2 in $roots) { if ($r -ne $r2 -and (Test-IsUnder $r $r2)) { $overlaps++ } } }
if ($overlaps -gt 0) { Add-Line "$overlaps folder(s) sit inside another folder you named; their files were counted once." ; Add-Line '' }

foreach ($r in $roots) {
    $fi++
    $scan = $scans[$r]
    Add-Line ("--- Folder {0} " -f $fi + ('-' * 60))
    foreach ($l in (Get-VolumeLines $r)) { Add-Line $l }
    $isDefaultICloud = $false
    if ($defaultICloud) { $isDefaultICloud = Test-IsUnder $r $defaultICloud }
    Add-Line "  Inside default iCloud Drive folder: $(if ($isDefaultICloud) { 'yes' } else { 'no' })"
    try {
        $rootAttr = [long][int][System.IO.File]::GetAttributes($r)
        Add-Line "  Folder's own attributes: $(Format-Attr $rootAttr) = $(Get-AttrNames $rootAttr)"
    } catch { Add-Line "  Folder's own attributes: could not read ($($_.Exception.Message))" }
    Add-Line "  Path length:        $($r.Length) characters"
    if ($null -eq $scan) { Add-Line '  (not listed - the probe stopped before this folder)'; continue }

    $files = $scan.Files
    $books = @($files | Where-Object { $BookExts -contains $_.Ext })
    Add-Line ''
    Add-Line ("  Directories listed: {0}" -f $scan.DirsListed)
    if ($scan.DirErrors.Count -gt 0) {
        $errText = ($scan.DirErrors.GetEnumerator() | ForEach-Object { "$($_.Key) x$($_.Value)" }) -join ', '
        Add-Line "  Directories that could not be listed: $errText"
    } else { Add-Line '  Directories that could not be listed: none' }
    Add-Line ("  Junctions/symlinks skipped: {0};  cloud/other reparse folders followed: {1}" -f $scan.LinksSkipped, $scan.ReparseDirsFollowed)
    if ($scan.DuplicatePathsSkipped -gt 0) { Add-Line ("  Files already counted under another folder: {0}" -f $scan.DuplicatePathsSkipped) }
    if ($scan.StoppedAtDirCap) { Add-Line '  STOPPED after 200,000 directories (possible folder loop) - counts are partial.' }
    if ($scan.DepthLimitHits -gt 0) { Add-Line ("  Folders deeper than 64 levels not listed: {0}" -f $scan.DepthLimitHits) }
    $rate = 0
    if ($scan.Seconds -gt 0) { $rate = $files.Count / $scan.Seconds }
    Add-Line ("  Listing time:       {0:0.0} s for {1} files ({2:0} files/s, PowerShell - not the app)" -f $scan.Seconds, $files.Count, $rate)

    Add-Line ''
    Add-Line '  Files by type:'
    $byExt = @{}
    foreach ($f in $files) { $k = $f.Ext; if ($k -eq '') { $k = '(no extension)' }; $byExt[$k] = 1 + $byExt[$k] }
    foreach ($e in $BookExts) { Add-Line ("    {0,-8} {1,7}" -f $e, [int]$byExt[$e]) }
    $others = @($byExt.GetEnumerator() | Where-Object { $BookExts -notcontains $_.Key } | Sort-Object Value -Descending)
    $otherTotal = 0; foreach ($o in $others) { $otherTotal += $o.Value }
    Add-Line ("    other    {0,7}  (top: {1})" -f $otherTotal, (($others | Select-Object -First 10 | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ', '))

    Add-Line ''
    Add-Line '  Book files by state (by the plan''s rule: RecallOnDataAccess, RecallOnOpen or'
    Add-Line '  Offline set = placeholder / online-only):'
    $ph = @($books | Where-Object { ($_.Attr -band $PlaceholderMask) -ne 0 })
    Add-Line ("    local (on this PC): {0}" -f ($books.Count - $ph.Count))
    Add-Line ("    placeholder:        {0}" -f $ph.Count)
    Add-Line ("      with RecallOnDataAccess: {0}" -f @($books | Where-Object { ($_.Attr -band $BIT_RECALL_ON_DATA_ACCESS) -ne 0 }).Count)
    Add-Line ("      with RecallOnOpen:       {0}" -f @($books | Where-Object { ($_.Attr -band $BIT_RECALL_ON_OPEN) -ne 0 }).Count)
    Add-Line ("      with Offline:            {0}" -f @($books | Where-Object { ($_.Attr -band $BIT_OFFLINE) -ne 0 }).Count)
    Add-Line ("    with Pinned (always keep on this device): {0}" -f @($books | Where-Object { ($_.Attr -band $BIT_PINNED) -ne 0 }).Count)
    Add-Line ("    with Unpinned (free up space requested):  {0}" -f @($books | Where-Object { ($_.Attr -band $BIT_UNPINNED) -ne 0 }).Count)
    Add-Line ("    with ReparsePoint:                        {0}" -f @($books | Where-Object { ($_.Attr -band $BIT_REPARSE) -ne 0 }).Count)
    Add-Line ("    placeholders reporting size 0:            {0}" -f @($ph | Where-Object { $_.Size -eq 0 }).Count)
    Add-Line ("    local files with size 0:                  {0}" -f @($books | Where-Object { $_.Size -eq 0 -and ($_.Attr -band $PlaceholderMask) -eq 0 }).Count)

    Add-Line ''
    Add-Line '  Raw attribute values on book files (most common first):'
    $byAttr = @{}
    foreach ($b in $books) { $byAttr[[string]$b.Attr] = 1 + $byAttr[[string]$b.Attr] }
    $attrRows = @($byAttr.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 15)
    if ($attrRows.Count -eq 0) { Add-Line '    (no book files)' }
    foreach ($row in $attrRows) {
        $v = [long]$row.Key
        Add-Line ("    {0,6} files  {1}  -> {2}  [{3}]" -f $row.Value, (Format-Attr $v), (Get-StateName $v), (Get-AttrNames $v))
    }

    Add-Line ''
    Add-Line '  File dates on book files (for the "bulk copy" rule, PLAN.md 13.7):'
    if ($books.Count -gt 0) {
        $mDays = @{}; $cDays = @{}; $createdAfter = 0
        foreach ($b in $books) {
            $mDays[$b.Modified.ToString('yyyy-MM-dd')] = 1 + $mDays[$b.Modified.ToString('yyyy-MM-dd')]
            $cDays[$b.Created.ToString('yyyy-MM-dd')] = 1 + $cDays[$b.Created.ToString('yyyy-MM-dd')]
            if ($b.Created -gt $b.Modified) { $createdAfter++ }
        }
        $topM = $mDays.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1
        $topC = $cDays.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1
        Add-Line ("    Most common modified day covers {0} of book files" -f (Get-Pct $topM.Value $books.Count))
        Add-Line ("    Most common created day covers  {0} of book files" -f (Get-Pct $topC.Value $books.Count))
        Add-Line ("    Created later than modified (typical of copied files): {0}" -f (Get-Pct $createdAfter $books.Count))
        $bigDirs = 0; $bulkDirs = 0
        foreach ($g in ($books | Group-Object Dir)) {
            if ($g.Count -lt 10) { continue }
            $bigDirs++
            $top = ($g.Group | Group-Object { $_.Modified.ToString('yyyy-MM-dd') } | Sort-Object Count -Descending | Select-Object -First 1).Count
            if ($top -gt ($g.Count / 2)) { $bulkDirs++ }
        }
        Add-Line ("    Directories with 10+ book files: {0}; of those, where over half share one modified day: {1}" -f $bigDirs, $bulkDirs)
    } else { Add-Line '    (no book files)' }
    Add-Line ''
}

# --- Copies and format groups across everything ------------------------------
$allBooks = @($allFiles | Where-Object { $BookExts -contains $_.Ext })

Add-Heading '3. Copies across folders (PLAN.md 11.3 rule 1)'
Add-Line 'A "copy" here = the same filename (ignoring case) with exactly the same size,'
Add-Line 'in more than one directory. Only book files are counted.'
$copyGroups = @($allBooks | Group-Object { $_.Name.ToLowerInvariant() + '|' + $_.Size } | Where-Object { @($_.Group | ForEach-Object { $_.Dir.ToLowerInvariant() } | Sort-Object -Unique).Count -gt 1 })
$copyFiles = 0; $copyMixed = 0; $copy3 = 0; $copyAcrossRoots = 0
foreach ($g in $copyGroups) {
    $copyFiles += $g.Count
    if ($g.Count -ge 3) { $copy3++ }
    $states = @($g.Group | ForEach-Object { Get-StateName $_.Attr } | Sort-Object -Unique)
    if ($states.Count -gt 1) { $copyMixed++ }
    if (@($g.Group | ForEach-Object { $_.Root } | Sort-Object -Unique).Count -gt 1) { $copyAcrossRoots++ }
}
Add-Line ("  Name+size groups found in more than one directory: {0} (covering {1} files)" -f $copyGroups.Count, $copyFiles)
Add-Line ("    ... spanning two or more of the folders you named:   {0}" -f $copyAcrossRoots)
Add-Line ("    ... where one copy is online-only and another local: {0}" -f $copyMixed)
Add-Line ("    ... with three or more copies:                       {0}" -f $copy3)
$sameNameDiffSize = @($allBooks | Group-Object { $_.Name.ToLowerInvariant() } | Where-Object {
    @($_.Group | ForEach-Object { $_.Dir.ToLowerInvariant() } | Sort-Object -Unique).Count -gt 1 -and
    @($_.Group | ForEach-Object { $_.Size } | Sort-Object -Unique).Count -gt 1 })
Add-Line ("  Same filename in several directories but with DIFFERENT sizes: {0}" -f $sameNameDiffSize.Count)

Add-Heading '4. Same book in several formats (PLAN.md 11.3 rules 2 and 3)'
Add-Line 'Base name = filename without extension, lowercased, punctuation removed, and'
Add-Line 'quality tags (HD, HQ, hi-res, highres) removed.'
foreach ($b in $allBooks) {
    $bi = Get-BaseInfo $b.Name
    $b | Add-Member -NotePropertyName BaseKey -NotePropertyValue $bi.Key -Force
    $b | Add-Member -NotePropertyName HasTag -NotePropertyValue $bi.HasTag -Force
}
$fmtGroups = @($allBooks | Group-Object { $_.Dir.ToLowerInvariant() + '|' + $_.BaseKey } | Where-Object { $_.Count -gt 1 })
$combos = @{}; $tagGroups = 0; $sameExtTwice = 0
foreach ($g in $fmtGroups) {
    $exts = @($g.Group | ForEach-Object { $_.Ext })
    $combo = (@($exts | Sort-Object) -join '+')
    $combos[$combo] = 1 + $combos[$combo]
    if (@($g.Group | Where-Object { $_.HasTag }).Count -gt 0) { $tagGroups++ }
    if (@($exts | Sort-Object -Unique).Count -lt $exts.Count) { $sameExtTwice++ }
}
Add-Line ("  Same directory, same base name, 2+ book files: {0} groups" -f $fmtGroups.Count)
foreach ($c in ($combos.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 15)) {
    Add-Line ("    {0,-28} {1,6}" -f $c.Key, $c.Value)
}
Add-Line ("  Groups that include a quality-tagged file (e.g. HD): {0}" -f $tagGroups)
Add-Line ("  Groups with the same extension twice (e.g. HD + standard .cbz): {0}" -f $sameExtTwice)
Add-Line ("  Book files with a quality tag in the name: {0}" -f @($allBooks | Where-Object { $_.HasTag }).Count)

$crossSuggest = 0; $crossPure = 0
foreach ($g in ($allBooks | Group-Object BaseKey)) {
    $dirs = @($g.Group | Group-Object { $_.Dir.ToLowerInvariant() })
    if ($dirs.Count -lt 2) { continue }
    $sigs = @($dirs | ForEach-Object { (@($_.Group | ForEach-Object { $_.Name.ToLowerInvariant() + '|' + $_.Size } | Sort-Object) -join ';') } | Sort-Object -Unique)
    if ($sigs.Count -eq 1) { $crossPure++ } else { $crossSuggest++ }
}
Add-Line ("  Base names found in more than one directory: {0}" -f ($crossPure + $crossSuggest))
Add-Line ("    ... identical sets of files (pure copies):                 {0}" -f $crossPure)
Add-Line ("    ... different formats or sizes (would be review suggestions): {0}" -f $crossSuggest)

Add-Heading '5. Filename shapes (book files, no names shown)'
$shapeTotal = $allBooks.Count
$shapes = [ordered]@{
    'contains spaces'                       = { param($n) $n.Contains(' ') }
    'contains underscores'                  = { param($n) $n.Contains('_') }
    'run-together lowercase (no separators)' = { param($n) $n -cmatch '^[a-z0-9]+$' }
    'run-together with capitals'            = { param($n) ($n -cmatch '^[A-Za-z0-9]+$') -and ($n -cmatch '[A-Z]') }
    'has " - " (Author - Title style)'      = { param($n) $n.Contains(' - ') }
    'has ( ) or [ ] tags'                   = { param($n) $n -match '[\(\[]' }
    'has a year (19xx/20xx)'                = { param($n) $n -match '(?<!\d)(19|20)\d\d(?!\d)' }
    'has a volume marker (vol1, v01, Vol. 1)' = { param($n) $n -match '(?i)(?<![a-z])(vol\.?\s*\d+|v\d{1,3})(?![a-z])' }
    'has an issue-like number (#1, 001)'    = { param($n) $n -match '#\d+|(?<![\d.])\d{3}(?!\d)' }
    'has non-English (non-ASCII) letters'   = { param($n) $n -match '[^\x00-\x7F]' }
}
foreach ($s in $shapes.GetEnumerator()) {
    $cnt = 0
    foreach ($b in $allBooks) { $base = [System.IO.Path]::GetFileNameWithoutExtension($b.Name); if (& $s.Value $base) { $cnt++ } }
    Add-Line ("  {0,-42} {1,6}  ({2})" -f $s.Key, $cnt, (Get-Pct $cnt $shapeTotal))
}
$long = @($allFiles | Where-Object { $_.FullLength -ge 260 }).Count
$maxLen = 0; foreach ($f in $allFiles) { if ($f.FullLength -gt $maxLen) { $maxLen = $f.FullLength } }
Add-Line ("  Full paths of 260+ characters (any file): {0}; longest: {1}" -f $long, $maxLen)

Add-Heading '6. Known online-only files (does reading attributes trigger a download?)'
if ($onlineChecks.Count -eq 0) {
    Add-Line '  Skipped - no files given.'
} else {
    $ci = 0
    foreach ($c in $onlineChecks) {
        $ci++
        Add-Line ("  File {0} ({1}), inside a folder you named: {2}" -f $ci, $c.Ext, $(if ($c.InLibrary) { 'yes' } else { 'no' }))
        if (-not $c.Found) { Add-Line "    Not found$(if ($c.Error) { ': ' + $c.Error } else { ' (check the path)' })"; continue }
        Add-Line ("    Before: {0} -> {1}  [{2}]" -f (Format-Attr $c.Before), (Get-StateName $c.Before), (Get-AttrNames $c.Before))
        if ($null -ne $c.After) {
            Add-Line ("    After:  {0} -> {1}  [{2}]" -f (Format-Attr $c.After), (Get-StateName $c.After), (Get-AttrNames $c.After))
            if ((Get-StateName $c.Before) -eq 'placeholder' -and (Get-StateName $c.After) -eq 'placeholder') {
                Add-Line '    Result: still online-only after the check - reading attributes did not download it.'
            } elseif ((Get-StateName $c.Before) -eq 'placeholder') {
                Add-Line '    Result: it CHANGED to local during the check. (Was it opened elsewhere meanwhile?)'
            } else {
                Add-Line '    Result: this file was not detected as online-only. If it shows a cloud icon in'
                Add-Line '            File Explorer, the plan''s detection rule needs correcting.'
            }
        } elseif ($c.Error) { Add-Line "    After:  could not read ($($c.Error))" }
    }
}

if ($includeSample -and $allBooks.Count -gt 0) {
    Add-Heading '7. Filename sample (names only - edit or delete freely before sharing)'
    $count = [Math]::Min(300, $allBooks.Count)
    $sample = @(Get-Random -InputObject $allBooks -Count $count | ForEach-Object { $_.Name } | Sort-Object)
    foreach ($nm in $sample) { Add-Line "  $nm" }
} else {
    Add-Heading '7. Filename sample'
    Add-Line '  Not included.'
}

Add-Line ''
Add-Line ("Finished in {0:0} seconds. End of report." -f ((Get-Date) - $started).TotalSeconds)

# ---------------------------------------------------------------------------
# Write the report: next to this script, unless that is inside a library folder.
# ---------------------------------------------------------------------------
$outDir = $env:WBP_DIR
if (-not $outDir) { $outDir = (Get-Location).Path }
$outDir = $outDir.TrimEnd('\', '/')
$insideLibrary = $false
foreach ($r in $roots) { if (Test-IsUnder $outDir $r) { $insideLibrary = $true } }
if ($insideLibrary) {
    $outDir = [Environment]::GetFolderPath('Desktop')
    Write-Host 'This script is inside one of your library folders, so the report goes on your Desktop instead.'
    foreach ($r in $roots) { if (Test-IsUnder $outDir $r) { $outDir = $null } }
}
if (-not $outDir) {
    Write-Host 'Your Desktop is inside a library folder too, so the report is shown here instead of saved.'
    Write-Host ''
    $Report | ForEach-Object { Write-Host $_ }
    return
}
$outFile = Join-Path $outDir ('whatbooks-probe-report-{0}.txt' -f $started.ToString('yyyyMMdd-HHmmss'))
try {
    $text = ($Report -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($outFile, $text, (New-Object System.Text.UTF8Encoding($true)))
    Write-Host ''
    Write-Host 'Done. Report saved to:'
    Write-Host "  $outFile"
    Write-Host ''
    Write-Host 'Next: open it, read it through, remove anything you want to keep private,'
    Write-Host 'then paste the whole thing into the chat.'
    if ($fatal) { Write-Host ''; Write-Host "Note: the probe stopped early: $fatal" }
    if (Ask-YesNo 'Open the report in Notepad now?' $true) { Start-Process notepad.exe -ArgumentList ('"' + $outFile + '"') }
} catch {
    Write-Host "Could not save the report ($($_.Exception.Message)). Here it is instead:"
    Write-Host ''
    $Report | ForEach-Object { Write-Host $_ }
}
