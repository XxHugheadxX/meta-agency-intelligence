# Requisitos de reporting y análisis

## Objetivo

Reducir el trabajo manual semanal de una agencia inmobiliaria mediante reportes
repetibles, trazables y comparables. El sistema debe explicar de dónde sale cada
métrica y distinguir datos observados, cálculos e inferencias.

## Cobertura inicial

- Aproximadamente 20 perfiles/cuentas, organizados por workspace.
- Meta Ads, páginas de Facebook y cuentas profesionales de Instagram.
- Periodicidad semanal y mensual.
- Histórico incremental para comparar tendencias y periodos anteriores.
- Exportación principal: workbook `.xlsx` autocontenido.

## Métricas requeridas

### Paid media

- Alcance e impresiones.
- Frecuencia.
- Clics y clics en enlace.
- Mensajes y conversaciones iniciadas, cuando Meta los exponga.
- Leads y conversiones agregadas.
- Gasto.
- CPC, CPM, CTR y CPL.
- Resultados y coste por resultado según objetivo.

### Facebook e Instagram orgánico

- Alcance e impresiones.
- Engagement e interacciones.
- Visitas al perfil.
- Guardados y compartidos.
- Crecimiento neto y porcentual de seguidores.

No todas las métricas están disponibles para todo tipo de cuenta, placement,
objetivo o versión de API. El reporte debe mostrar `N/D` y una razón de calidad,
no convertir datos ausentes en cero.

## Definiciones calculadas

- `CTR = clics relevantes / impresiones × 100`.
- `CPC = gasto / clics relevantes`.
- `CPM = gasto / impresiones × 1000`.
- `CPL = gasto / leads atribuidos`.
- `Frecuencia = impresiones / alcance`.
- `Crecimiento seguidores % = crecimiento neto / seguidores al inicio × 100`.

El tipo exacto de clic, lead, conversión y ventana de atribución debe guardarse
como dimensión. No mezclar métricas con definiciones distintas en una misma
serie.

## Periodos y tiempo

- Guardar timestamps en UTC.
- Configurar timezone de presentación por workspace.
- Semana y mes deben tener límites deterministas.
- Comparaciones mínimas: periodo anterior y mismo periodo disponible.
- Conservar fecha de extracción, versión de API, moneda, timezone, nivel de
  breakdown y ventana de atribución.

## Histórico y calidad

- Ingesta idempotente mediante claves compuestas por tenant, activo, fecha,
  nivel y dimensiones.
- Upserts no deben duplicar métricas.
- Registrar watermark y estado de cada ejecución.
- Permitir backfill por rango sin alterar otros tenants.
- Marcar datos tardíos, parciales, estimados o no disponibles.
- Conciliar gasto y resultados agregados contra el total de cuenta dentro de
  tolerancias definidas.
- Mantener lineage desde cada celda/KPI hasta la consulta y snapshot fuente.

## Workbook Excel

Cada entrega semanal o mensual debe incluir como mínimo:

1. **Resumen ejecutivo:** KPIs, variación, alertas y recomendaciones prioritarias.
2. **Tendencias:** series temporales de gasto, alcance, impresiones, clics,
   leads y eficiencia.
3. **Campañas:** comparación por campaña y objetivo.
4. **Conjuntos y anuncios:** rendimiento, fatiga y creatividades.
5. **Audiencias/segmentación:** breakdowns permitidos y comparaciones.
6. **Facebook/Instagram:** métricas orgánicas disponibles.
7. **Calidad de datos:** cobertura, datos faltantes, moneda, timezone y ventana
   de atribución.
8. **Datos fuente:** tablas normalizadas que alimentan fórmulas y gráficos.

Requisitos del archivo:

- Tablas filtrables, encabezados congelados y formatos numéricos consistentes.
- Fórmulas auditables; evitar valores calculados opacos cuando una fórmula sea
  viable.
- Gráficos legibles al abrir el archivo sin conexiones externas.
- Moneda y porcentajes correctamente formateados.
- Ningún token, secreto o PII cruda de leads.
- Nombre determinista con workspace, periodo y versión del reporte.

## Análisis de campañas

- Comparar rendimiento por objetivo, campaña, conjunto, anuncio y creatividad.
- Detectar cambios fuertes de gasto, CTR, CPC, CPM, CPL y conversiones.
- Identificar fatiga mediante frecuencia, caída de CTR y evolución temporal.
- Separar bajo volumen de bajo rendimiento; no recomendar con muestra
  insuficiente.
- Mostrar evidencia y periodo usados en cada conclusión.

## Audiencias y segmentación

- Analizar edad, género, geografía, placement, dispositivo y otras dimensiones
  sólo cuando Meta permita el breakdown y el volumen sea suficiente.
- Evitar inferencias sobre atributos sensibles o individuos.
- Detectar concentración excesiva, solapamiento aproximado y segmentos con
  costes/rendimiento atípicos.
- Etiquetar limitaciones causadas por agregación, privacidad o cambios de API.

## Recomendaciones

Cada recomendación debe contener:

- Hallazgo observado.
- Métricas y periodo que lo sustentan.
- Hipótesis, claramente separada del hecho.
- Acción sugerida para revisión humana.
- Impacto esperado y nivel de confianza.
- Riesgo o condición que podría invalidarla.

Las recomendaciones no ejecutan cambios, no generan llamadas mutantes y no
requieren `ads_management`.

## Criterios de aceptación del MVP

- Un workspace de prueba puede completar backfill y actualización incremental.
- Reportes semanal y mensual se regeneran con resultados deterministas.
- Los KPIs calculados coinciden con fixtures conocidos.
- Un tenant no puede consultar ni exportar datos de otro.
- La ausencia de métricas se representa de forma explícita.
- El workbook abre sin errores y sus fórmulas/gráficos pasan revisión visual.
- Las recomendaciones citan evidencia y nunca se presentan como cambios ya
  aplicados.

