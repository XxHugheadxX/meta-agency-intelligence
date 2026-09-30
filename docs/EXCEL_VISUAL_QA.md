# QA visual del Excel sintético

Este procedimiento genera un workbook completo con datos ficticios de dos
cuentas, Ads, orgánico de cuenta y contenido. No usa red, tokens ni activos de
Meta. El archivo se escribe fuera del repositorio para evitar commits binarios.

## Generación

Desde la raíz del repositorio, sin npm:

```powershell
.\node_modules\.bin\tsc.cmd

node scripts\generate-synthetic-agency-report.mjs `
  "C:\ruta\fuera\del\repo\meta-agency-synthetic-visual-qa.xlsx"
```

## Checklist manual

Revisar las diez hojas:

1. Resumen Ejecutivo.
2. Dashboard Visual.
3. Rendimiento Semanal.
4. Rendimiento Mensual.
5. Campañas.
6. Ad Sets.
7. Ads.
8. Contenido.
9. Métricas Digitales.
10. Raw Data.

Confirmar:

- El archivo abre sin reparación ni advertencias.
- Los encabezados tienen contraste blanco sobre azul.
- Las tablas operativas permiten filtrar.
- Las filas y columnas identificadoras permanecen congeladas al desplazarse.
- No hay textos importantes recortados.
- Los diez gráficos tienen títulos, categorías y valores visibles.
- CTR indica porcentaje e inversión, CPC y CPL indican moneda.
- No aparecen `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?` ni `#N/A`.
- Ads, orgánico de cuenta y contenido permanecen separados.
- Raw Data no contiene tokens, secretos ni identificadores tenant reales.

La inspección renderizada automatizada complementa, pero no sustituye, la
apertura final en Microsoft Excel de escritorio.

## Revisión requerida tras la integración de calidad y recomendaciones

La revisión renderizada anterior es un baseline, no aprueba automáticamente
los cambios de `codex/mvp-data-readiness`. Regenerar el archivo y verificar:

- Resumen Ejecutivo: limitaciones, recomendaciones y evidencia legibles.
- Alcance/frecuencia no agregables: N/D (guion visual), no cero ni suma de filas.
- Fórmulas que referencian N/D: cache de texto, sin cero fabricado.
- Funnel: título orientativo; no promete usuarios únicos ni atribución entre etapas.
- Recomendaciones: período y caveats presentes; no afirman acciones aplicadas.
