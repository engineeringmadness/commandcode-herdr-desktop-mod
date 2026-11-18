param(
	[switch]$Uninstall,
	[string]$HerdrHome
)

# Install the Herdr app companion for the herdr-status mod.
#
# Herdr app 0.1.16's shipped agents pane only draws sub-agents that are herdr-core
# child terminals. This copies that mod, patches it to draw OSC 7501
# `subagents/...` records too, clones the main layout to use the copy, and
# switches to it. Your original `main` mod and layout are untouched.
#
# Usage: pwsh -File scripts/install-herdr-app.ps1 [-Uninstall] [-HerdrHome <path>]

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

function Find-HerdrApp {
	if ($env:HERDR_APP) { return $env:HERDR_APP }
	$cmd = Get-Command herdr-app -ErrorAction SilentlyContinue
	if ($cmd) { return $cmd.Source }
	$candidates = @(
		(Join-Path $HOME '.local/bin/herdr-app'),
		(Join-Path $HOME 'Applications/Herdr.app/Contents/MacOS/herdr-app')
	)
	if ($env:LOCALAPPDATA) {
		$candidates = @((Join-Path $env:LOCALAPPDATA 'Programs\herdr-app\herdr-app.exe')) + $candidates
	}
	foreach ($candidate in $candidates) {
		if (Test-Path $candidate) { return $candidate }
	}
	return $null
}

if ($HerdrHome) {
	$appHome = $HerdrHome
} elseif ($env:HERDR_APP_HOME) {
	$appHome = $env:HERDR_APP_HOME
} else {
	$appHome = Join-Path $HOME '.config/herdr-app'
}

$mods = Join-Path $appHome 'mods'
$layouts = Join-Path $appHome 'layouts'
$source = Join-Path $mods 'agents'
$clone = Join-Path $mods 'agents-records'
$records = Join-Path $layouts 'main-records.json'
$app = Find-HerdrApp
$running = Test-Path (Join-Path $appHome 'herdr-app.sock')

if ($Uninstall) {
	if ($app -and $running) {
		& $app do layout.switch --name main
		if ($LASTEXITCODE -ne 0) { Write-Warning "Could not switch back to main; switch layouts with ctrl-shift-l." }
	}
	Remove-Item -Recurse -Force $clone -ErrorAction SilentlyContinue
	Remove-Item -Force $records -ErrorAction SilentlyContinue
	Write-Output "Removed $clone"
	Write-Output "Removed $records"
	Write-Output "Restart Herdr if it is running."
	exit 0
}

if (-not (Test-Path $source)) {
	throw "Herdr's agents mod was not found at $source. Start Herdr once, then retry."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js is required to patch the agents mod.' }

New-Item -ItemType Directory -Force -Path $clone | Out-Null
Copy-Item (Join-Path $source '*') $clone -Recurse -Force

& $node (Join-Path $root 'scripts/patch-agents-mod.mjs') (Join-Path $clone 'main.js')
if ($LASTEXITCODE -ne 0) { throw 'Could not patch the cloned agents mod.' }

if (-not (Test-Path $records)) {
	Copy-Item (Join-Path $layouts 'main.json') $records -Force
}
& $node (Join-Path $root 'scripts/patch-herdr-layout.mjs') $records
if ($LASTEXITCODE -ne 0) { throw 'Could not patch the cloned layout.' }

Write-Output "Installed $clone"
Write-Output "Installed $records"

if ($app -and $running) {
	& $app do layout.switch --name main-records
	if ($LASTEXITCODE -ne 0) {
		Write-Warning 'Could not switch to main-records automatically; use ctrl-shift-l.'
	} else {
		Write-Output 'Switched to the main-records layout.'
	}
} else {
	Write-Output 'Start Herdr, then switch to the main-records layout (ctrl-shift-l).'
}
Write-Output 'Switch back any time with: herdr-app do layout.switch --name main'
