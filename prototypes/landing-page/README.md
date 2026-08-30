# Landing page prototype

Prototipo estatico y sin dependencias para presentar Meta Agency Intelligence.
No se conecta a Meta, no procesa datos reales y no contiene credenciales.

## Vista local

Desde esta carpeta:

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

Luego abre `http://127.0.0.1:4173/`.

## Personalizacion

- Contenido y enlaces: `index.html`
- Colores, tipografia y responsive: `styles.css`
- Selector semanal/mensual de ejemplo: `script.js`

Antes de publicar, reemplaza `piloto@example.com` por el correo o formulario
real del piloto. Este prototipo se mantiene separado del backend y no debe
recibir tokens de Meta ni secretos de ningun tipo.
