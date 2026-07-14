param(
  [string]$BinaryPath = (Join-Path $PSScriptRoot "..\dist\pr-reviewer.exe"),
  [switch]$ForceSkill
)

$ErrorActionPreference = "Stop"

$source = (Resolve-Path -LiteralPath $BinaryPath).Path
$targetDirectory = Join-Path $env:LOCALAPPDATA "Programs\pr-reviewer"
$target = Join-Path $targetDirectory "pr-reviewer.exe"

New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @($userPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$present = $entries | Where-Object {
  $_.Trim().TrimEnd("\") -ieq $targetDirectory.TrimEnd("\")
}
if (-not $present) {
  $entries += $targetDirectory
  [Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")
}

$skillArguments = @("install-claude-skill")
if ($ForceSkill) { $skillArguments += "--force" }
& $target @skillArguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Output "Installed binary: $target"
Write-Output "Open a new terminal before invoking pr-reviewer by name."
