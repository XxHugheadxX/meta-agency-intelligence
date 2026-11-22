# Ingesta orgánica read-only

## Alcance implementado

La rama `mvp/read-only-reporting` contiene dos flujos independientes:

- `organic_account`: métricas diarias agregadas de Facebook Page e Instagram.
- `content`: snapshots lifetime de publicaciones, Reels, videos y carruseles de
  Instagram cuya fecha de publicación cae dentro del rango solicitado.

La separación evita sumar dos veces alcance e interacciones de cuenta y
contenido. Los snapshots por contenido se identifican por tenant, workspace,
cuenta, contenido, tipo y fecha de publicación; repetir una ejecución actualiza
la misma fila en vez de crear duplicados.

## Frontera de seguridad

- Únicamente se usa el método `GET` del cliente Meta read-only.
- El activo se autoriza contra tenant/workspace antes de cualquier llamada.
- IDs de cuenta y contenido deben ser numéricos y nunca se interpolan desde una
  URL suministrada por el usuario.
- Los parámetros son catálogos fijos; no aceptan campos o métricas arbitrarias.
- Hay límites de páginas, contenidos y métricas por respuesta.
- Raw data se conserva sanitizada y excluye valores con forma de credencial.
- No se solicitan ni utilizan `ads_management`, permisos de publicación o
  permisos para administrar comentarios/mensajes.

## Semántica

- Las métricas account-level se guardan por día.
- Las métricas de contenido son totales lifetime observados en `extractedAt` y
  se ubican en la fecha de publicación del contenido.
- Una métrica ausente queda en `null`; nunca se convierte silenciosamente en
  cero.
- Si Meta no devuelve todo el catálogo esperado, la fila queda `partial` y
  `rawData.missingMetrics` explica la cobertura.
- `interactions` usa `total_interactions` cuando existe. Sólo si falta, se
  deriva de likes, comentarios, compartidos y guardados y la fila permanece
  parcial.

El catálogo de media insights de Instagram se basa en la colección oficial de
Meta: <https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api>.

## Permisos previstos

La validación final debe comprobar en una Meta Test App los permisos de lectura
ya definidos por el proyecto:

- `pages_show_list`
- `pages_read_engagement`
- `read_insights`
- `instagram_basic`
- `instagram_manage_insights`

La disponibilidad efectiva depende del tipo de cuenta, la versión de Graph API,
el tipo de contenido y la aprobación de la aplicación.

## Pendiente antes del piloto

1. Contract tests contra una Meta Test App sin activos reales.
2. Confirmar el catálogo exacto por IMAGE, VIDEO, REELS y CAROUSEL.
3. Implementar Facebook post-level sólo después de validar métricas y respuesta
   actuales; no reutilizar a ciegas el contrato de Instagram.
4. Añadir checkpoints incrementales específicos para contenido.
5. Validar la ejecución programada completa contra Meta Test App. La runtime ya
   ejecuta Ads, cuenta orgánica y contenido dentro del mismo job firmado.

## Ejecución programada

Un binding orgánico sólo participa en un job cuando declara explícitamente
`reportingAccountId`. El valor debe ser la cuenta Ads `act_<digits>` que recibirá
ese activo en su reporte. Un Page o Instagram sin asociación se ignora en el
worker; nunca se asigna por heurística a una de las aproximadamente 20 cuentas.

Además, el resolver intersecta tres controles antes de exponer el activo a la
runtime:

1. binding activo del workspace;
2. `reportingAccountId` igual a la cuenta del job firmado;
3. `assetId` presente en `allowedAssetIds` del token cifrado del workspace.

La runtime exige `ads_read` para Ads. Si existe Page también exige
`read_insights` y `pages_read_engagement`; si existe Instagram exige
`read_insights`, `instagram_basic` e `instagram_manage_insights`. Cualquier
scope de escritura de la denylist mantiene el rechazo total del job.
