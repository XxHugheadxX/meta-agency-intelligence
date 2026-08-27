# Auditoría de seguridad — meta-ads-mcp

**Repositorio auditado:** `XxHugheadxX/meta-ads-mcp`  
**Commit:** `7cbb099f` (`main`, 2026-08-10)  
**Fecha de auditoría:** 2026-08-26  
**Alcance objetivo:** plataforma de reporting y análisis read-only para una agencia inmobiliaria con aproximadamente 20 cuentas/perfiles de Meta  
**Estado de conexión:** no se conectaron cuentas ni credenciales reales

## Resumen ejecutivo

El repositorio **no debe conectarse todavía a cuentas reales**. La base contiene controles valiosos —PKCE S256 para OAuth MCP, códigos de autorización de un solo uso, cifrado AES-256-GCM, validación de redirects, protección SSRF para descargas, escaping HTML, acciones de CI fijadas por SHA y escaneo Gitleaks limpio—, pero el modo read-only solicitado no existe como frontera de seguridad.

Se identificaron **2 hallazgos Critical, 7 High, 11 Medium y 4 Low**. Los dos bloqueadores principales son:

1. Los 135 tools se registran sin una política de capacidades ejecutable. Hay 61 tools no-READ y el OAuth de Meta solicita `ads_management`; un cliente MCP autenticado puede crear, modificar, activar o eliminar objetos publicitarios.
2. La resolución de tokens permite `X-Meta-Token` y credenciales globales antes o fuera del contexto de tenant. En un despliegue de agencia, un poseedor de la API key compartida puede seleccionar o utilizar credenciales que no están vinculadas a su tenant.

**Conclusión:** apto como base de desarrollo, **no apto para producción multi-tenant ni para conectar activos reales** hasta cerrar todos los Critical y High, implementar una política read-only de doble capa y ejecutar una prueba de aislamiento con tenants sintéticos.

## Alcance y metodología

La revisión incluyó:

- Los 188 archivos versionados y el historial Git disponible (99 commits).
- OAuth de Meta y OAuth MCP, PKCE, sesiones, cookies, API keys y autorización.
- Resolución multi-tenant, repositorios Firestore, almacenamiento y rotación de tokens.
- Registro de los 135 tools y todas las operaciones con efectos laterales.
- Cliente Graph API, descargas, SSRF, XSS, CSRF, redirects, logs, rate limiting y circuit breakers.
- GitHub Actions, Docker, Cloud Run, Workload Identity Federation, Secret Manager y scripts operativos.
- Dependencias de producción y desarrollo, tests, compilación y escaneo de secretos.

La auditoría fue estática y local. No incluyó pentest contra una instancia desplegada, revisión de configuración real de GCP/Meta Business Manager, App Review, IAM efectivo, branch protection, Cloud Armor, DNS ni cuentas reales.

## Resultados de verificación

| Control | Resultado |
|---|---|
| `npm run lint` | Pasa |
| `npm run typecheck` | Pasa |
| `npm run build` | Pasa |
| Tests | 720 pasan, 2 fallan |
| `npm audit --omit=dev` | 0 vulnerabilidades de producción |
| `npm audit` completo | Cadena dev High: `vitest -> vite -> postcss -> nanoid` (`GHSA-2v37-7h3g-55p8`) |
| Gitleaks 8.30.1, historial completo | Sin secretos detectados |

Los dos fallos de test no prueban vulnerabilidades explotables, pero reducen la confianza del gate de CI:

- `tests/gitleaks-config.test.ts` interpreta comentarios de `.gitleaks.toml` como entradas de allowlist.
- `tests/tools/insights.test.ts` depende del locale del sistema (`50,000` frente a `50.000`).

## Matriz de hallazgos

| ID | Severidad | Hallazgo | Estado |
|---|---|---|---|
| C-01 | Critical | No existe una frontera read-only ejecutable | Abierto / bloquea producción |
| C-02 | Critical | Bypass de aislamiento por tokens y credenciales globales | Abierto / bloquea producción |
| H-01 | High | CSRF incompleto en endpoints con cookie y cambio de estado | Abierto |
| H-02 | High | No se valida procedencia, scopes ni activos del token Meta | Abierto |
| H-03 | High | Rotación de cifrado incompleta y con downgrade de AAD | Abierto |
| H-04 | High | Identidad de despliegue GCP con privilegios excesivos | Abierto |
| H-05 | High | Rate limits y circuit breakers sólo por proceso | Abierto |
| H-06 | High | Falta allowlist interna tenant → activos Meta (IDOR lógico) | Abierto |
| H-07 | High | Lead data puede exponerse sin una frontera PII dedicada | Abierto |
| M-01 | Medium | Binding OAuth incompleto en token exchange y resource | Abierto |
| M-02 | Medium | Redirect HTTPS construido con `Host` no confiable | Abierto |
| M-03 | Medium | Secretos Meta incluidos en query strings | Abierto |
| M-04 | Medium | Redacción de logs y minimización de identificadores incompletas | Abierto |
| M-05 | Medium | Metadata sensible y artefactos OAuth en Firestore | Abierto |
| M-06 | Medium | Fallback de descifrado sin AAD permanece activo | Abierto |
| M-07 | Medium | Imagen Docker incluye dependencias dev y tags flotantes | Abierto |
| M-08 | Medium | Secret scanning de PRs de forks y supply chain incompletos | Abierto |
| M-09 | Medium | Límites de cuerpo/MCP y cuotas por tenant insuficientes | Abierto |
| M-10 | Medium | Versiones Graph API inconsistentes | Abierto |
| M-11 | Medium | Tools con side effects clasificados como consultas de negocio | Abierto |
| L-01 | Low | CSP y cache headers pueden endurecerse | Abierto |
| L-02 | Low | Health check sólo prueba el proceso | Abierto |
| L-03 | Low | Versión declarada por el servidor no coincide con el paquete | Abierto |
| L-04 | Low | Tests dependientes de locale/config reducen confiabilidad | Abierto |

## Hallazgos Critical

### C-01 — No existe una frontera read-only ejecutable

**Evidencia**

- `src/auth/meta-oauth.ts:7-16` solicita `ads_management`, `business_management` y `whatsapp_business_management` junto con permisos de lectura.
- Los registradores de `src/tools/` exponen 135 tools incondicionalmente. Las anotaciones `READ`, `CREATE`, `UPDATE`, `DELETE`, `TOGGLE`, `UPLOAD` y `TOKEN` son metadata para el cliente; no son autorización.
- Se encontraron 61 tools no-READ: 21 `CREATE`, 16 `UPDATE`, 12 `DELETE`, 7 `TOGGLE`, 3 `TOKEN` y 2 `UPLOAD`.
- No hay una comprobación central en `MetaApiClient` que impida métodos mutantes cuando el servicio opera en modo reporting.

**Impacto**

Un prompt malicioso, un cliente MCP comprometido, un error humano o una nueva tool registrada incorrectamente puede modificar campañas, presupuestos, anuncios, audiencias, comentarios o activos de WhatsApp. La etiqueta `destructiveHint` no constituye control de acceso.

**Remediación obligatoria**

1. Crear `MCP_MODE=read_only` como valor predeterminado y hacer que producción falle al arrancar si intenta habilitar escritura sin un despliegue separado y aprobado.
2. Registrar tools desde un catálogo central con capacidades: `pure_read`, `report_job`, `paid_external`, `credential_admin`, `ads_write` y `whatsapp_write`.
3. En read-only, no registrar ninguna capability salvo `pure_read`; habilitar `report_job` sólo mediante flag explícito.
4. Añadir una segunda barrera en el cliente HTTP de Meta: rechazar todo método distinto de `GET`, excepto endpoints exactos y revisados para jobs asíncronos de reporting si fueran imprescindibles.
5. Conectar únicamente tokens sin `ads_management` y sin permisos de escritura de páginas, Instagram o WhatsApp.
6. Añadir un test de CI que falle si una nueva tool no tiene capability o si una tool read-only provoca una petición mutante.

### C-02 — Bypass de aislamiento por tokens y credenciales globales

**Evidencia**

- `src/transport/http.ts:321-325` acepta `X-Meta-Token` antes de resolver al usuario/tenant.
- `src/transport/http.ts:291-313` acepta una única `MCP_API_KEY`; esa identidad no contiene tenant, rol ni activos permitidos.
- `src/transport/http.ts:334-377` resuelve por `fbUserId` sólo si está presente; si no, cae a `tokenManager.getActiveToken()` y luego a `META_ACCESS_TOKEN` incluso con multi-tenant habilitado.
- `src/tools/tokens.ts` expone `ads_register_token`, `ads_set_active_token` y `ads_delete_token`. El token activo del manager es estado global del proceso.
- `META_TOKENS`, `META_ACCESS_TOKEN`, `MCP_API_KEY` y el flujo OAuth pueden coexistir según la configuración y documentación del proyecto.

**Impacto**

En el modelo de agencia, un cliente con la API key compartida puede aportar una credencial arbitraria o usar/cambiar el pool global. La selección global también introduce carreras entre solicitudes. Con un system user que vea varias cuentas, una petición de un tenant puede consultar activos de otro tenant.

**Remediación obligatoria**

- En modo multi-tenant, rechazar toda solicitud que no produzca un `TenantContext` autenticado e inmutable.
- Eliminar `X-Meta-Token`, `META_TOKENS`, `META_ACCESS_TOKEN` y el token manager global de los despliegues multi-tenant.
- No usar una API key compartida para usuarios o schedulers. Usar OIDC con identidad de workload y jobs firmados que incluyan un `tenant_id` validado en servidor.
- Separar el servicio administrativo de conexión de cuentas del endpoint MCP de análisis.
- Vincular cada referencia de token y cada `ad_account_id`, `page_id`, `ig_user_id` o `business_id` a un tenant en base de datos; nunca confiar en un ID recibido del tool.

## Hallazgos High

### H-01 — CSRF incompleto

`src/transport/auth-routes.ts:76-84` implementa validación de origen, pero sólo se aplica a dos rutas de tokens Apify (`:556` y `:633`). Otros POST con cookie —seleccionar token, registrar/eliminar token Meta, logout y acciones de consentimiento— no tienen una protección uniforme. `SameSite=Lax` no bloquea todos los ataques same-site desde un subdominio comprometido.

**Corrección:** token CSRF ligado a sesión más verificación `Origin`/Fetch Metadata en todo endpoint state-changing; cookies `__Host-`; dominio de autenticación aislado; tests para origen sibling, ausencia de Origin y replay.

### H-02 — No se valida procedencia, scopes ni activos del token Meta

El OAuth guarda scopes vacíos y el registro de system tokens valida identidad mediante `/me`, pero no usa introspección `/debug_token` para comprobar `app_id`, `is_valid`, `scopes`, `granular_scopes`, caducidad, `data_access_expires_at` y activos autorizados. Un token de otra app o excesivamente privilegiado puede quedar etiquetado como válido/no expirable.

**Corrección:** introspección server-to-server con app access token, validación fail-closed, snapshot de scopes verificados y allowlist de activos. En reporting, rechazar o poner en cuarentena tokens que incluyan `ads_management` o permisos de publicación.

### H-03 — Rotación de cifrado incompleta y con downgrade de AAD

`scripts/rotate-token-encryption-key.mjs:29-48` cifra sin AAD, aunque el runtime vincula el ciphertext a `fbUserId:tokenName`. El script recorre sólo `users/*/meta_tokens/*`, no `apify_tokens`. Además, el “dry run” escribe probes (`:51-76`) y no los elimina cuando `DRY_RUN=1`; la rotación es no atómica, carece de versión de clave y usa un proyecto predeterminado hardcoded.

**Corrección:** cifrado envelope con Cloud KMS, `key_version` y AAD obligatoria; migración dual-read/single-write; canary, backup y restore probado; incluir todas las colecciones; dry-run estrictamente sin escrituras; eliminar el fallback legacy después de migrar.

### H-04 — Identidad de despliegue GCP con privilegios excesivos

`scripts/setup-gcloud.sh:98-108` concede a la service account de GitHub permisos a nivel proyecto, incluidos `roles/secretmanager.admin` y `roles/iam.serviceAccountUser`. La condición WIF debe vincularse también a branch/ref, workflow y environment, no sólo al repositorio.

**Corrección:** roles custom o bindings a recursos concretos; `secretVersionAdder`/access sobre secretos nombrados, `actAs` sólo sobre la runtime SA, writer sólo sobre el repositorio Artifact Registry y deploy sólo sobre el servicio Cloud Run. Añadir environment protegido y condición WIF por repo + `refs/heads/main` + workflow.

### H-05 — Rate limits y circuit breakers sólo por proceso

Los limitadores HTTP, de registro y del cliente Meta son mapas/singletons en memoria. Con varias instancias Cloud Run, cada instancia mantiene cuotas y circuitos independientes. Para 20 cuentas y trabajos concurrentes esto permite ráfagas multiplicadas y reintentos descoordinados.

**Corrección:** Cloud Tasks/Pub/Sub para backpressure, cuotas atómicas compartidas por app/token/cuenta/tenant, jitter, `Retry-After`, dead-letter queue y circuit state compartido. Aplicar además cuotas por principal en gateway/Cloud Armor.

### H-06 — Falta allowlist interna tenant → activos Meta (IDOR lógico)

Las tools aceptan IDs de cuenta, campaña, página y otros objetos. La autorización final se delega a Graph API. Esto puede bastar con tokens individuales, pero no con un system user de agencia que tenga acceso a múltiples clientes: Meta autorizará todos esos activos aunque la aplicación deba aislarlos.

**Corrección:** tabla autoritativa `tenant_asset_bindings`; resolver primero el objeto padre; comprobar pertenencia en toda consulta; usar vistas y claves compuestas con `tenant_id`; tests negativos tenant A → asset B en cada familia de tools.

### H-07 — Lead data sin frontera PII dedicada

`ads_get_leads` y `ads_create_lead_form` conviven con el catálogo general. Los formularios de propiedades pueden contener nombre, teléfono, email, presupuesto e intención de compra. Guardar esto junto al histórico agregado eleva innecesariamente el impacto de una brecha y las obligaciones de retención/borrado.

**Corrección:** deshabilitar `leads_retrieval` por defecto. Si el negocio necesita leads, crear un módulo opt-in con dataset, roles, claves, retención, exportación y auditoría separados; minimizar campos y no incluir PII cruda en recomendaciones ni Excel generales.

## Hallazgos Medium

### M-01 — Binding OAuth incompleto

El flujo MCP exige PKCE S256 en el SDK y vuelve a verificarlo como defensa en profundidad. Los códigos son aleatorios, expiran y se consumen atómicamente. Sin embargo, `src/auth/oauth-provider.ts:136-181` recibe `_redirectUri` y no lo compara con el redirect almacenado; el resource solicitado se guarda, pero debe verificarse contra el recurso MCP esperado durante emisión y validación. Los access tokens duran una hora y no tienen revocación individual.

**Corrección:** comparar exactamente `redirect_uri`; fijar issuer/resource/audience; reducir TTL del access token si el riesgo lo exige y añadir JTI revocable. Limitar o aprobar el Dynamic Client Registration y aplicar rate limit distribuido/TTL.

### M-02 — Redirect HTTPS usa `Host` no confiable

`src/transport/http.ts:440-447` construye `https://${req.header("host")}${req.originalUrl}`. Un Host manipulado puede producir open redirect o phishing si llega directamente al servicio.

**Corrección:** redirigir al origin configurado por `SERVER_URL` y rechazar hosts no allowlisted.

### M-03 — Secretos Meta en query strings

`src/auth/meta-oauth.ts:65-71` incluye `client_secret` y el código en la URL de intercambio; otros flujos añaden access tokens a query parameters. Aunque el logger propio no imprime la URL, proxies, APM o diagnósticos pueden capturarla.

**Corrección:** usar header `Authorization` donde Meta lo soporte y cuerpo POST para exchanges; prohibir logging de URL completa; aplicar `appsecret_proof` cuando corresponda.

### M-04 — Redacción de logs incompleta

Se registran `fbUserId`, nombres de token y mensajes crudos de error de Meta. `maskToken()` conserva un prefijo del token. La redacción cubre claves comunes, pero no garantiza secretos anidados, cuerpos o query strings.

**Corrección:** serializer allowlist central, redacción recursiva, cero fragmentos de token, IDs seudonimizados con HMAC y retención corta. Tratar respuestas MCP, URLs firmadas y errores de Meta como datos sensibles.

### M-05 — Metadata sensible y artefactos OAuth en Firestore

Firestore contiene email, nombre, foto, metadata de clientes, tokens cifrados, auth codes y JTIs. El SDK servidor usa IAM como frontera; reglas de cliente no sustituyen least privilege.

**Corrección:** minimizar campos, TTL para códigos/JTI/clientes temporales, separar entornos y colecciones, IAM por service account, PITR/backups auditados y cifrado de campos especialmente sensibles.

### M-06 — Fallback legacy sin AAD

`src/store/meta-token-repo.ts:33-42` reintenta descifrar sin AAD ante cualquier fallo. Eso conserva compatibilidad, pero permite que documentos legacy se reubiquen sin detectar cambio de owner/nombre y oculta la causa original de errores de integridad.

**Corrección:** migración inventariada con `schema_version`/`key_version`, métrica del fallback y fecha límite para eliminarlo.

### M-07 — Imagen Docker incluye dependencias dev y tags flotantes

`Dockerfile:1-17` instala todas las dependencias y copia `node_modules` completo a runtime. La cadena dev High de `nanoid` queda físicamente en la imagen aunque no sea importada en producción. `node:22-alpine` no está fijada por digest.

**Corrección:** build reproducible; `npm prune --omit=dev` o instalación production-only en stage limpio; imagen base por digest; scanner de imagen, SBOM, firma/attestation; filesystem read-only y `no-new-privileges`.

### M-08 — Secret scanning y supply chain incompletos

Las GitHub Actions están fijadas por SHA y Gitleaks local/histórico pasa. Sin embargo, el scan puede omitirse en PRs de forks según el workflow/licencia y la configuración efectiva de branch protection/environments no vive en el repositorio.

**Corrección:** escaneo Gitleaks CLI/container en todo PR sin inyectar secretos; dependency review; CodeQL/SAST; attestations también en deploy; branch protection, CODEOWNERS para auth/infra y environment approval obligatorios.

### M-09 — Límites de cuerpo y cuotas por tenant insuficientes

Express admite JSON global de hasta 10 MB y no hay una cuota MCP completa por principal/tenant. Algunas tools pueden provocar consultas costosas o exportaciones grandes.

**Corrección:** límite específico pequeño para MCP, paginación obligatoria, presupuestos de filas/bytes/tiempo, concurrency por tenant y jobs asíncronos para Excel.

### M-10 — Versiones Graph API inconsistentes

El OAuth usa `v22.0`, el cliente tiene otro default y el despliegue vuelve a fijar una versión. La disponibilidad/nombre de métricas y permisos puede variar.

**Corrección:** una única constante/configuración, matriz de compatibilidad, contract tests con fixtures por versión y proceso explícito de upgrade antes de que Meta retire la versión elegida.

### M-11 — Side effects que no modifican campañas

`ads_create_async_report` y `ads_run_report_and_wait` crean jobs en Meta; `ads_library_scrape` consume un proveedor pagado; las tools de token cambian credenciales. No deben confundirse con lecturas puras aunque no alteren delivery.

**Corrección:** capabilities separadas y disabled-by-default. El scheduler, no el analista MCP, debe crear jobs de reporting con idempotency keys y cuotas.

## Hallazgos Low

- **L-01:** ampliar CSP con `base-uri 'none'`, `frame-ancestors 'none'` y nonces cuando sea viable; aplicar `Cache-Control: no-store` a todas las respuestas de auth/error.
- **L-02:** `/health` sólo comprueba que el proceso responde. Añadir readiness interno para Firestore/KMS/colas sin filtrar detalles al público.
- **L-03:** la versión del servidor declarada en código no coincide con `package.json`; esto dificulta inventario y respuesta a incidentes.
- **L-04:** corregir los dos tests no deterministas antes de considerar verde el gate de seguridad.

## Controles revisados que funcionan correctamente

- AES-256-GCM con IV aleatorio de 12 bytes, clave validada de 32 bytes y AAD en documentos actuales.
- Cookie de sesión `__Host-`, `HttpOnly`, `Secure` en producción, `SameSite=Lax`, audiencia JWT y JTI allowlisted.
- State de OAuth firmado, con audiencia, expiración y nonce ligado a cookie.
- PKCE S256 obligatorio en OAuth MCP; códigos de autorización de 10 minutos y consumo atómico.
- Refresh tokens con JTI y rotación/consumo atómico.
- Comparación constant-time de API key.
- Allowlist de acceso fail-closed en modo multi-tenant y validación de secretos de producción.
- Validación exacta del redirect registrado antes de autorización y `returnTo` interno seguro.
- Escaping HTML, CSP, `X-Frame-Options: DENY`, HSTS y `Referrer-Policy: no-referrer`.
- Descargas con HTTPS, resolución DNS, bloqueo de redes privadas IPv4/IPv6, pinning de IP, revisión de redirects, tamaño, MIME y timeout.
- GitHub Actions fijadas por commit SHA y autenticación GCP mediante WIF, sin clave JSON estática.
- Contenedor ejecutado como usuario `node`.
- Historial completo limpio con Gitleaks y cero advisories en dependencias runtime.

## Inventario de tools que escriben o modifican estado

### Mutaciones directas de Ads/campañas — deshabilitar completamente

**Crear:**

- `ads_bulk_create_video_ads`
- `ads_clone_ad_set_bundle`
- `ads_create_ad`
- `ads_create_ad_creative`
- `ads_create_ad_rule`
- `ads_create_ad_set`
- `ads_create_ad_study`
- `ads_create_budget_schedule`
- `ads_create_campaign`
- `ads_create_custom_audience`
- `ads_create_custom_conversion`
- `ads_create_lead_form`
- `ads_create_lookalike_audience`
- `ads_reply_comment`

**Actualizar/compartir:**

- `ads_share_custom_audience`
- `ads_unshare_custom_audience`
- `ads_update_ad`
- `ads_update_ad_creative`
- `ads_update_ad_rule`
- `ads_update_ad_set`
- `ads_update_ad_url_tags`
- `ads_update_campaign`
- `ads_update_entity`
- `ads_update_spend_cap`

**Activar/ocultar:**

- `ads_activate_entity`
- `ads_hide_comment`

**Eliminar:**

- `ads_delete_ad`
- `ads_delete_ad_rule`
- `ads_delete_ad_set`
- `ads_delete_campaign`
- `ads_delete_comment`
- `ads_delete_custom_audience`

**Subir media:**

- `ads_upload_ad_image`
- `ads_upload_ad_video`

### Efectos laterales de reporting/proveedor — capability separada

- `ads_create_async_report`: crea un job de reporte en Meta.
- `ads_run_report_and_wait`: crea y espera un job de reporte en Meta.
- `ads_library_scrape`: inicia un run pagado en Apify.
- `ads_library_abort_run`: cancela un run.

### Administración de credenciales — sólo control plane

- `ads_register_token`
- `ads_set_active_token`
- `ads_delete_token`
- `ads_library_register_apify_token`
- `ads_library_delete_apify_token`

### Mutaciones de WhatsApp — fuera del servicio de reporting

- `whatsapp_register_phone`
- `whatsapp_deregister_phone`
- `whatsapp_request_verification_code`
- `whatsapp_verify_code`
- `whatsapp_update_business_profile`
- `whatsapp_create_template`
- `whatsapp_update_template`
- `whatsapp_delete_template`
- `whatsapp_create_flow`
- `whatsapp_update_flow`
- `whatsapp_publish_flow`
- `whatsapp_deprecate_flow`
- `whatsapp_delete_flow`
- `whatsapp_create_qr_code`
- `whatsapp_update_qr_code`
- `whatsapp_delete_qr_code`
- `whatsapp_subscribe_webhook`
- `whatsapp_unsubscribe_webhook`

## Diseño de read-only por defecto

La defensa debe ser redundante:

```text
Token Meta sin permisos de escritura
        ↓
Catálogo de tools filtrado por capability
        ↓
TenantContext + allowlist de activos
        ↓
Guard HTTP: GET-only / endpoints exactos de report job
        ↓
Graph API
```

Configuración propuesta:

```text
MCP_MODE=read_only                  # default y obligatorio inicialmente
ENABLE_REPORT_JOBS=false            # opt-in revisado
ENABLE_PAID_EXTERNAL=false          # Apify desactivado
ENABLE_CREDENTIAL_ADMIN=false       # nunca dentro del MCP de analistas
ENABLE_ADS_WRITE=false              # no disponible en este deployment
ENABLE_WHATSAPP_WRITE=false         # no disponible
ALLOW_LEAD_PII=false                # opt-in independiente
```

El build/deploy de reporting no debe contener una ruta para convertir recomendaciones en acciones Meta. Si en el futuro se autoriza automatización, debe vivir en otro servicio, otra service account, otro token/app y otro proceso de aprobación.

## Permisos Meta mínimos para reporting read-only

Los permisos deben solicitarse por módulo y sólo después de validar el producto de login y la versión Graph API elegidos en el App Dashboard/App Review. No conceder un bundle único a todos los tenants.

| Función | Permiso propuesto | Observación |
|---|---|---|
| Campañas, ad sets, ads, targeting e Insights pagados | `ads_read` | Permiso base; excluir `ads_management` |
| Descubrir Pages administradas | `pages_show_list` | Sólo si la conexión descubre Pages automáticamente |
| Contenido/metadata/engagement de Page | `pages_read_engagement` | Lectura orgánica de la Page |
| Métricas de Page | `read_insights` | Confirmar métricas disponibles en la versión elegida |
| Cuenta profesional y media de Instagram mediante Facebook Login | `instagram_basic` | No permite publicar |
| Insights de Instagram | `instagram_manage_insights` | Necesario para alcance, perfil y media insights; confirmar nomenclatura vigente |
| Leads crudos | `leads_retrieval` | Sólo módulo PII opt-in; no necesario para métricas agregadas si Meta entrega conversiones |
| Enumerar assets de Business Manager | `business_management` | Evitar si los assets se registran explícitamente y `ads_read` basta |
| Identidad de login | `public_profile` | Implícito/básico según el flujo |
| Email para allowlist | `email` | Opcional; preferir SSO/identidad interna |

Si se usa el producto Instagram Login en vez de Facebook Login, los nombres pueden corresponder a la familia `instagram_business_basic` / `instagram_business_manage_insights`; debe elegirse un solo flujo y confirmar los nombres exactos durante App Review.

**No necesarios para reporting:** `ads_management`, permisos `pages_manage_*`, permisos de publicación de Instagram, `whatsapp_business_management` y `whatsapp_business_messaging`.

Notas de métricas:

- Seguidores, visitas al perfil y ciertos insights orgánicos requieren snapshots periódicos; no asumir histórico ilimitado de Meta.
- Guardados/compartidos y algunas métricas varían por tipo de media, cuenta y versión. Guardar `null/not_available`, nunca convertir ausencia en cero.
- Leads, mensajes y conversiones deben conservar attribution window, action type y fuente. No sumar métricas incompatibles.

## Arquitectura segura propuesta para 20 cuentas

```text
                    ┌──────────────────────────┐
                    │ Control plane de cuentas │
                    │ OAuth, debug_token, KMS  │
                    └────────────┬─────────────┘
                                 │ tokenRef + bindings
Usuario/OIDC ──► Secure MCP ──► Tenant Resolver ──► consultas read-only
                    │                 │
                    │                 └── tenant/account/page/IG allowlist
                    │
Scheduler OIDC ─► Cloud Tasks/Pub/Sub ─► Ingestion workers ─► Meta Graph API
                                              │
                         ┌────────────────────┴────────────────────┐
                         ▼                                         ▼
               Raw landing opcional                        BigQuery histórico
                    GCS/CMEK                       particionado y tenant-scoped
                                                                    │
                                     ┌──────────────────────────────┼───────────┐
                                     ▼                              ▼           ▼
                                  Analytics                   Segmentation  Campaigns
                                     │
                              Recommendations
                              (sin executor Meta)
                                     │
                              Reporting worker
                                     │
                          Excel en GCS + URL temporal
```

### Identidad y tenancy

- Tenant interno estable (`tenant_id`), separado de `fbUserId`.
- `principal_memberships`: principal, tenant, rol y estado.
- `tenant_asset_bindings`: tenant, tipo de asset, ID Meta, tokenRef, fecha y provenance.
- `TenantContext` inmutable creado una vez por request; ningún tool puede reemplazarlo.
- Roles mínimos: `agency_admin`, `analyst`, `report_viewer`, `scheduler`; administración de tokens fuera de MCP.
- Tests de aislamiento para cada tipo de ID y cada capa de almacenamiento.

### Tokens y secretos

- Secret Manager + Cloud KMS envelope encryption, DEK por tenant o grupo de riesgo y `key_version` explícita.
- Firestore conserva sólo referencias, metadata validada y watermarks; nunca tokens en env vars compartidas.
- Service accounts separadas para auth/control plane, MCP, ingesta, analytics, Excel y scheduler.
- Egress restringido a endpoints Meta aprobados; acceso humano break-glass auditado.

### Histórico y analytics

- BigQuery particionado por `date`, clusterizado por `tenant_id`, `account_id`, `object_type` y `object_id`.
- Clave idempotente: tenant + cuenta + objeto + fecha + breakdown + attribution setting + versión de API/schema.
- Tablas raw/normalized/metrics separadas; preservar moneda, zona horaria y attribution window.
- Row-level controls/vistas tenant-scoped y jobs de calidad que detecten duplicados, gaps, cambios de schema y métricas no disponibles.
- PII de leads en dataset independiente con TTL y rol específico.

### Scheduling, límites y resiliencia

- Cloud Scheduler invoca un dispatcher mediante OIDC; dispatcher crea un job por tenant/cuenta/ventana.
- Cloud Tasks/Pub/Sub aplica concurrencia, idempotencia, retries con jitter y dead-letter queue.
- Quotas compartidas por token, app, cuenta y tenant; circuit breaker distribuido.
- Watermarks permiten backfill seguro y reportes semanales/mensuales reproducibles.

### Excel y entrega

- Worker aislado genera Excel desde snapshots cerrados, no consultando Meta durante el render.
- Dashboards con KPIs, tendencias, comparativas, funnel, campañas, audiencias y recomendaciones con evidencia.
- Objetos en GCS con CMEK, prefijo por tenant, lifecycle/retención y URLs firmadas de corta duración.
- Fórmulas protegidas y datos externos/macros deshabilitados para evitar formula injection; sanitizar valores que comiencen con `=`, `+`, `-` o `@`.

### Recomendaciones

Cada recomendación debe incluir tenant/cuenta/campaña, periodo, métricas fuente, regla/modelo/version, confianza, limitaciones y evidencia. El motor no debe recibir un cliente Meta con capacidad de escritura.

## Estructura modular propuesta

No se crearon estos directorios durante la auditoría. La estructura recomendada es:

```text
src/agency/
├── tenant-resolver/
├── policy/
├── analytics/
├── reporting/
├── segmentation/
├── historical-data/
├── excel/
├── scheduler/
└── recommendations/
```

Dependencias dirigidas:

- `tenant-resolver` y `policy` son capas obligatorias para todos los módulos.
- `historical-data` recibe datos de ingesta y expone repositorios tenant-scoped.
- `analytics`, `segmentation` y campaign analysis consumen datos históricos, no tokens Meta.
- `recommendations` consume resultados analíticos y sólo produce registros.
- `reporting` y `excel` consumen snapshots versionados.
- `scheduler` dispara jobs internos; no expone tools MCP ni credenciales al usuario.

## Auditoría, credenciales y rotación

Registrar en un audit log append-only:

- actor/workload, tenant, rol, asset, operación, job ID, timestamp y resultado;
- versión de dataset, API, reglas/modelo y reporte;
- eventos de conexión, introspección, revocación y rotación, sin token ni PII.

Runbook mínimo de credenciales:

1. Inventariar app secrets, OAuth/JWT/session secrets, claves KMS, tokens Meta, Apify y service accounts.
2. Asignar owner, ambiente, fecha de creación, última rotación, caducidad y activos permitidos.
3. Rotación normal con nueva versión, dual-read temporal, canary, verificación y revocación de la anterior.
4. Rotación de emergencia: detener ingesta, revocar token/app secret, invalidar sesiones, revisar audit logs, reconectar tenant por tenant y hacer postmortem.
5. Probar restore y rotación al menos trimestralmente; alertar por expiración, scope drift y `data_access_expires_at`.

## Gates antes de conectar cuentas reales

1. Cerrar C-01 y C-02 y todos los High.
2. Desplegar sólo el perfil read-only, sin `ads_management`, WhatsApp, Apify ni credenciales globales.
3. Corregir los 2 tests fallidos y dejar lint/typecheck/test/build/Gitleaks/audit verdes.
4. Ejecutar tests automatizados de no-escritura y aislamiento con dos tenants y activos sintéticos cruzados.
5. Validar permisos exactos y métricas en una Meta test app durante App Review.
6. Revisar IAM efectivo, WIF, Secret Manager/KMS, Cloud Run ingress/egress, Cloud Armor y branch protection.
7. Hacer threat model y pentest del deployment staging.
8. Conectar primero una cuenta sandbox/no productiva, observar rate limits, logs y reportes; después rollout gradual 1 → 3 → 10 → 20.

## Criterio de aceptación de seguridad

La plataforma estará lista para el primer activo real cuando:

- no exista ningún token con permisos de escritura accesible desde el servicio de reporting;
- ninguna tool registrada en read-only pueda provocar una mutación, ni directa ni por endpoint genérico;
- toda petición y fila histórica tenga tenant derivado del principal autenticado;
- una prueba tenant A → asset B falle antes de llamar a Meta y antes de consultar almacenamiento;
- los secretos tengan versionado, owner, rotación probada y logging sin material sensible;
- cuotas/circuitos sean compartidos entre instancias;
- los gates CI y el pentest de staging estén verdes.

