param([switch]$Uninstall)

# Install the herdr-status Command Code mod for the Herdr desktop app.
# The mod reports Command Code state through OSC 7501; see mods/herdr-status.ts.
#
# Usage: pwsh scripts/install-mod.ps1 [-Uninstall]

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$base = if ($env:COMMANDCODE_HOME) { $env:COMMANDCODE_HOME } else { Join-Path $HOME '.commandcode' }
$dest = Join-Path $base 'mods'
$target = Join-Path $dest 'herdr-status.ts'

if ($Uninstall) {
	Remove-Item -Force $target -ErrorAction SilentlyContinue
	Write-Output "Removed $target"
	exit 0
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $root 'mods/herdr-status.ts') $target -Force
Write-Output "Installed $target"
Write-Output "Restart Command Code (or run /reload), then verify with: cmd mods list"
