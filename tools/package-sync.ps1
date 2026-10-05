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
$publicKey = (Get-Content -LiteralPath (Join-Path $projectRoot 'extension-public-key.txt') -Raw).Trim()
$keyBytes = [Convert]::FromBase64String($publicKey)
$hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
try { $keyHash = $hashAlgorithm.ComputeHash($keyBytes) } finally { $hashAlgorithm.Dispose() }
$extensionId = -join ($keyHash[0..15] | ForEach-Object {
    [string][char](97 + ($_ -shr 4)) + [string][char](97 + ($_ -band 15))
})
$utf8 = New-Object System.Text.UTF8Encoding($false)
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version

foreach ($variant in @('migration', 'sync')) {
    $variantStage = Join-Path $packageStage $variant
    New-Item -ItemType Directory -Path $variantStage | Out-Null
    foreach ($file in $releaseFiles) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $variantStage -Recurse
    }
    $variantManifest = Get-Content -LiteralPath (Join-Path $variantStage 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($variant -eq 'sync') {
        $variantManifest | Add-Member -NotePropertyName key -NotePropertyValue $publicKey -Force
    } else {
        $variantManifest.PSObject.Properties.Remove('key')
    }
    [System.IO.File]::WriteAllText((Join-Path $variantStage 'manifest.json'), ($variantManifest | ConvertTo-Json -Depth 20), $utf8)
    $zipPath = Join-Path $releaseOutput "PriceTracker-$version-$variant.zip"
    Compress-Archive -Path (Join-Path $variantStage '*') -DestinationPath $zipPath -Force
    Write-Output $zipPath
}
Write-Output "Fixed sync extension ID: $extensionId"
