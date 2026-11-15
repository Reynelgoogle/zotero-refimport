"use strict";
/* Exportador RIS (port de parser/ris_export.py, función a_ris).
 *
 * Devuelve las líneas RIS de una referencia ya parseada. Los campos que
 * el texto NO trae (DOI, PMID/URL) no los produce el parser: quedan
 * vacíos y los cubriría el botón opcional de completar en línea.
 *
 * NOTA (peculiaridad heredada de Python, sin cambiar): el tipo solo
 * distingue capítulo de resto — una página web sale como TY JOUR, igual
 * que en a_ris de Python. No se "arregla" aquí para que el RIS generado
 * sea byte a byte idéntico al de Python.
 *
 * Uso en Node:  const { aRis } = require("./ris.js");
 * Uso en el plugin: el archivo se carga como script y la función queda
 * como global.
 */

function aRis(ref) {
  const L = [];
  L.push("TY  - " + (ref.type === "chapter" ? "CHAP" : "JOUR"));
  for (const a of ref.authors) {
    const given = a.given; // iniciales juntas: "CN", no "C N" (convención RIS)
    L.push(("AU  - " + a.family + ", " + given).replace(/[, ]+$/, ""));
  }
  if (ref.etAl) L.push("N1  - et al.: el texto lista solo los primeros autores");
  L.push("TI  - " + ref.title);
  if (ref.type === "chapter") {
    L.push("T2  - " + ref.book);
    if (ref.place) L.push("CY  - " + ref.place);
    if (ref.publisher) L.push("PB  - " + ref.publisher);
  } else {
    L.push("JO  - " + ref.journal);
  }
  L.push("PY  - " + ref.year);
  if (ref.volume) L.push("VL  - " + ref.volume);
  if (ref.issue) L.push("IS  - " + ref.issue);
  if (ref.pages) L.push("SP  - " + ref.pages);
  if (ref.pagesEnd) L.push("EP  - " + ref.pagesEnd);
  if (ref.doi) L.push("DO  - " + ref.doi);
  L.push("ER  - ");
  return L;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { aRis };
}
