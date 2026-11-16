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
// S6: el token de página admite también números romanos («iv»,
// «xii»): las páginas de preliminares vienen en romanos
// («2020;15:iv-xii») y el token no las veía — el artículo caía a
// webpage sin revista ni páginas. Solo vale tras «año;volumen:»,
// así que una palabra romana ahí ES páginas.
const PAGE_TOKEN = "(?:[A-Za-z]?(?:\\d{1,3}(?:,\\d{3})*|\\d+)(?:\\.e\\d+)?|[ivxlcdmIVXLCDM]+)";
const TAIL_RE = new RegExp(
  "\\[?(?<year>\\d{4})(?:\\s+(?<month>" + MESES + ")[a-z]*)?" +
    "(?:\\s+\\d{1,2})?\\]?" +
    "\\s*[;,]\\s*(?<volume>\\d+[A-Za-z]?)" +
    "(?:\\((?<issue>[^)]+)\\)|\\s*(?<suppl>Suppl\\.?|Supplement)\\s*(?<supplNum>\\d+)?)?" +
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

// Un ")" o "]" final sin su apertura es cierre del texto, no del
// DOI ("doi: 10.1234/abc)." -> "10.1234/abc"). Se quita solo el
// exceso de cierres: un DOI con "(SICI)" equilibrado queda intacto.
function limpiarDoi(doi) {
  let d = doi;
  const abrePar = (d.match(/\(/g) || []).length;
  const cierraPar = (d.match(/\)/g) || []).length;
  let excesoPar = cierraPar - abrePar;
  while (excesoPar > 0 && d.endsWith(")")) {
    d = d.slice(0, -1);
    excesoPar--;
  }
  const abreCor = (d.match(/\[/g) || []).length;
  const cierraCor = (d.match(/\]/g) || []).length;
  let excesoCor = cierraCor - abreCor;
  while (excesoCor > 0 && d.endsWith("]")) {
    d = d.slice(0, -1);
    excesoCor--;
  }
  return d;
}
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
  "[\\p{L}][\\p{L}\\p{M}0-9_'\\-]*(?:\\s+(?![A-Z](?![\\p{L}])|[yY]\\b|[aA][nN][dD]\\b|[eE][tT]\\b|[aA][lL]\\b)[\\p{L}][\\p{L}\\p{M}0-9_'\\-]*)*";
const _GIVEN =
  "[A-Z]{1,4}(?:(?:\\s*[" + DASHES + "]\\s*|\\s+)[A-Z]{1,4})*";
const COMMA_AUTHOR_RE = new RegExp(
  "^(?<family>" + _FAM + "),\\s*(?<given>" +
    "[A-Z][\\p{L}\\p{M}'’\\-]*\\.?" +
    "(?:\\s+[A-Z]{1,4}(?![\\p{L}])\\.?)*)",
  "u"
);
const AUTHOR_START_RE = new RegExp(
  "^(?<family>" + _FAM + ")\\s+(?<given>" + _GIVEN + ")(?=[,.:]|\\s+y\\s|\\s+and\\s|\\s+&\\s|$)",
  "u"
);
const AUTHOR_SUFFIX_START_RE = new RegExp(
  "^(?<family>" +
    _FAM +
    ")\\s+(?<given>" +
    _GIVEN +
    ")\\s+(?<suffix>2nd|3rd|Jr\\.?|Sr\\.?|II|III|IV)(?=[,.:]|\\s+y\\s|\\s+and\\s|\\s+&\\s|$)",
  "u"
);

// Nombre de pila completo: "Smith John", "García María José".
// El apellido es UNA palabra; el de varias palabras con partículas
// ("de la Cruz") lo cubre AUTHOR_START_RE con iniciales. La forma
// sin coma "Mary Ann Smith" es ambigua (¿apellido Mary o Smith?);
// se toma el primer token como apellido y se marca en DECISIONES.md.
const AUTHOR_FULLNAME_RE = new RegExp(
  "^(?<family>[\\p{L}][\\p{L}\\p{M}'’\\-]*)\\s+" +
    "(?<given>[A-Z][\\p{L}\\p{M}'’\\-]+" +
    "(?:[\\s\\-][A-Z][\\p{L}\\p{M}'’\\-]+)?)(?=[,.:]|\\s+y\\s|\\s+and\\s|\\s+&\\s|$)",
  "u"
);

// Nombre de pila completo ("John", "María José", "Jean-Pierre") ->
// iniciales ("J", "MJ", "JP").
function inicialesDeNombre(nombre) {
  return nombre
    .split(/[\s\-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase())
    .join("");
}

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
  /^(?<editors>.+?),\s+editors?\.\s+(?<book>[^.]+?)\.\s+(?:(?<edition>\d+(?:st|nd|rd|th)\s+ed\.?|\d+\.?\s*[ªa]\s*ed\.?)\s+)?(?<place>.+?):\s*(?<publisher>.+?);\s*(?<year>\d{4})\.?(?:\s+p{1,2}\.\s*(?<pages>[A-Za-z]?\d+(?:\s*[-\u2010-\u2015\u2212]\s*[A-Za-z]?\d+)?))?\.?\s*$/;
// Capítulo simple: "En: StatPearls [Internet]. Treasure Island (FL): StatPearls Publishing; 2025."
const CHAPTER_SIMPLE_RE =
  /^(?<book>[^.]+?)(?:\s*\[(?<medium>[^\]]+)\])?\.\s*(?<place>.+?):\s*(?<publisher>.+?);\s*(?<year>\d{4})\.?(?:\s+p{1,2}\.\s*(?<pages>[A-Za-z]?\d+(?:\s*[-\u2010-\u2015\u2212]\s*[A-Za-z]?\d+)?))?\.?\s*$/;
const BOOK_EDITION_RE =
  /\.\s*(?<edition>\d+(?:st|nd|rd|th)\s+ed\.?|\d+\.?\s*[ªa]\s*ed\.?)\s*(?<place>[^:;]+):\s*(?<publisher>[^;]+);\s*(?<year>(?:19|20)\d{2})\.?(?:\s+(?:pp?\.|pages?)\s*(?<pages>[A-Za-z]?\d+(?:\s*[-\u2013\u2014]\s*[A-Za-z]?\d+)?))?\.?\s*$/i;

// Python re.split(patrón, texto, maxsplit=1): devuelve [antes, después]
// de la PRIMERA ocurrencia, o [texto] si no hay coincidencia.
function splitFirst(s, re) {
  const m = re.exec(s);
  if (!m) return [s];
  return [s.slice(0, m.index), s.slice(m.index + m[0].length)];
}
const DOT_SPACE_RE = /\.\s+/;

// Divide en la PRIMERA frase, sin cortar dentro de una abreviatura
// de iniciales con puntos («U.S.», «U.K.», «E.U.», «U.S.A.»): el
// primer «. » tras «U.S» no es un límite de frase, y cortar ahí
// dejaba el título en «U.S» (N13/M14). Se usa en parseWebFallback
// (título y chequeo corporativo); la rama de artículo ya protege
// las abreviaturas con protegerAbbr.
function splitPrimeraFrase(s) {
  const re = /\.\s+/g;
  let m;
  while ((m = re.exec(s))) {
    const antes = s.slice(0, m.index);
    if (/(?:^|\s)[A-Z](?:\.[A-Z])*$/.test(antes)) continue;
    // Q4: tampoco cortar DESPUÉS de una abreviatura con minúscula
    // («Ph.D.»): el «. » tras «Ph.D» no es un límite de frase. La
    // guarda vieja solo cubre iniciales en mayúsculas («U.S.»); esta
    // exige al menos un punto en el token final, así que «St» (St.
    // Louis) NO casa y se sigue partiendo ahí (preexistente, no
    // reabrir).
    if (/(?:^|\s)[A-Z][a-z]?(?:\.[A-Z][a-z]?)+$/.test(antes)) continue;
    // Q4: no cortar dentro de una abreviatura con minúscula
    // («Ph.D.»): en «The Ph. D.» el `antes` termina en «Ph»
    // (capital + minúscula) y detrás viene «D.», así que el «. » es
    // interno a la abreviatura, no un límite de frase. «St. Louis»
    // no se toca: detrás de «St. » viene «Louis», no una inicial
    // con punto.
    if (/(?:^|\s)[A-Z][a-z]?$/.test(antes) && /^[A-Z]\./.test(s.slice(m.index + m[0].length))) continue;
    return [s.slice(0, m.index), s.slice(m.index + m[0].length)];
  }
  return [s];
}

function splitAutoresEstandar(head) {
  /* Rama "Apellido Iniciales" / "Apellido Nombre" / sufijos.
   * Consume el bloque de autores desde el inicio de `head`; los autores
   * terminan con ". " (Vancouver ICMJE) o ": " (estilo Cureus).
   * Devuelve [autores, etAl, flags, resto] como splitAutores. */
  const autores = [];
  const flags = [];
  let pos = 0;
  let etAl = false;
  const n = head.length;
  const SEPARADORES = [", ", " y ", " and ", " & "];
  while (pos < n) {
    if (autores.length > 0) {
      // Separador entre autores: ", " o " y " / " and " (listas en
      // español). Solo se consume si detrás viene otro autor; si no,
      // es el fin del bloque y el resto queda intacto.
      let sepLen = 0;
      for (const sep of SEPARADORES) {
        if (!head.startsWith(sep, pos)) continue;
        const despues = head.slice(pos + sep.length);
        if (
          AUTHOR_START_RE.test(despues) ||
          AUTHOR_SUFFIX_START_RE.test(despues) ||
          AUTHOR_FULLNAME_RE.test(despues) ||
          /^et\s+al\.?(?=[\s,.:;]|$)/i.test(despues)
        ) {
          sepLen = sep.length;
          break;
        }
      }
      if (!sepLen) break;
      pos += sepLen;
    }
    const restoHead = head.slice(pos);
    if (/^et\s+al\.?(?=[\s,.:;]|$)/i.test(restoHead)) {
      etAl = true;
      flags.push("et_al: hay más autores no listados en el texto");
      pos += /^et\s+al\.?/i.exec(restoHead)[0].length;
      break;
    }
    const m = AUTHOR_START_RE.exec(restoHead);
    const m2 = m ? null : AUTHOR_SUFFIX_START_RE.exec(restoHead);
    const m3 = m || m2 ? null : AUTHOR_FULLNAME_RE.exec(restoHead);
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
    } else if (m3) {
      autores.push({
        family: m3.groups.family,
        given: inicialesDeNombre(m3.groups.given),
      });
      pos += m3[0].length;
    } else {
      break;
    }
  }
  let resto = head.slice(pos);
  const mCol = /^\s+(?:y|and)\s+col\.?(?=[\s,.:;]|$)/i.exec(resto);
  if (mCol) {
    etAl = true;
    flags.push("et_al: hay más autores no listados en el texto");
    resto = resto.slice(mCol[0].length);
  }
  // Un " y " / " and " que quedó colgando (separador cuyo autor no
  // se reconoció) no es parte del título.
  resto = resto.replace(/^(?:y|and)\s+/i, "");
  if (resto.startsWith(". ") || resto.startsWith(": ")) resto = resto.slice(2);
  else if (resto.startsWith(".") || resto.startsWith(":"))
    resto = resto.slice(1).replace(/^\s+/, "");
  if (autores.length === 0) flags.push("sin autores reconocibles");
  return [autores, etAl, flags, resto];
}

function splitAutores(head) {
  /* Consume el bloque de autores desde el inicio de `head`.
   *
   * Dos estrategias compiten y gana la que reconozca MÁS autores:
   *   - "Apellido, Nombre" (con coma): "Smith, John, Doe, Jane."
   *   - estándar: "Smith J, Doe A." / "Smith John, Doe Jane."
   * En empate gana la de coma (comportamiento histórico). Así
   * "Smith John, Doe Jane" ya no se traga "Doe" como nombre de pila
   * de "Smith John" (rama de coma, 1 autor) frente a 2 autores
   * reales de la rama estándar.
   */
  const firstSentence = splitFirst(head, DOT_SPACE_RE);
  // Autor corporativo: la primera frase es SOLO el nombre ("World
  // Health Organization. Guideline..."). Si la frase trae ", " (lista
  // de autores) o ": " (estilo Cureus) o es muy larga, la institución
  // está en el TÍTULO ("...by the Cardiovascular and Interventional
  // Radiological Society of Europe") y no es el autor (Onishi refs 1
  // y 2 se tragaban el título entero como autor corporativo).
  const primera = firstSentence[0].trim();
  if (
    firstSentence.length === 2 &&
    pareceInstitucion(primera) &&
    !/, /.test(primera) &&
    !/: /.test(primera) &&
    primera.split(/\s+/).length <= 10
  ) {
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
  const estandar = splitAutoresEstandar(head);
  if (commaAuthors && commaAuthors[0].length >= estandar[0].length) {
    return commaAuthors;
  }
  return estandar;
}

// ¿Parece este segmento parte del nombre abreviado de una revista?
// Todas las palabras empiezan en mayúscula y la última es corta
// (≤4 letras): "Rev", "Cubana Med", "J", "Engl", "N Engl J Med".
// Un título normal tiene minúsculas ("del", "en el") y no pasa.
function esSegmentoRevista(seg) {
  const palabras = seg.trim().split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return false;
  if (!/^[A-Z][A-Za-z]{0,3}$/.test(palabras[palabras.length - 1])) return false;
  return palabras.every((p) => /^[A-ZÁÉÍÓÚÑ]/.test(p));
}

function protegerAbbr(texto) {
  /* Sustituye 'e.g.', 'U.S.'... por tokens sin punto para no romper
   * la división por frases. Devuelve [textoProtegido, restaurador].
   * N13: además de la lista fija, cualquier abreviatura de
   * iniciales con puntos («U.K.», «E.U.», «U.S.A.») se protege
   * sustituyendo sus puntos por U+2024 (se restauran después): la
   * lista fija no cubre todas las siglas y el título se partía en
   * «U.K». Un U+2024 original en el texto (inexistente en refs
   * Vancouver) se convertiría en «.» al restaurar. */
  const protegido = texto
    .replace(ABBR_RE, (m) => ABBR[m])
    .replace(/\b(?:[A-Z]\.){2,}/g, (m) => m.replace(/\./g, "․"));
  const restaurar = (s) =>
    s.replace(ABBR_RESTORE_RE, (m) => ABBR_INV[m]).replace(/․/g, ".");
  return [protegido, restaurar];
}

function expandirPaginas(paginas) {
  /* '144-7' -> ['144', '147']; 'S10-5' -> ['S10', 'S15'];
   * 'e33479' -> ['e33479', null]; '140' -> ['140', null].
   * v0.1.7: acepta guion largo/signo menos y páginas electrónicas
   * ('6.e1–6.e7' -> ['6.e1', '6.e7']). */
  const norm = String(paginas)
    .replace(/,/g, "")
    .replace(/\s*[-\u2010-\u2015\u2212]\s*/g, "-")
    .trim();
  // S6: rango romano («iv-xii» -> ['iv', 'xii']): no hay dígitos
  // que expandir (la regla Vancouver de heredar dígitos no aplica).
  const mRom = /^([ivxlcdm]+)-([ivxlcdm]+)$/i.exec(norm);
  if (mRom) return [mRom[1], mRom[2]];
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
  // Q4: un título que EMPIEZA por «The»/«A»/«An» + abreviatura con
  // puntos («The Ph.D. thesis…», «A M.D. approach…») no se lee como
  // autor: splitAutores ve «The» como apellido y «P» (de «Ph.») como
  // inicial y deja resto «D. thesis…» con título «D» y un autor
  // inventado. Si el único autor es una palabra común seguida de una
  // abreviatura prieta (capital + minúscula opcional + punto,
  // repetida: «Ph.D.», «M.D.», «U.S.»), no hay autor: el título es
  // el texto entero. P7 no lo cubre: su abreviatura prieta es solo
  // de iniciales («P.D.» no está en «Ph.D.»).
  if (autores.length === 1 && autores[0].given.length === 1 &&
    /^(?:The|A|An)$/i.test(autores[0].family)) {
    const trasPalabra = text.slice(autores[0].family.length).trimStart();
    if (/^[A-Z][a-z]?\.(?:[A-Z][a-z]?\.)+/.test(trasPalabra)) {
      resto = text;
      autores = [];
      if (!res.flags.includes("sin autores reconocibles")) res.flags.push("sin autores reconocibles");
    }
  }
  // P7: un título que TERMINA en abreviatura con puntos («Guidelines
  // of the U.S.», «…U.S.A.») no se lee como autor: splitAutores ve
  // «Guidelines of the U» como apellido+inicial y deja resto «S.
  // Available from: …» (o «S.» / «S.A» — parseReferencia quita la
  // URL antes de llamar aquí y la etiqueta se come el punto final),
  // con title «S» y un autor inventado. Si el único autor tiene una
  // sola inicial, el resto empieza por la cola de la abreviatura
  // (una o más iniciales con puntos) y en el texto original ambas
  // forman la abreviatura prieta («U.S.», «U.S.A.»), se deshace ese
  // «autor»: el título vuelve a ser el texto entero y el ítem queda
  // sin autores (con flag). «Doe A. E. Title…» no dispara: en el
  // original no hay «A.E.» prieto.
  const mRestoAbbr = autores.length === 1 && resto.length > 0
    ? /^([A-Z](?:\.[A-Z])*)(?=\.|$|\s)/.exec(resto) : null;
  const abbrPrieta = mRestoAbbr ? autores[0].given + "." + mRestoAbbr[1] : "";
  const esAbbrPrieta = abbrPrieta !== "" &&
    (text.includes(abbrPrieta + ".") || text.endsWith(abbrPrieta));
  if (autores.length === 1 && autores[0].given.length === 1 && esAbbrPrieta) {
    resto = autores[0].family + " " + autores[0].given + "." + resto;
    autores = [];
    if (!res.flags.includes("sin autores reconocibles")) res.flags.push("sin autores reconocibles");
  }
  if (autores.length === 0) {
    // N13: sin cortar dentro de «U.S.» — «U.S. Department of
    // Health. Guidelines…» tiene como primera frase la institución,
    // no «U.S».
    const partes = splitPrimeraFrase(text);
    const primero = partes[0].trim().replace(/\.+$/, "");
    // Misma guarda que en splitAutores: sin ", " ni ": " y corta, o
    // la institución está en el título y no es el autor.
    if (
      partes.length === 2 &&
      pareceInstitucion(primero) &&
      !/, /.test(primero) &&
      !/: /.test(primero) &&
      primero.split(/\s+/).length <= 10
    ) {
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
  // N13/M14: el título no se corta en el primer «. » si es el de
  // una abreviatura de iniciales («U.S. guidelines…» → título
  // completo, no «U.S»).
  let partes = splitPrimeraFrase(resto);
  let titulo = partes[0].trim();
  let cola = partes.length > 1 ? partes[1].trim() : "";
  // P7: si el título no se partió en ninguna frase y trae el
  // marcador de cita o la URL, el título termina antes del marcador
  // («Guidelines of the U.S. Available from: …» → «Guidelines of
  // the U.S.»): sin esto, una web sin autor y sin año dejaría el
  // marcador y la URL dentro del título.
  if (partes.length === 1) {
    const cut = titulo.search(/(?:available from|disponible en)\s*:?\s*(?:https?:\/\/|www\.)|https?:\/\/|www\./i);
    if (cut !== -1) titulo = titulo.slice(0, cut).trim();
  }
  if (!titulo || titulo === ".") titulo = resto.trim();
  // P7: un título que termina en abreviatura de iniciales
  // («Guidelines of the U.S.») conserva su punto final: el strip
  // habitual se lo comería y dejaría «Guidelines of the U.S». Y si
  // el punto ya venía comido (la etiqueta «Available from:» se lo
  // llevó en parseReferencia), se RESTAURA: la abreviatura lleva su
  // punto («Guidelines of the U.S» → «Guidelines of the U.S.»).
  const terminaEnAbbr = /(?:^|\s)[A-Z](?:\.[A-Z])+\.?$/u.test(titulo);
  const tituloLimpio = titulo.trim();
  res.title = terminaEnAbbr
    ? (tituloLimpio.endsWith(".") ? tituloLimpio : tituloLimpio + ".")
    : tituloLimpio.replace(/\.+$/, "");
  // Año: el último de la cola (el de la publicación, no el de acceso).
  const years = [...cola.matchAll(/\b((?:19|20)\d{2})\b/g)];
  if (years.length) res.year = years[years.length - 1][1];
  // "Lugar: Editorial; Año" (la editorial no debe tragarse el año).
  // Solo vale la forma completa "Lugar: Editorial; Año": sin el
  // "; Año" final, una cola de revista rota ("J Urol. 2020;15...") se
  // colaría como lugar/editorial inventados.
  const mPp = /^(?<place>[^:;\d]+):\s*(?<publisher>[^;\d][^;]*?)[;.]\s*(?:19|20)\d{2}\b/i
    .exec(cola);
  if (mPp) {
    const place = mPp.groups.place.trim();
    const publisher = mPp.groups.publisher.trim().replace(/[.;]+$/, "");
    if (place) {
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
  t = t.replace(/\s*\[(?:Internet|Epub[^\]]*|Resumen|Abstract)\]/gi, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\s+/g, " ").trim();

  // URL: se guarda SIEMPRE antes de decidir el tipo. v0.1.7: que una
  // referencia traiga "Disponible en:" no la convierte en página web;
  // puede ser un artículo de revista con enlace.
  const mUrl = /(https?:\/\/[^\s<>"]+)/i.exec(t);
  // El DOI de la URL es solo un respaldo: el DOI etiquetado
  // explícitamente («doi: 10....») gana si existe (L2). Se guarda
  // aparte y se resuelve tras el bucle de DOI.
  let doiDeUrl = "";
  if (mUrl) {
    res.url = mUrl[1].replace(/[.,;]+$/, "");
    const doiInUrl = DOI_RE.exec(res.url);
    if (doiInUrl) {
      doiDeUrl = doiInUrl[0].replace(/[.,;]+$/, "");
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

  // Puede haber DOS DOI (el del texto y el de "doi: ..." al final, o
  // una corrección): se quitan TODOS. El primero se guarda; los demás
  // solo se eliminan del texto. Antes solo se quitaba el primero y el
  // segundo rompía la cola (la referencia caía en la rama web). El
  // bucle termina porque cada vuelta quita un DOI del texto. Si hay
  // varios DOI explícitos DISTINTOS, se marca con flag (N10): antes
  // los extras se perdían en silencio (el mismo DOI dos veces no
  // levanta flag).
  let doiM;
  const doisExplicitos = [];
  while ((doiM = DOI_RE.exec(t))) {
    const d = limpiarDoi(doiM[0].replace(/[.,;]+$/, ""));
    if (!res.doi) res.doi = d;
    if (!doisExplicitos.includes(d)) doisExplicitos.push(d);
    t = (t.slice(0, doiM.index) + " " + t.slice(doiM.index + doiM[0].length))
      .replace(/\s+/g, " ")
      .trim();
  }
  // Quedan restos del DOI: "doi: ", "https://doi.org/". Con DOS DOI
  // quedan DOS "doi:" sueltos al final, así que se repite hasta que
  // el texto deje de cambiar (antes solo se quitaba uno y la cola no
  // casaba).
  let antes;
  do {
    antes = t;
    t = t.replace(/https?:\/\/(?:dx\.)?doi\.org\/?\s*$/, "");
    t = t.replace(/[\s.,;]*\bdoi\s*:?\s*\.?\s*$/i, "");
    t = t.replace(/[ .;]+$/, "");
  } while (t !== antes);

  // El DOI etiquetado «doi:» gana sobre el de la URL; si no hay
  // explícito, vale el de la URL. Si difieren, se marca la
  // ambigüedad con flag (L2): antes ganaba el de la URL en silencio.
  if (!res.doi && doiDeUrl) {
    res.doi = limpiarDoi(doiDeUrl);
  } else if (res.doi && doiDeUrl && res.doi !== limpiarDoi(doiDeUrl)) {
    res.flags.push("dos DOI distintos: se guardó el de «doi:»");
  }
  // Varios DOI explícitos distintos (N10): se guardó el primero.
  if (doisExplicitos.length > 1) {
    res.flags.push("varios DOI distintos: se guardó el primero");
  }

  // PMID/PMCID al final: son metadatos, no parte de la cola; si no se
  // quitan, la cola no casa y la referencia cae en la rama de web.
  t = t
    .replace(/\s*\bPMID:\s*\d+\.?/gi, "")
    .replace(/\s*\bPMCID:\s*PMC\d+\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  // S4: sufijo «Epub» al final («(Epub 2020 Jan 15).» o «Epub 2020
  // Jan 15.»): PubMed lo pone tras el doi (o antes, «(Epub ahead of
  // print). doi: …»); si no se quita, la cola no casa y el artículo
  // cae a webpage sin revista/volumen/páginas. Se quita aquí, tras
  // extraer el DOI, y se limpia el «doi:» huérfano que quedaba
  // antes del sufijo (la limpieza de restos de DOI ya pasó).
  // U3 (ronda 15): año de 2 dígitos también («Epub 20 Jan 15»):
  // PubMed usa 4, pero un «20» no es título y sin esto el artículo
  // caía a webpage sin revista/volumen/páginas.
  t = t.replace(/\s*\(?\s*Epub\s+(?:\d{2,4}\b|ahead\b)[^)]*\)?\.?\s*$/i, "").trim();
  t = t
    .replace(/[\s.,;]*\bdoi\s*:?\s*\.?\s*$/i, "")
    .replace(/[ .;]+$/, "")
    .trim();

  // --- capítulo de libro: "Autores. Título. En: ..." ---
  // Dos formas reales:
  //   a. "En: Editor(es), editor. Libro. 12th ed. Lugar: Editorial; Año. p. 123-45."
  //   b. "En: Libro [Internet]. Lugar: Editorial; Año."
  const chapterMarker = /([.!?])\s*(?:En|In):\s*/i.exec(t);
  if (chapterMarker) {
    res.type = "chapter";
    const head =
      t.slice(0, chapterMarker.index) +
      (chapterMarker[1] === "." ? "" : chapterMarker[1]);
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
    // El flag "sin cola" solo se borra si el fallback recuperó una
    // página web GENUINA: con URL o con forma "Lugar: Editorial;
    // Año", y SIN patrón año+volumen en el texto. Un artículo cuya
    // cola está rota por un detalle (coma de miles, corchetes, DOI
    // extra, volumen romano) huele a revista por su "2020;15" y NO
    // debe convertirse en página web sin revista ni páginas Y SIN
    // AVISAR. Como el fallback nunca recupera una revista (journal
    // siempre queda ""), en cualquier otro caso el flag se conserva.
    const patronAnioVolumen = /\[?(?:19|20)\d{2}\]?[;,]\s*\d+/;
    const esWebGenuina =
      !!fallback.url || !!(fallback.place && fallback.publisher);
    if (
      (fallback.year || fallback.url || fallback.publisher) &&
      fallback.title && fallback.authors.length &&
      esWebGenuina && !patronAnioVolumen.test(t)
    ) {
      fallback.flags = fallback.flags.filter((flag) =>
        flag !== "sin cola Año;Volumen(Número):Páginas reconocible"
      );
    }
    return fallback;
  }
  res.year = m.groups.year;
  res.month = m.groups.month || "";
  res.volume = m.groups.volume;
  res.issue =
    m.groups.issue ||
    (m.groups.suppl
      ? "Suppl" + (m.groups.supplNum ? " " + m.groups.supplNum : "")
      : "");
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
  // La revista es el sufijo del resto: retroceder mientras el segmento
  // anterior sea parte de ella (ver esSegmentoRevista). Así "J. Urol."
  // y "Rev. Cubana Med." quedan enteras como revista en vez de partirse
  // por el primer ". " interno de la abreviatura.
  let journalStart = seg.length - 1;
  while (
    journalStart > 0 &&
    term[journalStart - 1] === "." &&
    esSegmentoRevista(seg[journalStart - 1])
  ) {
    journalStart--;
  }
  if (journalStart > 1 || journalStart === 0) {
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
