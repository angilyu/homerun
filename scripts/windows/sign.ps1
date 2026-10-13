<#
.SYNOPSIS
  Authenticode-signs one file through Azure Artifact Signing (§11 Windows, §18 row 136).

.DESCRIPTION
  The release workflow's `bundle.windows.signCommand`. Tauri calls it once for each file it signs:
  - the shell's exe;
  - each sidecar not already validly signed (claude.exe keeps Anthropic's signature);
  - NSIS's plug-ins, the uninstaller and the installer.
  The workflow also calls it directly for homerund.exe, before its hash is compiled into the CLI.

  Uses the variables scripts/windows/signing-setup.ps1 exports: HOMERUN_SIGNTOOL,
  HOMERUN_SIGN_DLIB and HOMERUN_SIGN_METADATA. Timestamps with RFC 3161 and retries a failure
  twice. Finally checks the signature against the Windows trust policy.
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

foreach ($name in 'HOMERUN_SIGNTOOL', 'HOMERUN_SIGN_DLIB', 'HOMERUN_SIGN_METADATA') {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "$name isn't set; run scripts/windows/signing-setup.ps1 first." }
}
if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Nothing to sign at $Path." }

$signArgs = @(
    'sign', '/v', '/fd', 'SHA256',
    '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256',
    '/dlib', $env:HOMERUN_SIGN_DLIB, '/dmdf', $env:HOMERUN_SIGN_METADATA,
    $Path
)
for ($attempt = 1; ; $attempt++) {
    & $env:HOMERUN_SIGNTOOL @signArgs
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -ge 3) { throw "signtool couldn't sign $Path (exit $LASTEXITCODE)." }
    Write-Host "signtool failed (exit $LASTEXITCODE); retrying $Path"
    Start-Sleep -Seconds (10 * $attempt)
}

& $env:HOMERUN_SIGNTOOL verify /pa /q $Path
if ($LASTEXITCODE -ne 0) { throw "$Path doesn't verify after signing (exit $LASTEXITCODE)." }
