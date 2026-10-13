<#
.SYNOPSIS
  Installs a Homerun NSIS installer silently for the current user, checks it, starts the app, and
  uninstalls it (§11 Windows, §18 row 137). The release workflow runs it on each Windows build.

.DESCRIPTION
  Checks, in order:
  - The silent install. It needs no elevation, writes nothing under HKLM, and goes to
    %LOCALAPPDATA%\Programs\Homerun, never the data folder. The command-line tool is
    bin\homerun.exe, the Start menu shortcut carries the toasts' AppUserModelID, and the
    installer turns on neither Open at login nor the user's Path.
  - The CLI reports the release's version. The installed homerund.exe is the one the CLI was
    compiled to trust (-HomerundSha256).
  - With -Signed, every installed exe, the uninstaller and the installer have valid Authenticode
    signatures.
  - The app starts and starts its runtime. The CLI reaches that runtime and passes its peer check:
    it is refused only because it isn't approved yet.
  - An update-mode reinstall (/UPDATE) keeps the CLI and the user's Path entry.
  - The silent uninstall removes the program folder, the shortcuts, the uninstall entry, the
    Open-at-login value, and the CLI's Path entry, and leaves the rest of Path as it was.

  The test puts bin on the user's Path itself, as Settings would, to check that uninstalling takes
  it off. Exits non-zero on the first failure, after uninstalling.

.EXAMPLE
  pwsh -File scripts/windows/install-test.ps1 -Setup Homerun_0.2.0_x64-setup.exe -Version 0.2.0 -HomerundSha256 <hex>
#>
param(
    [Parameter(Mandatory = $true)] [string]$Setup,
    [Parameter(Mandatory = $true)] [string]$Version,
    [string]$HomerundSha256 = '',
    [switch]$Signed
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Setup = (Resolve-Path -LiteralPath $Setup).Path
$Dir = Join-Path $env:LOCALAPPDATA 'Programs\Homerun'
$DataDir = Join-Path $env:LOCALAPPDATA 'Homerun'
$Bin = Join-Path $Dir 'bin'
$Cli = Join-Path $Bin 'homerun.exe'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Homerun'
$StartMenuLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'Homerun.lnk'
$DesktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Homerun.lnk'
$Aumid = 'com.angilyu.homerun'

function Step([string]$what) { Write-Host "== $what" }
function Check([bool]$ok, [string]$what) {
    if (-not $ok) { throw "FAILED: $what" }
    Write-Host "ok: $what"
}
function UserPath {
    $k = Get-Item -LiteralPath 'HKCU:\Environment'
    [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}
function PathHas([string]$value, [string]$dir) {
    @($value -split ';' | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') }).Count -gt 0
}
function RunValue {
    (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Homerun' -ErrorAction SilentlyContinue)
}
function StopHomerun {
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($Dir, [StringComparison]::OrdinalIgnoreCase) } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}
function RunCli([string[]]$cliArgs) {
    $out = Join-Path $env:TEMP 'homerun-cli.out'
    $err = Join-Path $env:TEMP 'homerun-cli.err'
    $p = Start-Process -FilePath $Cli -ArgumentList $cliArgs -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    if (-not $p.WaitForExit(60000)) { $p.Kill(); throw "homerun $($cliArgs -join ' ') didn't finish in 60 s" }
    [pscustomobject]@{ Code = $p.ExitCode; Out = (Get-Content -Raw -LiteralPath $out) + ''; Err = (Get-Content -Raw -LiteralPath $err) + '' }
}
# The uninstaller copies itself to %TEMP% and returns at once, so wait for its effects.
function Uninstall {
    $u = Join-Path $Dir 'uninstall.exe'
    if (-not (Test-Path -LiteralPath $u)) { return }
    StopHomerun
    Start-Process -FilePath $u -ArgumentList '/S' -Wait
    $deadline = (Get-Date).AddMinutes(2)
    while ((Test-Path -LiteralPath $UninstallKey) -or (Test-Path -LiteralPath (Join-Path $Dir 'homerun.exe'))) {
        if ((Get-Date) -gt $deadline) { throw 'the uninstaller did not finish in 2 minutes' }
        Start-Sleep -Seconds 1
    }
    Start-Sleep -Seconds 2
}

$pathBefore = UserPath
Check (-not (Test-Path -LiteralPath $Dir)) "nothing is installed at $Dir yet"
Check (-not (PathHas $pathBefore $Bin)) "the user's Path doesn't have $Bin yet"

try {
    Step "silent install: $Setup /S"
    $p = Start-Process -FilePath $Setup -ArgumentList '/S' -Wait -PassThru
    Check ($p.ExitCode -eq 0) "the installer exits 0 (got $($p.ExitCode))"

    Step 'layout'
    foreach ($f in 'homerun.exe', 'homerund.exe', 'claude.exe', 'uninstall.exe', 'bin\homerun.exe') {
        Check (Test-Path -LiteralPath (Join-Path $Dir $f) -PathType Leaf) "$f is installed"
    }
    Check (-not (Test-Path -LiteralPath (Join-Path $Dir 'homerun-cli.exe'))) 'homerun-cli.exe was moved to bin'
    Check (-not (Test-Path -LiteralPath (Join-Path $DataDir 'uninstall.exe'))) 'nothing was installed into the data folder'
    Check (Test-Path -LiteralPath $UninstallKey) 'the per-user uninstall entry exists'
    $entry = Get-ItemProperty -LiteralPath $UninstallKey
    Check ($entry.DisplayVersion -eq $Version) "the uninstall entry says $Version (got $($entry.DisplayVersion))"
    Check (-not (Test-Path -LiteralPath 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Homerun')) 'nothing under HKLM'
    Check (-not (Test-Path -LiteralPath 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Homerun')) 'nothing under HKLM (WOW6432Node)'
    Check ($null -eq (RunValue)) "the installer doesn't turn on Open at login"
    Check (-not (PathHas (UserPath) $Bin)) "the installer doesn't edit the user's Path"

    Step 'Start menu shortcut'
    Check (Test-Path -LiteralPath $StartMenuLink) "$StartMenuLink exists"
    $target = (New-Object -ComObject WScript.Shell).CreateShortcut($StartMenuLink).TargetPath
    Check ($target -ieq (Join-Path $Dir 'homerun.exe')) "it opens $Dir\homerun.exe (got $target)"
    $folder = (New-Object -ComObject Shell.Application).Namespace((Split-Path -Parent $StartMenuLink))
    $id = $folder.ParseName((Split-Path -Leaf $StartMenuLink)).ExtendedProperty('System.AppUserModel.ID')
    if ([string]::IsNullOrEmpty($id)) {
        Write-Host "::warning::couldn't read the shortcut's AppUserModelID on this machine"
    } else {
        Check ($id -eq $Aumid) "it carries AppUserModelID $Aumid (got $id)"
    }

    Step 'the command-line tool'
    $r = RunCli @('version', '--json')
    Check ($r.Code -eq 0) "homerun version exits 0 (got $($r.Code): $($r.Err))"
    $v = ($r.Out | ConvertFrom-Json).version
    Check ($v -eq $Version) "homerun version says $Version (got $v)"
    if ($HomerundSha256) {
        $h = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Dir 'homerund.exe')).Hash.ToLowerInvariant()
        Check ($h -eq $HomerundSha256.ToLowerInvariant()) "the installed homerund.exe is the one the CLI trusts ($h)"
    }

    if ($Signed) {
        Step 'Authenticode'
        foreach ($f in @($Setup) + @('homerun.exe', 'homerund.exe', 'claude.exe', 'uninstall.exe', 'bin\homerun.exe' | ForEach-Object { Join-Path $Dir $_ })) {
            $s = Get-AuthenticodeSignature -LiteralPath $f
            Check ($s.Status -eq 'Valid') "$(Split-Path -Leaf $f) is signed: $($s.Status) $($s.SignerCertificate.Subject)"
        }
    }

    Step 'the app starts its runtime'
    Start-Process -FilePath (Join-Path $Dir 'homerun.exe')
    $deadline = (Get-Date).AddSeconds(90)
    $r = $null
    while ($true) {
        $r = RunCli @('status')
        if ($r.Err -notmatch 'not running') { break }
        if ((Get-Date) -gt $deadline) { break }
        Start-Sleep -Seconds 3
    }
    $shell = @(Get-Process -Name homerun -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq (Join-Path $Dir 'homerun.exe') })
    $runtime = @(Get-Process -Name homerund -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq (Join-Path $Dir 'homerund.exe') })
    Check ($shell.Count -ge 1) 'the app is running'
    Check ($runtime.Count -ge 1) 'its runtime is running'
    Write-Host "homerun status: exit $($r.Code): $($r.Err.Trim())"
    Check ($r.Err -notmatch "is not Homerun's homerund") 'the CLI trusts the installed runtime'
    Check ($r.Code -eq 77 -and $r.Err -match "isn't approved yet") 'the runtime answers the CLI, which isn''t approved yet'
    StopHomerun

    Step 'update-mode reinstall keeps the CLI and its Path entry'
    $before = UserPath
    $with = if ($before) { "$before;$Bin" } else { $Bin }
    Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name 'Path' -Value $with -Type ExpandString
    $p = Start-Process -FilePath $Setup -ArgumentList '/S', '/UPDATE' -Wait -PassThru
    Check ($p.ExitCode -eq 0) "the update-mode installer exits 0 (got $($p.ExitCode))"
    Check (Test-Path -LiteralPath $Cli) 'bin\homerun.exe is still there'
    Check (PathHas (UserPath) $Bin) 'bin is still on the user''s Path'
    StopHomerun

    Step 'silent uninstall'
    Uninstall
    Check (-not (Test-Path -LiteralPath $Dir)) "$Dir is gone"
    Check (-not (Test-Path -LiteralPath $StartMenuLink)) 'the Start menu shortcut is gone'
    Check (-not (Test-Path -LiteralPath $DesktopLink)) 'the desktop shortcut is gone'
    Check (-not (Test-Path -LiteralPath $UninstallKey)) 'the uninstall entry is gone'
    Check ($null -eq (RunValue)) 'no Open-at-login value is left'
    $after = UserPath
    Check (-not (PathHas $after $Bin)) 'bin is off the user''s Path'
    Check ($after -eq $before) "the rest of the user's Path is unchanged ('$after')"
    Write-Host 'install test passed'
}
finally {
    try { Uninstall } catch { Write-Host "cleanup: $_" }
}
