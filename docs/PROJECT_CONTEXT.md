# Contexto del proyecto

## Identidad

- **Nombre de trabajo:** Meta Agency Intelligence.
- **Repositorio base:** fork de `meta-ads-mcp`.
- **Cliente objetivo:** agencias inmobiliarias pequeñas y agentes individuales.
- **Piloto inicial:** aproximadamente 20 perfiles o cuentas de Meta.
- **Estado de referencia:** seguridad, histórico, reporting, Excel,
  segmentación, ingesta read-only, pipeline MVP, entrega GCS privada y descarga
  autenticada implementados en ramas encadenadas; sin cuentas reales conectadas.
- **Repositorio de trabajo:** `XxHugheadxX/meta-agency-intelligence` privado.
  El fork público se conserva exclusivamente como upstream de lectura.

## Problema

La preparación manual de reportes de Meta Ads, Facebook e Instagram consume
varias horas cada semana, repite trabajo y facilita errores de transcripción,
atribución y comparación entre periodos. Las agencias necesitan conservar
histórico, comparar cuentas y explicar qué mejorar sin entregar a un agente de
IA capacidad para modificar campañas.

## Solución

Construir una plataforma multi-tenant que:

1. Extraiga datos autorizados de Meta en modo de sólo lectura.
2. Mantenga un histórico normalizado por workspace, cuenta, activo y periodo.
3. Calcule métricas consistentes y detecte cambios o anomalías.
4. Genere reportes semanales y mensuales en Excel con dashboards y gráficos.
5. Analice campañas, audiencias y segmentación.
6. Produzca recomendaciones explicables, pero nunca aplique cambios
   automáticamente en la primera versión.

## Arquitectura objetivo

```text
Meta APIs
   ↓
Secure MCP Layer
   ↓
Tenant Resolver + Asset Authorization
   ↓
Historical Data
   ↓
Analytics Engine
   ├── Reporting
   ├── Segmentation Analysis
   ├── Campaign Analysis
   └── Recommendations
   ↓
Excel Generator
   ↓
Weekly / Monthly Reports
```

Los módulos de producto se incorporarán bajo esta estructura, sin mezclar
responsabilidades:

```text
src/agency/
├── ingestion/
├── analytics/
├── reporting/
├── segmentation/
├── historical-data/
├── excel/
├── scheduler/
└── recommendations/
```

## Decisiones vigentes

- El producto inicial es **READ-ONLY** y producción debe arrancar sólo con
  `MCP_MODE=read_only`.
- No se solicita ni acepta `ads_management` para reporting.
- Las recomendaciones son texto/datos explicables; no son acciones sobre Meta.
- El token de Meta permanece exclusivamente en backend.
- Cada token y cada activo autorizado están vinculados a un tenant/workspace.
- El histórico agregado y la PII de leads no comparten la misma frontera.
- Los snapshots paid se seleccionan por nivel, breakdown, atribución, versión
  de API y esquema; nunca se mezclan datasets para aumentar cobertura.
- El alcance único de varias filas no se obtiene sumando personas. Alcance y
  frecuencia agregados permanecen N/D hasta incorporar totales únicos por período.
- Los ratios requieren cobertura completa de numerador y denominador en todas
  las filas seleccionadas; una cobertura parcial conserva totales con advertencia,
  no produce ratios ni recomendaciones de optimización sobre esa muestra.
- El consolidado orgánico usa la unión deduplicada de activos autorizados de las
  conexiones del batch. Sin resolver de conexiones, el consolidado es paid-only;
  nunca se amplía automáticamente al workspace completo.
- Las acciones de mensajes/leads tienen una política canónica versionada; no se
  suman aliases solapados ni conversiones de objetivos diferentes.
- Deploy y publicación son opt-in, separados de un push de código al repo privado.
- Las herramientas nuevas se deniegan en read-only hasta entrar expresamente en
  la allowlist revisada.
- No se conectarán cuentas reales hasta superar los gates de seguridad y
  staging definidos en `PRODUCT_ROADMAP.md`.
- Los agentes que trabajen en este repositorio no deben ejecutar `npm` ni
  `npx`; la migración del package manager upstream requiere un cambio separado.
- Ningún agente debe enviar cambios al upstream público; todos los pushes de
  producto se limitan al repositorio privado de trabajo.

## Alcance funcional inicial

- Gestión lógica de unas 20 conexiones Meta aisladas.
- Meta Ads: cuentas, campañas, conjuntos, anuncios, creatividades e insights.
- Facebook e Instagram: métricas orgánicas disponibles con permisos aprobados.
- Histórico incremental e idempotente.
- Comparaciones semanales, mensuales y contra periodo anterior.
- Exportación Excel con tablas, KPIs, tendencias y gráficos.
- Recomendaciones sobre rendimiento, presupuesto, creatividades, audiencias y
  segmentación, acompañadas de evidencia.

## Fuera de alcance inicial

- Crear, editar, pausar o eliminar campañas.
- Modificar presupuestos, pujas, segmentación o creatividades.
- Enviar mensajes o gestionar WhatsApp.
- Descargar PII cruda de leads dentro del pipeline general de reporting.
- Facturación automática al cliente.
- Conectar cuentas reales durante desarrollo o pruebas unitarias.

## Fuentes de verdad

- `SECURITY_AUDIT.md`: auditoría base y hallazgos por severidad.
- `docs/SECURITY_REQUIREMENTS.md`: controles obligatorios y gates.
- `docs/REPORTING_REQUIREMENTS.md`: alcance funcional y definiciones de datos.
- `docs/PRODUCT_ROADMAP.md`: orden de ejecución y criterios de salida.
- `docs/MVP_READINESS.md`: avances verificables y pendientes de esta integración.
- `docs/SECURITY_REMEDIATION_STATUS.md`: controles en código frente a gates operativos.
- El código y los tests prevalecen sobre documentación histórica si hay una
  discrepancia; la discrepancia debe corregirse en la misma rama.

## Cómo retomar el trabajo en otra sesión

1. Leer este documento y los otros tres documentos de contexto.
2. Leer `SECURITY_AUDIT.md` y `AGENTS.md` completos.
3. Comprobar rama y árbol de trabajo antes de editar.
4. Preservar cambios sin commit del usuario y no hacer merge automáticamente.
5. Confirmar que el cambio propuesto mantiene read-only, aislamiento y mínimo
   privilegio.
6. Ejecutar las validaciones relevantes sin usar `npm` ni `npx`.
7. Actualizar roadmap y documentación cuando cambie una decisión de producto.
