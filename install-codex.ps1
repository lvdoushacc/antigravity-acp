# One-line installer for the Codex plugin `agy` (Windows PowerShell 5.1+ / PowerShell 7):
#
#   irm https://raw.githubusercontent.com/lvdoushacc/antigravity-acp/main/install-codex.ps1 | iex
#
# It copies codex/agy to ~/.codex/plugins/agy, lists it in
# ~/.agents/plugins/marketplace.json and enables it in ~/.codex/config.toml.
# Codex still asks you to trust the plugin's hook once (Settings > Hooks).
#
# Testing overrides: $env:AGY_INSTALL_HOME (instead of your home folder),
# $env:AGY_SOURCE_DIR (a local checkout instead of downloading from GitHub).

$ErrorActionPreference = 'Stop'
$Repo = 'lvdoushacc/antigravity-acp'
$Branch = 'main'
$PluginName = 'agy'

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

$Home_ = if ($env:AGY_INSTALL_HOME) { $env:AGY_INSTALL_HOME } else { $HOME }
$PluginDir = Join-Path $Home_ ".codex\plugins\$PluginName"
$MarketFile = Join-Path $Home_ '.agents\plugins\marketplace.json'
$ConfigFile = Join-Path $Home_ '.codex\config.toml'

Write-Host '== Antigravity (agy) for Codex =='

# 1. Requirements (warn only: the plugin installs either way)
foreach ($cmd in 'node', 'agy') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Warning "'$cmd' is not on PATH. The plugin needs Node.js 18+ and the Antigravity CLI (agy)."
  }
}

# 2. Get the plugin files
$tmp = $null
if ($env:AGY_SOURCE_DIR) {
  $src = Join-Path $env:AGY_SOURCE_DIR "codex\$PluginName"
} else {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("agy-install-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'repo.zip'
  Write-Host "Downloading $Repo ($Branch)..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repo/archive/refs/heads/$Branch.zip" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $root = Get-ChildItem $tmp -Directory | Select-Object -First 1
  $src = Join-Path $root.FullName "codex\$PluginName"
}
if (-not (Test-Path (Join-Path $src 'hooks\hooks.json'))) { throw "Plugin files not found at $src" }

# 3. Copy into ~/.codex/plugins/agy (replacing an older copy)
if (Test-Path $PluginDir) { Remove-Item $PluginDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PluginDir) | Out-Null
Copy-Item $src $PluginDir -Recurse
Write-Host "Copied plugin to $PluginDir"
if ($tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

# 4. List it in the personal marketplace (keeping any other entries)
$entry = [ordered]@{
  name     = $PluginName
  source   = [ordered]@{ source = 'local'; path = "./.codex/plugins/$PluginName" }
  policy   = [ordered]@{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }
  category = 'Productivity'
}
if (Test-Path $MarketFile) {
  $market = Get-Content $MarketFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $market.name) { $market | Add-Member -NotePropertyName name -NotePropertyValue 'personal-local' -Force }
  $others = @($market.plugins | Where-Object { $_ -and $_.name -ne $PluginName })
  $market | Add-Member -NotePropertyName plugins -NotePropertyValue @($others + (New-Object psobject -Property $entry)) -Force
} else {
  $market = [ordered]@{
    name        = 'personal-local'
    interface   = [ordered]@{ displayName = 'Personal Local' }
    plugins     = @($entry)
  }
}
$MarketName = $market.name
Write-Utf8NoBom $MarketFile (ConvertTo-Json $market -Depth 10)
Write-Host "Listed in $MarketFile (marketplace '$MarketName')"

# 5. Enable it in ~/.codex/config.toml (once)
$table = "[plugins.`"$PluginName@$MarketName`"]"
$config = if (Test-Path $ConfigFile) { Get-Content $ConfigFile -Raw -Encoding UTF8 } else { '' }
if ($null -eq $config) { $config = '' }
if ($config.Contains($table)) {
  Write-Host "Already enabled in $ConfigFile"
} else {
  $sep = if ($config -and -not $config.EndsWith("`n")) { "`n`n" } elseif ($config) { "`n" } else { '' }
  Write-Utf8NoBom $ConfigFile ($config + $sep + $table + "`nenabled = true`n")
  Write-Host "Enabled in $ConfigFile"
}

Write-Host ''
Write-Host 'Done. Next:' -ForegroundColor Green
Write-Host '  1. Restart Codex.'
Write-Host '  2. Trust the plugin hook: Settings > Hooks (desktop) or /hooks (CLI).'
Write-Host '  3. Make sure agy is logged in once: agy acp --login'
Write-Host '  4. In a Codex chat type:  /agy hello   (or  agy: hello)'
