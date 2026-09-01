# Contrato seguro de Meta Ads Insights

Este gate valida una cuenta publicitaria exclusivamente de prueba antes de
autorizar activos reales. El arnés usa el cliente `read_only`, sólo realiza GET,
exige binding del `act_<id>` al workspace y no solicita ni necesita
`ads_management`.

## Permiso mínimo

- `ads_read`

No añadir `ads_management`. Si Meta exige otro permiso, detener la prueba y
revisar el endpoint y la versión antes de ampliar scopes.

## Ejecución segura en PowerShell

No pegar el token en el chat, en archivos `.env`, en URLs ni en argumentos del
comando. Usar un token temporal y una cuenta publicitaria no productiva.

```powershell
$env:RUN_META_ADS_CONTRACT_TESTS = "true"
$env:META_ADS_CONTRACT_ACCESS_TOKEN = Read-Host -MaskInput "Token temporal con ads_read"
$env:META_ADS_CONTRACT_ACCOUNT_ID = "act_ID_NUMERICO_TEST"
$env:META_ADS_CONTRACT_API_VERSION = "v25.0"
$env:META_ADS_CONTRACT_START_DATE = "AAAA-MM-DD"
$env:META_ADS_CONTRACT_END_DATE = "AAAA-MM-DD"

.\node_modules\.bin\vitest.cmd run tests\contract\meta-ads-test-app.contract.test.ts --pool=threads --maxWorkers=1

Remove-Item Env:RUN_META_ADS_CONTRACT_TESTS -ErrorAction SilentlyContinue
Remove-Item Env:META_ADS_CONTRACT_ACCESS_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:META_ADS_CONTRACT_ACCOUNT_ID -ErrorAction SilentlyContinue
Remove-Item Env:META_ADS_CONTRACT_API_VERSION -ErrorAction SilentlyContinue
Remove-Item Env:META_ADS_CONTRACT_START_DATE -ErrorAction SilentlyContinue
Remove-Item Env:META_ADS_CONTRACT_END_DATE -ErrorAction SilentlyContinue
```

La prueba consulta metadata del ad account y Ads Insights diarios al nivel
`account`. Una respuesta vacía confirma autenticación y acceso, pero no valida
la forma real de métricas; antes del piloto debe repetirse con datos sintéticos
o no productivos dentro del rango.
