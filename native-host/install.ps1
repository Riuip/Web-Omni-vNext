[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string[]] $ExtensionId,

  [string] $GoExe = 'go.exe',

  [switch] $BuildFromSource,

  [ValidateSet('Prompt', 'Allow', 'Skip')]
  [string] $PrivateNetworkAccess = 'Prompt'
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.webomni.lan'
$FirewallRuleName = 'WebOmniLanHelperPrivate'
$FirewallDisplayName = 'Web-Omni LAN Helper (Private networks)'
$BundledBinarySha256 = 'D26ECDFCA7340E0DED78D7D66966EA3B6840741D48A5FC56926DED474E3925D5'
$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
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

function Confirm-PrivateNetworkAccess {
  param([string] $Choice)

  if ($Choice -eq 'Allow') { return $true }
  if ($Choice -eq 'Skip') { return $false }

  Write-Host ''
  Write-Host 'Private-network access is optional.' -ForegroundColor Yellow
  Write-Host 'Allowing it creates one inbound TCP rule for this helper executable.'
  Write-Host 'The rule applies only to the Windows Private profile and local subnet.'
  do {
    $Answer = (Read-Host 'Allow phones on your private network to connect? [y/N]').Trim().ToLowerInvariant()
  } while (@('', 'y', 'yes', 'n', 'no') -notcontains $Answer)
  return $Answer -in @('y', 'yes')
}

$AllowPrivateNetwork = Confirm-PrivateNetworkAccess -Choice $PrivateNetworkAccess
if ($AllowPrivateNetwork -and -not (Test-IsAdministrator)) {
  throw 'Private-network access requires an elevated PowerShell window. Run this installer as administrator, or use -PrivateNetworkAccess Skip.'
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
$Binary = Join-Path $InstallRoot 'web-omni-lan-helper.exe'
if ($BuildFromSource) {
  $OriginalGoOS = [Environment]::GetEnvironmentVariable('GOOS', 'Process')
  $OriginalGoArch = [Environment]::GetEnvironmentVariable('GOARCH', 'Process')
  $OriginalCgoEnabled = [Environment]::GetEnvironmentVariable('CGO_ENABLED', 'Process')
  Push-Location $SourceRoot
  try {
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    & $GoExe build -buildvcs=false -trimpath -ldflags '-s -w -H=windowsgui' -o $Binary .
    if ($LASTEXITCODE -ne 0) { throw 'Go build failed.' }
  } finally {
    if ($null -eq $OriginalGoOS) { Remove-Item Env:GOOS -ErrorAction SilentlyContinue } else { $env:GOOS = $OriginalGoOS }
    if ($null -eq $OriginalGoArch) { Remove-Item Env:GOARCH -ErrorAction SilentlyContinue } else { $env:GOARCH = $OriginalGoArch }
    if ($null -eq $OriginalCgoEnabled) { Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue } else { $env:CGO_ENABLED = $OriginalCgoEnabled }
    Pop-Location
  }
} else {
  $BundledBinary = Join-Path $SourceRoot 'web-omni-lan-helper.exe'
  if (-not (Test-Path -LiteralPath $BundledBinary -PathType Leaf)) {
    throw 'Bundled native helper is missing. Restore the release file or use -BuildFromSource.'
  }
  $ActualSha256 = (Get-FileHash -LiteralPath $BundledBinary -Algorithm SHA256).Hash
  if (-not $ActualSha256.Equals($BundledBinarySha256, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Bundled native helper checksum mismatch. Expected $BundledBinarySha256, received $ActualSha256."
  }
  Copy-Item -LiteralPath $BundledBinary -Destination $Binary -Force
}

$ManifestPath = Join-Path $InstallRoot "$HostName.json"
$Manifest = [ordered]@{
  name = $HostName
  description = 'Web-Omni LAN mobile page and encrypted relay helper'
  path = $Binary
  type = 'stdio'
  allowed_origins = @($ExtensionId | ForEach-Object { "chrome-extension://$_/" })
}
$ManifestJson = $Manifest | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($ManifestPath, $ManifestJson, [Text.UTF8Encoding]::new($false))

$ExistingFirewallRule = Get-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue
if ($AllowPrivateNetwork) {
  if ($null -ne $ExistingFirewallRule) {
    $ExistingFirewallRule | Remove-NetFirewallRule
  }
  New-NetFirewallRule `
    -Name $FirewallRuleName `
    -DisplayName $FirewallDisplayName `
    -Description 'Allows Web-Omni encrypted LAN transfers from devices on the local private subnet.' `
    -Group 'Web-Omni' `
    -Direction Inbound `
    -Action Allow `
    -Enabled True `
    -Profile Private `
    -Program $Binary `
    -Protocol TCP `
    -RemoteAddress LocalSubnet `
    -EdgeTraversalPolicy Block | Out-Null
} elseif ($null -ne $ExistingFirewallRule) {
  if (Test-IsAdministrator) {
    $ExistingFirewallRule | Remove-NetFirewallRule
  } else {
    Write-Warning "An existing firewall rule named '$FirewallRuleName' remains. Run uninstall.ps1 as administrator to remove it."
  }
}

$RegistryRoots = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
)
foreach ($RegistryRoot in $RegistryRoots) {
  $Key = Join-Path $RegistryRoot $HostName
  New-Item -Path $Key -Force | Out-Null
  Set-Item -Path $Key -Value $ManifestPath
}

Write-Host "Installed $HostName for Chrome and Edge (Windows amd64)." -ForegroundColor Green
Write-Host "Manifest: $ManifestPath"
if ($AllowPrivateNetwork) {
  Write-Host "Private-network firewall rule: $FirewallDisplayName" -ForegroundColor Green
} else {
  Write-Host 'Private-network firewall access was skipped.' -ForegroundColor Yellow
}
