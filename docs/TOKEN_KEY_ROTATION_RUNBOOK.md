# Rotación de la clave de tokens

Este procedimiento conserva AES-256-GCM, la AAD ligada al documento y una
ventana dual-read/single-write. No autoriza copiar tokens a archivos locales ni
registrarlos en logs.

## Precondiciones

- Trabajar primero con documentos y claves ficticios en un entorno aislado.
- Inventariar el número de documentos por tenant/workspace sin leer plaintext.
- Crear un backup cifrado, con acceso restringido, retención corta y prueba de
  restore. El backup debe conservar `ciphertext`, `iv`, `tag` y `keyVersion`.
- Mantener la clave anterior disponible en Secret Manager durante toda la
  migración y el periodo de rollback.

## Rotación resumible

1. Generar una nueva clave aleatoria de 32 bytes fuera del repositorio.
2. Configurar la nueva clave como `TOKEN_ENCRYPTION_KEY`, incrementar
   `TOKEN_ENCRYPTION_KEY_VERSION` y añadir la versión anterior a
   `TOKEN_ENCRYPTION_OLD_KEYS`.
3. Ejecutar primero un dry-run que valide descifrado, AAD, versión y conteos sin
   escribir ni mostrar plaintext.
4. Por cada documento, volver a leerlo dentro de una transacción, llamar a
   `reencryptToken(payload, aad)` y escribir sólo si la versión observada no
   cambió. Registrar únicamente IDs hasheados, versión y resultado.
5. Repetir hasta que el inventario confirme que todos los documentos usan la
   versión nueva. Los reintentos deben omitir documentos ya migrados.
6. Verificar lecturas normales y un restore del backup cifrado con datos
   ficticios. Mantener la clave anterior durante el periodo de rollback.
7. Retirar la clave anterior sólo cuando no queden ciphertexts antiguos,
   backups que la requieran ni instancias ejecutando la versión previa.

## Rollback y respuesta a fallos

- Si aumenta el número de errores de autenticación GCM, detener escrituras y
  conservar ambas claves. No reintentar con otra AAD ni omitir el binding.
- Restaurar el documento cifrado desde el backup y re-cifrarlo con la clave
  activa mientras la versión anterior siga en `TOKEN_ENCRYPTION_OLD_KEYS`.
- Si una clave pudo filtrarse, rotar también los tokens Meta; re-cifrar datos no
  revoca una credencial comprometida.

La suite `tests/auth/crypto.test.ts` ensaya con claves y documentos ficticios la
rotación a una versión nueva, el retiro de la clave anterior, el restore durante
la ventana dual-read y el rechazo de una AAD de otro workspace.
