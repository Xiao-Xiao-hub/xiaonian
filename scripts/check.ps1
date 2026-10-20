#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$WccDir = $env:WCC_DIR,
    [switch]$SkipNative,
    [ValidateSet('Asia/Shanghai', 'America/New_York')]
    [string]$Timezone = $(if ([string]::IsNullOrWhiteSpace($env:TZ)) { 'Asia/Shanghai' } else { $env:TZ })
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Native exit codes are checked explicitly on both Windows PowerShell and pwsh.
$PSNativeCommandUseErrorActionPreference = $false

function Find-Application {
    param([string]$Name)
    $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { throw "Required command was not found: $Name" }
    return $command.Source
}

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments, [string]$Label)
    Write-Host "check: $Label"
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)." }
}

function Invoke-Compiler {
    param([string]$Executable, [string]$Source, [string]$Output, [string[]]$Dependencies = @())
    # wcc may exit zero while printing an error, so any diagnostic is a failure.
    # PowerShell 5.1 treats native stderr as ErrorRecords; capture those as well.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $diagnostics = @(& $Executable '-d' '-o' $Output $Source @Dependencies 2>&1)
        $compilerExit = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($compilerExit -ne 0 -or $diagnostics.Count -gt 0) {
        Write-Host "compile: $Source (exit $compilerExit)"
        $message = ($diagnostics | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        if ($message.Length -gt 0) { Write-Host $message.Substring(0, [Math]::Min(400, $message.Length)) }
        return $false
    }
    return $true
}

$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverRoot = Join-Path $taskRoot 'server'
$miniRoot = Join-Path $taskRoot 'miniprogram'
$testRoot = Join-Path $taskRoot 'tests'
$compileTemp = $null
$compileTempCreated = $false
$tempParent = $null
$exitCode = 0
$savedTimezone = $env:TZ

Push-Location -LiteralPath $taskRoot
try {
    $env:TZ = $Timezone
    Write-Host "check: timezone $Timezone; test files run one at a time"
    $node = Find-Application 'node.exe'
    # npm.cmd avoids dependence on the execution policy for npm.ps1.
    $npm = Find-Application 'npm.cmd'
    $python = Find-Application 'python.exe'
    Invoke-Checked $node @('-e', 'if (parseInt(process.versions.node, 10) < 24) process.exit(1)') 'Node.js >= 24'
    Invoke-Checked $python @('-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)') 'Python >= 3.12'

    if (-not $SkipNative) {
        if ([string]::IsNullOrWhiteSpace($WccDir)) {
            throw 'Set WCC_DIR or pass -WccDir with the directory containing wcc.exe and wcsc.exe. Compilation is required.'
        }
        $compilerRoot = (Resolve-Path -LiteralPath $WccDir).ProviderPath
        $wcc = Join-Path $compilerRoot 'wcc.exe'
        $wcsc = Join-Path $compilerRoot 'wcsc.exe'
        foreach ($compiler in @($wcc, $wcsc)) {
            if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
                throw "Required mini program compiler was not found: $compiler"
            }
        }
    }

    Set-Location -LiteralPath $serverRoot
    Invoke-Checked $npm @('run', 'typecheck') 'typecheck'
    Invoke-Checked $npm @('run', 'build') 'build'
    # Windows shells do not expand the npm script's *.test.ts argument.
    # Keep the same test set as check.sh, but bound concurrent heavy workers.
    $backendTests = @(Get-ChildItem -LiteralPath $testRoot -Filter '*.test.ts' -File | Sort-Object FullName)
    if ($backendTests.Count -eq 0) { throw 'Backend test files were not found.' }
    $backendTestArguments = @('--test', '--test-concurrency=1', '--import', 'tsx') + @($backendTests.FullName)
    Invoke-Checked $node $backendTestArguments 'backend tests (one file at a time)'

    Set-Location -LiteralPath $taskRoot
    $frontendTests = @(Get-ChildItem -LiteralPath $testRoot -Filter 'frontend*.test.cjs' -File | Sort-Object FullName)
    $adminTests = @(Get-ChildItem -LiteralPath $testRoot -Filter 'admin*.test.mjs' -File | Sort-Object FullName)
    if ($frontendTests.Count -eq 0 -or $adminTests.Count -eq 0) {
        throw 'Frontend or admin test files were not found.'
    }
    $nativeTestArguments = @('--test', '--test-concurrency=1') + @($frontendTests.FullName) + @($adminTests.FullName)
    Invoke-Checked $node $nativeTestArguments 'frontend and admin tests'

    if (-not $SkipNative) {
        Write-Host 'check: WXML and WXSS compilation'
        $tempParent = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath.TrimEnd('\', '/')
        $compileTemp = [IO.Path]::GetFullPath((Join-Path $tempParent ('zhiye-check-' + [Guid]::NewGuid().ToString('N'))))
        $null = New-Item -ItemType Directory -Path $compileTemp
        $compileTempCreated = $true
        Set-Location -LiteralPath $miniRoot
        $wxmlFiles = @(
            foreach ($directory in @('pages', 'components')) {
                Get-ChildItem -LiteralPath (Join-Path $miniRoot $directory) -Filter '*.wxml' -File -Recurse
            }
        ) | Sort-Object FullName
        $wxmlFiles = @($wxmlFiles)
        $wxssFiles = @(Get-ChildItem -LiteralPath $miniRoot -Filter '*.wxss' -File -Recurse | Sort-Object FullName)
        if ($wxmlFiles.Count -eq 0 -or $wxssFiles.Count -eq 0) {
            throw 'WXML or WXSS source files were not found.'
        }
        $compilationFailed = $false
        $wxsDependencies = @(Get-ChildItem -LiteralPath $miniRoot -Filter '*.wxs' -File -Recurse | ForEach-Object { './' + $_.FullName.Substring($miniRoot.Length + 1).Replace('\', '/') })
        foreach ($file in $wxmlFiles) {
            $relative = './' + $file.FullName.Substring($miniRoot.Length + 1).Replace('\', '/')
            if (-not (Invoke-Compiler $wcc $relative (Join-Path $compileTemp 'out.js') $wxsDependencies)) {
                $compilationFailed = $true
            }
        }
        foreach ($file in $wxssFiles) {
            $relative = './' + $file.FullName.Substring($miniRoot.Length + 1).Replace('\', '/')
            if (-not (Invoke-Compiler $wcsc $relative (Join-Path $compileTemp 'out.css'))) {
                $compilationFailed = $true
            }
        }
        if ($compilationFailed) { throw 'Mini program compilation failed.' }
        Write-Host "compile: $($wxmlFiles.Count) WXML and $($wxssFiles.Count) WXSS files compiled"
    }
    else {
        Write-Host 'check: native compilation NOT RUN (-SkipNative); a separate required SDK check is needed before release'
    }

    Set-Location -LiteralPath $taskRoot
    Invoke-Checked $python @('scripts/verify.py') 'static source checks'
    Invoke-Checked $python @('-m', 'unittest', 'discover', '-s', 'tests', '-p', '*_test.py') 'operations and check-entry tests'
    if ($SkipNative) {
        Write-Host 'check: source and behavior stages passed; native compilation NOT VERIFIED'
    }
    else {
        Write-Host 'check: all stages passed (including native compilation)'
    }
}
catch {
    [Console]::Error.WriteLine("check: $($_.Exception.Message)")
    $exitCode = 1
}
finally {
    if ($null -eq $savedTimezone) {
        Remove-Item -LiteralPath Env:TZ -ErrorAction SilentlyContinue
    }
    else {
        $env:TZ = $savedTimezone
    }
    try {
        if ($compileTempCreated -and (Test-Path -LiteralPath $compileTemp)) {
            # Only remove the exact, directly nested temporary directory created
            # above; never a computed workspace path or a redirected directory.
            $resolvedTemp = (Resolve-Path -LiteralPath $compileTemp).ProviderPath
            $tempItem = Get-Item -LiteralPath $resolvedTemp -Force
            $parent = [IO.Path]::GetDirectoryName($resolvedTemp).TrimEnd('\', '/')
            if (-not $resolvedTemp.Equals($compileTemp, [StringComparison]::OrdinalIgnoreCase) -or
                -not $parent.Equals($tempParent, [StringComparison]::OrdinalIgnoreCase) -or
                -not $tempItem.Name.StartsWith('zhiye-check-', [StringComparison]::Ordinal) -or
                ($tempItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'Refusing to remove an unexpected temporary directory.'
            }
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
    catch {
        [Console]::Error.WriteLine("check: temporary-directory cleanup failed: $($_.Exception.Message)")
        $exitCode = 1
    }
    Pop-Location
}
exit $exitCode
