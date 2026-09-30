# MVP: estado verificable y próximos pasos

Actualizado: 2026-09-30. Rama de esta integración: `codex/mvp-data-readiness`.
No se conectaron cuentas reales, no se desplegó, no se hizo merge.

## Cambios de esta integración

- Comparación mensual contra el mes calendario anterior completo.
- Primer backfill del scheduler cubre el período actual y el anterior.
- Histórico y selección de reportes separan breakdown, atribución, API y esquema.
  Los datasets ambiguos o snapshots duplicados fallan antes de producir un total.
- El consolidado paid usa la lista de cuentas firmada del batch.
- No se suman aliases de leads/mensajes ni objetivos distintos de conversión.
  Se conservan tipos de acción y política en raw sanitizado.
- Alcance/frecuencia multi-fila quedan N/D; ratios se recalculan desde totales.
- Recomendaciones READ-ONLY integradas al reporte/Resumen Ejecutivo con período,
  confianza, evidencia y limitaciones. No se reemplaza creative ID por ad ID.
- Fórmulas Excel que apuntan a valores ausentes cachean texto, no cero.
- OAuth, cliente y contratos comparten un default configurable de API.
- Helper PowerShell para contrato Ads con ID validado, token oculto y preflight
  de mínimo privilegio. El contrato externo aún no fue ejecutado exitosamente.
- Deploy manual opt-in y publicación de paquetes desactivada por defecto.
- Docker separa dependencias de producción de las de desarrollo.

## Validación local

Suite normal sin acceso a Meta: 961 tests aprobados, 15 omitidos (976 total),
83 archivos aprobados y 6 omitidos. Firestore local: 4 archivos, 10 tests
adicionales ejecutados correctamente con fixtures; los 5 contratos Meta siguen
sin ejecutarse. La primera repetición simultánea con builds tuvo 4 timeouts;
pasaron aislados y luego pasó toda la suite con 2 workers, sin cambiar timeouts.
Typecheck, lint y compilación pasaron invocando binaries instalados sin npm.
Gitleaks 8.30.1: historial y directorio sin secretos detectados. Estos resultados
no reemplazan un pentest, un audit actualizado de dependencias ni revisión de IAM.
Las suites omitidas no cuentan como aprobadas por la ejecución normal.

## Pendientes de código/datos

1. Leer y almacenar alcance único por período/nivel de cuenta o campaña desde
   un endpoint autorizado. Mantenerlo separado del histórico diario; no fabricar
   un total de agencia deduplicado entre cuentas. Hasta entonces: N/D.
2. Incorporar metadata de targeting/ad sets y creative IDs reales bajo bindings
   revisados. Intereses, audiencias y creatividades no se inventan a partir de Ads
   Insights; actualmente sólo se analizan cuando hay fuentes explícitas válidas.
3. Conciliar la política de acciones/objetivos con fixtures aceptados por negocio.
   Los umbrales de recomendaciones son heurísticos, no promesas de mejora.
4. Cobertura orgánica del consolidado: actualmente workspace-scoped. Antes de
   ofrecer batches parciales, restringirla a la unión de activos autorizados de
   las conexiones del batch, no de otras conexiones del mismo workspace.

## Migración y backfill: no borrar ni mezclar

Las claves históricas ahora incluyen API y esquema, y la normalización paid
usa `meta-insights-v2`. Un histórico de una versión anterior puede conservar
IDs del algoritmo antiguo. No convertir ni borrar filas automáticamente.

- Hacer backup con datos ficticios y revisar la selección del dataset destino.
- Ejecutar backfill explícito de **ambos períodos** con el esquema nuevo; el
  watermark incremental por sí solo no renormaliza todos los días antiguos.
- Conciliar métricas aditivas y conteos antes de promover el dataset seleccionado.
- Si hay versiones mezcladas o snapshots duplicados, el reporte debe fallar.
- Retirar histórico anterior sólo con una política de retención y autorización.

Raw preservado significa payload sanitizado/acotado, no una copia arbitraria
de respuestas que puedan contener secretos o PII. Las coberturas parciales
tienen notas de calidad y no se presentan como totales conciliados.

## Gates externos: tareas necesarias, no completadas

- [ ] Contrato Ads con Test App, sólo `ads_read`, token nuevo y datos no vacíos.
- [ ] Contratos Page/Instagram/content con permisos mínimos aprobados.
- [ ] Conciliación de gasto, leads, clicks y objetivos con una fuente conocida.
- [ ] Staging: IAM efectivo, WIF/OIDC, Firestore, TTL/retención, GCS privado y CMEK.
- [ ] Pub/Sub + DLQ: fallo, replay, fencing, recuperación y carga de veinte cuentas.
- [ ] Rotación/revocación/restore de credenciales y revisión de logs/URLs desplegados.
- [ ] Regenerar Excel y aprobar layout, gráficos y fórmulas en Excel de escritorio.
- [ ] Revisión humana del cambio de configuración OAuth/API antes de activos reales.

## Orden para continuar

Primero el contrato sandbox guiado en `META_ADS_API_CONTRACT.md`. En paralelo
al trabajo manual de Meta, se puede implementar alcance por período y metadata
de segmentación con fixtures, sin nuevas credenciales ni cuentas reales.
Después cerrar staging y la aprobación de negocio. No habilitar
`ENABLE_PRODUCTION_DEPLOY` ni `ENABLE_PACKAGE_PUBLICATION` antes de esos gates;
la publicación heredada todavía usa identidad de paquetes del upstream.

El frontend de producto completo no forma parte de este cierre: la landing es
una pieza separada y no recibe tokens de Meta. El MVP entrega Excel mediante
una API autenticada, sin permisos de escritura sobre campañas.
