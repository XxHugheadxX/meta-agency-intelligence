# Política de delegación de modelos

## Objetivo

Minimizar consumo de tokens y uso de modelos costosos sin sacrificar calidad en
tareas críticas. Usar siempre el modelo más económico capaz de resolver la
tarea correctamente y reutilizar la memoria técnica existente.

## Clasificación

### Nivel 1 — Baja complejidad

Usar un modelo económico/rápido para exploración acotada, documentación,
fixtures, mocks, tipos, imports, formato, lint y tests unitarios sencillos.

### Nivel 2 — Complejidad media

Usar el modelo estándar de desarrollo para servicios, persistencia, reporting,
histórico, Excel, analytics, segmentación, scheduler, integraciones conocidas y
tests de integración.

### Nivel 3 — Alta complejidad

Usar razonamiento avanzado sólo para arquitectura, OAuth, autenticación,
criptografía, aislamiento multi-tenant, race conditions, vulnerabilidades,
migraciones delicadas o problemas que hayan fallado dos veces con el modelo
estándar.

### Nivel 4 — Revisión crítica

Usar el modelo más potente sólo como revisor antes de credenciales reales,
producción o cambios en OAuth, cifrado, tokens, tenants, herramientas mutantes o
gasto publicitario. No asignarle trabajo mecánico.

## Escalamiento y reintentos

1. Primer intento con el modelo correspondiente al nivel.
2. Segundo intento con el mismo nivel, proporcionando error, archivos, logs y
   resultado esperado.
3. Tercer intento: escalar un nivel.
4. No repetir indefinidamente el mismo análisis.

No saltar al modelo avanzado salvo por seguridad o arquitectura crítica.

## Contexto mínimo

1. Localizar archivos relevantes.
2. Leer sólo esos archivos y sus dependencias directas.
3. Reutilizar conclusiones ya documentadas.
4. Ejecutar primero tests específicos.
5. Analizar todo el repositorio sólo para arquitectura, auditoría o cambios
   transversales.

Memoria técnica principal:

- `docs/PROJECT_CONTEXT.md`
- `docs/SECURITY_REQUIREMENTS.md`
- `docs/REPORTING_REQUIREMENTS.md`
- `docs/PRODUCT_ROADMAP.md`
- `SECURITY_AUDIT.md`

Cuando existan, reutilizar también `docs/ARCHITECTURE.md` y
`docs/TOOL_PERMISSION_MATRIX.md`.

## Delegación recomendada

- Modelo económico: explorar, localizar, documentar, crear fixtures y tests
  simples.
- Modelo estándar: implementar reporting, histórico, Excel, analytics y
  segmentación.
- Modelo avanzado: revisar seguridad, arquitectura y cambios críticos.

Las tareas delegadas deben ser acotadas. Agentes que comparten worktree no deben
editar simultáneamente los mismos archivos ni hacer commits sin coordinación.

## Reglas específicas de Meta Agency Intelligence

- Cambios en `src/auth/`, OAuth, seguridad MCP, tokens, scopes, secretos o
  resolución tenant requieren revisión avanzada.
- Cambios en `src/agency/` normalmente usan el modelo estándar.
- La revisión avanzada no autoriza conectar credenciales reales.
- Ningún modelo puede ampliar permisos de escritura o modificar campañas sin
  una decisión explícita del usuario y una arquitectura separada.
- Objetivo de distribución: 80% económico/estándar, 15% estándar con mayor
  razonamiento y 5% avanzado para revisión crítica.

