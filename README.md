# EyeType · prototipo de escritura con la mirada

Página web (sin instalación) para medir si se puede escribir en español con la mirada usando solo la cámara frontal de un móvil Android con Chrome. No hay teclado QWERTY: se usan **movimientos cortos** de mirada (hacia el borde de la pantalla) y **parpadeos largos**, y un diccionario adivina la palabra (como el antiguo T9).

| Gesto | Acción |
|---|---|
| ← izquierda | grupo **A B C D E** |
| ↑ arriba | grupo **F G H I J K L M N Ñ O** |
| → derecha | grupo **P Q R S T U V W X Y Z** |
| ↓ abajo | siguiente candidato |
| parpadeo largo (0,4–1,5 s) | aceptar palabra + espacio |
| ojos cerrados ≥ 1,5 s | borrar (último grupo o última palabra) |

Ejemplo: «hola» = ↑ ↑ ↑ ← y parpadeo largo. Las tildes y la ñ las resuelve el diccionario. Tras cada gesto hay que volver a mirar al centro.

**Zoom a los ojos.** La cámara se abre a 1280×720 y, en cuanto localiza la cara, recorta un cuadrado centrado en los ojos y lo amplía (≈×1,5–2) antes de pasarlo a MediaPipe, así el iris tiene más píxeles. Si pierde la cara vuelve al fotograma entero. Se puede desactivar en Ajustes.

**Posturas.** Sentado, tumbado boca arriba o de lado, la cámara ve la cara desde ángulos muy distintos. Por eso se guarda **una calibración por postura** (selector «Postura»). Cada calibración recuerda cómo veía la cámara la cara (inclinación, giro, cabeceo, distancia y orientación de la pantalla) y, si cambias de postura, la app pasa sola a la calibración más parecida (con un doble pitido); si ninguna se parece, el indicador dice «Postura distinta: recalibra». El giro de la cabeza y los ojos se miden en los ejes de la propia cara, así que tumbado de lado (cara girada 90°) funciona igual. El modelo de calibración es 2D completo: si la cabeza está de lado y el móvil derecho, aprende que «izquierda de la pantalla» es un movimiento vertical del ojo.

Ficheros: `index.html` (toda la app), `palabras.js` (15 000 palabras ordenadas por frecuencia, de *wordfreq* 3.1.1, CC BY-SA 4.0) y `sw.js` (caché para usarla sin red una vez cargada).

## Cómo probarlo desde el móvil, sin ordenador

La cámara solo funciona en páginas **https://**. Con GitHub Pages:

1. En el móvil, descomprime el zip (app «Archivos» de Android).
2. Entra en github.com (en Chrome, activa «Sitio de escritorio» si algún menú no aparece) → **+** → **New repository** → nombre p. ej. `eyetype`, **Public** → *Create*.
3. En el repositorio: **Add file → Upload files** → elige `index.html`, `palabras.js`, `sw.js` y `README.md` → *Commit changes*.
4. **Settings → Pages** → *Source*: «Deploy from a branch», rama `main`, carpeta `/ (root)` → *Save*.
5. Espera 1–2 minutos y abre `https://TU-USUARIO.github.io/eyetype/`. Acepta el permiso de cámara.

Alternativa: cualquier hosting estático con HTTPS (Netlify Drop, Cloudflare Pages, etc.): basta con subir la carpeta.

La primera vez necesita red para descargar MediaPipe (cdn.jsdelivr.net, ~10 MB); después funciona sin red.

## Calibrar y practicar

1. **Aprende el método sin cámara**: usa los botones o, con teclado, las flechas, Intro (aceptar) y Retroceso (borrar). Prueba «Copiar frase»: la pista muestra los gestos de cada palabra.
2. **Activar cámara → Calibrar**. Ponte en la postura real y elígela en el selector. Comprueba que se ven tus ojos ampliados con el iris marcado y la distancia estimada (lo ideal: 25–50 cm). Después un punto recorre 18 posiciones conocidas de la pantalla (centro, bordes, esquinas, puntos intermedios, bordes otra vez y centro): fija la vista en su puntito central **solo con los ojos**.

   **Calibración geométrica.** Cada punto se pasa a centímetros (1 px CSS ≈ 1/160 pulgada en Android) y se calcula el ángulo real desde tu ojo hasta él: la distancia sale del tamaño del iris (≈ 11,7 mm en casi todas las personas) y la posición del ojo, de dónde aparece la cara en la imagen respecto a la cámara (encima de la pantalla en vertical). El modelo aprende iris + cabeza + párpados → ángulo de mirada, y en uso se calcula el punto como ojo + ángulo × distancia. Así, si acercas o alejas el móvil o mueves la cabeza, el punto sigue en su sitio. Con una cara simulada el error se mantuvo en 2–3 % de la pantalla a 25, 35 y 45 cm y con la cabeza desplazada 3 cm; sin la parte geométrica subía a 18–29 % al cambiar la distancia y a más del 100 % al mover la cabeza. Al terminar muestra el ángulo que abarca la pantalla, el error en grados, el temblor y la deriva, propone un umbral y deja probarlo con un círculo que sigue la mirada.
3. Ajustes: umbral (75 % del camino al borde), permanencia (500 ms), suavizado (60 %), corrección lenta de deriva, zoom a los ojos y compensación del giro de cabeza (se aplica al recalibrar).
4. «Pausa» detiene la detección (para descansar con los ojos cerrados sin borrar).
5. El panel **Depuración** muestra la cámara, el punto de mirada estimado, la dirección detectada y los umbrales.

## Criterio de éxito

Practica en sesiones cortas (5–10 min) en modo «Copiar frase» **con la mirada**. Al terminar cada sesión pulsa «Terminar sesión»; el historial guarda PPM (= (caracteres/5)/minutos), errores, borrados y gestos por palabra, y suma los minutos con mirada. Usa «Copiar estadísticas» para anotarlas.

**Éxito: ≥ 10 palabras por minuto con tasa de error baja (< 5 %) tras ~1 hora de práctica acumulada.** Si no se llega, el proyecto no sigue.

Referencia: con estos grupos, las frases de prueba necesitan de media ~6,2 gestos por palabra (letras + ↓ + aceptar). Llegar a 10 ppm exige ~1 gesto por segundo.

## Limitaciones conocidas

- La mirada vertical (sobre todo abajo) es la más débil; por eso el modelo usa también la apertura de los párpados.
- Con movimientos cortos, mirar el texto de arriba de la pantalla puede acercarse al umbral de «arriba»: la permanencia (500 ms) y el umbral lo evitan; súbelos si hay gestos falsos.
- Solo se ha probado con una cara simulada; el zoom y la calibración fina están sin validar con una cámara real.
- La geometría supone un campo de visión de cámara de ~80° en diagonal y 160 px CSS por pulgada; si un móvil se aleja mucho de eso, la compensación de distancia y de cabeza pierde precisión (la calibración en sí sigue funcionando).
- Los ángulos del ojo se miden respecto a la línea cámara-ojo y no a la perpendicular de la pantalla: con desplazamientos laterales grandes de la cabeza queda un error residual. Recalibrar lo elimina.
- Sensible a la luz, a las gafas con reflejos y a mover el móvil: recalibra a menudo.
- Solo escribe palabras del diccionario (15 000), en minúsculas y sin signos de puntuación.
- Consume batería; no hay modo en segundo plano.
- No es un producto sanitario.

## Fase 2 (no incluida)

- Un LLM que complete frases a partir de palabras clave o iniciales, al estilo de SpeakFaster (Google). Necesita una clave de API y un servidor.
- Un teclado (IME) o servicio de accesibilidad de Android para escribir en cualquier app.
- Pruebas con usuarios reales a través de asociaciones de ELA.
