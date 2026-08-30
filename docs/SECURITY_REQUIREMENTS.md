# Requisitos de seguridad

## Principios no negociables

1. **Fail closed:** ausencia de identidad, tenant, workspace, binding o permiso
   debe producir rechazo, nunca fallback global.
2. **Mínimo privilegio:** reporting usa permisos de lectura y no solicita
   `ads_management`.
3. **Defensa en profundidad:** la ausencia de tools de escritura y el bloqueo
   HTTP de mutaciones son controles independientes.
4. **Aislamiento por diseño:** ninguna autorización se delega únicamente al
   token de Meta cuando éste puede ver activos de varios clientes.
5. **Secretos sólo en backend:** ningún token se entrega al navegador, modelo,
   workbook, URL, log o mensaje de error.
6. **Datos mínimos:** reporting agregado no debe contener PII cruda de leads.

## Identidad MCP y multi-tenant

- Toda petición multi-tenant debe autenticar un principal MCP válido.
- Los access tokens MCP deben incluir claims verificados de tenant/workspace y
  recurso esperado.
- El proveedor MCP fija `iss`, `aud` y `resource` desde `SERVER_URL` y el
  endpoint `/mcp`; no emite ni acepta tokens si ese binding no está configurado
  o si falta el contexto tenant/workspace. La rotación de refresh preserva el
  recurso original y rechaza intentos de cambiarlo.
- PKCE debe ser S256 y el authorization code debe ser aleatorio, de corta vida,
  de un solo uso y ligado a cliente, redirect URI, resource y workspace.
- No se permite una `MCP_API_KEY` compartida en despliegues multi-tenant.
- `X-Meta-Token`, `META_ACCESS_TOKEN` y `META_TOKENS` están prohibidos en ese
  modo.
- Los schedulers futuros deben usar identidad de workload y jobs firmados con
  tenant inmutable, no credenciales humanas compartidas.
- La identidad Google OIDC del scheduler debe validar `RS256`, issuer, audience,
  email verificado y service account allowlisted; el rol `scheduler` no puede
  derivarse de claims arbitrarios enviados por el cliente.

## Tokens Meta

- OAuth y la introspección ocurren server-to-server.
- El token nunca se envía en query strings; se usa `Authorization` o body POST
  cuando el endpoint OAuth lo requiere.
- Antes de persistir un token se valida `app_id`, `is_valid`, propietario,
  `scopes`, `granular_scopes`, expiración y `data_access_expires_at`.
- Se rechazan tokens con `ads_management` o permisos de escritura de WhatsApp.
- Cada ciphertext debe guardar tenant/workspace, fingerprint no reversible,
  scopes generales/granulares verificados y snapshot de activos autorizados.
- Toda renovación de un token Meta se reintrospecciona y vuelve a descubrir sus
  activos antes de persistir el ciphertext nuevo; un fallo conserva únicamente
  el token anterior todavía válido y nunca guarda metadata no verificada.
- Un token sin binding legacy se rechaza salvo durante una migración explícita,
  limitada y auditada.

## Permisos Meta previstos

Permisos mínimos configurados para el alcance actual:

- `ads_read`
- `pages_show_list`
- `pages_read_engagement`
- `read_insights`
- `instagram_basic`
- `instagram_manage_insights`
- `email`
- `public_profile`

La necesidad real de cada permiso debe validarse contra la versión de Graph API
y App Review antes del piloto. Un nuevo permiso requiere justificación por
métrica o endpoint, revisión de seguridad y test que demuestre que no habilita
escritura no prevista.

## Autorización de activos e IDOR

- Mantener bindings autoritativos `workspace → ad account/page/IG asset`.
- Validar IDs suministrados por tools contra esos bindings.
- Para objetos hijos, resolver y verificar el activo padre antes de recuperar
  datos; si no puede resolverse, fallar cerrado.
- Las claves de histórico deben incluir tenant/workspace y activo.
- Los tests negativos deben cubrir tenant A intentando leer activos de tenant B.

## Cifrado y rotación

- Algoritmo mínimo actual: AES-256-GCM, IV aleatorio de 12 bytes y tag de
  autenticación.
- AAD obligatoria ligada a colección, tenant y referencia de token.
- Cada ciphertext declara una versión de clave.
- La rotación debe ser dual-read/single-write, resumible, transaccional por
  documento, con backup cifrado y dry-run sin escrituras.
- La migración de ciphertext legacy sin AAD exige un flag explícito y debe
  retirarse al completar la rotación.
- Objetivo posterior: envelope encryption con Cloud KMS y procedimiento de
  restore ensayado.

## Frontend, HTTP y CSRF

- Ningún formulario o script del navegador acepta tokens Meta.
- Todo endpoint state-changing con cookie verifica origen exacto y Fetch
  Metadata; las cookies de producción deben ser Secure, HttpOnly y SameSite.
- Redirects usan el origin configurado, nunca `Host` no confiable.
- CORS no autoriza headers de credenciales Meta.
- Los endpoints protegidos deben tener tests de ausencia de auth, auth inválida,
  tenant ausente y origen sibling.
- La descarga de reportes requiere Bearer auth y tenant/workspace derivados de
  claims verificados. Un ID inválido, expirado o perteneciente a otro tenant
  devuelve el mismo `404`; el bucket y su object key nunca se exponen.

## Logs y errores

- Redactar access tokens, client secrets, códigos OAuth, cookies y URLs
  sensibles.
- No incluir cuerpos de error crudos de Meta en logs ni respuestas MCP.
- Usar categorías, códigos permitidos y fingerprints no reversibles para
  correlación.
- Nunca registrar PII de leads, email o IDs personales sin hashing aprobado.

## Disponibilidad y abuso

- Rate limits y circuit breakers deben compartirse entre instancias.
- Aplicar cuotas por principal, tenant, token y cuenta cuando corresponda.
- Respetar `Retry-After`, aplicar jitter y detener reintentos frente a señales de
  abuso.
- Antes de escalar, incorporar cola con backpressure y dead-letter queue.

## CI, secretos e infraestructura

- Gitleaks debe revisar historial y árbol de trabajo, también en PRs de forks
  sin depender de secretos del repositorio.
- Cloud Run usa runtime service account dedicada.
- CI sólo puede desplegar el servicio concreto, escribir en el repositorio de
  imágenes concreto y hacer `actAs` sobre la runtime SA concreta.
- Acceso a Secret Manager se concede por secreto nombrado.
- WIF queda ligado a repositorio, branch principal y workflow de deploy.
- La creación inicial del servicio es una acción administrativa separada.

## Gates antes de cuentas reales

- Todos los Critical y High del audit están corregidos o tienen una excepción
  escrita, aprobada y con fecha de expiración.
- Tests de auth MCP, endpoints protegidos, aislamiento y bloqueo de escrituras
  pasan en CI.
- Pruebas de integración pasan con Firestore emulator y credenciales ficticias.
- Rotación y restore se ensayan en staging.
- Gitleaks no encuentra secretos.
- Se verifica manualmente que frontend, logs, errores y URLs no exponen tokens.
- Se conecta primero una cuenta sandbox/test; una cuenta real requiere una
  aprobación posterior y plan de revocación.
