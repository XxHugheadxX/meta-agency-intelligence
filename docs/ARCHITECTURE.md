# Arquitectura de Meta Agency Intelligence

Este documento distingue el estado observable en el repositorio del diseño de
producto previsto. La conexión de cuentas reales sigue prohibida hasta superar
los gates de `docs/SECURITY_REQUIREMENTS.md` y `docs/PRODUCT_ROADMAP.md`.

## Estado actual

El punto de entrada es `src/index.ts`, que sirve MCP por HTTP o stdio. La
integración con Meta está en `src/meta/`; autenticación, sesiones y OAuth en
`src/auth/`; persistencia de tokens y bindings en `src/store/`; y el catálogo de
tools en `src/tools/`.

El modo `read_only` es el predeterminado del registro de tools. El catálogo
central de `src/tools/index.ts` sólo registra las 58 tools exactas de la
allowlist de lectura cuando ese modo está activo; la anotación `readOnlyHint`
por sí sola no autoriza una tool. La política también mantiene fuera del
servicio de reporting las tools de PII de leads, credenciales, llamadas pagadas,
WhatsApp y mutaciones.

El contexto de solicitud contiene `tenantId`/`workspaceId` y allowlists de
cuentas y activos. El cliente Meta valida la cuenta o resuelve el activo padre
antes de leer. Los tokens persistidos se cifran en backend y se asocian a
workspace y activos autorizados. Estos controles están implementados en el
código, pero sus gates de producción, migración completa y pruebas de entorno
real siguen siendo trabajo pendiente.

`src/agency/` contiene histórico tenant-scoped, reporting semanal/mensual,
Excel editable, segmentación, recomendaciones e ingesta inicial de Ads
Insights. La ingesta usa una interfaz que sólo expone GET, exige autorización
de cuenta antes de la primera llamada, pagina con límites de filas/páginas,
normaliza métricas y sólo avanza el watermark cuando la ventana completa quedó
persistida. Los checkpoints y el histórico tienen implementaciones en memoria
y Firestore; las pruebas usan exclusivamente respuestas sintéticas.

`src/agency/worker/` contiene la orquestación inicial del worker: exige una
identidad de workload verificada, valida un payload firmado con clave pública,
resuelve tenant/workspace/cuenta antes del token, rechaza scopes de escritura y
ejecuta Ads Insights dentro de un contexto backend GET-only. El endpoint interno
opt-in autentica Google OIDC antes de parsear el payload firmado. Un trigger OIDC
separado calcula el último período completo y compone Firestore, firma KMS y
publicación Pub/Sub sin claves privadas locales; el bootstrap del worker compone
control plane, tokens cifrados, histórico, artefactos, auditoría y leases
tenant-scoped sobre Firestore. No existe todavía un scheduler o cola desplegados,
ni se validaron GCS/IAM/CMEK en staging. La ingesta orgánica account-level de
Pages/Instagram y content-level de Instagram ya tiene lectores GET-only,
normalización y aislamiento probados con fixtures. Los niveles permanecen
separados para evitar doble conteo. Falta Facebook post-level y validar los
contratos contra una Meta Test App; ver `ORGANIC_INSIGHTS.md`.

`src/agency/scheduler/` aporta control de concurrencia global y por workspace,
HTTP 429 con `Retry-After`, política conservadora de reintentos y registros
dead-letter minimizados. Autenticación, validación, señales de abuso y fallos
desconocidos son terminales; un rate limit sólo se reintenta con una espera
explícita. Estos controles no sustituyen la cola durable y DLQ de staging.

## Arquitectura objetivo

```text
Meta Graph API (GET/read scopes)
        ↓
MCP/HTTP auth + TenantContext
        ↓
Asset authorization (tenant_asset_bindings)
        ↓
Ingestion + raw immutable records
        ↓
Historical normalized data (tenant/workspace/account/date keys)
        ↓
Analytics / period comparison / recommendations
        ├── agency reporting API
        ├── segmentation intelligence (read-only)
        └── Excel export (separate capability)
```

Los módulos nuevos deben vivir bajo `src/agency/`: `ingestion`, `historical-data`,
`analytics`, `reporting`, `segmentation`, `recommendations`, `excel` y
`scheduler`. El scheduler futuro ejecutará jobs con identidad de workload y
tenant inmutable; no reutilizará credenciales humanas ni habilitará mutaciones.

Cada capa debe recibir un contexto tenant explícito, preservar raw data sin
alterarlo, producir modelos normalizados versionados y devolver errores sin
secretos ni PII. El histórico agregado y cualquier módulo opt-in de leads deben
tener fronteras de almacenamiento, autorización y retención separadas.

## Límites de capacidad

La primera versión sólo lee datos autorizados, calcula métricas y devuelve
recomendaciones explicables. No crea jobs externos salvo una capability revisada
por separado, no cambia campañas/presupuestos/audiencias/creativos, no envía
mensajes y no incluye PII cruda de leads en reporting o Excel.
