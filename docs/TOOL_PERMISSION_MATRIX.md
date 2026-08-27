# Matriz de tools y permisos

Esta matriz describe la frontera del despliegue de reporting. La allowlist de
lectura es ejecutable en `src/tools/index.ts`; las anotaciones MCP son sólo
señales para clientes y no sustituyen el gate del servidor.

## Política por modo

| Capability / familia | `read_only` | Estado / motivo |
|---|---:|---|
| `pure_read` — catálogo exacto | Permitido | 58 tools allowlisted y registradas sólo si tienen `readOnlyHint` |
| Leads con PII | Denegado | Módulo y dataset separados; `ALLOW_LEAD_PII` no es válido en reporting read-only |
| `report_job` / jobs asíncronos | Denegado por defecto | Crear un job en Meta tiene side effect; requiere revisión y flag explícito |
| `paid_external` (Apify) | Denegado | Consume créditos o crea estado externo |
| `credential_admin` / token management | Denegado | Cambia credenciales o estado de autenticación |
| `ads_write` | Denegado | Crea, actualiza, pausa o elimina objetos publicitarios |
| `whatsapp_write` | Denegado | Modifica activos, plantillas, flows o webhooks de WhatsApp |
| `upload` / media mutation | Denegado | Sube contenido y puede producir activos externos |
| `control-plane` / administración | Denegado | IAM, configuración, scheduler y conexiones se operan fuera del analista MCP |

## Familias de lectura permitidas

Las 58 entradas allowlisted cubren únicamente lecturas o cálculos derivados:

- cuentas, campañas, ad sets, ads, creativos y media;
- insights y vistas semánticas de rendimiento;
- targeting descriptivo, búsquedas de intereses/demografía/geografía y tamaño
  estimado de audiencia;
- audiencias existentes, píxeles, reglas, estudios, billing/invoices y límites
  como datos de consulta;
- páginas, Instagram, previews y entidades;
- diagnósticos, estado de rate limit, ayuda y resúmenes agregados de agencia.

La lista canónica, que debe revisarse por nombre exacto, es
`PURE_READ_TOOL_ALLOWLIST` en `src/tools/index.ts`. Una tool nueva queda
denegada hasta tener capability, justificación, tests de tenant y revisión de
seguridad.

## Familias explícitamente fuera de la allowlist

El catálogo completo del repositorio contiene 135 tools. La auditoría base
identificó 61 tools no-READ (21 create, 16 update, 12 delete, 7 toggle, 3 token
y 2 upload). Esas cifras describen el catálogo general, no permisos concedidos
al modo read-only. Incluyen gestión de campañas/ads/ad sets/creativos,
audiencias mutables, comentarios, reglas, A/B testing, billing mutante,
WhatsApp, bulk ads, uploads, tokens y Ad Library/Apify.

`ads_create_async_report` y `ads_run_report_and_wait` son side effects aunque
no cambien delivery; deben tratarse como `report_job`, no como lectura pura.
Las tools de leads (`ads_get_leads`, `ads_get_ad_leads`) quedan fuera por PII.

## Reglas de autorización

Toda llamada debe tener `TenantContext` autenticado e inmutable. El ID de
cuenta o activo recibido se comprueba contra `tenant_asset_bindings`; para
objetos hijos se verifica primero el padre. No se aceptan tokens Meta desde
headers/query/body del usuario ni credenciales globales en despliegues
multi-tenant. Los fallos de identidad, tenant, binding o permiso son fail-closed.
