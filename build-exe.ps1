# Builds the web app and publishes the single-file launcher to publish\WaveFlow.exe.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
npm run build
if ($LASTEXITCODE) { throw 'npm run build failed' }
dotnet publish launcher\WaveFlow.csproj -c Release -o publish
if ($LASTEXITCODE) { throw 'dotnet publish failed' }
Get-Item publish\WaveFlow.exe | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
