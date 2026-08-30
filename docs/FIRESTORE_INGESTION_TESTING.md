# Pruebas de ingesta con Firestore Emulator

## Propósito

La suite de emulador verifica la persistencia real del histórico y los
checkpoints sin usar credenciales, proyectos ni cuentas Meta reales. Cubre:

- upserts transaccionales e idempotentes;
- rollback completo de lotes inválidos;
- aislamiento por tenant/workspace;
- checkpoints monotónicos bajo escrituras concurrentes;
- rechazo de documentos cuya identidad no coincide con su ruta.
- generación del XLSX desde histórico y checkpoints respaldados por Firestore.
- leases concurrentes con fencing, takeover y replay idempotente.
- flujo HTTP firmado completo hasta el artefacto XLSX tenant-scoped.

La línea base validada localmente es Firestore Emulator 1.22.0 sobre Java 25:
cuatro archivos de integración y ocho tests aprobados.

La suite queda omitida durante los tests unitarios normales si
`FIRESTORE_EMULATOR_HOST` no apunta explícitamente a `localhost` o
`127.0.0.1`. Nunca debe configurarse esa variable con un servicio remoto.

## Ejecución en PowerShell

En una primera terminal, con Google Cloud CLI y Java instalados:

```powershell
gcloud beta emulators firestore start --host-port=127.0.0.1:8085
```

En una segunda terminal, desde la raíz del repositorio:

```powershell
.\scripts\test-firestore-emulator.ps1
```

El script invoca directamente el binario instalado de Vitest. No utiliza
`npm` ni `npx`, sólo acepta un emulador local y restaura las variables de
entorno al terminar.

## Índices

`firestore.indexes.json` declara el índice compuesto requerido por consultas
de histórico filtradas por `level` y rango de `date`. Su despliegue a staging o
producción es una operación de infraestructura separada y revisada; ejecutar
las pruebas locales no despliega índices ni modifica recursos remotos.

## Límites y gate pendiente

- Cada transacción histórica acepta como máximo 500 documentos.
- Un lote con identidades duplicadas se rechaza completo.
- Los datos de prueba usan tenants aleatorios y se eliminan del emulador al
  finalizar.
- Esta suite no sustituye las pruebas futuras de backup, restore, TTL, IAM o
  carga equivalente a veinte cuentas.
