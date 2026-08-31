# Cola durable de reporting con Pub/Sub

## Estado

El código acepta tanto el body directo `{ payload, signature }` como el envelope
push estándar de Pub/Sub. La identidad OIDC se verifica antes de parsear el body
y el payload conserva una firma RSA independiente. No se ha creado ningún
recurso Google Cloud ni se ha iniciado sesión en un proyecto real.

`ReportingJobFanOut` prepara un job determinista por cuenta activa, valida que
todas pertenezcan al tenant/workspace solicitado, firma el JSON mediante una
interfaz inyectable y publica solamente `{ payload, signature }`. El adaptador
Firestore de cuentas activas verifica primero el workspace, proyecta únicamente
identidad y estado, y nunca carga `tokenName` ni credenciales. El firmador KMS
envía sólo el digest SHA-256, usa el token efímero de la service account y valida
nombre de versión, `verifiedDigestCrc32c` y CRC32C de la firma. El adaptador de
Pub/Sub publica un único envelope en un topic fijado, usa el token efímero sólo
en el header y valida el ACK. La creación de recursos e IAM continúa pendiente
para staging; una clave privada no debe almacenarse en variables de entorno ni
en Firestore.

El bootstrap permanece deshabilitado salvo
`AGENCY_REPORTING_SCHEDULER_ENABLED=true` y exige modo read-only, multi-tenant,
Firestore, una versión KMS completa y un topic Pub/Sub completo. Los nombres de
recursos se validan antes de inicializar Firestore.

## Topología propuesta

```text
Cloud Scheduler + OIDC de trigger
  → POST /internal/agency/reporting/schedules
  → período anterior completo + fan-out tenant-scoped
  → firma KMS por cuenta
  → Pub/Sub topic: agency-reporting-jobs
  → push subscription + OIDC de push independiente
  → POST /internal/agency/reporting/jobs
  → admisión global/workspace + lease Firestore
  → worker read-only
  → ACK 200 o NACK 4xx/429
  → dead-letter topic tras intentos agotados
```

El trigger acepta exactamente `tenantId`, `workspaceId` y `reportKind`. El
servidor calcula la semana o mes anterior completo en
`AGENCY_REPORTING_TIME_ZONE`, añade un lookback acotado para ingesta y no acepta
fechas arbitrarias desde Cloud Scheduler. La respuesta contiene sólo período y
cantidad de jobs, no identificadores del tenant.

Pub/Sub ofrece entrega al menos una vez. La idempotencia no depende de
`messageId`: se basa en el payload firmado, su fingerprint y el lease
tenant-scoped. Un mensaje duplicado no debe ejecutar Meta o generar un workbook
por segunda vez.

## Contrato del mensaje

El campo `data` contiene base64 del siguiente JSON UTF-8:

```json
{
  "payload": "<JSON firmado del reporting job>",
  "signature": "<firma RSA base64url>"
}
```

Nunca incluir:

- token Meta;
- bearer OIDC;
- claves privadas;
- object keys o URLs de GCS;
- PII de leads.

El adaptador limita tamaño, exige base64 canónico, decodificación UTF-8 estricta,
JSON válido y exactamente los dos campos permitidos. Attributes de Pub/Sub no
pueden reemplazar el header `Authorization`.

## Configuración de la suscripción

Valores iniciales para el piloto de veinte cuentas:

- push endpoint: URL `run.app` más `/internal/agency/reporting/jobs`;
- push auth: service account dedicada;
- audience: exactamente `AGENCY_SCHEDULER_AUDIENCE`;
- ack deadline: 600 segundos;
- retry mínimo: 10 segundos;
- retry máximo: 600 segundos;
- dead-letter: 5 intentos iniciales;
- retención: 7 días;
- payload unwrapping: recomendado, aunque el endpoint acepta ambos formatos.

Comando de referencia para revisión; no ejecutar antes de tener proyecto,
service account, Cloud Run e IAM aprobados:

```powershell
gcloud pubsub subscriptions create agency-reporting-push `
  --project=<PROJECT_ID> `
  --topic=agency-reporting-jobs `
  --push-endpoint=https://<SERVICE>.run.app/internal/agency/reporting/jobs `
  --push-auth-service-account=agency-reporting-push@<PROJECT_ID>.iam.gserviceaccount.com `
  --push-auth-token-audience=https://<SERVICE>.run.app/internal/agency/reporting/jobs `
  --push-no-wrapper `
  --ack-deadline=600 `
  --min-retry-delay=10s `
  --max-retry-delay=600s `
  --dead-letter-topic=agency-reporting-dead-letter `
  --max-delivery-attempts=5 `
  --message-retention-duration=7d
```

## IAM mínimo

- Push service account: `roles/run.invoker` solamente sobre el servicio Cloud
  Run de reporting.
- Trigger service account: identidad dedicada para invocar únicamente el
  endpoint de schedules; no reutilizar la identidad push ni la runtime.
- Fan-out publisher: `roles/pubsub.publisher` solamente sobre
  `agency-reporting-jobs`.
- Pub/Sub service agent: capacidad de generar el OIDC de la push service account.
- Para DLQ, el Pub/Sub service agent necesita publicar solamente al dead-letter
  topic y consumir/acknowledge solamente la push subscription.
- Operadores humanos no reciben claves JSON de service accounts.

La cuenta de runtime de Cloud Run no necesita publicar al topic salvo que se
implemente explícitamente el fan-out dentro del mismo servicio. No conceder
`Editor`, `Owner`, `Pub/Sub Admin` o permisos Meta a las identidades de cola.

## Respuestas y redelivery

- `200`: job completado o replay idempotente; Pub/Sub hace ACK.
- `429` con `Retry-After`: capacidad agotada; Pub/Sub redeliverá según su
  backoff.
- otros `4xx`: envelope, firma, identidad o job inválidos; Pub/Sub los enviará
  eventualmente al dead-letter topic.
- señales de abuso Meta abren el circuit breaker; cualquier redelivery debe
  fallar sin volver a llamar Meta hasta terminar en DLQ o vencer el cooldown.

El contador de entregas de Pub/Sub y el máximo de DLQ son best-effort. Los
leases, circuit breakers y límites internos siguen siendo obligatorios.

## Gate antes de staging

1. Revisar IAM con Policy Analyzer/Simulator.
2. Confirmar que los endpoints internos no son utilizables sin OIDC. Si el mismo
   servicio expone OAuth público, la frontera interna sigue protegida en la app.
3. Verificar issuer, audience, email y `sub` de la push service account.
4. Publicar únicamente envelopes sintéticos firmados.
5. Forzar duplicados, 429, firma inválida y agotamiento hasta DLQ.
6. Confirmar ausencia de tokens y payloads en logs y dead-letter metadata.
7. Ejecutar carga equivalente a veinte cuentas antes de cualquier cuenta real.
8. Aprovisionar una versión KMS `RSA_SIGN_PKCS1_2048_SHA256` y limitar
   `cloudkms.cryptoKeyVersions.useToSign` a la identidad dedicada del fan-out.
