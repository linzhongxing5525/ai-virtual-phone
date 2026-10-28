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
$HomeLabel = [string]([char]0x5BB6)
$OfficeLabel = [string]([char]0x516C) + [char]0x53F8
$RecognitionKey = [string]([char]0x8BA4)
$HandFileName = [string]([char]0x624B) + ".cjs"

New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
if (-not (Test-Path -LiteralPath $UpstreamDirectory)) {
    $CloneDirectory = "$UpstreamDirectory.partial"
    if (Test-Path -LiteralPath $CloneDirectory) { Remove-Item -LiteralPath $CloneDirectory -Recurse -Force }
    git clone --depth 1 $RepoUrl $CloneDirectory
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path -LiteralPath $CloneDirectory) { Remove-Item -LiteralPath $CloneDirectory -Recurse -Force }
        throw "Could not download ai-order-takeout from GitHub. Check the network and run setup.ps1 again."
    }
    Move-Item -LiteralPath $CloneDirectory -Destination $UpstreamDirectory
} else {
    if (-not (Test-Path -LiteralPath (Join-Path $UpstreamDirectory ".git"))) {
        throw "$UpstreamDirectory is incomplete. Delete only that folder, then run setup.ps1 again."
    }
    git -C $UpstreamDirectory pull --ff-only
    if ($LASTEXITCODE -ne 0) { Write-Warning "Could not check for ai-order-takeout updates. Continuing with the complete local copy." }
}
npm --prefix (Join-Path $UpstreamDirectory "script") install
if ($LASTEXITCODE -ne 0) { throw "npm install failed. Check Node.js and the network, then run setup.ps1 again." }
if (Test-Path -LiteralPath (Join-Path $UpstreamDirectory "script\hand.js")) {
    Copy-Item -LiteralPath (Join-Path $UpstreamDirectory "script\hand.js") -Destination (Join-Path $UpstreamDirectory "script\$HandFileName") -Force
}
Copy-Item -LiteralPath (Join-Path $UpstreamDirectory "script\order.js") -Destination (Join-Path $UpstreamDirectory "script\order.cjs") -Force
$OrderScriptPath = Join-Path $UpstreamDirectory "script\order.cjs"
$OrderScript = [System.IO.File]::ReadAllText($OrderScriptPath)
$OrderScript = $OrderScript.Replace(('join(__dirname, "' + [char]0x624B + '.js")'), ('join(__dirname, "' + $HandFileName + '")'))
[System.IO.File]::WriteAllText($OrderScriptPath, $OrderScript, $Utf8NoBom)

if (-not (Test-Path -LiteralPath $PlacesPath)) {
    $PlacesTemplateObject = [ordered]@{
        $HomeLabel = [ordered]@{ latitude = 0; longitude = 0; addressKeyword = "CHANGE_TO_HOME_ADDRESS_KEYWORD" }
        $OfficeLabel = [ordered]@{ latitude = 0; longitude = 0; addressKeyword = "CHANGE_TO_OFFICE_ADDRESS_KEYWORD" }
        phone = "CHANGE_TO_YOUR_PHONE_NUMBER"
        defaultAddress = $HomeLabel
        defaultBudget = 50
    }
    $PlacesTemplate = $PlacesTemplateObject | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($PlacesPath, $PlacesTemplate, $Utf8NoBom)
    Write-Host "Created $PlacesPath. Fill it in, save it, then run setup.ps1 again."
    Start-Process notepad.exe -ArgumentList $PlacesPath
    exit 2
}

$PlacesInput = [System.IO.File]::ReadAllText($PlacesPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$AddressLabels = @($PlacesInput.PSObject.Properties.Name | Where-Object { $_ -notin @("phone", "defaultAddress", "defaultBudget", $RecognitionKey) })
$Places = @{}
$Recognition = @{}
foreach ($Label in $AddressLabels) {
    $Item = $PlacesInput.PSObject.Properties[$Label].Value
    $Latitude = [double]$Item.latitude
    $Longitude = [double]$Item.longitude
    if ($Latitude -eq 0 -or $Longitude -eq 0) { throw "Address label $Label still has an empty latitude/longitude" }
    $Places[$Label] = @{ latitude = $Latitude; longitude = $Longitude }
    if ($Item.addressKeyword) { $Recognition[$Label] = [string]$Item.addressKeyword }
}
$Places[$RecognitionKey] = $Recognition
$Places["phone"] = [string]$PlacesInput.phone
$TakeoutPrivateDirectory = Join-Path $env:USERPROFILE ".takeout"
New-Item -ItemType Directory -Force -Path $TakeoutPrivateDirectory | Out-Null
[System.IO.File]::WriteAllText((Join-Path $TakeoutPrivateDirectory "places.json"), ($Places | ConvertTo-Json -Depth 8), $Utf8NoBom)

if (Test-Path -LiteralPath $ConfigPath) {
    $Existing = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
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
    defaultAddress = if ($PlacesInput.defaultAddress) { [string]$PlacesInput.defaultAddress } else { $HomeLabel }
    defaultBudget = if ($PlacesInput.defaultBudget) { [double]$PlacesInput.defaultBudget } else { 50 }
    pollMs = 5000
    orderTimeoutMs = 720000
}
[System.IO.File]::WriteAllText($ConfigPath, ($Config | ConvertTo-Json -Depth 8), $Utf8NoBom)

$Now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$StatusToolName = [regex]::Unescape("\u67e5\u770b\u771f\u5b9e\u5916\u5356\u52a9\u624b\u72b6\u6001")
$PrepareToolName = [regex]::Unescape("\u51c6\u5907\u771f\u5b9e\u5916\u5356\u8ba2\u5355")
$DiscoveredTools = @(
    @{
        name = $StatusToolName
        description = "Read-only status check for the takeout helper on the user's computer."
        inputSchema = @{ type = "object"; additionalProperties = $false; properties = @{} }
    },
    @{
        name = $PrepareToolName
        description = "Use only when the user explicitly asks to order takeout. First creates a no-purchase quote; the real order requires the user's approval card confirmation."
        inputSchema = @{
            type = "object"
            additionalProperties = $false
            properties = @{
                kw = @{ type = "string"; description = "Food or drink requested by the user" }
                dish = @{ type = "string"; description = "Optional exact dish" }
                shop = @{ type = "string"; description = "Optional shop keyword" }
                specs = @{ type = "array"; items = @{ type = "string" }; description = "Optional specifications" }
                qty = @{ type = "number"; description = "Quantity, defaults to 1" }
                address = @{ type = "string"; description = "Local address label, never a full street address" }
                max = @{ type = "number"; description = "Maximum total amount in CNY" }
            }
            required = @("kw", "max")
        }
    }
)
$Import = @{
    format = "ai-phone-toolbox"
    version = 1
    exportedAt = [DateTime]::UtcNow.ToString("o")
    mcpServers = @(@{
        id = "mcp_takeout_$BridgeId"
        name = "Starforest Takeout Assistant"
        description = "Connects to the takeout helper on this computer. It creates an approval card when the user explicitly requests an order. A real order starts only after the user clicks the approval card."
        url = "$($Origin.TrimEnd('/'))/api/takeout-mcp?id=$BridgeId"
        enabled = $true
        accessToken = $Token
        discoveredTools = $DiscoveredTools
        createdAt = $Now
        updatedAt = $Now
    })
}
[System.IO.File]::WriteAllText($ImportPath, ($Import | ConvertTo-Json -Depth 10), $Utf8NoBom)

$Chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path -LiteralPath $Chrome)) { $Chrome = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" }
if (-not (Test-Path -LiteralPath $Chrome)) { throw "Chrome or Edge was not found" }
$Profile = Join-Path $RuntimeDirectory "chrome-profile"
Start-Process -FilePath $Chrome -ArgumentList @("--remote-debugging-port=9222", "--user-data-dir=$Profile", "--window-size=430,920", "https://h5.ele.me")

Write-Host ""
Write-Host "Starforest import file: $ImportPath"
Write-Host "Sign in to Eleme/Taobao Takeout in the dedicated browser, then run start.ps1."
