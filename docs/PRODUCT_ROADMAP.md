# Roadmap de producto

## Regla de avance

Una fase no autoriza conectar cuentas reales por sí sola. Cada fase termina con
tests, revisión de seguridad y criterios de salida verificables. Los cambios se
trabajan en ramas y no se fusionan automáticamente.

## Integración MVP read-only

**Estado:** `mvp/read-only-reporting` conecta la ingesta sintética de Ads
Insights con histórico, reporting y el generador XLSX profesional. La prueba
end-to-end valida KPIs, aislamiento, formato ZIP/OOXML, diez hojas esperadas y
ausencia de tokens en el workbook. El worker seguro ya puede ejecutar esta
cadena y registrar un artefacto privado con metadata tenant-scoped, sin exponer
bytes, object keys ni URLs. Falta ejecutar el contrato contra una Meta Test App
y Firestore Emulator antes de usar activos reales.

## Fase 0 — Auditoría y hardening

**Estado de código:** hardening Critical/High implementado y testeado en
`security/hardening-v1`. Los gates operativos y la revisión humana siguen
pendientes.

Entregables:

- Auditoría `SECURITY_AUDIT.md`.
- Frontera read-only fail-closed.
- OAuth Meta de mínimo privilegio e introspección.
- Autenticación MCP y binding tenant/workspace.
- Tokens AES-256-GCM versionados y rotables.
- Asset allowlist e IDOR checks.
- CSRF, sanitización de errores y logs.
- Rate limiting/circuit breaker distribuidos.
- Gitleaks, IAM y deploy endurecidos.
- Tests de autenticación, endpoints protegidos y aislamiento.

Salida pendiente:

- Revisar el diff humano completo.
- Probar Firestore emulator y rotación/restore.
- Resolver o aceptar explícitamente riesgos residuales.
- No conectar cuentas reales.

## Fase 1 — Fundaciones de agencia

**Estado:** primera versión implementada y testeada bajo `src/agency/`; faltan
la revisión humana, políticas de retención desplegadas y contratos del control
plane operativo.

- Crear `src/agency/` y contratos compartidos.
- Definir `Tenant`, `Workspace`, `MetaConnection`, `AssetBinding` y roles.
- Separar control plane de conexiones del endpoint MCP de análisis.
- Diseñar esquema histórico, migraciones, índices y políticas de retención.
- Incorporar fixtures sintéticos de inmobiliaria.

**Gate:** aislamiento probado a nivel de repositorio, servicio y exportación.

## Fase 2 — Ingesta e histórico

**Estado:** en progreso en `feature/meta-readonly-ingestion`. Ads Insights tiene
lector GET-only, paginación acotada, normalización diaria, raw sanitizado,
checkpoints monotónicos, replay idempotente y aislamiento probado con datos
sintéticos. Pages/Instagram orgánico, worker/scheduler, bindings de producción
y contract tests con una Meta test app siguen pendientes.

La rama `feature/firestore-ingestion-integration` añade persistencia
transaccional, checkpoints monotónicos ante concurrencia y una suite contra
Firestore Emulator. El gate no queda cerrado hasta ejecutar esa suite en un
equipo con el emulador disponible y ensayar backup/restore y retención.

- Clientes read-only para Ads, Facebook e Instagram.
- Jobs idempotentes, watermarks, paginación y backfill.
- Normalización de moneda, timezone, atribución y breakdowns.
- Registro de lineage y calidad de datos.
- Backpressure y reintentos coordinados.

**Gate:** backfill y actualización incremental reproducibles con datos
sintéticos/sandbox, sin duplicados ni cruces de tenant.

## Fase 3 — Analytics

**Estado:** comparaciones por periodo, agregación de KPIs y segmentación inicial
implementadas; faltan conciliación contra Meta, anomalías/fatiga y calibración
con datasets aceptados por negocio.

- Motor de KPIs con definiciones versionadas.
- Comparaciones semanal, mensual y periodo anterior.
- Tendencias, anomalías y detección de fatiga.
- Análisis de campañas, creatividades, audiencias y segmentación.
- Tests de precisión con datasets conocidos.

**Gate:** conciliación de métricas dentro de tolerancia y explicación de datos
ausentes.

## Fase 4 — Reporting y Excel

**Estado:** workbook semanal/mensual editable y sin macros implementado y
validado automáticamente con fixtures; queda pendiente aprobación manual de
negocio y smoke test final en Microsoft Excel de escritorio.

- Implementar `reporting/` y `excel/` separados del pipeline de ingesta.
- Workbook semanal y mensual con hojas, tablas, fórmulas y gráficos definidos.
- Validación visual automatizada y manual.
- Exportación tenant-safe y almacenamiento con retención.

**Gate:** archivos deterministas, sin secretos/PII y aprobados por una persona de
negocio usando fixtures.

## Fase 5 — Scheduler y operación

**Estado:** orquestador inicial del worker implementado en
`feature/agency-ingestion-worker`, con identidad y firma como dependencias
obligatorias, resolución tenant-safe, scopes read-only y auditoría minimizada.
La rama MVP añade el worker de reporting, metadata Firestore aislada, adaptador
GCS con identidad de workload y endpoint de descarga autenticado tenant-scoped.
Faltan aprovisionar y validar el bucket/IAM/CMEK reales, la verificación OIDC del
scheduler, repositorios Firestore del control plane, cola, leases, reintentos y
dead-letter queue.

- Scheduler con identidad de workload y tenant firmado.
- Cola, límites de concurrencia, jitter, dead-letter queue y reanudación.
- Observabilidad por job/tenant sin PII.
- Alertas de fallos, expiración de token y calidad de datos.

**Gate:** prueba de carga equivalente a 20 cuentas y recuperación ensayada.

## Fase 6 — Recomendaciones

**Estado:** reglas read-only explicables implementadas; falta evaluación offline
y calibración de umbrales con datos sintéticos o anonimizados representativos.

- Reglas explicables y versionadas.
- Priorización por impacto, confianza y volumen de evidencia.
- Separación estricta entre hecho, hipótesis y recomendación.
- Evaluación offline con casos históricos sintéticos o anonimizados.
- Confirmar que ninguna ruta produce mutaciones Meta.

**Gate:** revisión humana y tests contra recomendaciones engañosas o sin muestra
suficiente.

## Fase 7 — Piloto controlado

Orden recomendado:

1. Cuenta sandbox/test de Meta.
2. Staging con una conexión no productiva.
3. Revisión de logs, URLs, Firestore, scopes y revocación.
4. Una cuenta real de bajo riesgo con consentimiento y rollback.
5. Ampliación gradual hasta aproximadamente 20 cuentas.

**Gate:** aprobación de seguridad y producto antes de cada aumento de alcance.

## Después del MVP

- Portal de dashboards además de Excel.
- Benchmarks anonimizados entre cuentas, sólo con gobernanza adecuada.
- Control plane administrativo con RBAC más granular.
- Integraciones CRM bajo una frontera PII separada.
- Evaluar acciones asistidas sobre campañas únicamente en otro servicio,
  despliegue y modelo de permisos; nunca ampliar silenciosamente el servicio
  read-only.

## Próximas tareas recomendadas

1. Revisar las ramas encadenadas y decidir su integración sin merge automático.
2. Crear tests de integración de histórico/checkpoints con Firestore emulator.
3. Aprovisionar el bucket GCS privado y validar IAM, CMEK, lifecycle y descarga
   proxy en staging con archivos sintéticos.
4. Añadir lectores read-only de Pages e Instagram orgánico.
5. Ejecutar contract tests en una Meta test app sin cuentas reales.
6. Ensayar rotación y restore de claves con documentos ficticios.
7. Implementar scheduler, backpressure, reintentos coordinados y dead-letter
   queue antes de escalar a veinte cuentas.
