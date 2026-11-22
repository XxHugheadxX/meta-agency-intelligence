param(
  [string]$AccountId,
  [string]$StartDate,
  [string]$EndDate,
  [string]$ApiVersion,
  [ValidateSet("account", "campaign", "ad_set", "ad")]
  [string]$Level = "account",
  [switch]$RequireData
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$vitest = Join-Path $repositoryRoot "node_modules/.bin/vitest.cmd"
if (-not (Test-Path -LiteralPath $vitest)) { throw "Vitest no esta instalado; no se ejecutara npm." }
if (-not $AccountId) { $AccountId = Read-Host "ID numerico de la cuenta publicitaria SANDBOX (no App ID)" }
$AccountId = $AccountId.Trim()
if ($AccountId -match '^\d{1,32}$') { $AccountId = "act_$AccountId" }
if ($AccountId -notmatch '^act_\d{1,32}$') { throw "Usa solo el ID numerico o act_ seguido de numeros, sin /insights ni URLs." }

if (-not $EndDate) { $EndDate = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd") }
if (-not $StartDate) { $StartDate = (Get-Date).AddDays(-30).ToString("yyyy-MM-dd") }
$culture = [Globalization.CultureInfo]::InvariantCulture
$parsedStart = [DateTime]::ParseExact($StartDate, "yyyy-MM-dd", $culture)
$parsedEnd = [DateTime]::ParseExact($EndDate, "yyyy-MM-dd", $culture)
if ($parsedStart -gt $parsedEnd -or ($parsedEnd - $parsedStart).TotalDays -gt 90) {
  throw "Rango invalido: inicio <= fin, como maximo 91 dias para esta prueba."
}
if (-not $ApiVersion) { $ApiVersion = $env:META_API_VERSION }
if (-not $ApiVersion) {
  $versionSource = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot "src/meta/api-version.ts")
  if ($versionSource -notmatch 'DEFAULT_META_API_VERSION = "(v\d+\.\d+)"') { throw "No se encontro la version compartida." }
  $ApiVersion = $Matches[1]
}
$ApiVersion = $ApiVersion.Trim()
if ($ApiVersion -notmatch '^v\d{1,3}\.\d{1,2}$') { throw "Version invalida; usa vN.N." }
if ((Read-Host "Escribe SANDBOX para confirmar que NO es una cuenta real") -cne "SANDBOX") {
  throw "Prueba cancelada; no se llamo a Meta."
}

$names = @("RUN_META_ADS_CONTRACT_TESTS", "META_ADS_CONTRACT_ACCESS_TOKEN", "META_ADS_CONTRACT_ACCOUNT_ID",
  "META_ADS_CONTRACT_API_VERSION", "META_ADS_CONTRACT_START_DATE", "META_ADS_CONTRACT_END_DATE",
  "META_ADS_CONTRACT_LEVEL", "META_ADS_CONTRACT_REQUIRE_DATA")
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }
$secureToken = $null
$tokenPointer = [IntPtr]::Zero
Push-Location -LiteralPath $repositoryRoot
try {
  $secureToken = Read-Host "Token temporal (solo ads_read; entrada oculta)" -AsSecureString
  if ($secureToken.Length -eq 0) { throw "Token vacio; prueba cancelada." }
  $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $env:META_ADS_CONTRACT_ACCESS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
  $tokenPointer = [IntPtr]::Zero
  $env:RUN_META_ADS_CONTRACT_TESTS = "true"
  $env:META_ADS_CONTRACT_ACCOUNT_ID = $AccountId
  $env:META_ADS_CONTRACT_API_VERSION = $ApiVersion
  $env:META_ADS_CONTRACT_START_DATE = $StartDate
  $env:META_ADS_CONTRACT_END_DATE = $EndDate
  $env:META_ADS_CONTRACT_LEVEL = $Level
  $env:META_ADS_CONTRACT_REQUIRE_DATA = $RequireData.IsPresent.ToString().ToLowerInvariant()
  & $vitest run tests/contract/meta-ads-test-app.contract.test.ts --pool=threads --maxWorkers=1
  if ($LASTEXITCODE -ne 0) { throw "Contrato fallido. Comparte solo el codigo de error sanitizado, nunca el token." }
  Write-Host "Contrato terminado. Sin RequireData, una respuesta vacia solo valida acceso, no metricas."
} finally {
  if ($tokenPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer) }
  if ($secureToken) { $secureToken.Dispose() }
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], "Process") }
  Pop-Location
}
