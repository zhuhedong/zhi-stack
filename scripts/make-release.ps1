param([string]$Report = '.local/verification/latest.json')
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $projectRoot
try {
    $verification = Get-Content -Raw -LiteralPath $Report | ConvertFrom-Json
    $package = Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json
    $releaseNotes = 'docs/release-' + $package.version + '.md'
    if (-not (Test-Path -LiteralPath $releaseNotes -PathType Leaf)) { throw "Missing release notes: $releaseNotes" }
    $fingerprint = & node scripts/source-fingerprint.mjs
    if ($LASTEXITCODE -ne 0 -or $verification.status -ne 'passed' -or $verification.version -ne $package.version -or $verification.sourceFingerprint -ne $fingerprint) { throw 'Run npm run verify:release on the final source before packaging.' }
    & cargo build --manifest-path server/Cargo.toml --release --locked --target-dir .local/product-build
    if ($LASTEXITCODE -ne 0) { throw 'Server release build failed.' }
    $previousTarget = $env:CARGO_TARGET_DIR
    try {
        $env:CARGO_TARGET_DIR = Join-Path $projectRoot 'src-tauri/target'
        & npm run tauri -- build --bundles nsis
        if ($LASTEXITCODE -ne 0) { throw 'Desktop installer build failed.' }
    } finally { $env:CARGO_TARGET_DIR = $previousTarget }
    $afterBuild = & node scripts/source-fingerprint.mjs
    if ($afterBuild -ne $fingerprint) { throw 'Build changed source inputs. Re-run verification before packaging.' }
    $releaseRoot = Join-Path $projectRoot 'release'
    $destination = Join-Path $releaseRoot ('infohub-' + $package.version + '-windows-x64')
    if (Test-Path -LiteralPath $destination) { throw "Release already exists: $destination" }
    New-Item -ItemType Directory -Path $destination | Out-Null
    $serverFolder = Join-Path $destination 'server'
    New-Item -ItemType Directory -Path $serverFolder | Out-Null
    Copy-Item -LiteralPath '.local/product-build/release/infohub-server.exe' -Destination $serverFolder
    Copy-Item -LiteralPath 'dist' -Destination $serverFolder -Recurse
    Copy-Item -LiteralPath '.env.example' -Destination $serverFolder
    Copy-Item -LiteralPath 'src-tauri/target/release/app.exe' -Destination (Join-Path $destination 'infohub.exe')
    $installer = Join-Path 'src-tauri/target/release/bundle/nsis' ('infohub_' + $package.version + '_x64-setup.exe')
    Copy-Item -LiteralPath $installer -Destination $destination
    Copy-Item -LiteralPath 'docs/operations.md', 'docs/trial-protocol.md', $releaseNotes -Destination $destination
    Copy-Item -LiteralPath $Report -Destination (Join-Path $destination 'verification.json')
    $scriptFolder = Join-Path $destination 'scripts'
    New-Item -ItemType Directory -Path $scriptFolder | Out-Null
    Copy-Item -LiteralPath 'scripts/maintenance.mjs', 'scripts/release-ops.mjs' -Destination $scriptFolder
    $startScript = @'
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.env')) { throw 'Copy .env.example to .env and configure your PostgreSQL connection first.' }
& .\infohub-server.exe
exit $LASTEXITCODE
'@
    [IO.File]::WriteAllText((Join-Path $serverFolder 'start-server.ps1'), $startScript)
    $hashes = @()
    $files = Get-ChildItem -LiteralPath $destination -Recurse -File
    foreach ($file in $files) { $relative = [IO.Path]::GetRelativePath($destination, $file.FullName).Replace('\','/'); $hashes += [ordered]@{ path=$relative; bytes=$file.Length; sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant() } }
    $manifest = [ordered]@{ version=$package.version; platform='windows-x64'; sourceFingerprint=$fingerprint; createdAt=[DateTime]::UtcNow.ToString('o'); files=$hashes; validation=$verification.excluded }
    [IO.File]::WriteAllText((Join-Path $destination 'manifest.json'), ($manifest | ConvertTo-Json -Depth 8))
    $archive = $destination + '.zip'
    if (Test-Path -LiteralPath $archive) { throw "Archive already exists: $archive" }
    Compress-Archive -LiteralPath $destination -DestinationPath $archive -CompressionLevel Optimal
    Get-FileHash -Algorithm SHA256 -LiteralPath $archive | Format-List
    Write-Output "Release package: $archive"
} finally { Pop-Location }
