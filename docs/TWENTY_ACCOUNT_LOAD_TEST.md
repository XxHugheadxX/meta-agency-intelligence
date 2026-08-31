# Prueba sintética de 20 cuentas

## Objetivo

Validar localmente la forma del piloto previsto antes de conectar Meta o GCP:
20 cuentas Ads dentro de un workspace, jobs firmados, concurrencia acotada,
leases idempotentes, backpressure, reintento y resultados tenant-scoped.

## Escenario automatizado

`tests/agency/reporting-twenty-account-load.test.ts` usa exclusivamente datos y
credenciales sintéticos. Ejecuta el `AgencyReportingWorker` real con:

- 20 payloads diferentes y firmados con una clave efímera de prueba;
- un único tenant/workspace y 20 cuentas `act_<digits>` autorizadas por separado;
- máximo global de cuatro jobs y máximo de dos para el workspace;
- una entrega adicional rechazada con `ReportingBackpressureError` mientras los
  dos slots están ocupados;
- un fallo transitorio inyectado en una cuenta y reintento posterior;
- leases con fencing, replay de un job completado y 20 artefactos opacos únicos;
- auditoría minimizada y aserción de que ninguna credencial aparece en resultados
  o eventos.

La prueba comprueba que el pico del runtime nunca supera dos operaciones para el
workspace, las 20 cuentas terminan, sólo la cuenta con fallo transitorio ejecuta
dos veces y el replay no vuelve a resolver el token ni invoca la runtime.

## Qué demuestra y qué no

Demuestra la lógica local de admisión, aislamiento, liberación de leases,
idempotencia y recuperación con el volumen nominal del piloto. No mide latencia
de Meta, cuota real de Graph API, throughput de Firestore, tamaño final de los
XLSX, memoria de Cloud Run ni comportamiento real de Pub/Sub/GCS.

Por eso el gate de carga de producción continúa abierto. Debe repetirse en
staging con servicios no productivos, fixtures sintéticos y observación de
memoria, CPU, tamaño de artefactos, `Retry-After`, DLQ y tiempos p95/p99 antes de
conectar cualquier cuenta real.
