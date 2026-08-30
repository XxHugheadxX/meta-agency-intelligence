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
AGENCY_SCHEDULER_AUDIENCE=https://<servicio>/<endpoint-interno>
AGENCY_SCHEDULER_SERVICE_ACCOUNT=<scheduler>@<proyecto>.iam.gserviceaccount.com
AGENCY_SCHEDULER_SUBJECT=<id-numérico-obligatorio>
```

La configuración no sustituye la firma independiente del payload del job. La
identidad OIDC autoriza al workload; la firma liga tenant, workspace, cuenta y
periodo al contenido exacto del job.

El transporte HTTP permite montar `POST /internal/agency/reporting/jobs` sólo
cuando recibe por inyección un worker y este verificador. La autenticación y el
rol `scheduler` se validan antes de parsear el JSON, cuyo tamaño queda limitado
a 20 KiB. La respuesta contiene únicamente `jobId` y `artifactId`.

No se han configurado todavía una service account, audiencia ni cuenta Meta
reales. Falta componer las dependencias Firestore/control plane al arrancar y
validar el flujo completo en staging.
