# Milestone 8b probe: can another local user open our pipes? Creates a throwaway user, runs a
# client as that user, deletes the user. Needs an admin runner (GitHub's Windows runners are).
param([string]$Secure, [string]$Default)
$ErrorActionPreference = "Stop"
$user = "hrprobe" + (Get-Random -Maximum 99999)
$pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 20 | ForEach-Object { [char]$_ }) + "!a1"
$out = "C:\Users\Public\hr-probe-$user.txt"
$client = "C:\Users\Public\hr-probe-client.ps1"
@'
param([string]$Secure, [string]$Default, [string]$Out)
$r = @()
foreach ($p in @(@("secure", $Secure), @("default", $Default))) {
  foreach ($dir in @("In", "InOut")) {
    try {
      $c = New-Object System.IO.Pipes.NamedPipeClientStream(".", $p[1], [System.IO.Pipes.PipeDirection]$dir)
      $c.Connect(3000); $c.Dispose(); $r += "$($p[0]) $dir connected"
    } catch { $r += "$($p[0]) $dir $($_.Exception.GetType().Name)" }
  }
}
$r += "whoami " + (whoami)
$r | Out-File -Encoding utf8 $Out
'@ | Out-File -Encoding utf8 $client
try {
  net user $user $pw /add | Out-Null
  $cred = New-Object System.Management.Automation.PSCredential($user, (ConvertTo-SecureString $pw -AsPlainText -Force))
  $p = Start-Process -FilePath powershell.exe -Credential $cred -LoadUserProfile -WindowStyle Hidden -PassThru -Wait `
    -WorkingDirectory "C:\Users\Public" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $client, "-Secure", $Secure, "-Default", $Default, "-Out", $out)
  "exit $($p.ExitCode)"
  if (Test-Path $out) { Get-Content $out } else { "no output file" }
} catch {
  "cross-user probe failed: $($_.Exception.Message)"
} finally {
  net user $user /delete 2>$null | Out-Null
  Remove-Item -ErrorAction SilentlyContinue $out, $client
}
