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
 *     outliers y una permanencia mínima de K muestras),
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
      .replace(/[̀-ͯ]/g, '').replace(/\u0001/g, 'ñ');
  }

  // Distribuciones de letras probadas (ver test). La elegida es DISPOSICION_DEFECTO.
  var DISPOSICIONES = {
    '2x3': { filas: 2, columnas: 3, grupos: ['abc', 'def', 'ghijkl', 'mnño', 'pqrs', 'tuvwxyz'] },
    '2x4': { filas: 2, columnas: 4, grupos: ['a', 'bcd', 'efgh', 'ijkl', 'mnñ', 'op', 'qrs', 'tuvwxyz'] },
    '3x3': { filas: 3, columnas: 3, grupos: ['a', 'bcd', 'efgh', 'ijkl', 'mnñ', 'op', 'qrs', 't', 'uvwxyz'] },
    '2x5': { filas: 2, columnas: 5, grupos: ['a', 'bcd', 'efgh', 'ijkl', 'mnñ', 'op', 'qr', 's', 't', 'uvwxyz'] },
    '3x4': { filas: 3, columnas: 4, grupos: ['a', 'bcd', 'efg', 'hij', 'kl', 'm', 'nñ', 'op', 'qr', 's', 't', 'uvwxyz'] }
  };
  var DISPOSICION_DEFECTO = '3x3';

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
      penTransito: opc.penTransito != null ? opc.penTransito : 1.2,
      K: opc.K || 2,              // permanencia mínima (muestras) en cada fijación
      lambda: opc.lambda != null ? opc.lambda : 1.4, // peso del prior de frecuencia
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

    var PASADA1 = opc.pasada1 || 1000;
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
    function decodificarHMM(pts, nRes) {
      var N = pts.n, X = pts.x, Y = pts.y;
      var inv = 1 / (2 * P.s * P.s), tope = P.tope, g = P.basura, K = P.K;
      // Coste de fijación por zona y muestra
      var cF = new Array(Z);
      for (var zz = 0; zz < Z; zz++) {
        var a = new Float64Array(N);
        for (var t = 0; t < N; t++) {
          var dx = X[t] - ZX[zz], dy = Y[t] - ZY[zz];
          var c = (dx * dx + dy * dy) * inv;
          a[t] = c < tope ? c : tope;
        }
        cF[zz] = a;
      }
      // Coste de tránsito por par de zonas (distancia al segmento)
      var cT = new Array(Z * Z);
      function costeTransito(z1, z2) {
        var idx = z1 * Z + z2;
        if (cT[idx]) return cT[idx];
        var a = new Float64Array(N);
        var ax = ZX[z1], ay = ZY[z1], bx = ZX[z2] - ax, by = ZY[z2] - ay, L = bx * bx + by * by;
        for (var t = 0; t < N; t++) {
          var px = X[t] - ax, py = Y[t] - ay, u = (px * bx + py * by) / L;
          if (u < 0) u = 0; else if (u > 1) u = 1;
          var dx = px - u * bx, dy = py - u * by;
          var c = (dx * dx + dy * dy) * inv;
          a[t] = (c < tope ? c : tope) + P.penTransito;
        }
        cT[idx] = a;
        return a;
      }
      // Cota inferior del coste de cada muestra (cualquier estado) y su suma de sufijo:
      // permite podar celdas cuyo coste + lo que falta ya supera al n-ésimo mejor.
      var lbBase = g < P.penTransito ? g : P.penTransito;
      var sufCache = {};
      function sufDe(mascara) {
        var suf = sufCache[mascara];
        if (suf) return suf;
        suf = new Float64Array(N + 1);
        for (var t = N - 1; t >= 0; t--) {
          var lb = lbBase;
          for (var z = 0; z < Z; z++) if ((mascara >> z) & 1 && cF[z][t] < lb) lb = cF[z][t];
          suf[t] = suf[t + 1] + lb;
        }
        sufCache[mascara] = suf;
        return suf;
      }
      // Buffers por profundidad.
      var buf = [];
      for (var d = 0; d <= profMax; d++) {
        var bb = { T: new Float64Array(N), F: [], lo: 0 };
        for (var r = 0; r < K; r++) bb.F.push(new Float64Array(N));
        buf.push(bb);
      }
      // Prefijo de basura: pre[t] = coste de cubrir 0..t con basura (pre[-1] = 0).
      var pre = new Float64Array(N);
      for (t = 0; t < N; t++) pre[t] = g * (t + 1);

      var lambda = P.lambda, haz = P.haz;
      var res = []; // top nRes: {w, c}, ordenado por c
      var umbral = Infinity;
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

      // Calcula las columnas del nodo (nivel d) a partir del estado final del padre.
      // Devuelve la cota inferior de cualquier palabra del subárbol sin prior (o Infinity).
      var INF = Infinity;
      function calcular(nodo, d, finPrev, loPrev, zPrev, lim) {
        llamadas++;
        var b = buf[d], cf = cF[nodo.zona], F = b.F, t, v, w, suf = sufDe(nodo.mascara);
        var F0 = F[0], lo, r, A, B;
        if (zPrev < 0) {
          lo = 0;
          F0[0] = cf[0];
          for (t = 1; t < N; t++) F0[t] = cf[t] + pre[t - 1];
        } else {
          lo = loPrev + 1;
          if (lo >= N) return INF;
          var ct = costeTransito(zPrev, nodo.zona), T = b.T;
          T[lo - 1] = INF;
          for (t = lo; t < N; t++) {
            var fp = finPrev[t - 1]; v = T[t - 1];
            var mn = fp < v ? fp : v;
            w = ct[t] + mn;
            T[t] = w + suf[t + 1] < lim ? w : INF;
            F0[t] = cf[t] + mn;
          }
          F0[lo - 1] = INF;
        }
        for (r = 1; r < K; r++) {
          A = F[r - 1]; B = F[r];
          if (lo > 0) B[lo - 1] = INF;
          B[lo] = INF;
          for (t = lo + 1; t < N; t++) B[t] = cf[t] + A[t - 1];
        }
        var L = F[K - 1], m = INF, primero = -1;
        if (K > 1) {
          A = F[K - 2];
          for (t = lo + 1; t < N; t++) {
            v = L[t - 1]; w = A[t - 1];
            v = cf[t] + (v < w ? v : w);
            if (v + suf[t + 1] < lim) {
              L[t] = v;
              if (primero < 0) primero = t;
              if (v + suf[t + 1] < m) m = v + suf[t + 1];
            } else L[t] = INF;
          }
        } else {
          for (t = lo; t < N; t++) {
            v = L[t];
            if (t > lo && L[t - 1] + cf[t] < v) v = L[t - 1] + cf[t];
            if (v + suf[t + 1] < lim) {
              L[t] = v;
              if (primero < 0) primero = t;
              if (v + suf[t + 1] < m) m = v + suf[t + 1];
            } else L[t] = INF;
          }
        }
        b.lo = primero;
        return m;
      }

      function visitar(nodo, d) {
        var L = buf[d].F[K - 1], lo = buf[d].lo, t;
        if (nodo.palabras) {
          var fin = INF;
          for (t = lo; t < N; t++) { var v = L[t] + g * (N - 1 - t); if (v < fin) fin = v; }
          var ps = nodo.palabras;
          for (var i = 0; i < ps.length && i < nRes; i++) {
            var c = fin + lambda * ps[i].pr;
            if (c >= umbral) break;
            insertar(ps[i].w, c);
          }
        }
        if (d >= profMax) return;
        var hijos = nodo.lista;
        // Cada hijo se procesa completo (calcular + recursión) antes del siguiente,
        // porque los buffers del nivel d+1 se reutilizan.
        for (var k = 0; k < hijos.length; k++) {
          var h = hijos[k], pr = lambda * h.pr;
          if (pr >= umbral || h.mejorR > rMax) break; // hijos ordenados por mejor rango
          var m = calcular(h, d + 1, L, lo, nodo.zona, umbral - pr);
          if (m + pr >= umbral) continue;
          visitar(h, d + 1);
        }
      }

      // Dos pasadas: primero sólo palabras frecuentes (da pronto un umbral ajustado),
      // luego todo el diccionario con ese umbral.
      var rMax, llamadas = 0;
      function buscar(limite) {
        rMax = limite;
        var hijos0 = raiz.lista;
        for (var k = 0; k < hijos0.length; k++) {
          var h = hijos0[k], pr = lambda * h.pr;
          if (pr >= umbral || h.mejorR > rMax) break;
          var m = calcular(h, 1, pre, 0, -1, umbral - pr);
          if (m + pr >= umbral) continue;
          visitar(h, 1);
        }
      }
      buscar(PASADA1);
      buscar(Infinity);
      estadisticas.nodos = llamadas;
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
      zonas: zonas.map(function (q) { return { letras: q.letras, x: q.x, y: q.y }; }),
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
