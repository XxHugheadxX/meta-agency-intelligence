# Seguimiento de remediaciones de seguridad

2026-09-30. Complementa la auditoría histórica del 2026-08-26; no la reemplaza
ni certifica producción. «Implementado» significa control en código y pruebas
locales, no configuración efectiva de Meta/GitHub/GCP verificada.

## Critical / High

| ID | Control y evidencia en el repo | Gate restante |
|---|---|---|
| C-01 | Política READ-ONLY en registro y cliente; `tests/security/hardening.test.ts` verifica ausencia de tools mutantes/PII y rechazo POST/DELETE antes de fetch. | Inspección humana y smoke test del artefacto desplegado. |
| C-02 | Token descifrado y allowlist ligados al workspace; tests de binding/cross-tenant en `hardening.test.ts` y `tests/auth/token-store.test.ts`. | Revisar que producción no habilite fallbacks/API keys globales. |
| H-01 | CSRF/origin/nonce y tests en `tests/auth/csrf.test.ts` y suites de transporte. | Comprobar cookies, proxy y orígenes reales en staging. |
| H-02 | Introspección backend y mínimo privilegio; `hardening.test.ts` prueba scopes, expiración y ausencia de secretos en URL. Contrato Ads exige ads_read y rechaza scopes extra. | Test App autorizada y contrato positivo con datos; revisar procedencia/activos en el flujo desplegado. |
| H-03 | AES-256-GCM versionado, AAD y reencrypt; `tests/auth/crypto.test.ts` cubre rotación, backup ficticio y rechazo con otro workspace. | Ensayar restore/rotación/revocación en staging; comprobar política de claves. |
| H-04 | Configuración/guías de identidad separada y deploy opt-in manual. | IAM/WIF efectivos, roles y aprobación del environment GitHub no fueron inspeccionados remotamente. Sigue abierto operativamente. |
| H-05 | `src/meta/distributed-guard.ts` usa Firestore; leases/admisión/replay probados con fixtures y emulador. | Probar cuota/circuito entre réplicas, TTL, fallos de Firestore y carga real de staging. No equivale a control distribuido validado en producción. |
| H-06 | Intersección de activos del token con bindings autoritativos; tests de activos, parents orgánicos, repo y worker. | Aprovisionar bindings válidos de prueba y comprobar control plane/RBAC desplegado. |
| H-07 | Tools de leads crudos fuera de reporting; raw sanitizado, export scoped y pruebas de no filtración. | Revisión de payloads reales no productivos y política de retención/PII. |

No declarar todos estos hallazgos «cerrados» sólo porque la suite pasa. La
aceptación de riesgos y conexión real requiere aprobación explícita del dueño.

## Avances adicionales y riesgos residuales

- M-07: Docker ahora copia sólo dependencias de producción. Base aún con tag
  flotante; falta fijar digest revisado y construir/escanear la imagen resultante.
- M-08: Gitleaks 8.30.1 local sobre historial y directorio limpio. CI ya tiene
  scanning; revisar branch protection, políticas de forks y Actions efectivas.
- M-10: default unificado en `src/meta/api-version.ts`, validación estricta y
  tests en `tests/meta/api-version.test.ts`. Falta comprobar contrato para esa
  versión; no se infiere soporte sólo por compilar.
- Publicación upstream conservada por compatibilidad, pero requiere opt-in.
  No habilitar antes de revisar namespace/destinos/visibilidad del repo privado.
- No se realizó en esta integración un nuevo audit de advisories de dependencias,
  pentest ni inspección de recursos remotos. Un escaneo de secretos limpio no los
  sustituye y un repo privado no es un almacén seguro de credenciales.
- Cualquier token expuesto previamente en chat/URL debe revocarse; nunca reusarlo
  porque sea sandbox. La revocación remota no se presupone verificada.

## Evidencia de esta integración

961 tests normales pasan; 15 omitidos no cuentan como aprobación en esa suite.
Los 10 tests Firestore pasan por separado en emulador; los 5 contratos Meta
no se ejecutaron. Hubo 4 timeouts con builds concurrentes: pasaron aislados y
en la repetición completa con 2 workers, sin ampliar timeouts.
Lint/typecheck/build y Gitleaks local pasan. El detalle de datos,
migraciones y gates del MVP está en `MVP_READINESS.md`. Sin deploy, merge ni
cuentas reales en esta integración.
