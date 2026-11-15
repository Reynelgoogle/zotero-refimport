"use strict";
/* Lector de referencias desde PDF (port de parser/pdf_extract.py).
 *
 * Opera sobre LÍNEAS DE TEXTO ya extraídas (en el plugin las dará
 * pdf.js, que Zotero 7 ya trae dentro; aquí NO se toca el PDF binario).
 *
 * Pasos (todos deterministas, sin IA):
 *   1. Busca el encabezado de referencias ("References", "Referencias",
 *      "Bibliography"...). El encabezado se normaliza (minúsculas, sin
 *      numeración inicial "5.", sin puntuación final) y se aceptan las
 *      variantes reales: "References:", "Referencias bibliográficas",
 *      "Works Cited", "Literature Cited", "References and Notes"...
 *   2. Si NO hay encabezado, fallback: busca la primera corrida de 3 o
 *      más líneas numeradas seguidas (1, 2, 3...) y la lista empieza ahí.
 *   3. Segmenta por número: una línea que empieza por "N." (o "N)",
 *      "[N]", "(N)", "N -") abre una referencia nueva (el número puede
 *      venir solo en su línea o con texto detrás); las líneas siguientes
 *      se unen a la referencia abierta, des-guionizando el final de
 *      línea ("194-\n204" -> "194-204").
 *   4. Descarta el pie de página (líneas "N of N", cita del propio
 *      artículo, ©, etc.) que viene tras la última referencia.
 *
 * Divergencias Python -> JS: ninguna de comportamiento; `str.strip()` es
 * `trim()`, y la comprobación de verdad de `actual` (None o "" en
 * Python) es `if (actual)` en JS, que cubre ambos casos igual.
 *
 * Uso en Node:  const { extraerReferencias } = require("./pdfExtract.js");
 * Uso en el plugin: el archivo se carga como script y la función queda
 * como global.
 */

const HEADINGS = new Set([
  "references",
  "referencias",
  "referencia bibliografica",
  "referencias bibliograficas",
  "bibliography",
  "bibliografia",
  "bibliografica",
  "bibliograficas",
  "literature cited",
  "cited literature",
  "works cited",
  "cited references",
  "referencias citadas",
  "literatura citada",
  "list of references",
  "lista de referencias",
]);
/* Encabezados justificados que el PDF parte letra a letra:
 * "B I B L I O G R A F I A", "BIBLIOGR A FÍ A". Se comparan también sin
 * espacios. */
const HEADINGS_COMPACTO = new Set(
  [...HEADINGS].map((h) => h.replace(/\s+/g, ""))
);
/* Numeración de referencia al inicio de línea: "1.", "1)", "[1]",
 * "(1)" o "1 -". Un solo helper para el segmentador y el fallback. */
const NUM_RE = /^(?:\[(\d+)\]|\((\d+)\)|(\d+)[.)]|(\d+)\s*[-–—])\s*(.*)$/;
function numDeLinea(s) {
  const m = NUM_RE.exec(s);
  if (!m) return null;
  // "(2024)" o "[2024]" al inicio es un año entre paréntesis, no el
  // número de la referencia (una lista no tiene 2000 referencias).
  if ((m[1] || m[2]) && /^(?:19|20)\d{2}$/.test(m[1] || m[2])) return null;
  const num = parseInt(m[1] || m[2] || m[3] || m[4], 10);
  return { num, texto: m[5] };
}
const FOOTER_RES = [
  /^\d+\s+of\s+\d+\s*$/i,
  /^\d{4}\s+\S+ et al\./i,
  /^©/,
  /^page\s+\d+/i,
];
const AUTHOR_FAMILY =
  "[\\p{L}][\\p{L}\\p{M}'’\\-]*(?:\\s+[\\p{L}][\\p{L}\\p{M}'’\\-]*){0,3}";
const AUTHOR_CORPORATE =
  "(?:World Health Organization|Centers? for Disease Control and Prevention|" +
  "National (?:Cancer|Health|Institutes?)|United Nations|European Commission|" +
  "Ministry of [^.]+|University of [^.]+|WHO|OMS|UNICEF|UNESCO|OECD|NCI|CDC|NIH|NHS)";
const AUTHOR_LINE_RE = new RegExp(
  "^(?:(?:" + AUTHOR_FAMILY + ")\\s+[A-Z]{1,4}(?:[.\\-\\s]*[A-Z]{1,4})*(?=[,.:])" +
  "|(?:" + AUTHOR_FAMILY + "),\\s*[A-Z][\\p{L}\\p{M}'’\\-]*\\.?" +
  "(?:\\s+[A-Z]{1,4}(?![\\p{L}])\\.?)?(?=[,.:])" +
  "|" + AUTHOR_CORPORATE + "\\.)",
  "u"
);

function esPie(linea) {
  return FOOTER_RES.some((rx) => rx.test(linea));
}

/* Normaliza una línea candidata a encabezado: minúsculas, sin
 * numeración inicial ("5. ", "5) "), sin puntuación final (".", ":"),
 * sin número de página final ("References 12"). */
function normalizarEncabezado(linea) {
  let s = linea
    .trim()
    .toLowerCase()
    // Sin tildes: "BIBLIOGRAFIA" (sin acento, como sale en muchos
    // PDFs) tiene que igualar a "bibliografía" del conjunto.
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/^\d+\s*[.)\]]\s*/, "") // "5. References" -> "references"
    .replace(/\s+\d+\s*$/, "") // "References 12" -> "references"
    .replace(/[\s.:;\-]+$/, "") // "References:" -> "references"
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

/* ¿Es esta línea un encabezado de referencias? Dos niveles:
 *   1. Exacto (tras normalizar): "References", "Referencias
 *      bibliográficas", "Works Cited"...
 *   2. Parecido (v0.1.4): la línea es CORTA (un
 *      encabezado, no un párrafo), no tiene cola de referencia, y
 *      contiene "referenc" o "bibliograf" (o "literature cited" /
 *      "works cited" / "literatura citada"). Así entran "Bibliográficas",
 *      "Revisión bibliográfica", "Fuentes consultadas", "Referencias
 *      bibliográficas" y cualquier variante parecida, sin confundirla
 *      con una frase del cuerpo ("ver las referencias en..."). */
const TAIL_LIGERO_RE =
  /\b(?:19|20)\d{2}[;,]\s*\d+\s*(?:\([^)]*\))?\s*:\s*[A-Za-z]?\d+/;
const PARECIDO_RE =
  /referenc|bibliograf|fuentes consultadas|literature cited|works cited|cited literature|literatura citada/;

/* ¿Es esta línea un encabezado de referencias? Dos niveles, en
 * orden: exacto primero, parecido solo si no hay exacto (la
 * búsqueda en dos pasadas evita que una etiqueta corta del cuerpo
 * como "Calibre de referencia" robe el encabezado real, que viene
 * después). El parecido excluye "de referencia(s)": es el valor de
 * referencia de un dato ("Calibre de referencia", "Valor de
 * referencia"), no la sección de referencias. */
function esEncabezadoExacto(linea) {
  const s = normalizarEncabezado(linea);
  if (HEADINGS.has(s)) return true;
  // "BIBLIOGR A FÍ A" (justificado): comparar sin espacios.
  return HEADINGS_COMPACTO.has(s.replace(/\s+/g, ""));
}

function esEncabezadoParecido(linea) {
  const s = normalizarEncabezado(linea);
  if (!s || s.split(" ").length > 8) return false;
  if (TAIL_LIGERO_RE.test(s)) return false;
  if (/\bde referencias?\b/.test(s)) return false;
  return PARECIDO_RE.test(s);
}

function esEncabezado(linea) {
  return esEncabezadoExacto(linea) || esEncabezadoParecido(linea);
}

/* Búsqueda en dos pasadas: primero un encabezado exacto, y solo si
 * no lo hay, uno parecido. Devuelve el índice o -1. */
function buscarEncabezado(lineas) {
  let i = lineas.findIndex((ln) => esEncabezadoExacto(ln));
  if (i !== -1) return i;
  return lineas.findIndex((ln) => esEncabezadoParecido(ln));
}

function encabezadoConReferencia(linea) {
  const colon = linea.indexOf(":");
  if (colon !== -1 && esEncabezadoExacto(linea.slice(0, colon))) {
    const texto = linea.slice(colon + 1).trim();
    if (texto) return texto;
  }
  const marker =
    /\s+(?=(?:\d+\s*[.)]|\[\s*\d+\s*\]|\(\s*\d+\s*\)|\d+\s*[-–—])\s*\S)/g;
  let match;
  while ((match = marker.exec(linea))) {
    if (esEncabezadoExacto(linea.slice(0, match.index))) {
      return linea.slice(match.index + match[0].length).trim();
    }
  }
  return "";
}

/* Fallback sin encabezado: primera corrida de 3+ referencias
 * numeradas seguidas (1, 2, 3...) cuya PRIMERA referencia tenga
 * cola Vancouver (año;volumen:páginas). La cola evita confundir la
 * lista con secciones numeradas del cuerpo ("1. Introduction...").
 * Un número no secuencial dentro del bloque ("204." de "194-204")
 * se trata como continuación, no como referencia nueva. Devuelve
 * el índice de la primera línea de la corrida, o -1. */
function buscarCorridaNumerada(lineas) {
  const TAIL = TAIL_LIGERO_RE;
  const numDe = numDeLinea;
  for (let i = 0; i < lineas.length; i++) {
    const c0 = numDe(lineas[i].trim());
    if (!c0) continue;
    let bloque1 = c0.texto;
    let esperado = c0.num + 1;
    let encontrados = 1;
    let j = i + 1;
    let recorridas = 0;
    while (j < lineas.length && recorridas < 30) {
      const s = lineas[j].trim();
      const c = numDe(s);
      if (c && c.num === esperado) {
        encontrados++;
        esperado++;
        if (encontrados === 3) break;
      } else if (c) {
        // Línea numerada que no es la siguiente: es otra referencia
        // (o una sección numerada, p. ej. "1. Introduction"). Este
        // candidato no es la lista: reintentar desde esa línea (el
        // bucle exterior la probará como inicio). Sin esto, el texto
        // de esa referencia se pegaba a bloque1 y su cola Vancouver
        // hacía pasar el filtro como si fuera la primera referencia.
        i = j - 1;
        break;
      } else if (encontrados === 1 && s) {
        bloque1 += " " + s;
      }
      j++;
      recorridas++;
    }
    if (encontrados < 3) continue;
    if (!TAIL.test(bloque1)) continue;
    return i;
  }
  return -1;
}

/* Algunos PDF (o el extractor de Zotero con texto en columnas) pegan
 * varias referencias en una misma línea:
 *   "...799-810. 2. Alevizakos M, ... 3. Farro..."
 * El lector por líneas solo veía la 1 y se tragaba el resto. Este paso
 * inserta un corte antes del número EXACTO que toca (2, luego 3...),
 * así no parte un "(2)" de número de fascículo ni un año. */
function patronMarcador(n) {
  const num = String(n);
  return new RegExp(
    "(^|\\s)(?:\\[\\s*" + num + "\\s*\\]|" +
    "\\(\\s*" + num + "\\s*\\)|" +
    num + "\\s*[.)]|" +
    num + "\\s*[-\u2013\u2014])\\s+",
    "g"
  );
}

function buscarMarcadorInline(texto, n, desde) {
  const re = patronMarcador(n);
  re.lastIndex = desde || 0;
  let m;
  while ((m = re.exec(texto))) {
    const idx = m.index + m[1].length;
    if (idx > 0) return { index: idx, length: m[0].length - m[1].length };
  }
  return null;
}

function separarLineasNumeradas(lineas) {
  const salida = [];
  let esperado = null;
  for (const original of lineas) {
    let s = original;
    let vueltas = 0;
    while (s && vueltas++ < 500) {
      const cabecera = numDeLinea(s.replace(/^\f+/, "").trimStart());
      if (cabecera && (esperado === null || cabecera.num === esperado)) {
        esperado = cabecera.num + 1;
      }
      if (esperado === null) break;
      const m = buscarMarcadorInline(s, esperado, 1);
      if (!m) break;
      salida.push(s.slice(0, m.index));
      s = s.slice(m.index);
    }
    if (s) salida.push(s);
  }
  return salida;
}

function pareceInicioSinNumero(texto) {
  return AUTHOR_LINE_RE.test(texto.trim());
}

function extraerReferencias(lineas) {
  /* Devuelve la lista de referencias en texto (una por cadena). */
  // 1. localizar el encabezado de referencias (o el fallback)
  let idxEnc = buscarEncabezado(lineas);
  let inline = idxEnc === -1 ? "" : encabezadoConReferencia(lineas[idxEnc]);
  if (idxEnc === -1) {
    for (let i = 0; i < lineas.length; i++) {
      const remainder = encabezadoConReferencia(lineas[i]);
      if (remainder) {
        idxEnc = i;
        inline = remainder;
        break;
      }
    }
  }
  let idxInicio;
  if (idxEnc !== -1) {
    idxInicio = idxEnc + 1;
  } else {
    const idxCorrida = buscarCorridaNumerada(lineas);
    if (idxCorrida === -1) {
      throw new Error(
        "no se encontró el encabezado de referencias (se buscó References, Referencias, Bibliography, Works Cited y variantes, y tampoco una lista numerada)"
      );
    }
    idxInicio = idxCorrida;
  }
  // v0.1.6: separar referencias que vienen pegadas en la misma línea.
  const lineasRestantes = inline
    ? [inline, ...lineas.slice(idxEnc + 1)]
    : lineas.slice(idxInicio);
  const resto = separarLineasNumeradas(lineasRestantes);
  // 2. segmentar por número y unir líneas. El número debe ser
  // SECUENCIAL (1, 2, 3...): una línea como "204. 10.1055/..." es la
  // continuación de la página partida "194-", no la referencia 204.
  const refs = [];
  let actual = null;
  let esperado = null;
  for (const ln of resto) {
    // El extractor de Zotero separa las páginas con \f al inicio de la
    // primera línea de la página siguiente. Si la lista venía abierta
    // y la página nueva empieza con OTRA numeración (p. ej. el
    // cuestionario "1.- ¿Cuál...?" tras la bibliografía), la lista
    // terminó: sin esto, esa página entera se pegaba a la última
    // referencia (la última referencia quedaba con 2.700 caracteres).
    const saltoPagina = ln.startsWith("\f");
    const s = ln.replace(/^\f+/, "").trim();
    if (!s || esPie(s)) continue;
    const c = numDeLinea(s);
    const num = c ? c.num : null;
    if (saltoPagina && refs.length > 0 && actual !== null &&
      num !== null && esperado !== null && num !== esperado) {
      break;
    }
    if (num !== null && (esperado === null || num === esperado)) {
      if (actual) refs.push(actual);
      esperado = num + 1;
      actual = c.texto;
    } else {
      if (num !== null && actual !== null && num !== esperado &&
        refs.length >= 2 && TAIL_LIGERO_RE.test(actual)) {
        break;
      }
      if (actual === null) {
        if (pareceInicioSinNumero(s)) actual = s;
        continue;
      }
      if (num === null && TAIL_LIGERO_RE.test(actual) &&
        pareceInicioSinNumero(s)) {
        refs.push(actual);
        actual = s;
        continue;
      }
      if (actual.endsWith("-")) actual += s;
      else actual += " " + s;
    }
  }
  if (actual) refs.push(actual);
  // 3. normalizaciones finales por referencia
  return refs.map((r) =>
    r
      .replace(/\s+/g, " ")
      .trim()
      .replace(/ \./g, ".")
  );
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    extraerReferencias,
    esEncabezado,
    esEncabezadoExacto,
    esEncabezadoParecido,
    buscarEncabezado,
    normalizarEncabezado,
    numDeLinea,
    pareceInicioSinNumero,
  };
}
