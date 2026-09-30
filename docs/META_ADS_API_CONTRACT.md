# Contrato seguro de Meta Ads Insights

Este gate usa una cuenta exclusivamente sandbox/test, el cliente `read_only`,
GET y binding del `act_<id>` al workspace. No solicita `ads_management`.
No conecta activos reales ni valida automáticamente toda la infraestructura.

## Paso a paso en PowerShell

1. Abre PowerShell en la raíz del repositorio, no en Graph API Explorer.
2. En Meta genera un token temporal para esta Test App con **sólo `ads_read`**.
   `public_profile` puede aparecer como permiso básico. Si no puedes excluir
   permisos de escritura, cancela: no amplíes permisos para forzar la prueba.
3. Ejecuta:

```powershell
.\scripts\test-meta-ads-contract.ps1
```

4. Cuando pida el ID, escribe únicamente los números de la **cuenta publicitaria
   sandbox**, o `act_` seguido de esos números. No uses el App ID ni un endpoint
   `/insights`, ni pegues literalmente un placeholder.
5. Escribe `SANDBOX` para confirmar que no usarás una cuenta real.
6. Introduce el token en el prompt oculto. No lo compartas en chat, capturas,
   URLs, argumentos, archivos `.env` ni historial de comandos.
7. Comparte sólo PASS/FAIL y el código de error sanitizado. Revoca el token al
   finalizar. No uses un token previamente expuesto, aunque sea sandbox.

El helper funciona con Windows PowerShell 5.1 y PowerShell 7. No ejecuta npm.
Restaura las variables de proceso en `finally`; el token sólo se transmite al
proceso de test mediante entorno. No equivale a garantizar borrado de toda
copia en memoria del runtime. No ejecutes transcripciones ni herramientas que
vuelquen el entorno mientras lo usas.

## Qué valida y qué no

- Primero GET `/me/permissions`: exige `ads_read` concedido y rechaza scopes
  concedidos adicionales salvo `public_profile`, para este contrato Ads-only.
- Después metadata de cuenta e Insights diarios del nivel seleccionado.
- Una respuesta `data: []` valida acceso al endpoint, no semántica de métricas.
- Para cerrar el gate de datos, repetir con datos **no productivos** conocidos,
  fechas correctas y `-RequireData`; no crear anuncios reales para conseguir datos.
- La prueba está acotada a una página de hasta 25 filas. No certifica backfill,
  toda la paginación ni carga de veinte cuentas; tienen pruebas separadas.
- `/me/permissions` no sustituye la introspección de procedencia de token del
  backend ni comprueba por sí solo que la cuenta es sandbox.

Ejemplo sin secretos, usando un nivel más detallado:

```powershell
.\scripts\test-meta-ads-contract.ps1 -Level ad -RequireData
```

Se pueden indicar `-StartDate`, `-EndDate` (ISO `yyyy-MM-dd`) y `-ApiVersion`.
El default compartido está en `src/meta/api-version.ts`; no se afirma que sea
la última versión ni que Meta la haya validado para esta app. No cambiar de
versión entre frontend Explorer, contrato, OAuth y worker sin revisión.

## Si devuelve #200

El token puede tener `ads_read` y aun así no estar autorizado para esa cuenta.
Revisar app seleccionada, usuario/rol, titular y vínculo de la cuenta sandbox,
permisos concedidos y vigencia. No deducir del error que falta una Facebook
Page, ni solicitar `ads_management` como workaround. Resolver primero el acceso
de la Test App y repetir con un token nuevo de mínimo privilegio.

Los contratos están omitidos por defecto en CI y en la suite local normal.
