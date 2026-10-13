<#
.SYNOPSIS
  Sets up Authenticode signing through Azure Artifact Signing (formerly Trusted Signing) for the
  release workflow (§11 Windows, §18 row 136).

.DESCRIPTION
  - Downloads the signing client's signtool plug-in (dlib) from NuGet, pinned to a version and a
    sha256.
  - Writes the account metadata and finds the newest x64 signtool in the Windows SDK.
  - Appends three variables to $GITHUB_ENV for scripts/windows/sign.ps1: HOMERUN_SIGNTOOL,
    HOMERUN_SIGN_DLIB and HOMERUN_SIGN_METADATA.

  Needs AZURE_TRUSTED_SIGNING_ENDPOINT, AZURE_TRUSTED_SIGNING_ACCOUNT and
  AZURE_TRUSTED_SIGNING_PROFILE. The credentials (AZURE_TENANT_ID, AZURE_CLIENT_ID and
  AZURE_CLIENT_SECRET) are read by the dlib itself, at signing time, through EnvironmentCredential.
  This script never sees or prints them.
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ClientVersion = '1.0.146'
$ClientSha256 = '7761e5d8f31e54b764da21d33cd8b0a2940e1b05526c7dfcb5e94b0431426f70'

foreach ($name in 'AZURE_TRUSTED_SIGNING_ENDPOINT', 'AZURE_TRUSTED_SIGNING_ACCOUNT', 'AZURE_TRUSTED_SIGNING_PROFILE', 'GITHUB_ENV') {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "$name isn't set." }
}
$temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$dir = Join-Path $temp 'artifact-signing'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# A .nupkg is a zip; Expand-Archive wants the extension.
$pkg = Join-Path $dir 'client.zip'
Invoke-WebRequest -UseBasicParsing -Uri "https://www.nuget.org/api/v2/package/Microsoft.ArtifactSigning.Client/$ClientVersion" -OutFile $pkg
$got = (Get-FileHash -Algorithm SHA256 -Path $pkg).Hash.ToLowerInvariant()
if ($got -ne $ClientSha256) { throw "Microsoft.ArtifactSigning.Client $ClientVersion has sha256 $got, expected $ClientSha256." }
Expand-Archive -Path $pkg -DestinationPath (Join-Path $dir 'client') -Force
$dlib = Join-Path $dir 'client\bin\x64\Azure.CodeSigning.Dlib.dll'
if (-not (Test-Path -LiteralPath $dlib)) { throw "The signing client has no $dlib." }

$metadata = Join-Path $dir 'metadata.json'
[ordered]@{
    Endpoint               = $env:AZURE_TRUSTED_SIGNING_ENDPOINT
    CodeSigningAccountName = $env:AZURE_TRUSTED_SIGNING_ACCOUNT
    CertificateProfileName = $env:AZURE_TRUSTED_SIGNING_PROFILE
} | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath $metadata

# The newest SDK's x64 signtool: Windows Kits\10\bin\<10.0.x.y>\x64\signtool.exe.
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$signtool = Get-ChildItem -LiteralPath $kits -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'x64\signtool.exe')) } |
    Sort-Object { [version]$_.Name } -Descending |
    Select-Object -First 1
if (-not $signtool) { throw "No x64 signtool.exe under $kits." }
$signtoolPath = Join-Path $signtool.FullName 'x64\signtool.exe'
Write-Host "signtool: $signtoolPath"

Add-Content -Encoding utf8 -LiteralPath $env:GITHUB_ENV -Value @(
    "HOMERUN_SIGNTOOL=$signtoolPath"
    "HOMERUN_SIGN_DLIB=$dlib"
    "HOMERUN_SIGN_METADATA=$metadata"
)
