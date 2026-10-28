param([string]$RuntimeDirectory = "$env:USERPROFILE\Starforest-Takeout")
$ErrorActionPreference = "Stop"
$ConfigPath = Join-Path $RuntimeDirectory "takeout-bridge.local.json"
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Run setup.ps1 first" }
$Config = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$Chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path -LiteralPath $Chrome)) { $Chrome = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" }
$Profile = Join-Path $RuntimeDirectory "chrome-profile"
try { Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 2 | Out-Null }
catch { Start-Process -FilePath $Chrome -ArgumentList @("--remote-debugging-port=9222", "--user-data-dir=$Profile", "--window-size=430,920", "https://h5.ele.me"); Start-Sleep -Seconds 3 }
node (Join-Path $PSScriptRoot "worker.mjs") $ConfigPath
