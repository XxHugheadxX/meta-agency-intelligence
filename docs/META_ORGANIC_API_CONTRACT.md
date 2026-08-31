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
