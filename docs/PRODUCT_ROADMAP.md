# Roadmap de producto

## Regla de avance

Una fase no autoriza conectar cuentas reales por sí sola. Cada fase termina con
tests, revisión de seguridad y criterios de salida verificables. Los cambios se
trabajan en ramas y no se fusionan automáticamente.

## Fase 0 — Auditoría y hardening

**Estado:** en progreso avanzado en `security/hardening-v1`.

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

- Crear `src/agency/` y contratos compartidos.
- Definir `Tenant`, `Workspace`, `MetaConnection`, `AssetBinding` y roles.
- Separar control plane de conexiones del endpoint MCP de análisis.
- Diseñar esquema histórico, migraciones, índices y políticas de retención.
- Incorporar fixtures sintéticos de inmobiliaria.

**Gate:** aislamiento probado a nivel de repositorio, servicio y exportación.

## Fase 2 — Ingesta e histórico

- Clientes read-only para Ads, Facebook e Instagram.
- Jobs idempotentes, watermarks, paginación y backfill.
- Normalización de moneda, timezone, atribución y breakdowns.
- Registro de lineage y calidad de datos.
- Backpressure y reintentos coordinados.

**Gate:** backfill y actualización incremental reproducibles con datos
sintéticos/sandbox, sin duplicados ni cruces de tenant.

## Fase 3 — Analytics

- Motor de KPIs con definiciones versionadas.
- Comparaciones semanal, mensual y periodo anterior.
- Tendencias, anomalías y detección de fatiga.
- Análisis de campañas, creatividades, audiencias y segmentación.
- Tests de precisión con datasets conocidos.

**Gate:** conciliación de métricas dentro de tolerancia y explicación de datos
ausentes.

## Fase 4 — Reporting y Excel

- Implementar `reporting/` y `excel/` separados del pipeline de ingesta.
- Workbook semanal y mensual con hojas, tablas, fórmulas y gráficos definidos.
- Validación visual automatizada y manual.
- Exportación tenant-safe y almacenamiento con retención.

**Gate:** archivos deterministas, sin secretos/PII y aprobados por una persona de
negocio usando fixtures.

## Fase 5 — Scheduler y operación

- Scheduler con identidad de workload y tenant firmado.
- Cola, límites de concurrencia, jitter, dead-letter queue y reanudación.
- Observabilidad por job/tenant sin PII.
- Alertas de fallos, expiración de token y calidad de datos.

**Gate:** prueba de carga equivalente a 20 cuentas y recuperación ensayada.

## Fase 6 — Recomendaciones

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

1. Revisar y cerrar la rama de hardening sin merge automático.
2. Crear tests de integración con Firestore emulator.
3. Ensayar rotación y restore de claves con documentos ficticios.
4. Diseñar el modelo de datos tenant/workspace/asset/history.
5. Crear fixtures sintéticos y contratos de métricas.
6. Implementar el primer backfill read-only antes de construir Excel.

