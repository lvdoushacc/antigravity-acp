# One-line installer for the Claude Code plugin `antigravity-acp`
# (Windows PowerShell 5.1+ / PowerShell 7):
#
#   irm https://raw.githubusercontent.com/lvdoushacc/antigravity-acp/main/install-claude.ps1 | iex
#
# Adds this repository as a Claude Code marketplace and installs the plugin.
# Run it again to update both.

$ErrorActionPreference = 'Stop'
$Market = 'antigravity-acp'
$Repo = 'lvdoushacc/antigravity-acp'
$Plugin = "antigravity-acp@$Market"

Write-Host '== Antigravity (agy) for Claude Code =='

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  throw "'claude' (Claude Code CLI) is not on PATH. Install Claude Code first: https://claude.com/claude-code"
}
foreach ($cmd in 'node', 'agy') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Warning "'$cmd' is not on PATH. The plugin needs Node.js 18+ and the Antigravity CLI (agy)."
  }
}

function Invoke-Claude([string[]]$ArgList) {
  & claude @ArgList
  if ($LASTEXITCODE -ne 0) { throw "claude $($ArgList -join ' ') failed (exit $LASTEXITCODE)" }
}

# 1. Marketplace: add it, or refresh it when it is already there
$markets = (& claude plugin marketplace list 2>&1) -join "`n"
if ($markets -match "(?m)^\s*\S*\s*$([regex]::Escape($Market))\s*$") {
  Invoke-Claude @('plugin', 'marketplace', 'update', $Market)
} else {
  Invoke-Claude @('plugin', 'marketplace', 'add', $Repo)
}

# 2. Plugin: install it, or update it when it is already installed
$plugins = (& claude plugin list 2>&1) -join "`n"
if ($plugins.Contains($Plugin)) {
  Invoke-Claude @('plugin', 'update', $Plugin)
} else {
  Invoke-Claude @('plugin', 'install', $Plugin)
}

Write-Host ''
Write-Host 'Done. Next:' -ForegroundColor Green
Write-Host '  1. Make sure agy is logged in once: agy acp --login'
Write-Host '  2. Open a new Claude Code session and type:  /agy hello'
