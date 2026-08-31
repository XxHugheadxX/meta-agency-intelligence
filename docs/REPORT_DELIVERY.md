# Entrega interna de reportes

El worker de reporting ejecuta una cadena única y read-only:

```text
OIDC del scheduler + payload firmado
  → tenant/workspace/account binding
  → token Meta con ads_read y sin scopes de escritura
  → ingesta GET-only de Ads + activos orgánicos asociados a la cuenta
  → histórico tenant-scoped
  → reporte semanal o mensual
  → XLSX
  → objeto privado + metadata tenant-scoped en Firestore
```

## Contratos

- `AgencyReportingWorker` valida identidad, firma, periodo, tenant y scopes antes
  de iniciar la ingesta.
- `MetaAgencyReportingRuntime` conecta la ingesta con histórico, reporting,
  Excel y entrega del artefacto. Ejecuta primero Ads, luego métricas de cuenta
  para Page/Instagram y finalmente contenido Instagram; el workbook sólo se
  crea cuando las ingestas configuradas terminan correctamente.
- Los contadores `rowsWritten` y `pagesRead` del resultado suman Ads, orgánico
  account-level y contenido. Antes de agregarlos, el worker vuelve a validar que
  todos los resultados pertenezcan al tenant/workspace y ventana del job.
- `createFirestoreAgencyReportingRuntime` crea el runtime con histórico y
  checkpoints persistentes en Firestore.
- `FirestoreReportArtifactStore` guarda metadata bajo
  `agency_tenants/{tenant}/workspaces/{workspace}/report_artifacts` y delega los
  bytes a un `ReportObjectStore` privado.
- `GcsReportObjectStore` usa la API JSON de GCS con el token efímero de la
  service account de Cloud Run. No necesita una clave JSON ni coloca
  credenciales en URLs.
- `GET /agency/reports/:artifactId` exige un Bearer token MCP válido y vuelve a
  derivar tenant/workspace de sus claims antes de leer el artefacto.

La respuesta del worker contiene únicamente ID opaco, nombre, hash, tamaño,
periodo y caducidad. No contiene bytes del archivo, token Meta, object key ni
URL de almacenamiento.

## Reglas de almacenamiento

- Tamaño máximo por workbook: 25 MiB.
- Retención configurable entre 1 y 365 días; valor del worker: 90 días.
- ID y namespace derivados con SHA-256.
- El object key no contiene tenant ni workspace en texto claro.
- Un artefacto pendiente no se entrega hasta que el objeto esté almacenado.
- La consulta de metadata siempre requiere el mismo tenant/workspace.

## Configuración de infraestructura

Configurar `REPORTS_GCS_BUCKET` con un bucket GCS privado, CMEK, Uniform Bucket
Level Access y lifecycle. La runtime service account sólo necesita
`storage.objects.create` y `storage.objects.get` sobre ese bucket; la eliminación
se delega al lifecycle. El endpoint entrega el archivo como proxy autenticado,
con `Cache-Control: no-store`, por lo que no se emiten URLs firmadas ni
permanentes y el bucket nunca debe hacerse público.

El adaptador usa uploads reanudables con precondición de creación, hash SHA-256,
host de upload fijado y redirects deshabilitados. Una respuesta GCS o Firestore
no se devuelve directamente al cliente.
