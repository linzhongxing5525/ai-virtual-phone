param(
    [string]$RuntimeDirectory = "$env:USERPROFILE\Starforest-Takeout",
    [string]$Origin = "https://starforest.netlify.app"
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/sanqianzilanyue/ai-order-takeout.git"
$UpstreamDirectory = Join-Path $RuntimeDirectory "ai-order-takeout"
$ConfigPath = Join-Path $RuntimeDirectory "takeout-bridge.local.json"
$ImportPath = Join-Path $RuntimeDirectory "starforest-takeout-tool.json"
$PlacesPath = Join-Path $RuntimeDirectory "places.local.json"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
if (-not (Test-Path -LiteralPath $UpstreamDirectory)) {
    git clone --depth 1 $RepoUrl $UpstreamDirectory
} else {
    git -C $UpstreamDirectory pull --ff-only
}
npm --prefix (Join-Path $UpstreamDirectory "script") install
if (Test-Path -LiteralPath (Join-Path $UpstreamDirectory "script\hand.js")) {
    Copy-Item -LiteralPath (Join-Path $UpstreamDirectory "script\hand.js") -Destination (Join-Path $UpstreamDirectory "script\手.cjs") -Force
}
Copy-Item -LiteralPath (Join-Path $UpstreamDirectory "script\order.js") -Destination (Join-Path $UpstreamDirectory "script\order.cjs") -Force
$OrderScriptPath = Join-Path $UpstreamDirectory "script\order.cjs"
$OrderScript = [System.IO.File]::ReadAllText($OrderScriptPath)
$OrderScript = $OrderScript.Replace('join(__dirname, "手.js")', 'join(__dirname, "手.cjs")')
[System.IO.File]::WriteAllText($OrderScriptPath, $OrderScript, $Utf8NoBom)

if (-not (Test-Path -LiteralPath $PlacesPath)) {
    $PlacesTemplate = @'
{
  "家": {
    "latitude": 0,
    "longitude": 0,
    "addressKeyword": "请改成地址簿里能识别你家的关键词"
  },
  "公司": {
    "latitude": 0,
    "longitude": 0,
    "addressKeyword": "请改成地址簿里能识别公司的关键词"
  },
  "phone": "请改成你的手机号",
  "defaultAddress": "家",
  "defaultBudget": 50
}
'@
    [System.IO.File]::WriteAllText($PlacesPath, $PlacesTemplate, $Utf8NoBom)
    Write-Host "已生成 $PlacesPath，请填写后重新运行本脚本。"
    Start-Process notepad.exe -ArgumentList $PlacesPath
    exit 2
}

$PlacesInput = Get-Content -LiteralPath $PlacesPath -Raw | ConvertFrom-Json
$AddressLabels = @($PlacesInput.PSObject.Properties.Name | Where-Object { $_ -notin @("phone", "defaultAddress", "defaultBudget", "认") })
$Places = @{}
$Recognition = @{}
foreach ($Label in $AddressLabels) {
    $Item = $PlacesInput.PSObject.Properties[$Label].Value
    $Latitude = [double]$Item.latitude
    $Longitude = [double]$Item.longitude
    if ($Latitude -eq 0 -or $Longitude -eq 0) { throw "地址 $Label 的 latitude/longitude 还没有填写" }
    $Places[$Label] = @{ latitude = $Latitude; longitude = $Longitude }
    if ($Item.addressKeyword) { $Recognition[$Label] = [string]$Item.addressKeyword }
}
$Places["认"] = $Recognition
$Places["phone"] = [string]$PlacesInput.phone
$TakeoutPrivateDirectory = Join-Path $env:USERPROFILE ".takeout"
New-Item -ItemType Directory -Force -Path $TakeoutPrivateDirectory | Out-Null
[System.IO.File]::WriteAllText((Join-Path $TakeoutPrivateDirectory "places.json"), ($Places | ConvertTo-Json -Depth 8), $Utf8NoBom)

if (Test-Path -LiteralPath $ConfigPath) {
    $Existing = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $BridgeId = [string]$Existing.bridgeId
    $Token = [string]$Existing.token
} else {
    $BridgeBytes = [byte[]]::new(16)
    $TokenBytes = [byte[]]::new(32)
    $Random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $Random.GetBytes($BridgeBytes)
        $Random.GetBytes($TokenBytes)
    } finally {
        $Random.Dispose()
    }
    $BridgeId = ([BitConverter]::ToString($BridgeBytes) -replace '-', '').ToLowerInvariant()
    $Token = ([BitConverter]::ToString($TokenBytes) -replace '-', '').ToLowerInvariant()
}

$Config = @{
    origin = $Origin.TrimEnd('/')
    bridgeId = $BridgeId
    token = $Token
    upstreamDir = $UpstreamDirectory
    cdp = "http://127.0.0.1:9222"
    phone = [string]$PlacesInput.phone
    places = $Places
    defaultAddress = if ($PlacesInput.defaultAddress) { [string]$PlacesInput.defaultAddress } else { "家" }
    defaultBudget = if ($PlacesInput.defaultBudget) { [double]$PlacesInput.defaultBudget } else { 50 }
    pollMs = 5000
    orderTimeoutMs = 720000
}
[System.IO.File]::WriteAllText($ConfigPath, ($Config | ConvertTo-Json -Depth 8), $Utf8NoBom)

$Now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$Import = @{
    format = "ai-phone-toolbox"
    version = 1
    exportedAt = [DateTime]::UtcNow.ToString("o")
    mcpServers = @(@{
        id = "mcp_takeout_$BridgeId"
        name = "真实外卖助手"
        description = "连接用户电脑上的淘宝闪购/饿了么助手。可以查看在线状态；用户明确要求点外卖时生成独立确认卡，只有用户点击卡片确认后才会真实下单。不得在闲聊中擅自花钱。"
        url = "$($Origin.TrimEnd('/'))/api/takeout-mcp?id=$BridgeId"
        enabled = $true
        accessToken = $Token
        createdAt = $Now
        updatedAt = $Now
    })
}
[System.IO.File]::WriteAllText($ImportPath, ($Import | ConvertTo-Json -Depth 10), $Utf8NoBom)

$Chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path -LiteralPath $Chrome)) { $Chrome = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" }
if (-not (Test-Path -LiteralPath $Chrome)) { throw "没有找到 Chrome 或 Edge" }
$Profile = Join-Path $RuntimeDirectory "chrome-profile"
Start-Process -FilePath $Chrome -ArgumentList @("--remote-debugging-port=9222", "--user-data-dir=$Profile", "--window-size=430,920", "https://h5.ele.me")

Write-Host ""
Write-Host "已生成小手机导入文件：$ImportPath"
Write-Host "请在专用浏览器中登录淘宝闪购/饿了么，然后运行 start.ps1。"
