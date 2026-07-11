[CmdletBinding()]
param(
  [ValidateSet('Prompt', 'Remove', 'Keep')]
  [string] $FirewallRule = 'Prompt'
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.webomni.lan'
$FirewallRuleName = 'WebOmniLanHelperPrivate'
$LocalAppData = [Environment]::GetFolderPath('LocalApplicationData')
$InstallRoot = Join-Path $LocalAppData 'WebOmni\NativeHost'
$ResolvedBase = [IO.Path]::GetFullPath($LocalAppData).TrimEnd('\') + '\'
$ResolvedInstall = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') + '\'
if (-not $ResolvedInstall.StartsWith($ResolvedBase, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Native host install path is outside LocalAppData.'
}

function Test-IsAdministrator {
  $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
  return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$ExistingFirewallRule = Get-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue
$RemoveFirewallRule = $FirewallRule -eq 'Remove'
if ($null -ne $ExistingFirewallRule -and $FirewallRule -eq 'Prompt') {
  do {
    $Answer = (Read-Host 'Remove the Web-Omni private-network firewall rule? [Y/n]').Trim().ToLowerInvariant()
  } while (@('', 'y', 'yes', 'n', 'no') -notcontains $Answer)
  $RemoveFirewallRule = $Answer -in @('', 'y', 'yes')
}
if ($null -ne $ExistingFirewallRule -and $RemoveFirewallRule -and -not (Test-IsAdministrator)) {
  throw 'Removing the firewall rule requires an elevated PowerShell window. Run this uninstaller as administrator, or use -FirewallRule Keep.'
}

if ($null -ne $ExistingFirewallRule -and $RemoveFirewallRule) {
  $ExistingFirewallRule | Remove-NetFirewallRule
}

foreach ($Key in @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)) {
  if (Test-Path -LiteralPath $Key) { Remove-Item -LiteralPath $Key -Force }
}

if (Test-Path -LiteralPath $InstallRoot) {
  Remove-Item -LiteralPath $InstallRoot -Recurse -Force
}
Write-Host "Removed $HostName." -ForegroundColor Green
if ($null -ne $ExistingFirewallRule -and -not $RemoveFirewallRule) {
  Write-Warning "Firewall rule '$FirewallRuleName' was kept. It no longer references an installed executable."
}
