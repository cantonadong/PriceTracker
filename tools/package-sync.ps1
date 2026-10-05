param(
    [string]$OutputDirectory = (Join-Path $env:TEMP 'PriceTracker-browser-sync')
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $releaseOutput -Force | Out-Null
$packageStage = Join-Path $env:TEMP ('PriceTracker-package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $packageStage | Out-Null
$releaseFiles = @(
    'background.js', 'content.js', 'content.css',
    'dashboard.js', 'dashboard.html', 'dashboard.css',
    'manifest.json', 'offscreen.html', 'offscreen.js', 'price-reader.js',
    'popup.js', 'popup.html', 'popup.css',
    'watch-state.js', 'watch-sync-model.js', 'watch-store.js',
    'icon', 'icon.png', 'icon.svg', 'README.md'
)
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $manifest.key) { throw 'The manifest must retain the fixed extension identity.' }
$keyBytes = [Convert]::FromBase64String($manifest.key)
$hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
try { $keyHash = $hashAlgorithm.ComputeHash($keyBytes) } finally { $hashAlgorithm.Dispose() }
$extensionId = -join ($keyHash[0..15] | ForEach-Object {
    [string][char](97 + ($_ -shr 4)) + [string][char](97 + ($_ -band 15))
})
if ($extensionId -ne 'ljbffjpoegfcdkmacohmgagkbijmhoel') { throw 'The package would change the existing extension ID.' }
foreach ($file in $releaseFiles) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $packageStage -Recurse
}
$zipPath = Join-Path $releaseOutput "PriceTracker-$($manifest.version)-sync.zip"
Compress-Archive -Path (Join-Path $packageStage '*') -DestinationPath $zipPath -Force
Write-Output $zipPath
Write-Output "Preserved extension ID: $extensionId"
