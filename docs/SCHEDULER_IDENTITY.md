# Identidad del scheduler

`GoogleOidcWorkloadIdentityVerifier` valida la identidad OIDC usada por Cloud
Scheduler o Cloud Tasks antes de resolver conexiones o tokens Meta.

Controles aplicados:

- JWT firmado con `RS256` y claves JWKS oficiales de Google.
- Issuer de Google, audience HTTPS exacta y vida máxima de diez minutos.
- Email verificado y allowlist exacta de una service account.
- Binding obligatorio al claim numérico e inmutable `sub`.
- Header `Authorization: Bearer` limitado a 16 KiB.
- Rol `scheduler` asignado únicamente después de completar todas las
  verificaciones.
- Errores sanitizados que no devuelven JWT, claims ni detalles de JWKS.

Configuración:

```text
AGENCY_REPORTING_JOBS_ENABLED=true
AGENCY_SCHEDULER_AUDIENCE=https://<servicio>/<endpoint-interno>
AGENCY_SCHEDULER_SERVICE_ACCOUNT=<scheduler>@<proyecto>.iam.gserviceaccount.com
AGENCY_SCHEDULER_SUBJECT=<id-numérico-obligatorio>
AGENCY_REPORTING_JOB_PUBLIC_KEY=<clave-pública-PEM>
AGENCY_REPORTING_LEASE_TTL_MS=60000
```

La configuración no sustituye la firma independiente del payload del job. La
identidad OIDC autoriza al workload; la firma liga tenant, workspace, cuenta y
periodo al contenido exacto del job.

El transporte HTTP monta `POST /internal/agency/reporting/jobs` únicamente
cuando el gate fail-closed valida modo read-only, OAuth multi-tenant, Firestore,
GCS privado, identidad OIDC y clave pública de firma. La autenticación y el rol
`scheduler` se validan antes de parsear el JSON, cuyo tamaño queda limitado a
20 KiB. La respuesta contiene únicamente `jobId` y `artifactId`.

No se han configurado todavía una service account, audiencia ni cuenta Meta
reales. Falta provisionar el plano de control y validar el flujo completo en
staging antes de habilitar `AGENCY_REPORTING_JOBS_ENABLED=true`.
