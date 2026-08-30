param(
  [string]$EmulatorHost = "127.0.0.1:8085"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$vitest = Join-Path $repositoryRoot "node_modules/.bin/vitest.cmd"

if ($EmulatorHost -notmatch '^(localhost|127\.0\.0\.1):\d+$') {
  throw "EmulatorHost must point to localhost or 127.0.0.1"
}
if (-not (Test-Path -LiteralPath $vitest)) {
  throw "Vitest is not installed in node_modules/.bin"
}

$previousHost = $env:FIRESTORE_EMULATOR_HOST
$previousProject = $env:FIRESTORE_PROJECT_ID
try {
  $env:FIRESTORE_EMULATOR_HOST = $EmulatorHost
  $env:FIRESTORE_PROJECT_ID = "meta-agency-emulator"
  & $vitest run `
    tests/agency/firestore-ingestion.integration.test.ts `
    tests/agency/firestore-reporting-pipeline.integration.test.ts `
    --pool=threads --maxWorkers=1
  if ($LASTEXITCODE -ne 0) {
    throw "Firestore emulator integration tests failed with exit code $LASTEXITCODE"
  }
} finally {
  $env:FIRESTORE_EMULATOR_HOST = $previousHost
  $env:FIRESTORE_PROJECT_ID = $previousProject
}
