# Continuidad con Claude Code

Este documento permite alternar Codex y Claude Code sin depender del historial
de un chat. La fuente de verdad es el repositorio privado
`XxHugheadxX/meta-agency-intelligence`; el upstream público sirve únicamente
como referencia.

## Lectura obligatoria al iniciar

1. `CLAUDE.md` y `AGENTS.md`.
2. `docs/PROJECT_CONTEXT.md`.
3. `docs/SECURITY_REQUIREMENTS.md`.
4. `docs/REPORTING_REQUIREMENTS.md`.
5. `docs/PRODUCT_ROADMAP.md`.
6. `docs/MODEL_DELEGATION_POLICY.md`.
7. `SECURITY_AUDIT.md`.
8. El último `git log`, la rama actual y el working tree.

No copiar secretos, archivos `.env`, tokens o credenciales al chat. Los
documentos versionados contienen contexto suficiente y nunca deben contener
valores reales.

## Reglas que no se pueden negociar

- Trabajar sólo en este repositorio privado.
- No ejecutar `npm` ni `npx`. Usar directamente los binarios ya instalados en
  `node_modules/.bin`.
- Mantener el producto y el scheduler en modo `read_only`.
- No añadir `ads_management` ni habilitar tools de escritura.
- No conectar cuentas Meta reales hasta superar los gates de staging.
- El token Meta permanece en backend y no aparece en frontend, logs, errores,
  URLs, reportes, prompts o commits.
- No usar claves JSON de service accounts; usar identidad de workload.
- No hacer merge, force-push, rebase destructivo ni desplegar automáticamente.
- No usar modos que deshabiliten confirmaciones de permisos.
- Preservar cambios ajenos y mantener compatibilidad con upstream cuando sea
  razonable.

## Flujo Git para alternar agentes

1. No usar simultáneamente la misma rama con Codex y Claude Code.
2. Partir del SHA remoto confirmado de `mvp/read-only-reporting`.
3. Crear una rama por tarea, por ejemplo `claude/staging-infrastructure`.
4. Hacer commits pequeños, sin mezclar documentación, infraestructura y
   producto si pueden revisarse por separado.
5. Subir sólo al origin privado y abrir PR para revisión; no fusionar.
6. Antes de entregar, comprobar que el working tree esté limpio y que el SHA
   local coincida con el remoto.

## Verificación local sin npm

PowerShell:

```powershell
& .\node_modules\.bin\eslint.cmd src
& .\node_modules\.bin\tsc.cmd --noEmit
& .\node_modules\.bin\vitest.cmd run --pool=threads --maxWorkers=4 --silent=passed-only
& .\node_modules\.bin\tsc.cmd
```

Git Bash o WSL:

```bash
./node_modules/.bin/eslint src
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run --pool=threads --maxWorkers=4 --silent=passed-only
./node_modules/.bin/tsc
```

Antes de cada commit o push también se ejecuta la versión de Gitleaks fijada en
`.gitleaks-version`, con `.gitleaks.toml`, y se revisa `git diff --check`. Nunca
se salta un hallazgo: se elimina la credencial o se corrige el falso positivo de
forma revisable.

## Cierre de cada sesión

El reporte de entrega debe incluir:

- rama y SHA;
- cambios terminados;
- archivos principales;
- pruebas y escaneo de secretos ejecutados;
- riesgos restantes;
- recursos externos que no se crearon;
- siguiente tarea concreta;
- estado de sincronización con GitHub.

Si una decisión modifica arquitectura, seguridad o alcance, actualizar los
documentos de contexto y roadmap en el mismo bloque de trabajo.

## Prompt de reanudación

```text
Trabaja únicamente en este repositorio privado. Lee CLAUDE.md, AGENTS.md,
docs/CLAUDE_CODE_CONTINUITY.md y los documentos de contexto indicados allí.
No uses npm ni npx. Mantén todo READ-ONLY, no añadas ads_management, no conectes
cuentas reales y no expongas secretos. Verifica rama, SHA y git status antes de
editar. Implementa una sola tarea concreta, ejecuta lint, TypeScript, tests,
build y Gitleaks, crea commits pequeños, no hagas merge y deja un reporte con el
SHA remoto confirmado.

Tarea: <describir una sola tarea>
```

## Instalación

La instalación de Claude Code no forma parte del repositorio. Para respetar la
regla de no usar npm, utilizar una instalación existente o el instalador binario
oficial compatible con el entorno del operador. No ejecutar instaladores desde
scripts versionados ni almacenar credenciales de Claude en el proyecto.
