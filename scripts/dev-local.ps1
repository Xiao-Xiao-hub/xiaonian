#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$DataDir,
    [ValidateRange(1, 65535)]
    [int]$Port = 8788,
    [ValidateRange(-3650, 3650)]
    [int]$TestClockDays = 0,
    [switch]$NoWatch,
    [switch]$AdminPreview
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$serverRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../server'))
if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Join-Path $serverRoot 'data/local-synthetic'
}
elseif (-not [IO.Path]::IsPathRooted($DataDir)) {
    $DataDir = Join-Path (Get-Location).Path $DataDir
}
$localData = [IO.Path]::GetFullPath($DataDir)
$marker = Join-Path $localData '.zhiye-local-synthetic'
$savedEnvironment = @{}
$exitCode = 0

# Inspect metadata only. A normal leaf directory can still be reached through
# an ancestor junction, or contain a redirected SQLite/upload file.
function Assert-NormalAncestors([string]$Path) {
    $cursor = $Path
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $entry = Get-Item -LiteralPath $cursor -Force
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Refusing a redirected ancestor of the synthetic data path.'
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}

function Assert-NormalDataTree([string]$Path) {
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Path)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
            $linkType = $entry.PSObject.Properties['LinkType']
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                ($null -ne $linkType -and $linkType.Value -eq 'HardLink')) {
                throw 'Refusing a redirected entry inside the synthetic data directory.'
            }
            if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
        }
    }
}

Push-Location -LiteralPath $serverRoot
try {
    $node = Get-Command 'node.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1
    Assert-NormalAncestors $localData

    # An existing unmarked directory may contain the original handoff data.
    # Never adopt it implicitly or remove any existing files.
    if (Test-Path -LiteralPath $localData) {
        $dataItem = Get-Item -LiteralPath $localData -Force
        if (-not $dataItem.PSIsContainer -or ($dataItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The synthetic data path must be a normal directory.'
        }
        Assert-NormalDataTree $localData
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -and
            @(Get-ChildItem -LiteralPath $localData -Force).Count -gt 0) {
            throw 'Refusing an existing nonempty directory without the local synthetic-data marker. Choose a new directory.'
        }
    }
    else {
        $null = New-Item -ItemType Directory -Path $localData
    }
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        [IO.File]::WriteAllText($marker, "Local synthetic development data only.`n")
    }

    $localEnvironment = @{
        NODE_ENV = 'development'
        HOST = '127.0.0.1'
        PORT = $Port.ToString([Globalization.CultureInfo]::InvariantCulture)
        DEV_LOGIN_ENABLED = 'true'
        DATABASE_PATH = (Join-Path $localData 'app.sqlite')
        UPLOAD_DIR = (Join-Path $localData 'uploads')
        FORMULA_DIR = (Join-Path $localData 'formulas')
        LOG_LEVEL = 'info'
        TEST_CLOCK_DAYS = $TestClockDays.ToString([Globalization.CultureInfo]::InvariantCulture)
    }
    if ($AdminPreview) {
        # A new random key only for this loopback synthetic-data instance.
        # Never load, print or reuse a production admin credential.
        $previewKeyPath = Join-Path $localData 'admin-preview.key'
        if (Test-Path -LiteralPath $previewKeyPath) {
            $previewKeyItem = Get-Item -LiteralPath $previewKeyPath -Force
            $previewLinkType = $previewKeyItem.PSObject.Properties['LinkType']
            if (($previewKeyItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                ($null -ne $previewLinkType -and $previewLinkType.Value -eq 'HardLink')) {
                throw 'Refusing a redirected preview key path.'
            }
        }
        $previewBytes = New-Object byte[] 32
        $previewRng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $previewRng.GetBytes($previewBytes) } finally { $previewRng.Dispose() }
        $previewKey = [BitConverter]::ToString($previewBytes).Replace('-', '').ToLowerInvariant()
        [IO.File]::WriteAllText($previewKeyPath, $previewKey, (New-Object Text.UTF8Encoding($false)))
        $localEnvironment['ADMIN_API_KEY'] = $previewKey
        $localEnvironment['ADMIN_ORIGIN'] = "http://127.0.0.1:$Port"
    }
    # Do not inherit credentials or options that could load an env file.
    # Values are restored after this foreground server exits, never printed.
    $clearNames = @(
        'NODE_OPTIONS', 'ADMIN_API_KEY', 'ADMIN_ORIGIN', 'TRUST_PROXY', 'WECHAT_APP_ID', 'WECHAT_APP_SECRET',
        'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_EXTRA_BODY',
        'JEV_API_KEY', 'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'OCR_VISION_MODEL'
    )
    foreach ($name in (@($localEnvironment.Keys) + $clearNames | Select-Object -Unique)) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($localEnvironment.ContainsKey($name)) {
            [Environment]::SetEnvironmentVariable($name, $localEnvironment[$name], 'Process')
        }
        else {
            # PS 7.5+ distinguishes an empty environment value from absence.
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
    }

    & $node.Source '-e' 'if (parseInt(process.versions.node, 10) < 24) process.exit(1)'
    if ($LASTEXITCODE -ne 0) { throw 'Node.js 24 or newer is required.' }

    Write-Host "dev-local: http://127.0.0.1:$Port (synthetic data, development login)"
    Write-Host "dev-local: $localData"
    if ($TestClockDays -ne 0) {
        Write-Host "dev-local: business date offset $TestClockDays day(s); restart to change"
    }
    if ($AdminPreview) {
        Write-Host "dev-local: admin preview http://127.0.0.1:$Port/admin/"
        Write-Host "dev-local: disposable access key is in $previewKeyPath (rotates on every start)"
    }
    $nodeArguments = @('--import', 'tsx', 'src/index.ts')
    if (-not $NoWatch) { $nodeArguments = @('--watch') + $nodeArguments }
    # Intentionally bypass npm run dev, which adds --env-file-if-exists=.env.
    & $node.Source @nodeArguments
    $exitCode = $LASTEXITCODE
}
catch {
    [Console]::Error.WriteLine("dev-local: $($_.Exception.Message)")
    $exitCode = 1
}
finally {
    foreach ($name in $savedEnvironment.Keys) {
        if ($null -eq $savedEnvironment[$name]) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
        else {
            [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
        }
    }
    Pop-Location
}
exit $exitCode
