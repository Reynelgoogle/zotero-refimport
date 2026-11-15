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
// v0.1.7: los PDF y las webs usan guion largo (277–87), signo menos
// (277−87) o guion Unicode (277‐87), no solo el guion ASCII. También
// hay páginas electrónicas (e4878, 6.e1–6.e7).
const MESES =
  "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|" +
  "Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic";
const DASHES = "\\-\\u2010-\\u2015\\u2212";
const PAGE_TOKEN = "[A-Za-z]?\\d+(?:\\.e\\d+)?";
const TAIL_RE = new RegExp(
  "(?<year>\\d{4})(?:\\s+(?<month>" + MESES + ")[a-z]*)?" +
    "(?:\\s+\\d{1,2})?" +
    "\\s*[;,]\\s*(?<volume>\\d+)" +
    "(?:\\((?<issue>[^)]+)\\))?" +
    ":\\s*(?<pages>" +
    PAGE_TOKEN +
    "(?:\\s*[" +
    DASHES +
    "]\\s*" +
    PAGE_TOKEN +
    ")?)\\.?\\s*$"
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
// v0.1.7: las iniciales pueden venir separadas por espacio o por un
// guion Unicode ("Rumpelt H ‐J"): se aceptan y luego se normalizan.
// Ver la nota de divergencia sobre `\w` de Python vs `\p{L}` arriba.
const _FAM =
  "[\\p{L}][\\p{L}\\p{M}0-9_'\\-]*(?:\\s+[\\p{L}][\\p{L}\\p{M}0-9_'\\-]*)*";
const _GIVEN =
  "[A-Z]{1,4}(?:(?:\\s*[" + DASHES + "]\\s*|\\s+)[A-Z]{1,4})*";
const COMMA_AUTHOR_RE = new RegExp(
  "^(?<family>" + _FAM + "),\\s*(?<given>" +
    "[A-Z][\\p{L}\\p{M}'’\\-]*\\.?" +
    "(?:\\s+[A-Z]{1,4}(?![\\p{L}])\\.?)*)",
  "u"
);
const AUTHOR_START_RE = new RegExp(
  "^(?<family>" + _FAM + ")\\s+(?<given>" + _GIVEN + ")(?=[,.:]|$)",
  "u"
);
const AUTHOR_SUFFIX_START_RE = new RegExp(
  "^(?<family>" +
    _FAM +
    ")\\s+(?<given>" +
    _GIVEN +
    ")\\s+(?<suffix>2nd|3rd|Jr\\.?|Sr\\.?|II|III|IV)(?=[,.:]|$)",
  "u"
);

// "H ‐J" -> "H-J"; "J A" -> "JA".
function normalizarIniciales(given) {
  return given
    .replace(/\s*[-\u2010-\u2015\u2212]\s*/g, "-")
    .replace(/\s+/g, "");
}

function splitAutoresApellidoComa(head) {
  const authors = [];
  let pos = 0;
  while (pos < head.length) {
    const match = COMMA_AUTHOR_RE.exec(head.slice(pos));
    if (!match) return null;
    if (/\s[A-Z]{1,4}$/.test(match.groups.family)) return null;
    const given = match.groups.given.trim().replace(/\./g, "");
    const isFullName = /\p{Ll}/u.test(given);
    authors.push({
      family: match.groups.family.trim(),
      given: isFullName ? given : normalizarIniciales(given),
    });
    pos += match[0].length;

    const comma = /^\s*,\s*/.exec(head.slice(pos));
    if (!comma || !COMMA_AUTHOR_RE.test(head.slice(pos + comma[0].length))) {
      break;
    }
    pos += comma[0].length;
  }

  let resto = head.slice(pos).trim().replace(/^[,.:;\s]+/, "");
  let etAl = false;
  const flags = [];
  if (/^et\s+al\.?\b/i.test(resto)) {
    etAl = true;
    flags.push("et_al: hay más autores no listados en el texto");
    resto = resto.replace(/^et\s+al\.?\s*/i, "");
  }
  return [authors, etAl, flags, resto];
}

// Capítulo con editor(es) y edición:
// "En: Partin AW, editor. Campbell-Walsh-Wein Urology. 12th ed. Philadelphia: Elsevier; 2021. p. 123-45."
const CHAPTER_ED_RE =
  /^(?<editors>.+?),\s+editors?\.\s+(?<book>[^.]+?)\.\s+(?:(?<edition>\d+(?:st|nd|rd|th)\s+ed\.)\s+)?(?<place>.+?):\s*(?<publisher>.+?);\s*(?<year>\d{4})\.?(?:\s+p{1,2}\.\s*(?<pages>[A-Za-z]?\d+(?:\s*[-\u2010-\u2015\u2212]\s*[A-Za-z]?\d+)?))?\.?\s*$/;
// Capítulo simple: "En: StatPearls [Internet]. Treasure Island (FL): StatPearls Publishing; 2025."
const CHAPTER_SIMPLE_RE =
  /^(?<book>[^.]+?)(?:\s*\[(?<medium>[^\]]+)\])?\.\s*(?<place>.+?):\s*(?<publisher>.+?);\s*(?<year>\d{4})\.?(?:\s+p{1,2}\.\s*(?<pages>[A-Za-z]?\d+(?:\s*[-\u2010-\u2015\u2212]\s*[A-Za-z]?\d+)?))?\.?\s*$/;
const BOOK_EDITION_RE =
  /\.\s*(?<edition>\d+(?:st|nd|rd|th)\s+ed\.)\s*(?<place>[^:;]+):\s*(?<publisher>[^;]+);\s*(?<year>(?:19|20)\d{2})\.?(?:\s+(?:pp?\.|pages?)\s*(?<pages>[A-Za-z]?\d+(?:\s*[-\u2013\u2014]\s*[A-Za-z]?\d+)?))?\.?\s*$/i;

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
  const firstSentence = splitFirst(head, DOT_SPACE_RE);
  if (firstSentence.length === 2 &&
    pareceInstitucion(firstSentence[0].trim())) {
    const family = firstSentence[0].trim().replace(/[.,;:]+$/, "");
    const resto = firstSentence[1].trim();
    return [
      [{ family, given: "" }],
      false,
      ["autor corporativo (sin iniciales)"],
      resto,
    ];
  }
  const commaAuthors = splitAutoresApellidoComa(head);
  if (commaAuthors) return commaAuthors;
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
      autores.push({
        family: m.groups.family,
        given: normalizarIniciales(m.groups.given),
      });
      pos += m[0].length;
    } else if (m2) {
      autores.push({
        family: m2.groups.family + " " + m2.groups.suffix,
        given: normalizarIniciales(m2.groups.given),
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
   * 'e33479' -> ['e33479', null]; '140' -> ['140', null].
   * v0.1.7: acepta guion largo/signo menos y páginas electrónicas
   * ('6.e1–6.e7' -> ['6.e1', '6.e7']). */
  const norm = String(paginas)
    .replace(/\s*[-\u2010-\u2015\u2212]\s*/g, "-")
    .trim();
  const m = /^([A-Za-z]?)(\d+)(\.e\d+)?-([A-Za-z]?)(\d+)(\.e\d+)?$/.exec(norm);
  if (!m) return [norm, null];
  const pref = m[1] || m[4];
  const ini = m[2];
  const fin = m[5];
  const iniSuf = m[3] || "";
  const finSuf = m[6] || "";
  if (iniSuf || finSuf) {
    // Páginas electrónicas: cada lado lleva su propio sufijo.
    return [pref + ini + iniSuf, (m[4] || "") + fin + finSuf];
  }
  // Regla Vancouver: el final abreviado hereda los dígitos iniciales del inicio.
  const finCompleto = pref + ini.slice(0, ini.length - fin.length) + fin;
  return [pref + ini, finCompleto];
}

// v0.1.7: pistas para distinguir un autor corporativo de un título que
// simplemente empieza la referencia ("Cancer, Renal. StatPearls...").
function pareceInstitucion(s) {
  return /\b(?:Instituto|Instituci[oó]n|Organizaci[oó]n|Organizations?|Organisations?|Ministerio|Ministry|Centros?|Centers?|Centres?|Institute|Universit(?:y|ies)|Societ(?:y|ies)|Association|Asociaci[oó]n|Federaci[oó]n|Federation|Fundaci[oó]n|Foundation|Department|Agenc(?:y|ies)|Council|Committee|Commission|Hospital|United Nations|WHO|OMS|UNICEF|UNESCO|OECD|NCI|CDC|NIH|NHS)\b/i
    .test(s);
}

function parseWebFallback(t, res) {
  /* Rama de página web, también para referencias sin cola de revista.
   * v0.1.7: no inventa una revista ni deja el título en "."; separa
   * autores, título, año y Lugar: Editorial. */
  res.type = "webpage";
  let text = t.replace(/\s+/g, " ").trim().replace(/^[.;\s]+/, "");
  let [autores, etAl, fl, resto] = splitAutores(text);
  res.flags.push(...fl);
  if (autores.length === 0) {
    const partes = splitFirst(text, DOT_SPACE_RE);
    const primero = partes[0].trim().replace(/\.+$/, "");
    if (partes.length === 2 && pareceInstitucion(primero)) {
      autores = [{ family: primero, given: "" }];
      res.flags = res.flags.filter((f) => f !== "sin autores reconocibles");
      res.flags.push("autor corporativo (sin iniciales)");
      resto = partes[1];
    } else {
      resto = text;
    }
  }
  res.authors = autores;
  res.etAl = etAl;
  resto = resto.trim().replace(/^[.;\s]+/, "");
  let partes = splitFirst(resto, DOT_SPACE_RE);
  let titulo = partes[0].trim();
  let cola = partes.length > 1 ? partes[1].trim() : "";
  if (!titulo || titulo === ".") titulo = resto.trim();
  res.title = titulo.replace(/\.+$/, "").trim();
  // Año: el último de la cola (el de la publicación, no el de acceso).
  const years = [...cola.matchAll(/\b((?:19|20)\d{2})\b/g)];
  if (years.length) res.year = years[years.length - 1][1];
  // "Lugar: Editorial; Año" (la editorial no debe tragarse el año).
  const mPp = /^(?<place>.+?):\s*(?<publisher>.+?)(?:[;.]\s*(?:19|20)\d{2}\b.*)?$/i
    .exec(cola);
  if (mPp) {
    const place = mPp.groups.place.trim();
    const publisher = mPp.groups.publisher.trim().replace(/[.;]+$/, "");
    if (place && !/^(?:19|20)\d{2}$/.test(place)) {
      res.place = place;
      res.publisher = publisher;
    }
  }
  return res;
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
  // Quitar numeración inicial "12. " y etiquetas de "Citar como:".
  // Las webs cubanas (Rev Ciencias Médicas, etc.) ponen "Citar como:"
  // delante de los autores y antes se colaba en el título.
  t = t.replace(/^\d+\.\s*/, "");
  t = t.replace(/^(?:c[oó]mo citar|citar como|cite as)\s*[:.]\s*/i, "");
  res.rawClean = t.replace(/\s+/g, " ").trim();

  // [citado ...] / [cited ...] -> fecha de acceso; se quita del texto.
  const mAcc = /\[(?:citado|cited)\s+([^\]]*)\]/i.exec(t);
  if (mAcc) {
    res.accessed = mAcc[1].trim();
    t = (t.slice(0, mAcc.index) + " " + t.slice(mAcc.index + mAcc[0].length))
      .replace(/\s+/g, " ").trim();
  }
  // [Internet] y menciones de soporte: no aportan a los campos.
  t = t.replace(/\s*\[(?:Internet|Epub ahead of print|Resumen|Abstract)\]/gi, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\s+/g, " ").trim();

  // URL: se guarda SIEMPRE antes de decidir el tipo. v0.1.7: que una
  // referencia traiga "Disponible en:" no la convierte en página web;
  // puede ser un artículo de revista con enlace.
  const mUrl = /(https?:\/\/[^\s<>"]+)/i.exec(t);
  if (mUrl) {
    res.url = mUrl[1].replace(/[.,;]+$/, "");
    const doiInUrl = DOI_RE.exec(res.url);
    if (doiInUrl) {
      res.doi = doiInUrl[0].replace(/[.,;]+$/, "");
    }
    t = (t.slice(0, mUrl.index) + " " + t.slice(mUrl.index + mUrl[0].length))
      .replace(/\s+/g, " ").trim();
  }
  // "Disponible en: www..." sin esquema.
  const mLabel = /(?:Disponible en|Available from):\s*(\S+)/i.exec(t);
  if (mLabel) {
    let u = mLabel[1].replace(/[.,;]+$/, "");
    if (!res.url && /^www\./i.test(u)) res.url = "http://" + u;
    t = (t.slice(0, mLabel.index) + " " + t.slice(mLabel.index + mLabel[0].length))
      .replace(/\s+/g, " ").trim();
  }
  // Restos de la etiqueta al final ("... . Disponible en:").
  t = t.replace(/[.;\s]*(?:Disponible en|Available from):?\s*$/i, "").trim();

  const doiM = DOI_RE.exec(t);
  if (doiM) {
    if (!res.doi) res.doi = doiM[0].replace(/[.,;]+$/, "");
    t = t.slice(0, doiM.index) + t.slice(doiM.index + doiM[0].length);
    t = t.replace(/\s+/g, " ").trim();
    // Quedan restos del DOI: "doi: ", "https://doi.org/"
    t = t.replace(/https?:\/\/(?:dx\.)?doi\.org\/?\s*$/, "");
    t = t.replace(/[\s.,;]*\bdoi\s*:?\s*\.?\s*$/i, "");
    t = t.replace(/[ .;]+$/, "");
  }

  // --- capítulo de libro: "Autores. Título. En: ..." ---
  // Dos formas reales:
  //   a. "En: Editor(es), editor. Libro. 12th ed. Lugar: Editorial; Año. p. 123-45."
  //   b. "En: Libro [Internet]. Lugar: Editorial; Año."
  const chapterMarker = /\.\s*(?:En|In):\s*/i.exec(t);
  if (chapterMarker) {
    res.type = "chapter";
    const head = t.slice(0, chapterMarker.index);
    const rest = t.slice(chapterMarker.index + chapterMarker[0].length).trim();
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

  // --- libro completo con edición explícita ---
  const mBook = BOOK_EDITION_RE.exec(t);
  if (mBook) {
    const head = t.slice(0, mBook.index).replace(/[.\s]+$/, "");
    const [autores, etAl, fl, titulo] = splitAutores(head);
    res.type = "book";
    res.authors = autores;
    res.etAl = etAl;
    res.flags.push(...fl);
    res.title = titulo.trim();
    res.edition = mBook.groups.edition;
    res.place = mBook.groups.place.trim();
    res.publisher = mBook.groups.publisher.trim();
    res.year = mBook.groups.year;
    if (mBook.groups.pages) {
      const [pages, pagesEnd] = expandirPaginas(mBook.groups.pages);
      res.pages = pages;
      res.pagesEnd = pagesEnd;
    }
    return res;
  }

  // --- artículo de revista ---
  const m = TAIL_RE.exec(t);
  if (!m) {
    res.flags.push("sin cola Año;Volumen(Número):Páginas reconocible");
    // v0.1.7: en vez de dejar un ítem "document" vacío, se intenta la
    // rama de página web (título, año, Lugar: Editorial y URL).
    const fallback = parseWebFallback(t, res);
    if ((fallback.year || fallback.url || fallback.publisher) &&
      fallback.title && fallback.authors.length) {
      fallback.flags = fallback.flags.filter((flag) =>
        flag !== "sin cola Año;Volumen(Número):Páginas reconocible"
      );
    }
    return fallback;
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
  const [restoProt, restaurar] = protegerAbbr(resto);
  // String.split con grupo capturador devuelve los separadores
  // intercalados, igual que re.split de Python.
  const partes = restoProt.split(/([.?!])\s+/);
  const seg = partes.filter((_, i) => i % 2 === 0);
  const term = partes.filter((_, i) => i % 2 === 1);
  if (seg.length < 2) {
    res.flags.push("no se separa Título. Revista");
    return parseWebFallback(t, res);
  }
  let journalStart = seg.length - 1;
  let abbreviatedSuffix = 0;
  for (let i = seg.length - 1; i > 0; i--) {
    if (/^[A-Z][A-Za-z]{0,3}$/.test(seg[i].trim()) &&
      term[i - 1] === ".") {
      abbreviatedSuffix++;
    }
    else {
      break;
    }
  }
  if (abbreviatedSuffix >= 2) {
    journalStart = seg.length - abbreviatedSuffix;
  }
  else if (seg.length >= 3 &&
    /^[A-Z]$/.test(seg[seg.length - 2].trim()) &&
    term[seg.length - 2] === ".") {
    journalStart = seg.length - 2;
  }
  if (journalStart > 1) {
    res.flags.push(
      "el título contiene límites de frase internos; la división Título/Revista es una suposición"
    );
  }
  res.journal = restaurar(seg.slice(journalStart).join(". ").trim());
  let titulo = restaurar(seg.slice(0, journalStart).join(". ").trim());
  // term[k] es el terminador DESPUÉS de seg[k].
  const titleTerminator = term[journalStart - 1];
  if (titleTerminator === "?" || titleTerminator === "!") {
    titulo += titleTerminator;
  }
  res.title = titulo;
  return res;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseReferencia, splitAutores, expandirPaginas, protegerAbbr };
}
