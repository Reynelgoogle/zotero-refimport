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
 * "(1)" o "1 -". Un solo helper para el segmentador y el fallback.
 * El guion exige un espacio después («1 - Smith»): sin él,
 * «5-year outcomes…» se leería como la ref nº 5 (S1).
 * R15 (U1): sin espacio tras el guion, el lookahead de mayúscula
 * solo NO basta («10-Year», «2-Stage», «3-Dimensional», «1-Phase»
 * son títulos reales y se tragaban la lista entera en PDF): la
 * variante sin espacio solo vale cuando el resto parece referencia
 * — iniciales de autor («Smith J.», «De la Cruz M.», «Smith J Jr.»)
 * o cola de revista/libro («;15:1-5», «; 2021», con el resto
 * empezando en mayúscula, para no reabrir «1-smith»). Un título
 * con cola («… J Urol. 2020;15:1-5.») cuenta como referencia por
 * esa vía; un título+URL sin cola no. La clase de guiones incluye
 * U+2010 y U+2011 (U4), como DASHES/PALABRA_TITULO.
 * Prefijo «Nº» / «No.» / «N.» («Nº 1. Smith...», N7): se pela antes
 * de leer el número; el grupo es no capturador, así m[1..5] no se
 * mueven. Sin dígito detrás no casa («N. Smith» no es un número).
 * Numeración romana ("i.", "ii.", "iii."): rara en Vancouver, pero
 * existe; se convierte a arábigo (L1). Tope en 50: una "c." o "d."
 * suelta no es el nº 100/500. */
const NUM_RE = /^(?:N[º°]\.?\s*|N\.\s+|No\.?\s+)?(?:\[(\d+)[a-zA-Z]?\]|\((\d+)[a-zA-Z]?\)|(\d+)[a-zA-Z]?[.)]|(\d+)[a-zA-Z]?\s*[-–—\u2010\u2011](?:\s+|(?=(?:[A-ZÁÉÍÓÚÜÑ][A-Za-zÁÉÍÓÚÜÑ'’\-]*(?: (?:[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ'’\-]+|[A-ZÁÉÍÓÚÜÑ]{2,}|de|la|van|der|den|ten|di|dos|das|do|el|al|bin|ibn)){0,3},? (?:[A-ZÁÉÍÓÚÜÑ]\.(?: ?[A-ZÁÉÍÓÚÜÑ]\.)*|[A-ZÁÉÍÓÚÜÑ]{2,3}\.|[A-ZÁÉÍÓÚÜÑ] (?:Jr|Sr)\.)|[A-ZÁÉÍÓÚÜÑ].*;\s*(?:\d+\s*:|(?:19|20)\d{2}\b)))))\s*(.*)$/;
const ROMAN_VALIDO_RE = /^(m{0,3})(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;
function romanANumero(s) {
  const VAL = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = VAL[s[i].toLowerCase()];
    const next = i + 1 < s.length ? VAL[s[i + 1].toLowerCase()] : 0;
    total += v < next ? -v : v;
  }
  return total;
}
function numDeLinea(s) {
  const m = NUM_RE.exec(s);
  if (m) {
    // "(2024)" o "[2024]" al inicio es un año entre paréntesis, no el
    // número de la referencia (una lista no tiene 2000 referencias).
    if ((m[1] || m[2]) && /^(?:19|20)\d{2}$/.test(m[1] || m[2])) return null;
    // Una línea DOI ("10.1007/s00261-...", "204. 10.1055/s-...") no es
    // la referencia 10 ni la 204: el resto es el sufijo del DOI
    // (dígitos, quizá con punto, y "/"). Sin esto, la línea suelta del
    // DOI cortaba la lista entera (Onishi ref 6) y la continuación de
    // página "194-204" también (Onishi ref 8).
    if (/^\d+(?:\.\d+)?\//.test(m[5])) return null;
    // R7: un año PELADO con URL en el resto («2020. Ver en
    // https://…») no es el número de la referencia: se lee como ref
    // nº 2020 (esperado 2021) y las líneas 1/2/3 se pegan a ella, así
    // que la lista entera se traga en una sola ref. Solo con URL en
    // el resto: «2020. Resultados del estudio.» (sin URL) sigue
    // abriendo como ref 2020 y se conserva con flag de subtítulo (H5).
    if ((m[3] || m[4]) && /^(?:19|20)\d{2}$/.test(m[3] || m[4]) && /https?:\/\/|www\./i.test(m[5])) return null;
    const num = parseInt(m[1] || m[2] || m[3] || m[4], 10);
    return { num, texto: m[5] };
  }
  // Numeración romana ("i.", "ii.", "iii."): sin esto la lista salía
  // vacía sin error (L1). La regex estricta evita tragarse palabras
  // ("mix." no es un número romano válido) y el tope en 50 evita que
  // una "c." o "d." suelta se lea como 100/500. Prefijo «Nº» (N7).
  const rm = /^(?:N[º°]\.?\s*|N\.\s+|No\.?\s+)?([ivxlcdm]+)[.)]\s*(.*)$/i.exec(s);
  if (rm && ROMAN_VALIDO_RE.test(rm[1])) {
    const n = romanANumero(rm[1]);
    if (n >= 1 && n <= 50) return { num: n, texto: rm[2] };
  }
  return null;
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
  "Ministry of [^.]+|University of [^.]+|Ministerio de [^.]+|Secretaría de [^.]+|Instituto [^.]+|Universidad [^.]+|Organización [^.]+|Organizacion [^.]+|WHO|OMS|UNICEF|UNESCO|OECD|NCI|CDC|NIH|NHS)";
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
  /\[?\b(?:19|20)\d{2}\]?[;,]\s*\d+[A-Za-z]?\s*(?:\((?:[^)]*)\)|Suppl\.?(?:\s*\d+)?)?\s*:\s*[A-Za-z]?\d+/;
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

/* ¿Empieza una lista tras este encabezado? En las 10 líneas
 * siguientes debe haber una línea que parezca el inicio de una
 * referencia:
 *   - una línea numerada cuyo texto parezca un autor, traiga año o
 *     traiga cola Vancouver ("1. Smith J. ..." sí; "1. Paciente A"
 *     no; la ref puede venir partida y el año/cola estar en las 2
 *     líneas siguientes);
 *   - una línea con cola Vancouver;
 *   - una línea sin numerar con pinta de autor.
 * Se aplica IGUAL al exacto que al parecido: un "Referencias" como
 * título de tabla/sección con filas numeradas detrás secuestraba la
 * extracción y la lista real se perdía (F1). Si ningún candidato
 * valida, la búsqueda devuelve -1 y el llamador prueba el fallback;
 * si tampoco hay corrida, lanza error: un encabezado exacto sin lista
 * detrás ya no devuelve 0 refs en silencio (F9). */
const ANIO_RE = /\b(?:19|20)\d{2}\b/;
const URL_RE = /https?:\/\/|www\./i;
const DISPONIBLE_RE = /available from:|disponible en:/i;
// «Geneva: WHO», «New York: Springer», «Madrid: Elsevier»: ciudad +
// editorial, la marca de un libro. El editor es un acrónimo (≥2
// mayúsculas) o una palabra de ≥4 letras: «Title: An analysis» no
// vale (el editor «An» es demasiado corto). «En:»/«In:» NO es un
// lugar: es el marcador de capítulo («En: Jones R, editor.»); sin
// esta exclusión el marcador se leía como lugar:editorial y un
// capítulo partido en dos líneas se cortaba en dos referencias (K4).
const LUGAR_EDITORIAL_RE = /\b(?!(?:En|In):)[A-Z][\p{L}]+(?: [A-Z][\p{L}]+)*: (?:[A-Z]{2,}|[A-Z][\p{L}]{3,})/u;
// ¿Trae este bloque un lugar:editorial con título antes? Un lugar
// justo tras el autor/institución, sin título entre medias
// («Hospital Ameijeiras. La Habana: Cuba.»), es una lista de
// centros, no una cita (J5'). Un libro real trae autor. título.
// lugar («Smith J. Title. Madrid: Elsevier.»): al menos dos límites
// de frase antes del lugar. O el «editorial» es un acrónimo (L2):
// «Geneva: WHO», «New York: NKF», «Linthicum: AUA» son la propia
// institución como editorial, no un lugar:país.
// Países en versales que NO son un editorial-acrónimo (M8): «La
// Habana: CUBA» es lugar:país, no lugar:editorial. Sin esta lista,
// la regla del acrónimo de L2 («Geneva: WHO») aceptaba «CUBA» y
// reabría J5' en mayúsculas. Se incluyen las formas con y sin tilde
// y las siglas de país (US, UK, EU) que un autor podría poner como
// lugar de publicación. Lista COMPLETA (ronda 9, N4/N5/N6): todos
// los países en ES y EN, no solo los que el constructor recordó —
// una lista de denegación es por naturaleza incompleta y un país
// que falte reabre M8; se documenta en DECISIONES.md §R9.2. El país
// puede tener varias palabras («NEW ZEALAND», «SOUTH AFRICA»): la
// regex de lugar solo captura la primera, así que tieneLugarConTitulo
// mira la serie de palabras en mayúsculas tras «: ».
const PAISES_VERSALES = new Set(["CUBA", "USA", "EEUU", "EE.UU.", "US", "UK", "EU", "UE", "PERU", "PERÚ", "CHILE", "MEXICO", "MÉXICO", "BRASIL", "BRAZIL", "ARGENTINA", "ESPAÑA", "ESPANA", "SPAIN", "COLOMBIA", "VENEZUELA", "ECUADOR", "BOLIVIA", "URUGUAY", "PARAGUAY", "PUERTO RICO", "REPUBLICA DOMINICANA", "REPÚBLICA DOMINICANA", "DOMINICAN REPUBLIC", "GUATEMALA", "HONDURAS", "NICARAGUA", "COSTA RICA", "PANAMA", "PANAMÁ", "EL SALVADOR", "FRANCIA", "FRANCE", "ALEMANIA", "GERMANY", "ITALIA", "ITALY", "PORTUGAL", "HOLANDA", "NETHERLANDS", "PAÍSES BAJOS", "PAISES BAJOS", "BELGICA", "BÉLGICA", "BELGIUM", "SUIZA", "SWITZERLAND", "AUSTRIA", "GRECIA", "GREECE", "TURQUIA", "TURQUÍA", "TURKEY", "RUSIA", "RUSSIA", "CHINA", "JAPON", "JAPÓN", "JAPAN", "INDIA", "CANADA", "CANADÁ", "AUSTRALIA", "NEW ZEALAND", "NUEVA ZELANDA", "NUEVA ZELANDIA", "IRELAND", "IRLANDA", "NORWAY", "NORUEGA", "SWEDEN", "SUECIA", "DENMARK", "DINAMARCA", "FINLAND", "FINLANDIA", "POLAND", "POLONIA", "SOUTH AFRICA", "SUDÁFRICA", "SUDAFRICA", "AFGHANISTAN", "AFGANISTÁN", "AFGANISTAN", "ALBANIA", "ANDORRA", "ANGOLA", "ANTIGUA AND BARBUDA", "ANTIGUA Y BARBUDA", "SAUDI ARABIA", "ARABIA SAUDITA", "ARABIA SAUDI", "ALGERIA", "ARGELIA", "ARMENIA", "AZERBAIJAN", "AZERBAIYÁN", "AZERBAIYAN", "BAHAMAS", "BANGLADESH", "BARBADOS", "BAHRAIN", "BARÉIN", "BAHREIN", "BELIZE", "BELICE", "BENIN", "BENÍN", "BELARUS", "BIELORRUSIA", "MYANMAR", "BIRMANIA", "BOSNIA AND HERZEGOVINA", "BOSNIA Y HERZEGOVINA", "BOTSWANA", "BOTSUANA", "BRUNEI", "BRUNÉI", "BULGARIA", "BURKINA FASO", "BURUNDI", "BHUTAN", "BUTÁN", "CAPE VERDE", "CABO VERDE", "CAMBODIA", "CAMBOYA", "CAMEROON", "CAMERÚN", "CAMERUN", "QATAR", "CATAR", "CHAD", "CYPRUS", "CHIPRE", "COMOROS", "COMORAS", "CONGO", "NORTH KOREA", "COREA DEL NORTE", "SOUTH KOREA", "COREA DEL SUR", "IVORY COAST", "COSTA DE MARFIL", "CROATIA", "CROACIA", "DOMINICA", "EGYPT", "EGIPTO", "UNITED ARAB EMIRATES", "EMIRATOS ÁRABES UNIDOS", "EMIRATOS ARABES UNIDOS", "ERITREA", "SLOVAKIA", "ESLOVAQUIA", "SLOVENIA", "ESLOVENIA", "UNITED STATES", "ESTADOS UNIDOS", "ESTONIA", "ESWATINI", "ESUATINI", "ETHIOPIA", "ETIOPÍA", "ETIOPIA", "PHILIPPINES", "FILIPINAS", "FIJI", "FIYI", "GABON", "GABÓN", "GAMBIA", "GEORGIA", "GHANA", "GRENADA", "GRANADA", "GUINEA", "GUINEA-BISSAU", "GUINEA-BISÁU", "GUINEA-BISAU", "EQUATORIAL GUINEA", "GUINEA ECUATORIAL", "GUYANA", "HAITI", "HAITÍ", "HUNGARY", "HUNGRÍA", "HUNGRIA", "INDONESIA", "IRAQ", "IRAK", "IRAN", "IRÁN", "ICELAND", "ISLANDIA", "ISRAEL", "JAMAICA", "JORDAN", "JORDANIA", "KAZAKHSTAN", "KAZAJISTÁN", "KAZAJISTAN", "KENYA", "KENIA", "KYRGYZSTAN", "KIRGUISTÁN", "KIRGUISTAN", "KIRIBATI", "KOSOVO", "KUWAIT", "LAOS", "LESOTHO", "LESOTO", "LATVIA", "LETONIA", "LEBANON", "LÍBANO", "LIBANO", "LIBERIA", "LIBYA", "LIBIA", "LIECHTENSTEIN", "LITHUANIA", "LITUANIA", "LUXEMBOURG", "LUXEMBURGO", "NORTH MACEDONIA", "MACEDONIA DEL NORTE", "MADAGASCAR", "MALAYSIA", "MALASIA", "MALAWI", "MALAUI", "MALDIVES", "MALDIVAS", "MALI", "MALÍ", "MALTA", "MOROCCO", "MARRUECOS", "MAURITIUS", "MAURICIO", "MAURITANIA", "MICRONESIA", "MOLDOVA", "MOLDAVIA", "MONACO", "MÓNACO", "MONGOLIA", "MONTENEGRO", "MOZAMBIQUE", "NAMIBIA", "NAURU", "NEPAL", "NIGER", "NÍGER", "NIGERIA", "OMAN", "OMÁN", "PAKISTAN", "PAKISTÁN", "PALAU", "PALAOS", "PALESTINE", "PALESTINA", "PAPUA NEW GUINEA", "PAPÚA NUEVA GUINEA", "PAPUA NUEVA GUINEA", "UNITED KINGDOM", "REINO UNIDO", "CENTRAL AFRICAN REPUBLIC", "REPÚBLICA CENTROAFRICANA", "REPUBLICA CENTROAFRICANA", "CZECH REPUBLIC", "REPÚBLICA CHECA", "REPUBLICA CHECA", "RWANDA", "RUANDA", "ROMANIA", "RUMANÍA", "RUMANIA", "SAMOA", "SAINT KITTS AND NEVIS", "SAN CRISTÓBAL Y NIEVES", "SAN CRISTOBAL Y NIEVES", "SAN MARINO", "SAINT VINCENT AND THE GRENADINES", "SAN VICENTE Y LAS GRANADINAS", "SAINT LUCIA", "SANTA LUCÍA", "SANTA LUCIA", "SAO TOME AND PRINCIPE", "SANTO TOMÉ Y PRÍNCIPE", "SANTO TOME Y PRINCIPE", "SENEGAL", "SERBIA", "SEYCHELLES", "SIERRA LEONE", "SIERRA LEONA", "SINGAPORE", "SINGAPUR", "SYRIA", "SIRIA", "SOMALIA", "SRI LANKA", "SUDAN", "SUDÁN", "SOUTH SUDAN", "SUDÁN DEL SUR", "SUDAN DEL SUR", "SURINAME", "SURINAM", "THAILAND", "TAILANDIA", "TANZANIA", "TAJIKISTAN", "TAYIKISTÁN", "TAYIKISTAN", "EAST TIMOR", "TIMOR ORIENTAL", "TOGO", "TONGA", "TRINIDAD AND TOBAGO", "TRINIDAD Y TOBAGO", "TUNISIA", "TÚNEZ", "TUNEZ", "TURKMENISTAN", "TURKMENISTÁN", "TUVALU", "UKRAINE", "UCRANIA", "UGANDA", "UZBEKISTAN", "UZBEKISTÁN", "VANUATU", "VIETNAM", "YEMEN", "DJIBOUTI", "YIBUTI", "ZAMBIA", "ZIMBABWE", "ZIMBABUE", "SCOTLAND", "ESCOCIA", "WALES", "GALES", "ENGLAND", "INGLATERRA", "GREENLAND", "GROENLANDIA", "TAIWAN", "TAIWÁN", "HONG KONG",
  // P3 (ronda 9): los diez confirmados fuera en la ronda 9
  // (VATICAN CITY, CONGO ×2, WESTERN SAHARA, CZECHIA, MACEDONIA,
  // TIMOR-LESTE, SWAZILAND, BURMA) + revisión ISO ES/EN: faltaban
  // SOLOMON ISLANDS y MARSHALL ISLANDS (soberanos) y varios
  // territorios habituales (FAROE, GIBRALTAR, ARUBA, CURACAO,
  // BERMUDA, CAYMAN). La lista sigue siendo por naturaleza
  // incompleta (ver DECISIONES.md §R9.2): un país no listado
  // reabrirá M8; el arreglo estructural es el veto ANTES del atajo
  // de ≥2 límites (P2), no la lista en sí.
  "VATICAN CITY", "CIUDAD DEL VATICANO", "VATICANO", "VATICAN",
  "DEMOCRATIC REPUBLIC OF THE CONGO", "REPUBLIC OF THE CONGO",
  "REPÚBLICA DEL CONGO", "REPUBLICA DEL CONGO",
  "REPÚBLICA DEMOCRÁTICA DEL CONGO", "REPUBLICA DEMOCRATICA DEL CONGO",
  "WESTERN SAHARA", "SÁHARA OCCIDENTAL", "SAHARA OCCIDENTAL",
  "CZECHIA", "CHEQUIA", "MACEDONIA",
  "TIMOR-LESTE", "TIMOR LESTE",
  "SWAZILAND", "SUAZILANDIA", "BURMA",
  "SOLOMON ISLANDS", "ISLAS SALOMÓN", "ISLAS SALOMON",
  "MARSHALL ISLANDS", "ISLAS MARSHALL",
  "FAROE ISLANDS", "ISLAS FEROE", "GIBRALTAR", "ARUBA",
  "CURACAO", "CURAZAO", "BERMUDA", "CAYMAN ISLANDS",
  "ISLAS CAIMÁN", "ISLAS CAIMAN",
  // Q3 (ronda 10): nombres en el ámbito que faltaban — NORTHERN
  // IRELAND (con SCOTLAND/WALES/ENGLAND presentes), FALKLAND
  // ISLANDS / ISLAS MALVINAS, BOSNIA-HERZEGOVINA (forma con guion;
  // la afirmación de §R10.2 «la serie no se parte por el guion» es
  // cierta para TIMOR-LESTE, que SÍ está en el set, pero no salva
  // las formas con guion que NO están) y COTE D'IVOIRE (sin tildes).
  // La forma acentuada CÔTE D'IVOIRE también se añade: en 0.1.22
  // TAMPOCO pasaba (5 refs, no 3 como decía el diagnóstico del
  // árbitro — el regex sí casa «CÔTE» por [A-Z][\p{L}]{3,} y
  // esPaisEnVersales devuelve false sin mirar la lista).
  "NORTHERN IRELAND", "IRLANDA DEL NORTE",
  "FALKLAND ISLANDS", "ISLAS MALVINAS",
  "BOSNIA-HERZEGOVINA",
  "COTE D'IVOIRE", "CÔTE D'IVOIRE"]);
// ¿Es el «editorial» tras «: » un país en versales? El país puede
// tener varias palabras («NEW ZEALAND», «SOUTH AFRICA», «REPÚBLICA
// DOMINICANA», «DEMOCRATIC REPUBLIC OF THE CONGO»): la regex de
// lugar solo captura la primera («NEW»), así que se mira la serie
// de palabras en mayúsculas tras «: » — si sus primeras palabras
// forman un país de la lista, no vale como acrónimo de editorial.
// La serie no se parte por el guion («TIMOR-LESTE»,
// «GUINEA-BISSAU» son una sola entrada, P3) ni por el apóstrofo
// («COTE D'IVOIRE», Q3).
function esPaisEnVersales(s) {
  // R4: Word autocorrige el apóstrofo a curvo («COTE D’IVOIRE»,
  // U+2019) y la serie solo cubría el recto: normalizar antes de
  // mirar la serie, o el país no se reconoce y la fila secuestra.
  const t = s.replace(/[‘’]/g, "'");
  const m = LUGAR_EDITORIAL_RE.exec(t);
  if (!m) return false;
  const tras = t.slice(m.index + m[0].indexOf(": ") + 2);
  const serie = /^([A-ZÀ-Þ][\p{L}]*(?:[ '-][A-ZÀ-Þ][\p{L}]*)*)/u.exec(tras);
  if (serie) {
    const palabras = serie[1].split(" ");
    for (let n = palabras.length; n >= 1; n--) {
      if (PAISES_VERSALES.has(palabras.slice(0, n).join(" "))) return true;
    }
  }
  return PAISES_VERSALES.has(m[0].split(": ").pop());
}
function tieneLugarConTitulo(s) {
  const m = LUGAR_EDITORIAL_RE.exec(s);
  if (!m) return false;
  // P2: el veto de país corre ANTES del atajo de ≥2 límites: un
  // libro real no tiene un país como editorial («Hospital
  // Ameijeiras. Guía de servicios. La Habana: CUBA.» trae 2 «. »
  // antes del lugar y antes devolvía true sin mirar el país).
  if (esPaisEnVersales(s)) return false;
  const antes = s.slice(0, m.index);
  if ((antes.match(/\.\s+/g) || []).length >= 2) return true;
  const editor = m[0].split(": ").pop();
  return /^[A-Z]{2,}$/.test(editor);
}
// Fila de tabla clínica («Paciente A, 45 años, ingreso 2020»,
// «Paciente A, 45 años. Alta 2020»): tiene año pero no es una cita.
// Se veta solo cuando la línea no trae estructura de cita más allá
// de autor+año (N17b): un título real con «ingreso 2020»
// («Mortalidad tras ingreso 2020 por litiasis renal») trae texto
// sustantivo detrás del año y NO se veta. Dos formas de fila:
//   - paciente + edad («Paciente A, 45 años»);
//   - «ingreso/alta/egreso AAAA» al final de la línea (sin texto
//     sustantivo detrás): la fila termina en el año.
function esFilaClinica(s) {
  // 1ª forma: «paciente» + edad solo en el segmento ANTES del primer
  // límite de frase: en una fila clínica el «Paciente» va al inicio
  // («Paciente A, 45 años. Alta 2020»); en un título va tras el
  // autor («Gómez R. Paciente de 45 años…», K14). Antes se buscaba
  // en TODA la línea y el título vetaba la lista entera.
  // L4: un libro cuyo TÍTULO empieza por «Paciente» («Paciente de
  // 45 años con litiasis renal. 2.ª ed. 2020.») no es una fila
  // clínica: si tras el primer segmento trae marca de libro
  // («ed.», lugar:editorial, «Available from:»), no se veta.
  const primerSegmento = s.split(/\.\s+/)[0];
  if (/\bpaciente\b/i.test(primerSegmento) && /\b\d+\s*años?\b/i.test(primerSegmento)) {
    const resto = s.slice(primerSegmento.length);
    if (/\bed\./i.test(resto) || LUGAR_EDITORIAL_RE.test(resto) || DISPONIBLE_RE.test(resto)) return false;
    return true;
  }
  const m = /\b(?:ingreso|alta|egreso)\s+(?:19|20)\d{2}\b/i.exec(s);
  if (m) {
    const resto = s.slice(m.index + m[0].length).replace(/^[.\s,;:\-]+/, "").trim();
    if (!resto) return true;
  }
  return false;
}
function tieneEvidenciaWeb(s) {
  return URL_RE.test(s) || DISPONIBLE_RE.test(s);
}
// ¿Trae esta línea evidencia web o de lugar:editorial? (Puerta de la
// rama sin numerar del validador: una web institucional o un libro sin
// autor reconocido también pueden abrir el bloque.)
function tieneEvidenciaWebOLugar(s) {
  return tieneEvidenciaWeb(s) || LUGAR_EDITORIAL_RE.test(s);
}
// ¿Trae este bloque estructura de cita (autor o institución al inicio
// + título)? Un autor Vancouver («Smith J.») o una institución
// («National Kidney Foundation.») seguida de punto y más texto, o un
// texto largo. La forma literal del encargo (pareceInicioSinNumero)
// rompería H1: «National Kidney Foundation» no está en
// AUTHOR_CORPORATE y su web solo validaría por la URL; la institución
// (2-6 palabras capitalizadas + punto + más texto) vale como autor.
// «Ver protocolo en https://...» (J4) y «La Habana: Hospital...»
// (J5) no la traen: no hay autor ni título.
function tieneEstructuraCita(s) {
  if (pareceInicioSinNumero(s)) return /\.\s+[\p{Lu}]/u.test(s) || s.length >= 60;
  return /^[A-Z][\p{L}]+(?:\s+(?:[A-Z][\p{L}]+|de|del|la|el|y|of|the|and|for)){1,5}\.\s+\S/u.test(s);
}
// ¿Trae este bloque evidencia de que es una referencia? Cola
// Vancouver, URL / «Available from:» o lugar:editorial JUNTO con
// estructura de cita, o año con estructura de cita (autor al inicio +
// límite de frase interno o texto largo). Un año SUELTO no basta: una
// fila de tabla con año («ingreso 2020») no es una referencia (H2).
// Una URL o un lugar:editorial SOLOS tampoco bastan: una lista de
// enlaces internos («Ver protocolo en https://...», J4) o de centros
// («La Habana: Hospital...», J5) no es una cita. Una web sin año vale
// por su URL + institución + título (H1).
// Título al inicio: palabra capitalizada + hasta 5 palabras + punto
// + más texto («Kidney stones.», «Manual de urología.»). Vale como
// estructura SOLO junto a URL o lugar:editorial (una web o un libro
// partidos pueden empezar por el título, sin el autor en la línea);
// junto a un año solo NO basta («Resultados. ... en 2020.» es prosa,
// no una cita). Anclado al inicio: en un bloque concatenado no casa
// a través de la juntura («.../p2 3. Ver protocolo...», J4).
// Verbos imperativos de enlace (ES/EN): un «título» que empieza por
// uno de ellos es una instrucción («Ver protocolo.», «See the
// guidelines.»), no el título de una cita (K15, J4').
const VERBOS_ENLACE = new Set(["ver", "vease", "vea", "consultar", "consulte", "revisar", "revise", "acceder", "acceda", "descargar", "descargue", "visitar", "visite", "abrir", "abra", "leer", "lea", "see", "check", "visit", "open", "read", "download", "click", "go", "view"]);
// S1: palabra de un título: admite dígitos, guiones y apóstrofos
// («COVID-19», «type 2», «Alzheimer's», «3D», «SARS-CoV-2»,
// «5-year»). Los cuatro helpers de título exigían solo letras
// ([\p{L}]+) y cualquier título con dígito, guion o apóstrofo se
// perdía en silencio antes de la lista numerada. El veto de verbos
// y el límite «. » se mantienen: la prosa con URL y verbo (K3'/J4')
// sigue sin validar.
const PALABRA_TITULO = "[\\p{L}\\p{N}][\\p{L}\\p{N}'’\\-\\u2010-\\u2015\\u2212:]*";
const TITULO_INICIO_RE = new RegExp(
  "^(?:[A-Z]\\.(?:[A-Z]\\.)+|(" + PALABRA_TITULO + "))((?:\\s+" + PALABRA_TITULO + "){1,5})\\.\\s+\\S",
  "u"
);
const TITULO_ANIO_CON_URL_RE = new RegExp(
  "^(?:19|20)\\d{2}\\s+(" + PALABRA_TITULO + "(?:\\s+" + PALABRA_TITULO + ")*)\\.\\s+(.*)$",
  "u"
);
const TITULO_ANIO_FINAL_CON_URL_RE = new RegExp(
  "^" + PALABRA_TITULO + "(?:\\s+" + PALABRA_TITULO + ")*\\s+(?:19|20)\\d{2}\\.\\s+(.*)$",
  "u"
);
// ¿Termina el título en un número pelado («Ver protocolo 1.»,
// «Guidelines part 2.»)? Esas líneas son filas de instrucciones
// numeradas, no títulos: si validaran como título, esPreambuloFalso
// las conservaría como preámbulo y la guarda de líneas casi
// idénticas (M16) ya no las vetaría. Un dígito en medio del título
// («type 2 diabetes», «COVID-19») o al inicio («3D», «2020…») sí
// vale. Un título que TERMINA en año («Kidney stones 2020.») no
// pasa por aquí: lo cubre tituloAnioFinalConUrl. `m` es el match de
// TITULO_INICIO_RE (m[2] = palabras tras la primera) o de
// TITULO_ANIO_CON_URL_RE (m[1] = palabras del título).
function tituloTerminaEnNumeroPelado(m, grupo) {
  const palabras = (m[grupo] || "").trim().split(/\s+/);
  const ultima = palabras[palabras.length - 1] || "";
  return /^\p{N}+$/u.test(ultima);
}
function tieneTituloAlInicio(s) {
  // Título de ≥2 palabras: «Resultados.» (una palabra) es prosa,
  // no un título (K3). Y nunca un verbo imperativo de enlace.
  // M14: la primera palabra puede ser una abreviatura con puntos
  // («U.S. guidelines…»): sin esto el título se perdía porque el
  // regex exigía ≥2 letras en la primera palabra.
  const m = TITULO_INICIO_RE.exec(s);
  if (!m) return false;
  if (tituloTerminaEnNumeroPelado(m, 2)) return false;
  const primera = (m[1] || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (VERBOS_ENLACE.has(primera)) return false;
  return true;
}
// Título al inicio SIN el veto de verbos de enlace: la APERTURA es
// permisiva y el validador es el que guarda la puerta (L1). Una web
// real sin numerar cuyo título es un imperativo («See the
// guidelines. Available from: …») se perdía en silencio porque
// esInicioRef consultaba VERBOS_ENLACE; el validador sigue vetando
// el encabezado falso («Ver protocolo.», K15) por la regla de líneas
// casi idénticas, no por la apertura.
function tieneTituloAlInicioSinVeto(s) {
  // M14: como tieneTituloAlInicio, la primera palabra puede ser una
  // abreviatura con puntos («U.S. guidelines…»).
  const m = TITULO_INICIO_RE.exec(s);
  if (!m) return false;
  return !tituloTerminaEnNumeroPelado(m, 2);
}
// ¿Es esta línea una web de título de UNA palabra («Urolithiasis.
// Available from: …»)? tieneTituloAlInicio exige ≥2 palabras para
// no confundir la prosa («Resultados.») con un título (K3); con URL
// la señal es otra: tras la primera palabra viene el marcador de
// cita («Available from:»/«Disponible en:») o la URL directamente,
// no prosa («Resultados. Ver en https://…», K3; «Ver guía 2020 en
// https://…», M15). Sin esto la web se perdía en silencio antes de
// la lista numerada (P6/C15): ni se conservaba con flag ni se abría
// por la vía normal.
function tituloUnaPalabraConUrl(s) {
  // S1: la palabra admite dígitos, guiones y apóstrofos («COVID-19.»
  // como título de una palabra).
  const m = /^(?:[A-Z][\p{L}\p{N}'’\-\u2010-\u2015\u2212]{2,}|[A-Z](?:\.[A-Z])+)\.\s+(.*)$/u.exec(s);
  if (!m) return false;
  const resto = m[1];
  if (/^(?:available from|disponible en)\s*:?/i.test(resto)) return true;
  if (/^(?:https?:\/\/|www\.)/i.test(resto)) return true;
  return false;
}
// ¿Es esta línea una web cuyo título EMPIEZA POR AÑO («2020
// guidelines for kidney stones. Available from: …»)?
// tieneTituloAlInicio exige que la primera palabra empiece por letra
// y «2020» son dígitos, así que la web se perdía en silencio antes
// de la lista numerada (Q1/H9, misma clase que P6). La URL tras el
// marcador («Available from:»/«Disponible en:») o directa la
// distingue de la prosa: «2020. Ver en https://…» no trae marcador
// tras el año (tras «2020» no viene palabra + marcador/URL) y
// «2020 guidelines. Ver en https://…» tampoco (tras el título viene
// prosa, no el marcador). R1: SIN tope de palabras en el título (el
// tope de 6 se comía títulos reales de 7 y 9 palabras: «2022
// european guidelines for diagnosis of kidney stones. Available
// from: …»); la URL tras el marcador distingue la web de la prosa,
// el tope no hacía falta.
function tituloAnioConUrl(s) {
  const m = TITULO_ANIO_CON_URL_RE.exec(s);
  if (!m) return false;
  // S1: como tieneTituloAlInicio, el título no puede terminar en un
  // número pelado («2020 ver protocolo 1.») o la guarda M16 de
  // líneas casi idénticas se saltaría igual que con «Ver protocolo
  // 1.». El resto tras el título es ahora el grupo 2.
  if (tituloTerminaEnNumeroPelado(m, 1)) return false;
  const resto = m[2];
  if (/^(?:available from|disponible en)\s*:?/i.test(resto)) return true;
  if (/^(?:https?:\/\/|www\.)/i.test(resto)) return true;
  return false;
}
// ¿Es esta línea una web cuyo título TERMINA EN AÑO («Kidney stones
// 2020. Available from: …», «AUA guidelines 2023. Disponible en:
// …»)? Un título terminado en año es muy habitual en webs reales y
// se perdía en silencio antes de la lista numerada (R2, misma clase
// que Q1/P6). La URL tras el marcador (o directa) la distingue de
// la prosa: «Kidney stones 2020. Ver en https://…» no trae marcador
// tras el año y «Resultados 2020. Consultar en https://…» tampoco.
function tituloAnioFinalConUrl(s) {
  const m = TITULO_ANIO_FINAL_CON_URL_RE.exec(s);
  if (!m) return false;
  const resto = m[1];
  if (/^(?:available from|disponible en)\s*:?/i.test(resto)) return true;
  if (/^(?:https?:\/\/|www\.)/i.test(resto)) return true;
  return false;
}
// ¿Es esta línea el título (partido) de una web que empieza o
// termina en año («2022 european guidelines… stones.»,
// «Kidney stones 2020.»)? La línea termina en punto y no trae el
// marcador ni la URL: sola no valida como web (tituloAnioConUrl /
// tituloAnioFinalConUrl exigen el marcador o la URL en la misma
// línea). Se usa para unirla con la línea siguiente de
// marcador/URL en el preámbulo (S3). Las palabras admiten dígitos,
// guiones y apóstrofos (S1). «2020. Ver en» NO es título partido:
// tras el año viene el punto, no palabras.
function esTituloAnioPartido(s) {
  const t = String(s).trim();
  const añoInicio = new RegExp(
    "^(?:19|20)\\d{2}\\s+" + PALABRA_TITULO + "(?:\\s+" + PALABRA_TITULO + ")*\\.$",
    "u"
  );
  if (añoInicio.test(t)) return true;
  const añoFinal = new RegExp(
    "^" + PALABRA_TITULO + "(?:\\s+" + PALABRA_TITULO + ")*\\s+(?:19|20)\\d{2}\\.$",
    "u"
  );
  return añoFinal.test(t);
}
// ¿Viene la URL introducida por el marcador de cita («Available
// from:»/«Disponible en:») o directamente tras el título? Una URL
// pelada tras una frase de prosa («Datos clínicos. Consultar en
// https://…», K3') es un enlace en el texto, no la URL de una cita:
// el título termina en el primer «. » y entre el título y la URL
// solo puede haber el marcador (o nada). Sin esto, cualquier prosa
// con enlace validaba el encabezado falso.
function urlIntroducidaPorMarcador(s) {
  const u = s.search(/https?:\/\/|www\./i);
  if (u === -1) return true; // sin URL: no es el caso web
  const antes = s.slice(0, u);
  // ¿Hay marcador («Available from:»/«Disponible en:») justo antes
  // de la URL? El título termina donde empieza el marcador.
  const mm = /(available from|disponible en)\s*:?\s*$/i.exec(antes);
  // Sin marcador, el título termina donde empieza la URL.
  const pre = mm ? antes.slice(0, mm.index) : antes;
  // M6: el fin del título es el ÚLTIMO «. » dentro de `pre`, no el
  // primero: un título con «. » interno («Kidney stones. Part 2.
  // Available from: …») es una web real — entre el fin del título
  // y el marcador/URL no queda nada. Con K3' («Datos clínicos.
  // Consultar en URL») no hay marcador y el último «. » deja
  // «Consultar en» entre medias → sigue bloqueado. Sin ningún
  // «. » no se puede saber dónde termina el título: no se bloquea
  // (comportamiento anterior).
  const idx = pre.lastIndexOf(". ");
  if (idx === -1) return true;
  const entre = pre.slice(idx + 2).trim();
  return !entre;
}
function tieneEvidenciaRef(s) {
  if (TAIL_LIGERO_RE.test(s)) return true;
  if (tieneEvidenciaWeb(s)) {
    // La URL vale con estructura de cita (autor/institución)
    // siempre; con solo título al inicio, solo si la URL viene
    // introducida por el marcador o directamente tras el título
    // («Kidney stones. Available from: …», K6; «Kidney stones.
    // https://…»): una URL pelada tras prosa («Datos clínicos.
    // Consultar en https://…», K3') no es una cita.
    if (tieneEstructuraCita(s)) return true;
    // Q1: un título que empieza por año con URL también vale como
    // evidencia (tieneTituloAlInicio exige primera palabra con
    // letra y «2020» son dígitos). R2: igual el que TERMINA en año
    // («Kidney stones 2020. Available from: …»).
    return (tieneTituloAlInicio(s) || tituloAnioConUrl(s) || tituloAnioFinalConUrl(s)) && urlIntroducidaPorMarcador(s);
  }
  // El lugar vale solo con título antes (J5'): «Hospital
  // Ameijeiras. La Habana: Cuba.» es una lista de centros, no una
  // cita, aunque traiga estructura de institución.
  if (LUGAR_EDITORIAL_RE.test(s)) return (tieneEstructuraCita(s) || tieneTituloAlInicio(s)) && tieneLugarConTitulo(s);
  if (ANIO_RE.test(s)) {
    if (esFilaClinica(s)) return false;
    return tieneEstructuraCita(s);
  }
  return false;
}
// Evidencia para la rama NUMERADA del validador (y el resto inline,
// que también es numerado): la evidencia URL/lugar exige
// tieneEstructuraCita (autor o institución al inicio), NO
// tieneTituloAlInicio — una ref Vancouver numerada empieza siempre
// por autor o institución; una línea numerada que empieza por un
// título pelado no es una ref (J4': «Ver protocolo. Disponible en
// https://…» validaba por el título). El lugar además exige título
// entre el autor y el lugar (J5'). El fallback de corrida sigue
// salvando listas con una web de título solo entre refs normales
// (los bloques 2º/3º validan); una lista de SOLO webs de título
// pelado, sin encabezado, ya no valida — en Vancouver una ref sin
// autor ni institución no es estándar (limitación documentada).
function tieneEvidenciaRefNumerada(s) {
  if (TAIL_LIGERO_RE.test(s)) return true;
  // L3: la evidencia web vuelve a aceptar título al inicio («Kidney
  // stones. Available from: …»): una web de título pelado es una
  // ref real. El secuestro por filas falsas idénticas (J4'/J4'')
  // lo cierra la regla de líneas casi idénticas en los llamadores
  // (validador y fallback), no esta función.
  // Q1: una web numerada de título que empieza por año («1. 2020
  // guidelines… Available from: …») también vale como evidencia.
  // R2: igual la que termina en año («1. Kidney stones 2020.
  // Available from: …»).
  if (tieneEvidenciaWeb(s)) return tieneEstructuraCita(s) || tieneTituloAlInicio(s) || tituloAnioConUrl(s) || tituloAnioFinalConUrl(s);
  if (LUGAR_EDITORIAL_RE.test(s)) return tieneEstructuraCita(s) && tieneLugarConTitulo(s);
  if (ANIO_RE.test(s)) {
    if (esFilaClinica(s)) return false;
    return tieneEstructuraCita(s);
  }
  return false;
}
// Evidencia numerada SIN el veto de verbos de enlace (P1): la rama
// `restoInline` del validador existe precisamente para consultar
// `segundaCorrida`, y el veto es lo que impide detectar la corrida
// falsa cuando el verbo está listado («Ver», «Descargar»,
// «Consultar» inline se tragaban a Smith). La rama web usa
// tieneTituloAlInicioSinVeto — la misma que usa la apertura L1.
// Solo se usa en esa rama; el resto del validador sigue vetando
// (J4': una fila «1. Ver el protocolo.» numerada en la rama normal
// ya se rechaza por falta de evidencia).
function tieneEvidenciaRefNumeradaSinVeto(s) {
  if (TAIL_LIGERO_RE.test(s)) return true;
  // Q1: como tieneEvidenciaRefNumerada, el título que empieza por
  // año con URL también vale. R2: igual el que termina en año.
  if (tieneEvidenciaWeb(s)) return tieneEstructuraCita(s) || tieneTituloAlInicioSinVeto(s) || tituloAnioConUrl(s) || tituloAnioFinalConUrl(s);
  if (LUGAR_EDITORIAL_RE.test(s)) return tieneEstructuraCita(s) && tieneLugarConTitulo(s);
  if (ANIO_RE.test(s)) {
    if (esFilaClinica(s)) return false;
    return tieneEstructuraCita(s);
  }
  return false;
}
// Evidencia para el fallback de corrida numerada (sin encabezado):
// la misma que tieneEvidenciaRefNumerada. El año solo NO vale: una
// sección numerada del cuerpo con un año no es la lista (H1); y una
// corrida de filas clínicas (J3), de enlaces (J4) o de centros (J5)
// tampoco valida como lista por la misma regla del validador.
function tieneEvidenciaCorrida(s) {
  return tieneEvidenciaRefNumerada(s);
}
function lineaPareceRef(s) {
  if (pareceInicioSinNumero(s)) return true;
  if (TAIL_LIGERO_RE.test(s)) return true;
  if (ANIO_RE.test(s)) return true;
  // Una web sin año («National Kidney Foundation. Kidney stones.
  // Available from: https://...») también parece una referencia: sin
  // esto, el descarte de abridor basura se la comía (H5).
  if (tieneEvidenciaWeb(s)) return true;
  if (LUGAR_EDITORIAL_RE.test(s)) return true;
  return false;
}
// ¿Empieza aquí una referencia sin numerar? Línea con autor
// («Smith J.», corporativo de la lista) o con institución + título +
// URL/lugar («National Kidney Foundation. Kidney stones. Available
// from: ...»). Una URL pelada, un año suelto o una cola sola NO son
// inicio: son continuaciones de la ref anterior. Sin esto, la NKF se
// perdía en el camino sin numerar del PDF (J1/J2): pareceInicioSinNumero
// no la veía (su institución no está en AUTHOR_CORPORATE) y la línea
// se descartaba o se pegaba a la anterior. Es la versión estricta de
// lineaPareceRef para partir: lineaPareceRef se conserva para la
// lógica conservadora (conservar con flag), donde un falso positivo
// solo cuesta un aviso.
function esInicioRef(s) {
  if (pareceInicioSinNumero(s)) return true;
  // Institución/título + URL o lugar («National Kidney Foundation.
  // Kidney stones. Available from: ...», «Kidney stones. Available
  // from: ...»): una web partida puede empezar por el título. Una
  // URL pelada, un año suelto o una cola sola NO son inicio.
  // L1: el título aquí NO lleva el veto de verbos de enlace (la
  // apertura es permisiva; el validador guarda la puerta).
  // M9: el lugar solo vale con tieneLugarConTitulo cuando la línea
  // tiene estructura de cita (autor o institución al inicio) —
  // «Hospital Ameijeiras. La Habana: CUBA.» es un centro, no una
  // ref. Pero una línea de SOLO título + lugar:editorial
  // («Tratado de nefrología. New York: Springer; 2020.») es un
  // libro sin autor: el editorial en minúsculas (Springer,
  // Elsevier) no pasa tieneLugarConTitulo (que solo valida
  // acrónimos y ≥2 límites de frase) y exigirlo aquí pegaba el
  // libro a la ref anterior (N1/N12 de la ronda 6: 4 refs es lo
  // correcto). La distinción es estructural, no por lista:
  // institución/autor → estricto, solo-título → permisivo. P5: la
  // rama permisiva de solo-título NO vale cuando el «editorial» es
  // un país en versales («Guía de práctica. La Habana: CUBA.»): un
  // libro real sin autor trae un editorial de verdad, nunca un país.
  // P6: una web de título de una palabra («Urolithiasis. Available
  // from: …») también abre ref: la URL tras el marcador (o directa)
  // la distingue de la prosa («Resultados. Ver en https://…», K3).
  // Q1: lo mismo para un título que empieza por año («2020
  // guidelines… Available from: …»): los dígitos no son letra, así
  // que tieneTituloAlInicio no lo ve.
  if (tituloUnaPalabraConUrl(s)) return true;
  if (tituloAnioConUrl(s)) return true;
  if (tituloAnioFinalConUrl(s)) return true;
  if ((tieneEstructuraCita(s) || tieneTituloAlInicioSinVeto(s)) &&
    (tieneEvidenciaWeb(s) || (LUGAR_EDITORIAL_RE.test(s) && (tieneLugarConTitulo(s) || (!tieneEstructuraCita(s) && !esPaisEnVersales(s)))))) return true;
  return false;
}
// Clave de una línea candidata para detectar filas falsas casi
// idénticas: sin el número inicial («1. », «[1] », «i. ») y sin la
// URL (desde el primer http/www). Dos filas falsas de una tabla
// («Ver protocolo. Disponible en https://…/p1» ×3) solo se
// distinguen por el sufijo de la URL; una bibliografía real no
// tiene 3 líneas idénticas seguidas (K15', J4').
function claveCasiIdentica(s) {
  let t = String(s).trim();
  const c = numDeLinea(t);
  if (c) t = c.texto;
  const u = t.search(/https?:\/\/|www\./i);
  if (u !== -1) t = t.slice(0, u);
  return t.replace(/\s+/g, " ").trim();
}
// ¿Hay ≥3 líneas candidatas con la misma clave? El umbral es 3, no
// 2: dos refs reales al mismo título con URLs distintas («Kidney
// stones. Available from: https://a.com/1» y «…/2») comparten clave
// y no deben vetarse.
function lineasCasiIdenticas(lineas) {
  const vistas = {};
  for (const ln of lineas) {
    const k = claveCasiIdentica(ln);
    if (!k) continue;
    vistas[k] = (vistas[k] || 0) + 1;
    if (vistas[k] >= 3) return true;
  }
  return false;
}
// ¿Es esta línea una continuación pelada de lugar:editorial + año
// («Madrid: Elsevier; 2020.»)? Trae lugar y año pero ningún autor
// ni título propios: es la cola de un libro partido (K8). En el
// camino PDF una línea así no es inicio y se pega a la anterior; en
// el camino DOCX sin numerar se fusiona con la ref anterior. Una
// línea «Available from: URL» NO es continuación de lugar: en PDF
// abre una ref degenerada visible (híbrido K1/K2) y en DOCX
// sobrevive partida en dos (paridad documentada).
function esContinuacionLugar(s) {
  const t = String(s).trim();
  if (!LUGAR_EDITORIAL_RE.test(t) || !ANIO_RE.test(t)) return false;
  if (pareceInicioSinNumero(t) || tieneEstructuraCita(t) || tieneTituloAlInicio(t)) return false;
  return true;
}
// ¿Termina esta referencia con el marcador de capítulo sin el libro?
// «Smith J. Title. En: Jones R, editor.» aún no trae el libro
// (título + lugar + año); la referencia está incompleta y su
// continuación viene en la línea/párrafo siguiente (K4). Una
// referencia de capítulo completa sí trae el libro tras el marcador
// («En: Jones R, editor. Tratado. New York: Springer; 2020.»).
function capituloIncompleto(s) {
  const m = /\b(?:En|In):\s/.exec(s);
  if (!m) return false;
  const resto = s.slice(m.index);
  return !LUGAR_EDITORIAL_RE.test(resto) && !TAIL_LIGERO_RE.test(resto) && !ANIO_RE.test(resto);
}
// ¿Abre aquí una referencia sin numerar? esInicioRef con la guarda
// K3': una línea con solo título + URL pelada tras prosa («Datos
// clínicos. Consultar en https://…») no es un inicio: la URL debe
// venir introducida por el marcador o directamente tras el título.
// Con estructura de cita (autor/institución) sí abre. Sin la guarda,
// la apertura permisiva (L1) abriría la prosa con enlace como si
// fuera una ref. Solo se usa en la apertura (antes de la primera
// ref); el corte en mitad de lista y buscarCortePegado conservan
// esInicioRef sin guarda (una línea así en mitad de lista se ve en
// revisión como ref propia, no se pega a la anterior).
function esInicioRefValido(s) {
  if (!esInicioRef(s)) return false;
  if (!tieneEstructuraCita(s) && tieneEvidenciaWeb(s) && !urlIntroducidaPorMarcador(s)) return false;
  return true;
}
// ¿Parece esta línea un encabezado de sección («Discusión»,
// «Métodos», «Resultados»)? Corta (≤4 palabras), sin URL, sin año,
// sin cola, sin número, sin punto final. Se usa para distinguir el
// preámbulo antes de la lista real de la lista misma (M1/M3b, §R8):
// una ref real es larga o trae año/cola/URL; un encabezado de
// sección es una o dos palabras sin puntuación final.
function esEncabezadoSeccion(s) {
  const t = String(s).trim();
  if (!t || t.length > 40) return false;
  if (t.split(/\s+/).length > 4) return false;
  if (/[0-9]/.test(t) || URL_RE.test(t) || ANIO_RE.test(t) || TAIL_LIGERO_RE.test(t)) return false;
  if (numDeLinea(t)) return false;
  if (/[.!?;:,]$/.test(t)) return false; // termina en punto: es frase, no encabezado
  return /^[A-ZÀ-Þ]/.test(t);
}
// ¿Valida esta línea SOLO por título + URL (sin estructura, sin
// cola, sin año, sin lugar)? Es la forma de una fila falsa de
// instrucciones («Buscar el protocolo. Disponible en https://…»)
// y también la de una web real de título pelado (D5): solo el
// contexto (¿hay una segunda corrida después?) las distingue (M3b).
function soloTituloYUrl(s) {
  return tieneEvidenciaWeb(s) && tieneTituloAlInicio(s) &&
    !tieneEstructuraCita(s) && !TAIL_LIGERO_RE.test(s) &&
    !ANIO_RE.test(s) && !LUGAR_EDITORIAL_RE.test(s);
}
// Como soloTituloYUrl, sin el veto de verbos de enlace (P1): una
// fila falsa cuyo título empieza por un verbo listado («Ver el
// protocolo.») también es solo título+URL. Solo se usa en la rama
// `restoInline` del validador, vía segundaCorrida(…, true).
function soloTituloYUrlSinVeto(s) {
  return tieneEvidenciaWeb(s) && tieneTituloAlInicioSinVeto(s) &&
    !tieneEstructuraCita(s) && !TAIL_LIGERO_RE.test(s) &&
    !ANIO_RE.test(s) && !LUGAR_EDITORIAL_RE.test(s);
}
// ¿Hay, a partir de `desde`, un encabezado de sección seguido de
// otra corrida numerada (≥2 líneas con evidencia)? Devuelve el
// índice (en `vista`) de la segunda corrida, o -1. Sin encabezado
// entre las corridas no hay segunda corrida: dos bibliografías
// seguidas sin separación no se distinguen de una sola lista.
function indiceSegundaCorrida(vista, desde) {
  let j = desde;
  while (j < vista.length) {
    const s = String(vista[j]).replace(/^\f+/, "").trim();
    if (!s || esPie(s) || /^\d{1,4}$/.test(s)) { j++; continue; }
    break;
  }
  if (j >= vista.length) return -1;
  if (!esEncabezadoSeccion(String(vista[j]).replace(/^\f+/, "").trim())) return -1;
  j++;
  while (j < vista.length) {
    const s = String(vista[j]).replace(/^\f+/, "").trim();
    if (!s || esPie(s) || /^\d{1,4}$/.test(s)) { j++; continue; }
    break;
  }
  if (j >= vista.length) return -1;
  const d0 = numDeLinea(String(vista[j]).replace(/^\f+/, "").trim());
  if (!d0) return -1;
  // Segunda corrida: ≥2 líneas numeradas secuenciales con evidencia
  // (la ref puede venir partida: el año/cola puede estar en la
  // línea siguiente).
  let m = d0.num, q = j, seguidas = 0;
  while (q < vista.length && seguidas < 2) {
    const s = String(vista[q]).replace(/^\f+/, "").trim();
    const c = numDeLinea(s);
    if (!c || c.num !== m) break;
    if (!tieneEvidenciaRefNumerada(c.texto)) {
      const s2 = q + 1 < vista.length ? String(vista[q + 1]).replace(/^\f+/, "").trim() : "";
      if (!tieneEvidenciaRefNumerada(c.texto + " " + s2)) break;
    }
    seguidas++; m++; q++;
  }
  return seguidas >= 2 ? j : -1;
}
function haySegundaCorridaTras(vista, desde) {
  return indiceSegundaCorrida(vista, desde) !== -1;
}
// ¿Empieza en `vista[p]` una corrida numerada de solo título+URL
// seguida, tras un encabezado de sección, de OTRA corrida numerada?
// Devuelve el índice (en `vista`) de la segunda corrida, o -1.
// (M3b: la primera corrida son filas falsas de instrucciones; la
// segunda, la lista real. Sin segunda corrida, la primera valida:
// D5 es una lista real de webs de título pelado.) La primera
// corrida tiene 1–3 líneas: una sola fila falsa numerada seguida
// de la lista real es el mismo caso que tres.
function segundaCorrida(vista, p, sinVeto) {
  const c0 = numDeLinea(String(vista[p]).replace(/^\f+/, "").trim());
  if (!c0) return -1;
  // P1: con sinVeto, la primera fila se acepta también si su título
  // empieza por un verbo listado (la rama restoInline la consulta).
  if (!(sinVeto ? soloTituloYUrlSinVeto(c0.texto) : soloTituloYUrl(c0.texto))) return -1;
  let n = c0.num, k = p, recogidas = 0;
  while (k < vista.length && recogidas < 3) {
    const s = String(vista[k]).replace(/^\f+/, "").trim();
    const c = numDeLinea(s);
    if (!c || c.num !== n || !tieneEvidenciaWeb(c.texto)) break;
    recogidas++; n++; k++;
  }
  if (recogidas === 0) return -1;
  return indiceSegundaCorrida(vista, k);
}
// ¿Es esta línea un preámbulo falso antes de la lista real (M1/M2/
// M3)? Solo título + URL, sin estructura, sin cola, sin lugar, sin
// año: una fila de instrucciones («Ver protocolo. Disponible en
// https://…») y una web real de título pelado (L1) tienen la misma
// forma; solo el contexto las distingue (hayCorridaNumeradaTras).
function esPreambuloFalso(s) {
  // Q1: un título que empieza por año con URL («2020 guidelines…
  // Available from: …») también es preámbulo conservable: la URL
  // tras el marcador la distingue de la prosa. (El chequeo general
  // excluye líneas con año, así que este caso va aparte.)
  // R2: igual el que TERMINA en año («Kidney stones 2020.
  // Available from: …»).
  if (tituloAnioConUrl(s) && !tieneEstructuraCita(s)) return true;
  if (tituloAnioFinalConUrl(s) && !tieneEstructuraCita(s)) return true;
  // P6: una web de título de una palabra («Urolithiasis. Available
  // from: …») también es preámbulo conservable: la URL tras el
  // marcador (o directa) la distingue de la prosa («Resultados.»).
  return tieneEvidenciaWeb(s) && (tieneTituloAlInicioSinVeto(s) || tituloUnaPalabraConUrl(s)) &&
    !tieneEstructuraCita(s) && !TAIL_LIGERO_RE.test(s) &&
    !LUGAR_EDITORIAL_RE.test(s) && !ANIO_RE.test(s);
}
// U2 (ronda 15): línea que es SOLO lugar:editorial (+ año/edición),
// sin autor ni título delante («New York: Springer; 2021.»,
// «La Habana: Editorial Ciencias Médicas, 2020.»). Es la cola de un
// libro o una línea editorial suelta: dudosa, se conserva con flag
// (posiblePreambulo) en vez de llegar a revisión como ref normal.
// El lugar debe empezar la línea: con autor o título delante
// («Tratado…. New York: Springer; 2020.») es un libro real y no se
// marca. No se toca esPreambuloFalso (veto en validadores).
function esLineaSoloLugar(s) {
  const t = String(s).trim();
  const m = LUGAR_EDITORIAL_RE.exec(t);
  if (!m || m.index !== 0) return false;
  if (pareceInicioSinNumero(t) || tieneEstructuraCita(t) || tieneTituloAlInicio(t)) return false;
  return true;
}
// U2 (ronda 15): marcador de cita pelado, sin título («Available
// from: https://…», «Disponible en: https://…»). También dudoso:
// llega a revisión como ref normal y se crea un ítem vacío.
function esMarcadorPelado(s) {
  return /^(?:available from|disponible en)\s*:?\s*(?:https?:\/\/|www\.)\S*\.?\s*$/i.test(String(s).trim());
}
// ¿Empieza una corrida numerada en las líneas siguientes (hasta 5
// líneas no vacías)? Las intermedias deben ser preámbulo (título+
// URL) o encabezado de sección; una ref real entre medias corta la
// búsqueda (la línea no es preámbulo). Desviación del encargo
// literal (§5.2 pedía 2–3 líneas): la 1ª fila de M3 está a 4 líneas
// de la corrida (fila, fila, «Discusión», «1. Smith»); con 2–3 no
// se saltaría y M3 daría 4 refs. La restricción de intermedias
// mantiene la regla acotada.
function hayCorridaNumeradaTras(resto, li) {
  let vistos = 0;
  for (let k = li + 1; k < resto.length && vistos < 5; k++) {
    const s = resto[k].replace(/^\f+/, "").trim();
    if (!s || esPie(s) || /^\d{1,4}$/.test(s)) continue;
    vistos++;
    if (numDeLinea(s)) return true;
    if (esPreambuloFalso(s) || esEncabezadoSeccion(s)) continue;
    return false;
  }
  return false;
}
// ¿Es esta racha de líneas casi idénticas un preámbulo antes de la
// lista real (K15')? Solo si tras ella viene una lista numerada o
// un encabezado de sección. Si tras ella viene directamente una ref
// sin numerar, la racha ES la lista (M5/M5b: 3 webs reales al mismo
// título) y no se salta.
function rachaEsPreambulo(resto, fin) {
  let vistos = 0;
  for (let k = fin; k < resto.length && vistos < 4; k++) {
    const s = resto[k].replace(/^\f+/, "").trim();
    if (!s || esPie(s) || /^\d{1,4}$/.test(s)) continue;
    vistos++;
    if (numDeLinea(s)) return true;
    if (esEncabezadoSeccion(s)) return true;
    return false;
  }
  return false;
}
// ¿Viene el año DESPUÉS del primer «. » (forma de cita: título.
// año. URL)? (M11: «Paciente de 45 años con litiasis renal. 2020.
// https://…» se rescata como libro; «Ver guía 2020 en https://…»,
// con el año en mitad de la frase, no.)
function anioTrasPrimerPunto(s) {
  const idx = s.indexOf(". ");
  if (idx === -1) return false;
  const resto = s.slice(idx + 2).trim();
  return /^(?:19|20)\d{2}\b/.test(resto);
}
// ¿Empieza aquí una racha de ≥3 líneas casi idénticas? Filas falsas
// de una tabla («Ver protocolo. Disponible en https://…/p1» ×3)
// antes de la primera ref real: se saltan enteras, no se abren como
// refs (K15/K15'). Una ref real no tiene 3 líneas idénticas
// seguidas. Devuelve la longitud de la racha, o 0.
function rachaCasiIdentica(lineas, i) {
  const k0 = claveCasiIdentica(lineas[i]);
  if (!k0) return 0;
  let n = 0;
  while (i + n < lineas.length && claveCasiIdentica(lineas[i + n]) === k0) n++;
  return n >= 3 ? n : 0;
}
// ¿Es esta línea una continuación pelada de cita y no prosa con un
// enlace? «Available from: https://…», una URL pelada, una cola
// Vancouver suelta o un año suelto son la cola de una ref partida
// (K1/K2). «Resultados. Ver en https://…» es prosa (K3): empieza
// por un título de una palabra y un verbo, no por el marcador de
// cita ni por la URL.
function esContinuacionPelada(s) {
  const t = s.trim();
  if (/^(?:available from|disponible en)\s*:/i.test(t)) return true;
  if (/^https?:\/\/\S+\.?$/i.test(t)) return true;
  if (/^www\.\S+\.?$/i.test(t)) return true;
  if (TAIL_LIGERO_RE.test(t) && !pareceInicioSinNumero(t) && !tieneEstructuraCita(t) && !tieneTituloAlInicio(t)) return true;
  if (/^\[?(?:19|20)\d{2}\]?\.?\s*$/.test(t)) return true;
  return false;
}
// ¿Parece esta línea la primera mitad de una referencia partida
// (institución o título cortos)? Corta (≤12 palabras) y con
// estructura de cita, título al inicio, o frase corta capitalizada
// terminada en punto («Kidney stones.»). No vale un encabezado ni
// una línea larga de prosa. Se usa solo al abrir la primera ref de
// la lista (K1/K2): una vez abierta, ya no hay descartes que
// recuperar.
function esMitadPartida(s) {
  const t = String(s).trim();
  if (!t || t.split(/\s+/).length > 12) return false;
  if (esEncabezado(t)) return false;
  if (tieneEstructuraCita(t) || tieneTituloAlInicio(t)) return true;
  return /^[A-Z][\p{L}]+(?:\s+[\p{L}]+){0,5}\.\s*$/u.test(t);
}
function encabezadoConListaValida(lineas, i, meta) {
  // El resto de la propia línea (encabezado con la 1ª ref pegada:
  // "Referencias: 1. Smith...") también vale — pero solo con
  // evidencia de cita (cola, URL, lugar:editorial o año con
  // estructura): un resto con solo "pinta de autor" ("Referencias:
  // Paciente B, 52 años") es el mismo agujero que G1 en la rama
  // numerada, y un año suelto de fila clínica («ingreso 2020») no
  // basta (H2). Los casos reales validan igual por el escaneo de las
  // líneas siguientes.
  const restoInline = encabezadoConReferencia(lineas[i]);
  if (restoInline) {
    // Candidatas para la regla de casi-idénticas (K15'/J4'): el resto
    // + las 2 líneas siguientes (las 3 refs que validarían el
    // encabezado). Si las 3 son casi idénticas, el resto no valida
    // por esta vía: se sigue buscando en el bucle.
    const cand = [restoInline];
    for (let k = i + 1; k < lineas.length && cand.length < 3; k++) {
      const s2 = lineas[k].replace(/^\f+/, "").trim();
      if (!s2 || esPie(s2) || /^\d{1,4}$/.test(s2)) continue;
      cand.push(s2);
    }
    // M3b: si el resto abre una corrida de solo título+URL seguida
    // de otra corrida numerada (filas falsas + lista real), el
    // encabezado NO valida por el resto: se rechaza y el fallback
    // encuentra la lista real. Validar aquí metería las filas
    // falsas como refs (la segmentación no salta filas numeradas).
    // N12: la evidencia se comprueba sobre el texto SIN el prefijo
    // numérico («1. Buscar…»): el chequeo de título está anclado al
    // inicio y el «1. » lo hacía fallar, así que la rama se saltaba
    // entera sin consultar segundaCorrida y la fila falsa inline se
    // colaba como ref 1 (con Smith tragada). La vista para
    // segundaCorrida conserva el prefijo (numDeLinea lo quita).
    const restoTexto = numDeLinea(restoInline) ? numDeLinea(restoInline).texto : restoInline;
    // P1: la evidencia aquí es la variante SIN veto de verbos: con
    // la vetada, un resto «1. Ver el protocolo. …» daba false y la
    // rama se saltaba entera sin consultar segundaCorrida.
    if (tieneEvidenciaRefNumeradaSinVeto(restoTexto) && !lineasCasiIdenticas(cand)) {
      const vistaInline = [restoInline].concat(lineas.slice(i + 1, i + 9));
      if (segundaCorrida(vistaInline, 0, true) !== -1) return false;
      return true;
    }
  }
  for (let j = i + 1; j < lineas.length && j <= i + 10; j++) {
    const s = lineas[j].replace(/^\f+/, "").trim();
    // Blancos, pies de página y números de página sueltos se saltan.
    if (!s || esPie(s) || /^\d{1,4}$/.test(s)) continue;
    // Otro encabezado antes que la lista: este no la encabeza.
    if (esEncabezadoExacto(s) || esEncabezadoParecido(s)) return false;
    const c = numDeLinea(s);
    if (c) {
      // M3b: si esta línea abre una corrida de solo título+URL
      // seguida de otra corrida numerada (filas falsas + lista
      // real), el encabezado NO valida por esta línea: se rechaza
      // y el fallback encuentra la lista real. R3: la variante SIN
      // veto de verbos (el arreglo P1 solo había llegado a la rama
      // inline): con la vetada, una fila «1. Revisar la guía. …»
      // daba false y la rama se saltaba sin consultar
      // segundaCorrida, así que Smith quedaba tragada en la ref 1.
      if (segundaCorrida(lineas, j, true) !== -1) return false;
      // Candidatas para la regla de casi-idénticas (K15'/J4'): el
      // resto inline + esta línea + las 2 siguientes. Se recogen por
      // adelantado: la evidencia se comprueba tras cada apéndice y
      // el 3er idéntico aún no estaría en el bloque.
      const candidatas = [];
      if (restoInline) candidatas.push(restoInline);
      candidatas.push(s);
      for (let k = j + 1; k < lineas.length && k <= j + 2; k++) {
        const s2 = lineas[k].replace(/^\f+/, "").trim();
        if (s2) candidatas.push(s2);
      }
      const repetidas = lineasCasiIdenticas(candidatas);
      // La ref puede venir partida: el año/cola puede estar en las
      // 2 líneas siguientes ("1. Smith J. Title..." / "...2020;15:1-5.").
      // Pero solo vale con EVIDENCIA NUMERADA (cola, URL o lugar con
      // estructura de cita, o año con estructura): la "pinta de
      // autor" sola NO basta — una fila de tabla ("Paciente B, 52
      // años") también parece un autor y el encabezado falso
      // validaba por ella (G1), un año suelto de fila clínica
      // («ingreso 2020») tampoco (H2), un título pelado con URL
      // («Ver protocolo. Disponible en https://…», J4') tampoco, y
      // un lugar justo tras la institución («Hospital Ameijeiras.
      // La Habana: Cuba.», J5') tampoco.
      let bloque = c.texto;
      if (tieneEvidenciaRefNumerada(bloque) && !repetidas) return true;
      for (let k = j + 1; k < lineas.length && k <= j + 2; k++) {
        const s2 = lineas[k].replace(/^\f+/, "").trim();
        if (!s2) continue;
        bloque += " " + s2;
        if (tieneEvidenciaRefNumerada(bloque) && !repetidas) return true;
      }
      // M4: el bloque tiene evidencia pero los candidatos son casi
      // idénticos (3 webs reales al mismo título con URLs distintas).
      // NO rechazar de inmediato: anotar (con flag «posibles
      // duplicados, revisar») y seguir buscando otra lista en la
      // ventana; si tras la corrida viene otra corrida numerada
      // (filas falsas + lista real, J4''), se rechaza y el fallback
      // encuentra la real; si no viene ninguna otra, el escaneo
      // valida por la cola de la corrida (desde la 2ª línea las
      // candidatas ya no son 3 idénticas).
      if (tieneEvidenciaRefNumerada(bloque) && repetidas) {
        if (meta) meta.posiblesDuplicados = true;
        // Fin de la corrida idéntica: líneas numeradas seguidas con
        // la misma clave (el resto inline cuenta como primera si
        // comparte clave, pero vive en la línea i, no en el escaneo).
        let finRun = j;
        const claveRun = claveCasiIdentica(c.texto);
        while (finRun < lineas.length) {
          const sR = lineas[finRun].replace(/^\f+/, "").trim();
          const cR = numDeLinea(sR);
          if (!cR || claveCasiIdentica(sR) !== claveRun) break;
          finRun++;
        }
        if (haySegundaCorridaTras(lineas, finRun)) return false;
        continue;
      }
      // Línea numerada que no parece referencia ("1. Paciente A"):
      // es otro contenido (tabla, cuestionario), no la lista.
      return false;
    }
    // Línea sin numerar (H3): solo vale si el bloque (esta línea +
    // las 2 siguientes SIN numerar — el bloque no cruza una línea
    // numerada, o la cola de la lista real validaría el encabezado
    // falso) trae evidencia de cita. Una línea con pinta de autor
    // pero sin evidencia («García M, López A, Pérez J.») es una
    // lista de nombres, no el inicio de la bibliografía: se rechaza
    // el encabezado para que el fallback encuentre la lista real.
    // Tensión documentada (DECISIONES.md §R3.5): una lista real sin
    // numerar que empiece por un libro/web sin cola ni año ni URL ni
    // lugar en sus 3 primeras líneas no validaría; en la práctica
    // los libros traen lugar:editorial y las webs su URL.
    if (pareceInicioSinNumero(s) || TAIL_LIGERO_RE.test(s)) {
      let bloque = s;
      const lineasBloque = [s];
      let tomadas = 0;
      for (let k = j + 1; k < lineas.length && tomadas < 2; k++) {
        const s2 = lineas[k].replace(/^\f+/, "").trim();
        if (!s2 || esPie(s2) || /^\d{1,4}$/.test(s2)) continue;
        if (numDeLinea(s2)) break;
        bloque += " " + s2;
        lineasBloque.push(s2);
        tomadas++;
      }
      // Filas falsas casi idénticas (K15'): 3 líneas con el mismo
      // texto antes de la URL no validan como lista... salvo que no
      // haya otra lista detrás (M4 sin numerar con autor: la corrida
      // idéntica ES la lista). Con segunda corrida detrás se rechaza
      // (el fallback encuentra la real); sin ella se sigue buscando
      // en la ventana y la cola de la corrida valida (desde la 2ª
      // línea ya no son 3 idénticas). Sin evidencia, la línea es una
      // lista de nombres, no el inicio de la bibliografía: se
      // rechaza como antes (H3).
      if (tieneEvidenciaRef(bloque)) {
        if (!lineasCasiIdenticas(lineasBloque)) return true;
        if (meta) meta.posiblesDuplicados = true;
        if (haySegundaCorridaTras(lineas, j + lineasBloque.length)) return false;
      } else {
        return false;
      }
    }
    // Línea con URL o lugar:editorial pero sin pinta de autor (una
    // web institucional cuya institución no está en AUTHOR_CORPORATE,
    // J1): el bloque decide; si no trae evidencia NO se rechaza el
    // encabezado — la línea puede ser la continuación partida de una
    // ref (la institución sola en una línea y el título+URL en la
    // siguiente) — se sigue buscando dentro de la ventana.
    if (tieneEvidenciaWebOLugar(s)) {
      let bloque = s;
      const lineasBloque = [s];
      let tomadas = 0;
      for (let k = j + 1; k < lineas.length && tomadas < 2; k++) {
        const s2 = lineas[k].replace(/^\f+/, "").trim();
        if (!s2 || esPie(s2) || /^\d{1,4}$/.test(s2)) continue;
        if (numDeLinea(s2)) break;
        bloque += " " + s2;
        lineasBloque.push(s2);
        tomadas++;
      }
      // Filas falsas casi idénticas (K15'/K3'): 3 líneas con el mismo
      // texto antes de la URL no validan — se sigue buscando. Si el
      // bloque trae evidencia y es idéntico, se anota con flag
      // (M4: puede ser la lista real).
      if (tieneEvidenciaRef(bloque)) {
        if (!lineasCasiIdenticas(lineasBloque)) return true;
        if (meta) meta.posiblesDuplicados = true;
      }
    }
    // La prosa o un subtítulo no invalidan: se sigue buscando dentro
    // de la ventana.
  }
  return false;
}

function buscarEncabezado(lineas, meta) {
  for (let i = 0; i < lineas.length; i++) {
    if (esEncabezadoExacto(lineas[i]) && encabezadoConListaValida(lineas, i, meta)) return i;
  }
  for (let i = 0; i < lineas.length; i++) {
    if (esEncabezadoParecido(lineas[i]) && encabezadoConListaValida(lineas, i, meta)) return i;
  }
  return -1;
}

function encabezadoConReferencia(linea) {
  const colon = linea.indexOf(":");
  if (colon !== -1 && esEncabezadoExacto(linea.slice(0, colon))) {
    const texto = linea.slice(colon + 1).trim();
    if (texto) return texto;
  }
  const marker =
    /\s+(?=(?:\d+\s*[.)]|\[\s*\d+\s*\]|\(\s*\d+\s*\)|\d+\s*[-–—\u2010\u2011])\s*\S)/g;
  let match;
  while ((match = marker.exec(linea))) {
    if (esEncabezadoExacto(linea.slice(0, match.index))) {
      return linea.slice(match.index + match[0].length).trim();
    }
  }
  return "";
}

/* Fallback sin encabezado: primera corrida de 3+ referencias
 * numeradas seguidas (1, 2, 3...) de las que AL MENOS UNA tenga cola
 * Vancouver (año;volumen:páginas). Antes se exigía la cola en la
 * PRIMERA: si la lista empezaba por un libro o una web sin cola, el
 * fallback fallaba aunque la 2ª y 3ª sí la tuvieran. La cola evita
 * confundir la lista con secciones numeradas del cuerpo
 * ("1. Introduction..."). Un número no secuencial dentro del bloque
 * ("204." de "194-204") se trata como continuación, no como
 * referencia nueva. Devuelve el índice de la primera línea de la
 * corrida, o -1. */
function buscarCorridaNumerada(lineas, meta) {
  const TAIL = TAIL_LIGERO_RE;
  const numDe = numDeLinea;
  // Corrida idéntica con evidencia recordada (M4/M5): si los 3
  // candidatos son casi idénticos no se rechaza de inmediato — se
  // sigue buscando otra lista; si no aparece ninguna otra, esta
  // corrida ES la lista (con flag «posibles duplicados, revisar»).
  // Si aparece otra corrida DISJUNTA (tras la recordada), es la
  // lista real (K15': las filas falsas + la real); si la otra
  // corrida SOLAPA con la recordada, es la misma lista corrida un
  // puesto (M17: 3 idénticas + 2 normales) y manda la recordada.
  let candidatoIdentico = null;
  for (let i = 0; i < lineas.length; i++) {
    const c0 = numDe(lineas[i].trim());
    if (!c0) continue;
    const bloques = [c0.texto];
    let esperado = c0.num + 1;
    let encontrados = 1;
    let j = i + 1;
    let recorridas = 0;
    while (j < lineas.length && recorridas < 30) {
      const s = lineas[j].trim();
      const c = numDe(s);
      if (c && c.num === esperado) {
        encontrados++;
        bloques.push(c.texto);
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
      } else if (s) {
        bloques[bloques.length - 1] += " " + s;
      }
      j++;
      recorridas++;
    }
    if (encontrados < 3) continue;
    // P4 (fallback): si esta corrida es de solo título+URL seguida
    // de otra corrida tras un encabezado de sección, Y viene
    // precedida de una línea de preámbulo (web sin numerar), la
    // lista empieza en el preámbulo — se devuelve su índice para
    // que se conserve con flag y la segmentación salte la corrida
    // falsa. Sin preámbulo antes, NO se salta: una primera corrida
    // real (N3 sin encabezado: 3 webs + Discusión + lista real) es
    // indistinguible por estructura de la corrida falsa, y saltarla
    // borraría 3 refs reales en silencio (H5). Ver DECISIONES.md
    // §R10.4.
    const idxSegunda = segundaCorrida(lineas, i, true);
    if (idxSegunda !== -1) {
      let k = i - 1;
      while (k >= 0) {
        const sAnt = lineas[k].trim();
        if (!sAnt || esPie(sAnt) || /^\d{1,4}$/.test(sAnt)) { k--; continue; }
        break;
      }
      if (k >= 0 && esPreambuloFalso(lineas[k].trim())) return k;
    }
    // Filas falsas casi idénticas (K15'/J4' sin encabezado): 3 líneas
    // con el mismo texto antes de la URL no son una lista... salvo
    // que no haya otra lista detrás (M4/M5): se recuerda y se sigue
    // buscando.
    if (lineasCasiIdenticas(bloques)) {
      if (!candidatoIdentico && bloques.some((b) => tieneEvidenciaCorrida(b))) {
        candidatoIdentico = { idx: i, fin: j + 1 };
        if (meta) meta.posiblesDuplicados = true;
      }
      continue;
    }
    // H1: una web sin año vale por su URL (o por su lugar:editorial
    // si es un libro); el año solo NO vale (una sección numerada del
    // cuerpo con un año no es la lista).
    if (!bloques.some((b) => tieneEvidenciaCorrida(b))) continue;
    if (candidatoIdentico && i < candidatoIdentico.fin) return candidatoIdentico.idx;
    return i;
  }
  return candidatoIdentico ? candidatoIdentico.idx : -1;
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
    "(^|\\s)(?:\\[\\s*" + num + "[a-zA-Z]?\\s*\\]|" +
    "\\(\\s*" + num + "[a-zA-Z]?\\s*\\)|" +
    num + "[a-zA-Z]?\\s*[.)]|" +
    num + "[a-zA-Z]?\\s*[-\u2010\u2011\u2013\u2014])\\s+",
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

/* Dos referencias SIN número pegadas en una misma línea:
 *   "Smith J. Title one. J Urol. 2020;15:1-5. Doe A. Title two. ..."
 * El lector por líneas solo veía una y la 2ª se perdía. Se corta
 * donde, tras una cola Vancouver completa, empieza otra referencia
 * (pinta de autor). Sin cola previa no se corta: una sola referencia
 * larga no se parte. El rango de páginas ("1-5") se salta antes de
 * buscar el inicio siguiente. */
function buscarCortePegado(s) {
  const re = new RegExp(TAIL_LIGERO_RE.source, "g");
  let m;
  while ((m = re.exec(s))) {
    let e = m.index + m[0].length;
    const rango = /^\s*[-\u2010-\u2015\u2212]\s*[A-Za-z]?\d+/.exec(s.slice(e));
    if (rango) e += rango[0].length;
    const sep = /^\.?\s+/.exec(s.slice(e));
    if (!sep) continue;
    const resto = s.slice(e + sep[0].length);
    // Inicio de ref sin numerar (J1/J2): una institución + título +
    // URL también abre ref, no solo el autor («National Kidney
    // Foundation...» tras la cola de la anterior). Una URL pelada o
    // un año suelto no cortan: son continuaciones («[Epub 2020]»).
    // M10: la guarda K3' también vive aquí — una línea con solo
    // título + URL pelada tras prosa («Datos clínicos. Consultar en
    // https://…») no corta: se queda pegada a la ref anterior, que
    // se ve en revisión, en vez de convertirse en ref propia.
    if (resto && esInicioRefValido(resto)) return e + sep[0].length;
  }
  return -1;
}

function separarRefsPegadas(lineas) {
  const salida = [];
  for (const ln of lineas) {
    let s = ln;
    let guard = 0;
    while (guard++ < 20) {
      const corte = buscarCortePegado(s);
      if (corte === -1) break;
      salida.push(s.slice(0, corte).trim());
      s = s.slice(corte).trim();
    }
    if (s) salida.push(s);
  }
  return salida;
}

/* Una línea numerada que abrió `actual` pero no parece una
 * referencia (sin autor, sin año, sin cola, sin URL, sin
 * lugar:editorial): es un subtítulo numerado de sección
 * ("1. Artículos"), no una ref. Antes se descartaba en silencio
 * cuando la línea numerada siguiente SÍ parecía una referencia (G3)
 * — y ese descarte se comía referencias reales cortas sin autor
 * reconocido ni año ni cola (H5: «National Kidney Foundation.
 * Kidney stones. Available from: ...» desaparecía sin rastro).
 * Ahora el descarte YA NO BORRA: lo dudoso se conserva como
 * referencia con flag («posible subtítulo, revisar», en
 * meta.posibleSubtitulo) para que la pantalla de revisión lo muestre
 * y lo decida el usuario. Por eso ya no hay tope de palabras (H4):
 * un subtítulo de 9 palabras se pegaba a la ref siguiente, y un
 * tope mayor se comería más refs institucionales cortas; con el
 * flag, una clasificación errónea solo cuesta un aviso, no una
 * referencia perdida. */
function esAbridorBasura(texto) {
  const s = String(texto).trim();
  if (!s) return false;
  return !lineaPareceRef(s);
}

// S2: índice de la línea de URL envuelta tras un año pelado, o -1.
// La línea actual es «AAAA. resto» (año pelado con resto, p. ej.
// «2020. Ver en») y la siguiente línea sustantiva es una URL pelada
// («https://…» o «www.…»). El veto R7 de numDeLinea solo ve la URL
// en la misma línea; con la URL envuelta, el año se leería como ref
// nº 2020 y se tragaría la lista entera. Sin resto tras el año
// («2020.» solo) también vale, PERO solo si no hay ref abierta
// (`sinRefAbierta`): en mitad de lista, un año pelado es la
// continuación de la ref abierta (libro partido, K8) y la URL
// siguiente es su continuación, no una fila falsa. Sin ref abierta,
// un año pelado seguido de una URL no puede ser continuación de
// nada: es la misma fila falsa y se tragaría la lista igual.
function indiceUrlEnvuelta(lineas, i, s, sinRefAbierta) {
  if (sinRefAbierta) {
    if (!/^(?:19|20)\d{2}\.\s*(?:\S.*)?$/.test(s)) return -1;
  } else if (!/^(?:19|20)\d{2}\.\s+\S/.test(s)) return -1;
  let j = i + 1;
  while (j < lineas.length) {
    const s2 = String(lineas[j]).replace(/^\f+/, "").trim();
    if (!s2 || esPie(s2) || /^\d{1,4}$/.test(s2)) { j++; continue; }
    break;
  }
  if (j >= lineas.length) return -1;
  const s2 = String(lineas[j]).replace(/^\f+/, "").trim();
  if (/^(?:(?:Disponible en|Available from):?\s*)?(?:https?:\/\/|www\.)\S*\.?$/i.test(s2)) return j;
  return -1;
}

function extraerReferencias(lineas, meta) {
  /* Devuelve la lista de referencias en texto (una por cadena). */
  // 1. localizar el encabezado de referencias (o el fallback)
  let idxEnc = buscarEncabezado(lineas, meta);
  let inline = idxEnc === -1 ? "" : encabezadoConReferencia(lineas[idxEnc]);
  if (idxEnc === -1) {
    // 2º bucle: encabezado con la 1ª ref pegada en su línea
    // ("Referencias: 1. Smith..."). Se acepta SOLO si valida con la
    // MISMA regla que buscarEncabezado: sin validar, un "Referencias"
    // falso ("Referencias: 1. Paciente A, 45 años") secuestraba la
    // extracción y la lista real se perdía (G1). Si no valida, se
    // sigue buscando y, si no hay nada, manda el fallback de corrida.
    for (let i = 0; i < lineas.length; i++) {
      const remainder = encabezadoConReferencia(lineas[i]);
      if (remainder && encabezadoConListaValida(lineas, i, meta)) {
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
    const idxCorrida = buscarCorridaNumerada(lineas, meta);
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
  // v0.1.14 (F6): y las sin número pegadas en una misma línea.
  const resto = separarRefsPegadas(separarLineasNumeradas(lineasRestantes));
  // 2. segmentar por número y unir líneas. El número debe ser
  // SECUENCIAL (1, 2, 3...): una línea como "204. 10.1055/..." es la
  // continuación de la página partida "194-", no la referencia 204.
  const refs = [];
  let actual = null;
  let esperado = null;
  // ¿Es `actual` una línea con forma de preámbulo (solo título +
  // URL) conservada con flag (N1/N2)? Se consume en empujar().
  let actualEsPreambulo = false;
  // Última línea descartada antes de abrir la primera ref (K1/K2):
  // si la primera ref de la lista viene partida y su primera mitad
  // no parece inicio de ref, se perdía en silencio. Cuando una
  // continuación pelada abre la primera ref, la mitad anterior se le
  // pega delante si tiene pinta de institución/título. Solo vale al
  // inicio de la lista (actual === null): una vez abierta la primera
  // ref ya no hay descartes que recuperar.
  let ultimaDescartada = null;
  // Empujar una referencia acumulada. Si parece un subtítulo
  // (abridor basura), se CONSERVA igual y se anota su índice en
  // meta.posibleSubtitulo para que _parseRefs le ponga el flag
  // «posible subtítulo, revisar»: nunca borrar en silencio (H5).
  // Igual para el preámbulo (meta.posiblePreambulo, N1/N2): una web
  // real y una fila falsa tienen la misma forma; se conserva con
  // flag «posible fila de instrucciones, revisar».
  function empujar(texto) {
    refs.push(texto);
    if (meta && esAbridorBasura(texto)) {
      (meta.posibleSubtitulo = meta.posibleSubtitulo || []).push(refs.length - 1);
    }
    if (meta && actualEsPreambulo) {
      (meta.posiblePreambulo = meta.posiblePreambulo || []).push(refs.length - 1);
      actualEsPreambulo = false;
    }
  }
  // Bucle indexado (no for-of): la racha casi idéntica se salta
  // avanzando el índice (K15/K15').
  for (let li = 0; li < resto.length; li++) {
    const ln = resto[li];
    // El extractor de Zotero separa las páginas con \f al inicio de la
    // primera línea de la página siguiente. Si la lista venía abierta
    // y la página nueva empieza con OTRA numeración (p. ej. el
    // cuestionario "1.- ¿Cuál...?" tras la bibliografía), la lista
    // terminó: sin esto, esa página entera se pegaba a la última
    // referencia (la última referencia quedaba con 2.700 caracteres).
    const saltoPagina = ln.startsWith("\f");
    const s = ln.replace(/^\f+/, "").trim();
    if (!s || esPie(s)) continue;
    // S2: año pelado + URL envuelta («2020. Ver en» / «https://…»):
    // las dos líneas son una fila falsa de instrucciones y se
    // descartan juntas, como la variante en una sola línea (que
    // numDeLinea ya veta con R7 y la segmentación descarta antes de
    // la primera ref). Sin esto, el año se leía como ref nº 2020 y
    // la lista entera se tragaba en una sola ref.
    const idxUrlEnvuelta = indiceUrlEnvuelta(resto, li, s, actual === null);
    if (idxUrlEnvuelta !== -1) { li = idxUrlEnvuelta; continue; }
    const c = numDeLinea(s);
    const num = c ? c.num : null;
    if (saltoPagina && refs.length > 0 && actual !== null &&
      num !== null && esperado !== null && num !== esperado) {
      break;
    }
    if (num !== null && (esperado === null || num === esperado)) {
      // P4 (ronda 11, Q2): una corrida numerada de solo título+URL
      // seguida de un encabezado de sección + otra corrida numerada
      // son filas falsas (M3b) aunque el encabezado ya haya validado
      // por un preámbulo sin numerar (C3: la guarda vive solo en el
      // validador y la segmentación abría la corrida falsa). Antes se
      // SALTABA la corrida entera — pero C3 (3 filas falsas) y
      // N3-con-preámbulo (3 webs reales) son indistinguibles por
      // estructura, y saltar borraba 3 refs reales en silencio
      // (violación de H5). Ahora se CONSERVA la corrida con flag
      // («posible fila de instrucciones, revisar», mismo patrón que
      // meta.posiblePreambulo) y se sigue con la segunda corrida.
      // Solo cuando la ref abierta ES el preámbulo: sin preámbulo,
      // la corrida es la lista misma (N3: 3 webs + Discusión + lista
      // real dan 6 refs). Ver DECISIONES.md §R11.2.
      if (actual !== null && actualEsPreambulo) {
        const idxSegunda = segundaCorrida(resto, li, true);
        if (idxSegunda !== -1) {
          empujar(actual);
          actual = null;
          // Q2: cada línea numerada del rango [li, idxSegunda) se
          // empuja como ref con flag de preámbulo. El rango solo
          // contiene las líneas de la corrida + el encabezado de
          // sección + blancos (segundaCorrida exige corrida
          // consecutiva de líneas simples); las no numeradas se
          // saltan. empujar() consume actualEsPreambulo por línea,
          // así que se rearma antes de cada una.
          for (let k = li; k < idxSegunda; k++) {
            const sk = resto[k].replace(/^\f+/, "").trim();
            const ck = numDeLinea(sk);
            if (ck) {
              actualEsPreambulo = true;
              empujar(ck.texto);
            }
          }
          li = idxSegunda - 1;
          continue;
        }
      }
      if (actual) {
        // Subtítulo numerado que se coló como ref ("3. Artículos" en
        // mitad de la lista): se conserva con flag (H5), no se borra.
        empujar(actual);
      }
      esperado = num + 1;
      actual = c.texto;
    } else {
      // Salto de número (falta el 2, viene el 3): la referencia
      // anterior ya está completa (tiene cola Vancouver) y no es un
      // corte de página ("194-" partido). Antes se pegaba a la
      // anterior y se perdía una referencia entera. El salto se
      // limita a 5: más que eso huele a otra lista (cuestionario,
      // apéndice) y ahí manda la rama de corte de abajo.
      if (
        num !== null && actual !== null && esperado !== null &&
        num > esperado && num - esperado <= 5 &&
        TAIL_LIGERO_RE.test(actual) && !actual.endsWith("-")
      ) {
        empujar(actual);
        esperado = num + 1;
        actual = c.texto;
        continue;
      }
      // Abridor numerado basura ("1. Artículos"): la línea numerada
      // que abrió `actual` no parece una referencia y es corta, y la
      // línea numerada siguiente SÍ parece una referencia. Antes se
      // descartaba el abridor (G3); ahora se CONSERVA como ref con
      // flag (H5): sin tope de palabras, el subtítulo de 9 palabras
      // (H4) también se conserva en vez de pegarse a la ref
      // siguiente. La numeración de las refs reales no se corre:
      // el subtítulo ocupa su propio índice y el usuario lo desmarca
      // en la revisión.
      if (
        num !== null && actual !== null && num !== esperado &&
        esAbridorBasura(actual) && lineaPareceRef(c.texto)
      ) {
        empujar(actual);
        esperado = num + 1;
        actual = c.texto;
        continue;
      }
      // Reinicio de numeración por sección ("1,2,1,2"): la
      // numeración vuelve a 1 (o 2) y la referencia anterior está
      // completa (tiene cola). Antes la lista se cortaba aquí y la
      // 2ª sección se perdía entera. Se sigue extrayendo y el
      // reinicio se anota en `meta.reinicioEn` (índices de las refs
      // que abren sección) para que el llamador lo marque con flag.
      // El salto de página (\f) sigue cortando la lista como antes:
      // un cuestionario en la página siguiente no es una sección.
      // N3: la ref anterior también vale si es una web completa
      // (tieneEvidenciaWeb): una web no tiene cola y por eso el
      // reinicio no cortaba — «Prostate health. Available from:
      // … Discusión 1. Smith…» se pegaba y Smith se tragaba.
      if (
        num !== null && actual !== null && num !== esperado &&
        num <= 2 && refs.length >= 1 && (TAIL_LIGERO_RE.test(actual) || tieneEvidenciaWeb(actual)) &&
        lineaPareceRef(c.texto)
      ) {
        empujar(actual);
        if (meta) {
          meta.reinicios = (meta.reinicios || 0) + 1;
          (meta.reinicioEn = meta.reinicioEn || []).push(refs.length);
        }
        esperado = num + 1;
        actual = c.texto;
        continue;
      }
      if (num !== null && actual !== null && num !== esperado &&
        refs.length >= 1 && TAIL_LIGERO_RE.test(actual)) {
        break;
      }
      if (actual === null) {
        // Inicio de lista sin numerar (J1): una línea con URL /
        // lugar:editorial + estructura de cita también abre ref
        // aunque su autor corporativo no esté en la lista.
        // Híbrido (K1/K2, juicio del árbitro §R5): al ABRIR se usa
        // lineaPareceRef (no esInicioRef): una continuación pelada
        // («Available from: https://…», URL, cola o año sueltos)
        // abre una ref degenerada VISIBLE en vez de perderse en
        // silencio, y su mitad anterior se le pega delante si tiene
        // pinta de institución/título. Al CORTAR se sigue usando
        // esInicioRef (rama de corte y buscarCortePegado), para que
        // una web partida «…Available from:» / «https://…» no se
        // parta en dos. La prosa con enlace («Resultados. Ver en
        // https://…», K3) NO abre: no es inicio ni continuación
        // pelada, así que se descarta como las demás líneas previas.
        // Racha de filas falsas casi idénticas (K15/K15') antes de la
        // primera ref: se salta ENTERA (el update del bucle suma 1
        // más) — pero SOLO si tras ella viene una lista numerada o
        // un encabezado de sección (M5/M5b): si tras ella viene
        // directamente una ref sin numerar, la racha ES la lista
        // (3 webs reales al mismo título con URLs distintas) y no
        // se salta. Sin esto, la apertura permisiva (L1) abriría las
        // 3 filas como refs aunque el validador no las validara:
        // el encabezado es real y valida por la lista real, y las
        // filas quedan entre el encabezado y la lista.
        const racha = rachaCasiIdentica(resto, li);
        if (racha > 0 && rachaEsPreambulo(resto, li + racha)) {
          li += racha - 1;
          continue;
        }
        // S3: web partida con título que empieza o termina en año:
        // la línea del título («2022 european guidelines…
        // stones.», «Kidney stones 2020.») no trae el marcador y
        // la línea siguiente trae solo «Available from: URL». Sin
        // unirlas, el título se descartaba y sobrevivía solo el
        // marcador como ref degenerada sin flag. Se unen y se marcan
        // como preámbulo si tras ellas viene una corrida numerada
        // (mismo patrón que esPreambuloFalso + hayCorridaNumeradaTras);
        // sin corrida numerada detrás no se unen: la partida
        // sobrevive como dos refs por la vía normal (K1/K2).
        if (esTituloAnioPartido(s)) {
          let j2 = li + 1;
          while (j2 < resto.length) {
            const s2 = resto[j2].replace(/^\f+/, "").trim();
            if (!s2 || esPie(s2) || /^\d{1,4}$/.test(s2)) { j2++; continue; }
            break;
          }
          if (j2 < resto.length) {
            const s2 = resto[j2].replace(/^\f+/, "").trim();
            if (esContinuacionPelada(s2) && hayCorridaNumeradaTras(resto, j2)) {
              actual = s + " " + s2;
              actualEsPreambulo = true;
              li = j2;
              continue;
            }
          }
        }
        // Preámbulo falso antes de la lista real (M1/M2/M3): una
        // línea con solo título + URL ya NO se salta en silencio
        // (N1/N2): una web real («Kidney stones. Available from:
        // …») y una fila falsa («Ver protocolo. Disponible en …»)
        // tienen la misma forma y el salto borraba la real sin
        // rastro. Se CONSERVA como ref con flag («posible fila de
        // instrucciones, revisar», mismo principio que H5): el
        // usuario desmarca la fila falsa en revisión o conserva la
        // web real, y el enlazado ya omite lo excluido (J6), así
        // que la fila conservada no corrompe las citas. En L1 no
        // hay corrida numerada después (las refs son sin numerar),
        // así que la web real sigue abriéndose por la vía normal,
        // sin flag.
        if (esPreambuloFalso(s) && hayCorridaNumeradaTras(resto, li)) {
          actual = s;
          actualEsPreambulo = true;
          continue;
        }
        if (esInicioRefValido(s)) {
          actual = s;
          // U2: línea de solo lugar:editorial o marcador pelado que
          // abre ref: se conserva, pero con flag (posiblePreambulo).
          actualEsPreambulo = esLineaSoloLugar(s) || esMarcadorPelado(s);
        } else if (lineaPareceRef(s) && esContinuacionPelada(s)) {
          const conMitad = ultimaDescartada && esMitadPartida(ultimaDescartada);
          actual = conMitad ? ultimaDescartada + " " + s : s;
          // U2: marcador pelado sin mitad anterior que lo complete.
          actualEsPreambulo = !conMitad && esMarcadorPelado(s);
        } else if (ANIO_RE.test(s) && (/\bed\./i.test(s) || LUGAR_EDITORIAL_RE.test(s) ||
          // M11: la URL SÍ cuenta como marca de libro solo cuando el
          // año viene DESPUÉS del primer «. » (forma de cita:
          // título. año. URL). «Paciente de 45 años con litiasis
          // renal. 2020. https://…» se rescata; «Ver guía 2020 en
          // https://…» (año en mitad de la frase) no.
          (tieneEvidenciaWeb(s) && anioTrasPrimerPunto(s)))) {
          // L4: línea descartada con año + marca de libro («2.ª
          // ed.», lugar:editorial): un libro sin autor cuyo título
          // empieza por «Paciente» («Paciente de 45 años con
          // litiasis renal. 2.ª ed. 2020.») no es una fila clínica
          // y no debe perderse en silencio. Se conserva como ref;
          // el parser ya la marca con flag («sin autores
          // reconocibles», «sin cola…») para la revisión. La URL
          // NO es marca aquí: una prosa con enlace y año («Ver
          // guía 2020 en https://…») se colaría como ref.
          actual = s;
          // U2: línea de solo lugar:editorial que abre ref por esta
          // vía («New York: Springer; 2021.»): con flag.
          actualEsPreambulo = esLineaSoloLugar(s) || esMarcadorPelado(s);
        } else {
          ultimaDescartada = s;
        }
        continue;
      }
      // Lista sin numerar: la línea nueva empieza una ref y la
      // referencia abierta ya está completa (tiene cola, URL,
      // lugar:editorial, termina en año, o es larga y termina en
      // punto). Sin esto, dos refs sin número se pegaban (y la NKF
      // se pegaba a la anterior, J2). Terminar en año es el cierre
      // de un libro («…3.ª ed. 2021.», K14): sin esta cláusula, dos
      // libros cortos sin numerar se pegaban en uno. La cláusula es
      // segura porque el corte exige además esInicioRef(s): una
      // continuación («J Urol. 2021;15:1-5.», «Madrid: Elsevier.»)
      // no es inicio y se sigue pegando. La cláusula de longitud no
      // corta un capítulo sin terminar («…En: Jones R, editor.»,
      // K4): el libro aún no llegó y la continuación es la línea
      // siguiente.
      // M10: el corte en mitad de lista usa esInicioRefValido, no
      // esInicioRef: una línea con solo título + URL pelada tras
      // prosa («Datos clínicos. Consultar en https://…») no abre
      // ref propia — se pega a la anterior y se ve en revisión.
      // N1/N2: si la línea que abre aquí tiene forma de preámbulo
      // y tras ella viene una corrida numerada, también se marca
      // (la 2ª y 3ª fila de M2/M3 abren por aquí, no por la rama
      // de apertura); si tras ella viene otra ref sin numerar, es
      // una web real de lista sin numerar (M5) y NO se marca.
      if (num === null && esInicioRefValido(s) &&
        (TAIL_LIGERO_RE.test(actual) || tieneEvidenciaWeb(actual) ||
          LUGAR_EDITORIAL_RE.test(actual) ||
          /\b(?:19|20)\d{2}\]?\.?\s*$/.test(actual) ||
          (actual.length > 60 && actual.endsWith(".") && !capituloIncompleto(actual)))) {
        empujar(actual);
        actual = s;
        actualEsPreambulo = esPreambuloFalso(s) && hayCorridaNumeradaTras(resto, li);
        continue;
      }
      if (actual.endsWith("-")) actual += s;
      else actual += " " + s;
    }
  }
  if (actual) empujar(actual);
  // Lista vacía sin error (L1): un encabezado que validó pero del
  // que no salió ninguna referencia (p. ej. numeración romana sin
  // soporte, o lista con otro formato) ya no devuelve 0 refs en
  // silencio — la pantalla de revisión salía vacía sin explicar por
  // qué. Con numeración romana (i./ii./iii.) esto ya no se dispara:
  // numDeLinea la acepta.
  if (refs.length === 0) {
    throw new Error(
      "la lista de referencias está vacía: tras el encabezado no se reconoció ninguna referencia (¿numeración romana, lista sin numerar con otro formato?)"
    );
  }
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
    lineaPareceRef,
    esAbridorBasura,
    esInicioRef,
    tieneEstructuraCita,
    tieneTituloAlInicio,
    tieneEvidenciaRef,
    tieneEvidenciaRefNumerada,
    tieneLugarConTitulo,
    capituloIncompleto,
    esContinuacionLugar,
    esContinuacionPelada,
    esMitadPartida,
    esFilaClinica,
    tieneEvidenciaWeb,
    tieneEvidenciaWebOLugar,
    tieneEvidenciaCorrida,
    tieneEvidenciaCorrida,
    tieneTituloAlInicioSinVeto,
    tituloUnaPalabraConUrl,
    tituloAnioConUrl,
    tituloAnioFinalConUrl,
    esTituloAnioPartido,
    indiceUrlEnvuelta,
    esPaisEnVersales,
    tieneEvidenciaRefNumeradaSinVeto,
    soloTituloYUrlSinVeto,
    urlIntroducidaPorMarcador,
    claveCasiIdentica,
    lineasCasiIdenticas,
    esInicioRefValido,
    rachaCasiIdentica,
    esEncabezadoSeccion,
    soloTituloYUrl,
    indiceSegundaCorrida,
    haySegundaCorridaTras,
    segundaCorrida,
    esPreambuloFalso,
    hayCorridaNumeradaTras,
    rachaEsPreambulo,
    anioTrasPrimerPunto,
    separarLineasNumeradas,
    separarRefsPegadas,
    buscarEncabezado,
  };
}
