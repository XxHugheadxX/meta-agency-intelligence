# Reporting unificado sin doble conteo

## Objetivo

El workbook semanal o mensual puede contener tres datasets en un único archivo:

1. `paid`: Meta Ads al nivel solicitado, normalmente `ad`.
2. `organic_account`: métricas diarias agregadas de Facebook/Instagram.
3. `content`: snapshots lifetime de contenidos publicados durante el periodo.

Los datasets comparten tenant, workspace y periodo, pero no se fusionan en un
único total de alcance, impresiones, visualizaciones o interacciones. Una misma
persona puede aparecer en Ads, orgánico y varios contenidos; sumarla produciría
un KPI engañoso.

## Reglas de composición

- El Resumen Ejecutivo conserva como KPIs principales los resultados pagados.
- Orgánico de cuenta y contenido tienen secciones independientes.
- El Dashboard muestra Ads y orgánico de cuenta lado a lado.
- Rendimiento semanal/mensual, Campañas, Ad Sets y Ads usan el dataset pagado.
- Contenido combina filas Ads identificables y contenido orgánico tipado, sin
  convertir una publicación en un anuncio.
- Métricas Digitales muestra comparaciones actual/anterior por dataset.
- Raw Data reúne los tres niveles e incluye `level`, `content_id`,
  `content_name` y `content_type` para auditoría.
- El gráfico Top contenidos usa `content` cuando existe; no intenta derivarlo de
  alcance account-level.

## Compatibilidad

`AgencyReportingService.createReport` y los reportes de un solo nivel continúan
disponibles. `createUnifiedReport`, `createUnifiedWeeklyReport` y
`createUnifiedMonthlyReport` añaden la composición. El pipeline MVP utiliza el
reporte unificado y mantiene `report.current`, `report.rawRows`, rankings y KPIs
pagados para consumidores anteriores.

## Límites actuales

- Todavía no se ejecutan los tres procesos de ingesta dentro del mismo job; el
  workbook consume histórico orgánico ya disponible y ejecuta Ads en el job
  actual.
- Facebook post-level sigue pendiente.
- Los snapshots de contenido se atribuyen a su fecha de publicación y reflejan
  el total lifetime observado en `extractedAt`.
- La revisión visual final en Microsoft Excel de escritorio sigue siendo un gate
  de producto.
