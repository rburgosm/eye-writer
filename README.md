# EyeType · prototipo de escritura con la mirada

Página web (sin instalación) para medir si se puede escribir en español con la mirada usando solo la cámara frontal de un móvil Android con Chrome. No hay teclado QWERTY: se usan **gestos amplios** de mirada y **parpadeos largos**, y un diccionario adivina la palabra (como el antiguo T9).

| Gesto | Acción |
|---|---|
| ← izquierda | grupo **A B C D E** |
| ↑ arriba | grupo **F G H I J K L M N Ñ O** |
| → derecha | grupo **P Q R S T U V W X Y Z** |
| ↓ abajo | siguiente candidato |
| parpadeo largo (0,4–1,5 s) | aceptar palabra + espacio |
| ojos cerrados ≥ 1,5 s | borrar (último grupo o última palabra) |

Ejemplo: «hola» = ↑ ↑ ↑ ← y parpadeo largo. Las tildes y la ñ las resuelve el diccionario. Tras cada gesto hay que volver a mirar al centro.

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
2. **Activar cámara → Calibrar**. Apoya el móvil o sujétalo firme a 30–40 cm, con buena luz de frente. Una voz te pide mirar al centro, izquierda, derecha, arriba y abajo durante 2 s cada vez. Mira **fuera del móvil** (unos 30 cm hacia cada lado): cuanto más amplio sea el gesto, mejor. Recalibra si cambias de postura o de luz.
3. Ajustes: umbral (60 %), permanencia (500 ms), compensación del giro de cabeza. Si la calibración sale «mala», desactiva la compensación de cabeza y repite.
4. «Pausa» detiene la detección (para descansar con los ojos cerrados sin borrar).
5. El panel **Depuración** muestra la cámara, el punto de mirada estimado, la dirección detectada y los umbrales.

## Criterio de éxito

Practica en sesiones cortas (5–10 min) en modo «Copiar frase» **con la mirada**. Al terminar cada sesión pulsa «Terminar sesión»; el historial guarda PPM (= (caracteres/5)/minutos), errores, borrados y gestos por palabra, y suma los minutos con mirada. Usa «Copiar estadísticas» para anotarlas.

**Éxito: ≥ 10 palabras por minuto con tasa de error baja (< 5 %) tras ~1 hora de práctica acumulada.** Si no se llega, el proyecto no sigue.

Referencia: con estos grupos, las frases de prueba necesitan de media ~6,2 gestos por palabra (letras + ↓ + aceptar). Llegar a 10 ppm exige ~1 gesto por segundo.

## Limitaciones conocidas

- Solo está probado en un navegador de escritorio sin cara real: los umbrales con cámara de verdad están sin validar.
- La mirada vertical (sobre todo abajo) es la más débil; mirar abajo también entorna los párpados.
- Sensible a la luz, a las gafas con reflejos y a mover el móvil: recalibra a menudo.
- Solo escribe palabras del diccionario (15 000), en minúsculas y sin signos de puntuación.
- Consume batería; no hay modo en segundo plano.
- No es un producto sanitario.

## Fase 2 (no incluida)

- Un LLM que complete frases a partir de palabras clave o iniciales, al estilo de SpeakFaster (Google). Necesita una clave de API y un servidor.
- Un teclado (IME) o servicio de accesibilidad de Android para escribir en cualquier app.
- Pruebas con usuarios reales a través de asociaciones de ELA.
