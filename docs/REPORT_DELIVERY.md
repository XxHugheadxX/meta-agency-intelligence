# Entrega interna de reportes

El worker de reporting ejecuta una cadena única y read-only:

```text
OIDC del scheduler + payload firmado
  → tenant/workspace/account binding
  → token Meta con ads_read y sin scopes de escritura
  → ingesta GET-only
  → histórico tenant-scoped
  → reporte semanal o mensual
  → XLSX
  → objeto privado + metadata tenant-scoped en Firestore
```

## Contratos

- `AgencyReportingWorker` valida identidad, firma, periodo, tenant y scopes antes
  de iniciar la ingesta.
- `MetaAgencyReportingRuntime` conecta la ingesta con histórico, reporting,
  Excel y entrega del artefacto.
- `createFirestoreAgencyReportingRuntime` crea el runtime con histórico y
  checkpoints persistentes en Firestore.
- `FirestoreReportArtifactStore` guarda metadata bajo
  `agency_tenants/{tenant}/workspaces/{workspace}/report_artifacts` y delega los
  bytes a un `ReportObjectStore` privado.

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

## Integración pendiente de infraestructura

Implementar `ReportObjectStore` con un bucket GCS privado, CMEK, Uniform Bucket
Level Access y lifecycle. La descarga debe pasar por un endpoint autenticado
que vuelva a comprobar tenant/rol y emita una URL firmada de vida corta. No se
deben devolver URLs permanentes ni hacer público el bucket.
