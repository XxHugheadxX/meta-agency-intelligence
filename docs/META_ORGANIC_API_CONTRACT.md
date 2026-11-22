# Contrato orgánico de Meta

Revisión de código: 2026-08-31. Este documento describe el contrato implementado,
no confirma acceso a una cuenta real.

## Fuentes primarias

- El codegen oficial de Meta declara los edges GET `published_posts` de Page y
  `insights` de Post:
  <https://github.com/facebook/facebook-business-sdk-codegen/blob/main/api_specs/specs/Page.json>
  y
  <https://github.com/facebook/facebook-business-sdk-codegen/blob/main/api_specs/specs/Post.json>.
- El SDK oficial actual expone los campos `id`, `message`, `created_time`,
  `permalink_url` y `status_type` en `PagePost`, junto al edge GET de insights:
  <https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/page-post.js>.
- El catálogo generado actual de `InsightsResult` incluye `views`,
  `total_interactions`, `profile_visits` y `follows`:
  <https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/insights-result.js>.

## Contrato implementado

- Sólo se usan llamadas GET mediante el cliente Meta read-only compartido.
- Page account-level solicita `views`, `total_interactions`, `profile_visits` y
  `follows` como serie temporal diaria.
- Post-level descubre publicaciones propias mediante `published_posts` y
  solicita `views` y `total_interactions` lifetime.
- El post debe tener un ID numérico ligado al Page ID permitido. Un post de otro
  Page se rechaza antes de consultar insights o persistir histórico.
- URLs se reducen a hosts HTTPS de Facebook permitidos, sin query ni fragment.
- Raw data pasa por redacción de secretos, límites de profundidad y tamaño.
- `views` se conserva como views. No se presenta como alcance o impresiones.
  Métricas no entregadas se mantienen ausentes y la fila se marca parcial.

## Permisos mínimos previstos

El worker exige `read_insights` y `pages_read_engagement` para un Page, además de
`ads_read` para el job de reporting. Rechaza `ads_management` y otros scopes de
escritura definidos por la frontera read-only.

## Gate pendiente

Antes de conectar activos reales, ejecutar contract tests con una Meta Test App
para confirmar por versión: soporte de `since`/`until`, forma time-series de
account-level, forma lifetime de post-level, posts sin mensaje, paginación y
respuesta cuando una métrica no está disponible. Un error de métrica debe
fallar cerrado; no debe activar un fallback silencioso a métricas retiradas.

## Ejecución segura en PowerShell

Usar exclusivamente activos no productivos con al menos una publicación por
plataforma dentro del rango. No pegar el token en el chat ni guardarlo en un
archivo del repositorio.

```powershell
$env:RUN_META_ORGANIC_CONTRACT_TESTS = "true"
$env:META_CONTRACT_ACCESS_TOKEN = Read-Host -MaskInput "Token temporal de la Meta Test App"
$env:META_CONTRACT_PAGE_ID = "ID_NUMERICO_PAGE_TEST"
$env:META_CONTRACT_FACEBOOK_POST_ID = "ID_PAGE_TEST_ID_POST_TEST"
$env:META_CONTRACT_INSTAGRAM_ID = "ID_NUMERICO_INSTAGRAM_TEST"
$env:META_CONTRACT_INSTAGRAM_MEDIA_ID = "ID_NUMERICO_MEDIA_TEST"
$env:META_CONTRACT_API_VERSION = "v25.0"
$env:META_CONTRACT_START_DATE = "AAAA-MM-DD"
$env:META_CONTRACT_END_DATE = "AAAA-MM-DD"

.\node_modules\.bin\vitest.cmd run tests\contract\meta-organic-test-app.contract.test.ts --pool=threads --maxWorkers=1

Remove-Item Env:RUN_META_ORGANIC_CONTRACT_TESTS
Remove-Item Env:META_CONTRACT_ACCESS_TOKEN
Remove-Item Env:META_CONTRACT_PAGE_ID
Remove-Item Env:META_CONTRACT_FACEBOOK_POST_ID
Remove-Item Env:META_CONTRACT_INSTAGRAM_ID
Remove-Item Env:META_CONTRACT_INSTAGRAM_MEDIA_ID
Remove-Item Env:META_CONTRACT_API_VERSION
Remove-Item Env:META_CONTRACT_START_DATE
Remove-Item Env:META_CONTRACT_END_DATE
```

El archivo se omite en la suite normal. Sólo realiza GET, usa el cliente
read-only compartido y falla si un post/media no pertenece al activo permitido.
