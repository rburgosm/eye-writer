/* recorrido.js — decodificador de "escritura por recorrido de mirada" (gaze swipe) en español.
 *
 * El teclado se divide en pocas ZONAS grandes, cada una con un grupo de letras
 * contiguas en orden alfabético. El usuario recorre con la mirada las zonas de las
 * letras de la palabra y termina con un parpadeo largo. El diccionario resuelve la
 * ambigüedad (como T9); tildes y ñ se resuelven por diccionario (ñ va con n).
 *
 * Coordenadas: x,y en [-1,1] relativas al área del teclado; x hacia la derecha,
 * y hacia ABAJO. Cualquier punto fuera se acepta (se usa la zona más cercana).
 *
 * Método por defecto ('hmm'): alineamiento tipo HMM izquierda-derecha / DTW entre la
 * secuencia de muestras y la plantilla de la palabra (centros de zona), con
 *   - estados de FIJACIÓN por letra (coste gaussiano a centro de zona, con tope para
 *     outliers y una permanencia mínima de 2 muestras/intervalos),
 *   - estados de TRÁNSITO entre letras (coste = distancia al segmento + penalización,
 *     absorbe muestras de sacada que cruzan zonas intermedias),
 *   - "basura" al principio y al final (miradas previas al inicio, cola del parpadeo),
 * más un prior de frecuencia  lambda*ln(rango+1).  La búsqueda recorre un trie de
 * secuencias de zonas (las palabras con prefijo común comparten cálculo) con poda
 * branch-and-bound, así que decodificar es rápido aun con 15k palabras.
 *
 * Método alternativo ('forma'): distancia entre polilíneas remuestreadas (estilo
 * SHARK2). Se conserva para comparar en los tests; es peor (ver test/recorrido.test.js).
 */
(function (root) {
  'use strict';

  var ALFABETO = 'abcdefghijklmnñopqrstuvwxyz';

  function sinTildes(w) {
    return w.toLowerCase().replace(/ñ/g, '\u0001').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/\u0001/g, 'ñ');
  }

  // Distribuciones de letras probadas (ver test). La elegida es DISPOSICION_DEFECTO.
  var DISPOSICIONES = {
    '2x3': { filas: 2, columnas: 3, grupos: ['abc', 'def', 'ghijkl', 'mnño', 'pqrs', 'tuvwxyz'] },
    '2x4': { filas: 2, columnas: 4, grupos: ['a', 'bcd', 'efgh', 'ijkl', 'mnñ', 'op', 'qrs', 'tuvwxyz'] },
    '3x3': { filas: 3, columnas: 3, grupos: ['a', 'bcd', 'efgh', 'ijkl', 'mnñ', 'op', 'qrs', 't', 'uvwxyz'] },
    '2x5': { filas: 2, columnas: 5, grupos: ['a', 'bcd', 'efgh', 'ijkl', 'mnñ', 'op', 'qr', 's', 't', 'uvwxyz'] },
    '3x4': { filas: 3, columnas: 4, grupos: ['a', 'bcd', 'efg', 'hij', 'kl', 'm', 'nñ', 'op', 'qr', 's', 't', 'uvwxyz'] },
    '3x5': { filas: 3, columnas: 5, grupos: ['a', 'bc', 'd', 'e', 'f', 'gh', 'i', 'jk', 'l', 'mnñ', 'op', 'qr', 's', 't', 'uvwxyz'] },
    '4x4': { filas: 4, columnas: 4, grupos: ['a', 'b', 'c', 'd', 'ef', 'gh', 'ij', 'kl', 'm', 'nñ', 'o', 'p', 'qr', 's', 'tu', 'vwxyz'] }
  };
  var DISPOSICION_DEFECTO = '3x4';

  function zonasDeDisposicion(d) {
    var z = [];
    for (var i = 0; i < d.grupos.length; i++) {
      var f = Math.floor(i / d.columnas), c = i % d.columnas;
      z.push({
        letras: d.grupos[i],
        x: -1 + (2 * c + 1) / d.columnas,
        y: -1 + (2 * f + 1) / d.filas,
        fila: f, columna: c, ancho: 2 / d.columnas, alto: 2 / d.filas
      });
    }
    return z;
  }

  function resolverZonas(opc) {
    var z = opc && opc.zonas;
    if (!z) z = DISPOSICION_DEFECTO;
    if (typeof z === 'string') {
      if (!DISPOSICIONES[z]) throw new Error('Disposición desconocida: ' + z);
      return zonasDeDisposicion(DISPOSICIONES[z]);
    }
    if (z.grupos) return zonasDeDisposicion(z);
    return z.map(function (q) { return { letras: q.letras, x: q.x, y: q.y }; });
  }

  function crear(palabras, opciones) {
    var opc = opciones || {};
    var zonas = resolverZonas(opc);
    var Z = zonas.length;
    var zonaLetra = {};
    zonas.forEach(function (q, i) { for (var k = 0; k < q.letras.length; k++) zonaLetra[q.letras[k]] = i; });
    for (var a = 0; a < ALFABETO.length; a++) {
      if (zonaLetra[ALFABETO[a]] === undefined) throw new Error('Letra sin zona: ' + ALFABETO[a]);
    }
    var ZX = new Float64Array(Z), ZY = new Float64Array(Z);
    for (var i = 0; i < Z; i++) { ZX[i] = zonas[i].x; ZY[i] = zonas[i].y; }

    // Parámetros (ajustados por simulación, ver test/recorrido.test.js).
    var P = {
      s: opc.s || 0.22,           // escala de dispersión (ruido + posición dentro de zona)
      tope: opc.tope || 4.5,      // coste máximo por muestra (outliers)
      basura: opc.basura || 2.2,  // coste por muestra antes del inicio / tras el final
      penTransito: opc.penTransito != null ? opc.penTransito : 1.5,
      lambda: opc.lambda != null ? opc.lambda : 1.25, // peso del prior de frecuencia
      haz: opc.haz || 8,
      bin: opc.bin != null ? opc.bin : 70, // ms por intervalo (0 = sin agrupar)
      metodo: opc.metodo || 'hmm'
    };

    // --- Diccionario -> trie de secuencias de zonas ---
    function claveDe(norm) {
      var seq = [], prev = -1;
      for (var k = 0; k < norm.length; k++) {
        var zz = zonaLetra[norm[k]];
        if (zz === undefined) return null;
        if (zz !== prev) seq.push(zz);
        prev = zz;
      }
      return seq;
    }

    // Nodo: { hijos: {zona: nodo}, zona, palabras: [{w, r}], mejorR }
    var raiz = { hijos: {}, zona: -1, palabras: null, mejorR: Infinity, lista: null };
    var clases = []; // para el método 'forma': {seq, palabras}
    var vistas = Object.create(null);
    var rango = 0;
    for (var p = 0; p < palabras.length; p++) {
      var w = palabras[p];
      if (typeof w !== 'string' || !w) continue;
      var norm = sinTildes(w);
      if (!/^[a-zñ]+$/.test(norm)) continue;
      var lw = w.toLowerCase();
      if (vistas[lw]) continue;
      vistas[lw] = 1;
      var seq = claveDe(norm);
      var r = rango++;
      var nodo = raiz;
      if (r < nodo.mejorR) nodo.mejorR = r;
      for (var k = 0; k < seq.length; k++) {
        var h = nodo.hijos[seq[k]];
        if (!h) { h = nodo.hijos[seq[k]] = { hijos: {}, zona: seq[k], palabras: null, mejorR: Infinity, lista: null }; }
        if (r < h.mejorR) h.mejorR = r;
        nodo = h;
      }
      if (!nodo.palabras) { nodo.palabras = []; clases.push({ seq: seq, nodo: nodo }); }
      nodo.palabras.push({ w: lw, r: r });
    }
    // Hijos como arrays (iteración rápida)
    (function compactar(n) {
      n.lista = [];
      // mascara: zonas que puede visitar cualquier palabra del subárbol desde este nodo
      // (la propia y las siguientes); sirve para acotar el coste de lo que falta.
      n.mascara = n.zona >= 0 ? (1 << n.zona) : 0;
      for (var key in n.hijos) {
        var h = n.hijos[key];
        n.lista.push(h); compactar(h); n.mascara |= h.mascara;
      }
      n.hijos = null;
      n.pr = Math.log(n.mejorR + 1);
      if (n.palabras) n.palabras.forEach(function (e) { e.pr = Math.log(e.r + 1); });
    })(raiz);
    var profMax = 0;
    clases.forEach(function (c) { if (c.seq.length > profMax) profMax = c.seq.length; });

    var estadisticas = { nodos: 0, muestras: 0 };
    function priorDe(r) { return P.lambda * Math.log(r + 1); }

    function zonaDe(x, y) {
      var best = 0, bd = Infinity;
      for (var i = 0; i < Z; i++) {
        var dx = x - ZX[i], dy = y - ZY[i], d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }

    function plantilla(palabra) {
      var seq = claveDe(sinTildes(palabra));
      if (!seq) return [];
      return seq.map(function (zz) { return { x: ZX[zz], y: ZY[zz] }; });
    }

    // --- Preprocesado de puntos ---
    // Agrupa las muestras en intervalos de P.bin ms (media; mediana si hay >= 3) para
    // que el decodificador no dependa de la frecuencia de muestreo y vaya más rápido.
    // Sin marcas de tiempo válidas se asume ~25 Hz.
    function prepararPuntos(puntos) {
      var xs = [], ys = [], ts = [], conT = true;
      for (var i = 0; i < puntos.length; i++) {
        var q = puntos[i];
        if (!q || !isFinite(q.x) || !isFinite(q.y)) continue;
        xs.push(+q.x); ys.push(+q.y);
        if (!isFinite(q.t)) conT = false;
        ts.push(+q.t);
      }
      var n = xs.length;
      if (!conT) for (i = 0; i < n; i++) ts[i] = i * 40;
      var bin = P.bin, ox = [], oy = [];
      if (!(bin > 0)) return { x: xs, y: ys, n: n };
      var t0 = ts[0], j = 0;
      while (j < n) {
        var k = Math.floor((ts[j] - t0) / bin), e = j;
        while (e < n && Math.floor((ts[e] - t0) / bin) === k) e++;
        if (e === j) e = j + 1; // marcas no monótonas: avanzar igualmente
        var c = e - j;
        if (c >= 3) {
          var bx = xs.slice(j, e).sort(num), by = ys.slice(j, e).sort(num);
          ox.push(c & 1 ? bx[c >> 1] : (bx[c / 2 - 1] + bx[c / 2]) / 2);
          oy.push(c & 1 ? by[c >> 1] : (by[c / 2 - 1] + by[c / 2]) / 2);
        } else {
          var sx = 0, sy = 0;
          for (i = j; i < e; i++) { sx += xs[i]; sy += ys[i]; }
          ox.push(sx / c); oy.push(sy / c);
        }
        j = e;
      }
      return { x: ox, y: oy, n: ox.length };
    }
    function num(a, b) { return a - b; }

    // --- Método HMM / DTW sobre trie ---
    // Estado de la decodificación en curso (variables del cierre de crear() para que
    // las funciones calientes se compilen una vez y no se recreen en cada llamada).
    var INF = Infinity;
    var N = 0, cap = 0, cF = [], cT = [], buf = [], pre = null;
    var res = [], umbral = INF, nRes = 5, llamadas = 0;
    var inv = 0, tope = 0, g = 0, pen = 0, lambda = 0, haz = 0;

    function reservar(n) {
      if (n <= cap) return;
      cap = Math.max(n, 2 * cap, 64);
      cF = []; for (var z = 0; z < Z; z++) cF.push(new Float64Array(cap));
      buf = [];
      for (var d = 0; d <= profMax; d++) {
        var nivel = [];
        for (var k = 0; k < Z; k++) nivel.push({ L: new Float64Array(cap), lo: 0, hi: 0, fin: 0, cota: 0, nodo: null });
        buf.push(nivel);
      }
      pre = new Float64Array(cap);
    }

    function costeTransito(z1, z2) {
      var idx = z1 * Z + z2;
      if (cT[idx]) return cT[idx];
      var X = ptsX, Y = ptsY, a = new Float64Array(N);
      var ax = ZX[z1], ay = ZY[z1], bx = ZX[z2] - ax, by = ZY[z2] - ay, L = bx * bx + by * by;
      for (var t = 0; t < N; t++) {
        var px = X[t] - ax, py = Y[t] - ay, u = (px * bx + py * by) / L;
        if (u < 0) u = 0; else if (u > 1) u = 1;
        var dx = px - u * bx, dy = py - u * by;
        var c = (dx * dx + dy * dy) * inv;
        a[t] = (c < tope ? c : tope) + pen;
      }
      cT[idx] = a;
      return a;
    }
    // Cota inferior del coste por muestra usando sólo las zonas de la máscara (o un
    // tránsito / basura), acumulada como suma de sufijo: permite podar celdas cuyo coste
    // más lo que falta ya supera el umbral. Se guardan en un único bloque reutilizable.
    var sufIdx = new Int32Array(1 << Z), sufPool = new Float64Array(0), sufUsados = 0, sufVista = null;
    var lbTmp = new Float64Array(0);
    function sufDe(mascara) {
      var off = sufIdx[mascara];
      if (off > 0) return off - 1;
      var W = N + 1;
      if ((sufUsados + 1) * W > sufPool.length) {
        var nuevo = new Float64Array(Math.max(2 * sufPool.length, 64 * W));
        nuevo.set(sufPool);
        sufPool = nuevo;
      }
      off = sufUsados * W; sufUsados++;
      var base = g < pen ? g : pen, t, z;
      for (t = 0; t < N; t++) lbTmp[t] = base;
      for (z = 0; z < Z; z++) {
        if (!((mascara >> z) & 1)) continue;
        var c = cF[z];
        for (t = 0; t < N; t++) if (c[t] < lbTmp[t]) lbTmp[t] = c[t];
      }
      sufPool[off + N] = 0;
      for (t = N - 1; t >= 0; t--) sufPool[off + t] = sufPool[off + t + 1] + lbTmp[t];
      sufIdx[mascara] = off + 1;
      return off;
    }

    function insertar(w, c) {
      for (var j = 0; j < res.length; j++) if (res[j].w === w) return;
      var i = res.length;
      res.push(null);
      while (i > 0 && res[i - 1].c > c) { res[i] = res[i - 1]; i--; }
      res[i] = { w: w, c: c };
      if (res.length > nRes) res.length = nRes;
      // Umbral de poda: el n-ésimo mejor, y nunca más de 'haz' por encima del mejor
      // (lo que queda más lejos no tiene opciones reales de ser la palabra).
      umbral = res[0].c + haz;
      if (res.length >= nRes && res[res.length - 1].c < umbral) umbral = res[res.length - 1].c;
    }

    // Columnas DP de un nodo del trie (nivel d) a partir del estado final de su padre.
    // Estados por letra: T (tránsito desde la letra anterior), A (primera muestra de la
    // fijación), L (fijación con >= 2 muestras = final de la letra). Sólo L se guarda
    // (es lo que leen los hijos); T y A se arrastran como escalares.
    // Devuelve la cota inferior (sin prior) de cualquier palabra del subárbol.
    function calcular(nodo, b, finPrev, loPrev, hiPrev, zPrev, lim) {
      llamadas++;
      var cf = cF[nodo.zona], so = sufDe(nodo.mascara) + 1, suf = sufPool, L = b.L;
      var tPrev = INF, aPrev = INF, lPrev = INF, m = INF, primero = -1, ultimo = -1, fin = INF;
      var raizP = zPrev < 0;
      var ct = raizP ? cf : costeTransito(zPrev, nodo.zona);
      var lo = raizP ? 0 : loPrev + 1;
      if (lo >= N) return INF;
      for (var t = lo; t < N; t++) {
        var c = cf[t], s1 = suf[so + t], mn, v;
        // L: seguir en la fijación (o segunda muestra tras A)
        var nl = c + (lPrev < aPrev ? lPrev : aPrev);
        // entrada a la letra: desde basura inicial (raíz) o desde la letra anterior
        if (raizP) {
          mn = t > 0 ? pre[t - 1] : 0;
        } else {
          if (t - 1 <= hiPrev) mn = finPrev[t - 1];
          else if (tPrev === INF && aPrev === INF && lPrev === INF) break; // nada vivo
          else mn = INF;
          if (tPrev < mn) mn = tPrev;
          v = ct[t] + mn;
          tPrev = v + s1 < lim ? v : INF;
        }
        v = c + mn;
        aPrev = v + s1 < lim ? v : INF;
        if (nl + s1 < lim) {
          lPrev = nl;
          if (primero < 0) primero = t;
          ultimo = t;
          if (nl + s1 < m) m = nl + s1;
          v = nl + g * (N - 1 - t); // terminar aquí: el resto es cola de basura
          if (v < fin) fin = v;
        } else lPrev = INF;
        L[t] = lPrev;
      }
      b.lo = primero; b.hi = ultimo; b.fin = fin;
      return m;
    }

    // Expande los hijos de un nodo: calcula todas sus columnas (nivel d) y los recorre
    // de mejor a peor cota (+ prior), para encontrar pronto buenas palabras y podar más.
    var orden = [];
    function expandir(nodo, d, finPrev, loPrev, hiPrev) {
      var hijos = nodo.lista, nivel = buf[d], cnt = 0, k, j;
      for (k = 0; k < hijos.length; k++) {
        var h = hijos[k], pr = lambda * h.pr;
        if (pr >= umbral) break; // hijos ordenados por mejor rango
        var b = nivel[cnt];
        var m = calcular(h, b, finPrev, loPrev, hiPrev, nodo.zona, umbral - pr);
        if (m + pr >= umbral) continue;
        b.cota = m + pr; b.nodo = h; cnt++;
      }
      if (!cnt) return;
      // ordenar por inserción (cnt <= Z); 'orden' guarda índices por nivel
      var base = d * Z;
      for (k = 0; k < cnt; k++) {
        j = k;
        while (j > 0 && nivel[orden[base + j - 1]].cota > nivel[k].cota) { orden[base + j] = orden[base + j - 1]; j--; }
        orden[base + j] = k;
      }
      for (k = 0; k < cnt; k++) {
        var bb = nivel[orden[base + k]];
        if (bb.cota >= umbral) break;
        visitar(bb, d);
      }
    }

    function visitar(b, d) {
      var nodo = b.nodo;
      if (nodo.palabras) {
        var fin = b.fin, ps = nodo.palabras;
        for (var i = 0; i < ps.length && i < nRes; i++) {
          var c = fin + lambda * ps[i].pr;
          if (c >= umbral) break;
          insertar(ps[i].w, c);
        }
      }
      if (d < profMax && nodo.lista.length) expandir(nodo, d + 1, b.L, b.lo, b.hi);
    }

    var ptsX = null, ptsY = null;
    function decodificarHMM(pts, n) {
      N = pts.n; ptsX = pts.x; ptsY = pts.y; nRes = n;
      inv = 1 / (2 * P.s * P.s); tope = P.tope; g = P.basura; pen = P.penTransito;
      lambda = P.lambda; haz = P.haz;
      reservar(N);
      var X = ptsX, Y = ptsY, t, z;
      for (z = 0; z < Z; z++) {
        var a = cF[z];
        for (t = 0; t < N; t++) {
          var dx = X[t] - ZX[z], dy = Y[t] - ZY[z];
          var c = (dx * dx + dy * dy) * inv;
          a[t] = c < tope ? c : tope;
        }
      }
      cT = new Array(Z * Z);
      sufIdx.fill(0); sufUsados = 0;
      if (lbTmp.length < N) lbTmp = new Float64Array(cap);
      for (t = 0; t < N; t++) pre[t] = g * (t + 1);
      res = []; umbral = INF; llamadas = 0;

      expandir(raiz, 1, pre, 0, N - 1);
      estadisticas.nodos = llamadas;
      estadisticas.mascaras = sufUsados;
      estadisticas.muestras = N;
      return res;
    }

    // Ordenar hijos por mejor rango (heurística para la poda)
    (function ordenar(n) {
      n.lista.sort(function (a, b) { return a.mejorR - b.mejorR; });
      n.lista.forEach(ordenar);
    })(raiz);

    // --- Método alternativo: forma (polilínea remuestreada) ---
    var M = 24, formas = null;
    function remuestrear(xs, ys, m) {
      var n = xs.length, ox = new Float64Array(m), oy = new Float64Array(m);
      if (n === 1) { for (var i = 0; i < m; i++) { ox[i] = xs[0]; oy[i] = ys[0]; } return [ox, oy]; }
      var acc = [0];
      for (i = 1; i < n; i++) acc.push(acc[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
      var L = acc[n - 1], j = 0;
      for (i = 0; i < m; i++) {
        var s = L === 0 ? 0 : L * i / (m - 1);
        while (j < n - 2 && acc[j + 1] < s) j++;
        var seg = acc[j + 1] - acc[j], u = seg > 0 ? (s - acc[j]) / seg : 0;
        if (u > 1) u = 1;
        ox[i] = xs[j] + u * (xs[j + 1] - xs[j]); oy[i] = ys[j] + u * (ys[j + 1] - ys[j]);
      }
      return [ox, oy];
    }
    function decodificarForma(pts, nRes) {
      if (!formas) {
        formas = clases.map(function (c) {
          return remuestrear(c.seq.map(function (q) { return ZX[q]; }), c.seq.map(function (q) { return ZY[q]; }), M);
        });
      }
      // Suavizado (mediana de 5) para reducir el ruido que infla la longitud de arco.
      var n = pts.n, sx = [], sy = [];
      function med(a, i) { var v = a.slice(Math.max(0, i - 2), i + 3).sort(function (p, q) { return p - q; }); return v[v.length >> 1]; }
      for (var i = 0; i < n; i++) { sx.push(med(pts.x, i)); sy.push(med(pts.y, i)); }
      var o = remuestrear(sx, sy, M), inv = 1 / (2 * P.s * P.s);
      var res = [];
      for (var c = 0; c < clases.length; c++) {
        var f = formas[c], d = 0;
        for (i = 0; i < M; i++) { var dx = o[0][i] - f[0][i], dy = o[1][i] - f[1][i]; d += dx * dx + dy * dy; }
        d = d * inv * (8 / M);
        var ps = clases[c].nodo.palabras;
        for (var k = 0; k < ps.length && k < nRes; k++) res.push({ w: ps[k].w, c: d + priorDe(ps[k].r) });
      }
      res.sort(function (a, b) { return a.c - b.c; });
      return res.slice(0, nRes);
    }

    function decodificar(puntos, o) {
      var nRes = (o && o.n) || 5;
      var pts = prepararPuntos(puntos || []);
      if (pts.n === 0) return [];
      var met = (o && o.metodo) || P.metodo;
      var r = met === 'forma' ? decodificarForma(pts, nRes) : decodificarHMM(pts, nRes);
      // score: mayor es mejor (log-verosimilitud aproximada, <= 0)
      return r.map(function (e) { return { w: e.w, score: -e.c }; });
    }

    return {
      // zonas: centros (x,y) y, si es una cuadrícula, ancho/alto de la celda (mismas unidades)
      zonas: zonas.map(function (q) {
        var o = { letras: q.letras, x: q.x, y: q.y };
        if (q.ancho) { o.ancho = q.ancho; o.alto = q.alto; o.fila = q.fila; o.columna = q.columna; }
        return o;
      }),
      zonaDe: zonaDe,
      plantilla: plantilla,
      decodificar: decodificar,
      parametros: P,
      estadisticas: estadisticas,
      numPalabras: rango
    };
  }

  var Recorrido = {
    crear: crear,
    sinTildes: sinTildes,
    DISPOSICIONES: DISPOSICIONES,
    DISPOSICION_DEFECTO: DISPOSICION_DEFECTO
  };
  root.Recorrido = Recorrido;
  if (typeof module !== 'undefined' && module.exports) module.exports = Recorrido;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
