"use strict";
/* Parser determinista de referencias Vancouver (sin IA, sin internet).
 *
 * Port de parser/vancouver.py a JavaScript (ES2020, sin dependencias).
 * Lee UNA referencia en texto y la descompone en campos estructurados:
 * autores, título, revista/libro, año, volumen, número, páginas, DOI.
 *
 * Estrategia (de atrás hacia adelante, lo más regular primero):
 *   1. La cola `AÑO;VOLUMEN(NÚMERO):PÁGINAS.` es el ancla.
 *   2. Los autores se consumen desde el inicio, uno por uno, con el
 *      patrón `Apellido Iniciales` (terminan con ". " en Vancouver ICMJE
 *      o con ": " en estilo Cureus). Lo que queda es `Título. Revista`.
 *   3. Capítulos de libro (`En: Libro [Internet]. Lugar: Editorial; Año.`)
 *      y páginas web van por sus propias ramas.
 *   4. Nada se inventa: todo lo dudoso queda marcado en `flags` para la
 *      pantalla de revisión.
 *
 * DIVERGENCIAS Python -> JS (documentadas, sin cambio de comportamiento
 * en los datos de prueba):
 *   - Grupos nombrados: Python `(?P<nombre>...)` -> JS `(?<nombre>...)`.
 *   - Python `\w` es Unicode (letras acentuadas, dígitos); JS `\w` es
 *     solo ASCII. En los patrones de apellidos se usa `\p{L}\p{M}` con
 *     flag `u`, que es un superconjunto del `\w` de Python (incluye
 *     además marcas combinantes). En los datos de prueba es idéntico.
 *   - Python `re.split(patrón, texto, maxsplit=1)` no existe en JS:
 *     `String.split` no admite límite de divisiones. Se usa el helper
 *     `splitFirst` (primera ocurrencia, manual).
 *   - Python `str.rstrip(chars)` no existe en JS: se traduce por
 *     `replace(/[...]+$/, "")` con la misma clase de caracteres.
 *   - Python `re.split` con grupo capturador devuelve los separadores
 *     intercalados; `String.split` de JS con grupo capturador hace lo
 *     mismo. Sin divergencia.
 *   - `ini[:-k]` de Python y `ini.slice(0, -k)` de JS coinciden también
 *     con k > len(ini) (ambos cuentan desde el final).
 *   - Nombres de campo en camelCase (pagesEnd, etAl, rawClean) por
 *     convención JS; los valores son idénticos a los de Python.
 *
 * Uso en Node:  const { parseReferencia } = require("./vancouver.js");
 * Uso en el plugin de Zotero 7: el archivo se carga como script y las
 * funciones quedan como globales (la guarda de module.exports de abajo
 * solo actúa cuando `module` existe).
 */

// Cola de artículo de revista. Variantes reales:
//   Vancouver ICMJE: 2014;81(3):144-7.      (año;volumen(número):páginas)
//   Estilo Cureus:   2020, 31:662-6.        (año, volumen:páginas)
//   Con mes:         2024 Jan;143(1):45-52. (año mes;volumen(número):páginas)
// El orden de la alternancia de meses es el mismo que en Python
// ("Sep" antes que "Sept": el `[a-z]*` posterior se traga la "t").
const MESES =
  "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|" +
  "Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic";
const TAIL_RE = new RegExp(
  "(?<year>\\d{4})(?:\\s+(?<month>" + MESES + ")[a-z]*)?" +
    "\\s*[;,]\\s*(?<volume>\\d+)" +
    "(?:\\((?<issue>[^)]+)\\))?" +
    ":(?<pages>[A-Za-z]?\\d+(?:-\\d+)?)\\.?\\s*$"
);
// DOI: el sufijo puede llevar puntos, guiones y barras
// (10.1016/j.jvir.2019.12.001); se quitan . , ; finales.
const DOI_RE = /\b10\.\d{4,9}\/\S+/i;
// Abreviaturas con punto que NO son fin de frase: se protegen antes de
// dividir el título ("e.g.", "U.S.") y se restauran después.
const ABBR = {
  "e.g.": "EGABBR",
  "i.e.": "IEABBR",
  "U.S.": "USABBR",
  "vs.": "VSABBR",
  "etc.": "ETCABBR",
  "No.": "NOABBR",
  "Dr.": "DRABBR",
  "St.": "STABBR",
};
const ABBR_RE = /\b(e\.g\.|i\.e\.|U\.S\.|vs\.|etc\.|No\.|Dr\.|St\.)/g;
const ABBR_RESTORE_RE =
  /\b(EGABBR|IEABBR|USABBR|VSABBR|ETCABBR|NOABBR|DRABBR|STABBR)\b/g;
const ABBR_INV = {};
for (const k of Object.keys(ABBR)) ABBR_INV[ABBR[k]] = k;

// Un autor al INICIO de un texto (sin $ final): "Rubilotta E, ..." ->
// family "Rubilotta", given "E". El lookahead exige que tras las
// iniciales venga coma, punto, dos puntos o fin de texto. El apellido
// admite partículas en minúscula ("de la Cruz", "van der Berg").
// Ver la nota de divergencia sobre `\w` de Python vs `\p{L}` arriba.
const _FAM =
  "[\\p{L}][\\p{L}\\p{M}0-9_'\\-]*(?:\\s+[\\p{L}][\\p{L}\\p{M}0-9_'\\-]*)*";
const AUTHOR_START_RE = new RegExp(
  "^(?<family>" + _FAM + ")\\s+(?<given>[A-Z]{1,4})(?=[,.:]|$)",
  "u"
);
const AUTHOR_SUFFIX_START_RE = new RegExp(
  "^(?<family>" +
    _FAM +
    ")\\s+(?<given>[A-Z]{1,4})\\s+(?<suffix>2nd|3rd|Jr\\.?|Sr\\.?|II|III|IV)(?=[,.:]|$)",
  "u"
);

// Capítulo con editor(es) y edición:
// "En: Partin AW, editor. Campbell-Walsh-Wein Urology. 12th ed. Philadelphia: Elsevier; 2021. p. 123-45."
const CHAPTER_ED_RE =
  /^(?<editors>.+?),\s+editors?\.\s+(?<book>[^.]+?)\.\s+(?:(?<edition>\d+(?:st|nd|rd|th)\s+ed\.)\s+)?(?<place>.+?):\s*(?<publisher>.+?);\s*(?<year>\d{4})\.?(?:\s+p\.\s*(?<pages>\d+(?:-\d+)?)\.?)?\s*$/;
// Capítulo simple: "En: StatPearls [Internet]. Treasure Island (FL): StatPearls Publishing; 2025."
const CHAPTER_SIMPLE_RE =
  /^(?<book>[^.]+?)(?:\s*\[(?<medium>[^\]]+)\])?\.\s*(?<place>.+?):\s*(?<publisher>.+?);\s*(?<year>\d{4})\.?(?:\s+p\.\s*(?<pages>\d+(?:-\d+)?)\.?)?\s*$/;

// Python re.split(patrón, texto, maxsplit=1): devuelve [antes, después]
// de la PRIMERA ocurrencia, o [texto] si no hay coincidencia.
function splitFirst(s, re) {
  const m = re.exec(s);
  if (!m) return [s];
  return [s.slice(0, m.index), s.slice(m.index + m[0].length)];
}
const DOT_SPACE_RE = /\.\s+/;

function splitAutores(head) {
  /* Consume el bloque de autores desde el inicio de `head`.
   *
   * Los autores terminan con ". " (Vancouver ICMJE) o ": " (estilo
   * Cureus) antes del título. Devuelve [autores, etAl, flags, resto],
   * donde resto es el texto tras el separador autores/título.
   */
  const autores = [];
  const flags = [];
  let pos = 0;
  let etAl = false;
  const n = head.length;
  while (pos < n) {
    if (autores.length > 0) {
      if (head.slice(pos, pos + 2) === ", ") pos += 2;
      else break; // ". " o ": " -> fin del bloque de autores
    }
    if (head.slice(pos).startsWith("et al.")) {
      etAl = true;
      flags.push("et_al: hay más autores no listados en el texto");
      pos += "et al.".length;
      break;
    }
    const m = AUTHOR_START_RE.exec(head.slice(pos));
    const m2 = m ? null : AUTHOR_SUFFIX_START_RE.exec(head.slice(pos));
    if (m) {
      autores.push({ family: m.groups.family, given: m.groups.given });
      pos += m[0].length;
    } else if (m2) {
      autores.push({
        family: m2.groups.family + " " + m2.groups.suffix,
        given: m2.groups.given,
      });
      pos += m2[0].length;
    } else {
      break;
    }
  }
  let resto = head.slice(pos);
  if (resto.startsWith(". ") || resto.startsWith(": ")) resto = resto.slice(2);
  else if (resto.startsWith(".") || resto.startsWith(":"))
    resto = resto.slice(1).replace(/^\s+/, "");
  if (autores.length === 0) flags.push("sin autores reconocibles");
  return [autores, etAl, flags, resto];
}

function protegerAbbr(texto) {
  /* Sustituye 'e.g.', 'U.S.'... por tokens sin punto para no romper
   * la división por frases. Devuelve [textoProtegido, restaurador]. */
  const protegido = texto.replace(ABBR_RE, (m) => ABBR[m]);
  const restaurar = (s) => s.replace(ABBR_RESTORE_RE, (m) => ABBR_INV[m]);
  return [protegido, restaurar];
}

function expandirPaginas(paginas) {
  /* '144-7' -> ['144', '147']; 'S10-5' -> ['S10', 'S15'];
   * 'e33479' -> ['e33479', null]; '140' -> ['140', null]. */
  const m = /^([A-Za-z]?)(\d+)-(\d+)$/.exec(paginas);
  if (!m) return [paginas, null];
  const pref = m[1];
  const ini = m[2];
  const fin = m[3];
  // Regla Vancouver: el final abreviado hereda los dígitos iniciales del inicio.
  const finCompleto = pref + ini.slice(0, ini.length - fin.length) + fin;
  return [pref + ini, finCompleto];
}

function parseReferencia(texto) {
  /* Parsea una referencia Vancouver. Devuelve dict con campos + flags. */
  const res = {
    raw: texto,
    type: "journal-article",
    authors: [],
    etAl: false,
    title: "",
    journal: "",
    book: "",
    place: "",
    publisher: "",
    year: "",
    month: "",
    volume: "",
    issue: "",
    pages: "",
    pagesEnd: "",
    doi: "",
    url: "",
    accessed: "",
    edition: "",
    editors: [],
    flags: [],
  };
  let t = texto.trim();
  // Quitar numeración inicial "12. "
  t = t.replace(/^\d+\.\s*/, "");
  res.rawClean = t;

  const doiM = DOI_RE.exec(t);
  if (doiM) {
    res.doi = doiM[0].replace(/[.,;]+$/, "");
    t = t.slice(0, doiM.index) + t.slice(doiM.index + doiM[0].length);
    t = t.replace(/\s+/g, " ").trim();
    // Quedan restos del DOI: "doi: ", "https://doi.org/"
    t = t.replace(/https?:\/\/(?:dx\.)?doi\.org\/?\s*$/, "");
    t = t.replace(/[\s.,;]*\bdoi\s*:?\s*\.?\s*$/i, "");
    t = t.replace(/[ .;]+$/, "");
  }

  // --- página web: "Autor. Título [Internet]. Lugar: Editorial; Año [citado ...]. Disponible en: URL" ---
  if (/(?:Disponible en|Available from):/i.test(t)) {
    res.type = "webpage";
    const mUrl = /(https?:\/\/\S+)/.exec(t);
    if (mUrl) {
      res.url = mUrl[1].replace(/[.,;]+$/, "");
      t = t.slice(0, mUrl.index).replace(/\s+$/, "");
    }
    t = t.replace(/(?:Disponible en|Available from):\s*$/i, "").trim();
    const mAcc = /\[(?:citado|cited)\s+([^\]]+)\]/i.exec(t);
    if (mAcc) {
      res.accessed = mAcc[1].trim();
      t = (t.slice(0, mAcc.index) + t.slice(mAcc.index + mAcc[0].length)).trim();
    }
    const mY = [...t.matchAll(/;\s*(\d{4})\b/g)];
    if (mY.length > 0) {
      const last = mY[mY.length - 1];
      res.year = last[1];
      t = t.slice(0, last.index).replace(/\s+$/, "");
    }
    let [autores, etAl, fl, resto] = splitAutores(t);
    if (autores.length === 0) {
      const partes = splitFirst(t, DOT_SPACE_RE);
      if (partes.length === 2) {
        autores = [{ family: partes[0].trim(), given: "" }];
        fl = fl.filter((f) => f !== "sin autores reconocibles");
        fl.push("autor corporativo (sin iniciales)");
        resto = partes[1];
      }
    }
    res.flags.push(...fl);
    res.authors = autores;
    res.etAl = etAl;
    resto = resto.trim();
    const mInet = /\[Internet\]/.exec(resto);
    if (mInet) {
      res.title = resto.slice(0, mInet.index).trim().replace(/\.+$/, "");
      resto = resto
        .slice(mInet.index + mInet[0].length)
        .trim()
        .replace(/^[. ]+/, "");
    } else {
      const partes = splitFirst(resto, DOT_SPACE_RE);
      res.title = partes[0].trim();
      resto = partes.length > 1 ? partes[1] : "";
    }
    const mPp = /^(?<place>.+?):\s*(?<publisher>.+?)\s*$/.exec(resto.trim());
    if (mPp) {
      res.place = mPp.groups.place.trim();
      res.publisher = mPp.groups.publisher.trim().replace(/\.+$/, "");
    }
    return res;
  }

  // --- capítulo de libro: "Autores. Título. En: ..." ---
  // Dos formas reales:
  //   a. "En: Editor(es), editor. Libro. 12th ed. Lugar: Editorial; Año. p. 123-45."
  //   b. "En: Libro [Internet]. Lugar: Editorial; Año."
  if (t.includes(". En: ")) {
    res.type = "chapter";
    const idx = t.indexOf(". En: ");
    const head = t.slice(0, idx);
    const rest = t.slice(idx + ". En: ".length).trim();
    let m = CHAPTER_ED_RE.exec(rest);
    if (!m) m = CHAPTER_SIMPLE_RE.exec(rest);
    if (!m) {
      res.flags.push("capítulo: no encaja el patrón Libro. Lugar: Editorial; Año.");
      return res;
    }
    res.book = m.groups.book.trim();
    res.place = m.groups.place.trim();
    res.publisher = m.groups.publisher.trim();
    res.year = m.groups.year;
    if (m.groups.edition) res.edition = m.groups.edition;
    if (m.groups.editors) {
      const [ed] = splitAutores(m.groups.editors.trim());
      res.editors = ed;
    }
    if (m.groups.pages) {
      const [p, pe] = expandirPaginas(m.groups.pages);
      res.pages = p;
      res.pagesEnd = pe;
    }
    // head = "Autores. Título" — splitAutores consume los autores y
    // deja el título en resto (con su '?' o '!' si lo tiene).
    const [autores, etAl, fl, resto] = splitAutores(head);
    res.flags.push(...fl);
    res.authors = autores;
    res.etAl = etAl;
    res.title = resto.trim();
    return res;
  }

  // --- artículo de revista ---
  const m = TAIL_RE.exec(t);
  if (!m) {
    res.flags.push("sin cola Año;Volumen(Número):Páginas reconocible");
    res.type = "unknown";
    return res;
  }
  res.year = m.groups.year;
  res.month = m.groups.month || "";
  res.volume = m.groups.volume;
  res.issue = m.groups.issue || "";
  const [pg, pgEnd] = expandirPaginas(m.groups.pages);
  res.pages = pg;
  res.pagesEnd = pgEnd;
  const head = t.slice(0, m.index).trim().replace(/\.+$/, "");
  // Autores desde el inicio (". " ICMJE o ": " Cureus); el resto es
  // "Título. Revista". Las abreviaturas con punto ("e.g.", "U.S.") se
  // protegen para que no rompan la división por frases.
  const [autores, etAl, fl, resto] = splitAutores(head);
  res.flags.push(...fl);
  res.authors = autores;
  res.etAl = etAl;
  if (autores.length === 0) {
    res.type = "unknown";
    return res;
  }
  const [restoProt, restaurar] = protegerAbbr(resto);
  // String.split con grupo capturador devuelve los separadores
  // intercalados, igual que re.split de Python.
  const partes = restoProt.split(/([.?!])\s+/);
  const seg = partes.filter((_, i) => i % 2 === 0);
  const term = partes.filter((_, i) => i % 2 === 1);
  if (seg.length < 2) {
    res.flags.push("no se separa Título. Revista");
    res.type = "unknown";
    return res;
  }
  if (seg.length > 2) {
    res.flags.push(
      "el título contiene límites de frase internos; la división Título/Revista es una suposición"
    );
  }
  res.journal = restaurar(seg[seg.length - 1].trim());
  let titulo = restaurar(seg[seg.length - 2].trim());
  // term[k] es el terminador DESPUÉS de seg[k]; el del título es term[-1]
  if (term.length > 0 && (term[term.length - 1] === "?" || term[term.length - 1] === "!")) {
    titulo += term[term.length - 1];
  }
  res.title = titulo;
  return res;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseReferencia, splitAutores, expandirPaginas, protegerAbbr };
}
