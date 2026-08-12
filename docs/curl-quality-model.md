# Modelo de calidad de curl v1

`curl-quality-v1` es una compuerta híbrida de calidad para curl estricto. MediaPipe obtiene la pose; un clasificador entrenado con secuencias normalizadas evalúa la estabilidad, y reglas calibradas con los ejemplos válidos verifican recorrido, duración y visibilidad.

La app ya no incrementa el contador al llegar arriba. Espera a que el brazo vuelva a extensión, evalúa el ciclo completo y entonces produce uno de dos resultados:

- repetición válida: incrementa el contador y pronuncia el número;
- intento no contado: conserva el contador y da una corrección de recorrido, codo, torso, hombros, velocidad o encuadre.

## Dataset y evaluación

- 4 videos humanos comparables seleccionados de los clips etiquetados.
- 427 ventanas de pose: 393 correctas y 34 incorrectas.
- 21 intentos completos adicionales para calibrar el recorrido.
- Separación `GroupKFold(4)` por video completo; ningún cuadro del video evaluado entra al entrenamiento de ese fold.
- AUC: `0.8815`.
- Detección de ejemplos correctos: `87.02%`.
- Rechazo de ejemplos incorrectos: `79.41%`.
- Comprobación secundaria de ciclos completos: `82.35%` de aceptación de intentos etiquetados como correctos y `100%` de rechazo de los incorrectos disponibles.

El entrenamiento se niega a exportar un candidato si no supera los mínimos guardados en `evaluation.deployment_gate`.

## Entrenamiento reproducible

Desde la raíz del proyecto:

```powershell
.\.venv\Scripts\python.exe src\train_curl_quality.py
```

El manifiesto de intervalos es `training-videos/curl-training-segments/quality-labels.json`. Los videos ambiguos —dos personas en el mismo cuadro, saltos de cámara, animaciones, barra y curl martillo— quedan como referencia y no entran al clasificador de curl estricto.

Los MP4 no se publican ni forman parte de la app. El estado de derechos del material descargado sigue marcado como no verificado; debe confirmarse antes de redistribuir los videos o usarlos fuera de este entrenamiento privado. El modelo es una ayuda técnica y no sustituye la evaluación de un entrenador o profesional de salud.
