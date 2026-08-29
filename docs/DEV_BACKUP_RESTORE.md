# Backup y restore reproducible — DEV

1. Abrir `CoreStore` sobre una ruta bajo `Sistema-CF2/dev/` o un directorio temporal.
2. Ejecutar `backupTo(rutaBackup)`. El método usa `VACUUM INTO`, devuelve bytes y SHA-256.
3. Verificar que los bytes sean mayores que cero y registrar el hash del backup.
4. Para una restauración controlada, cerrar el store y ejecutar `restoreFrom(rutaBackup)` sobre una copia DEV limpia.
5. Comparar `state_version`, objetos relevantes y cantidad de audit antes y después.

La prueba `backup and restore preserve state and audit` ejecuta este procedimiento en un directorio temporal, conserva el backup durante la comprobación y elimina únicamente ese directorio temporal al finalizar. No toca CF 1.0, D:, G: ni Drive.
