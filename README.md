# Importar Referencias Vancouver — complemento para Zotero

Complemento para **Zotero 7, 8, 9 y 10** que importa referencias en estilo
Vancouver desde un documento Word (`.docx`) o un PDF.

Todo el procesamiento es **local y determinista**: no usa IA, no envía nada
a internet y no necesita conexión.

## Qué hace

1. Lee la lista de referencias de un `.docx` o de un PDF.
2. Parsea cada referencia (autores, título, revista/libro, año, volumen,
   páginas, DOI) con reglas de Vancouver.
3. Muestra una pantalla de revisión para incluir o descartar filas antes
   de importar.
4. Crea los ítems en una **colección nueva** de la biblioteca de Zotero,
   llamada `Referencias de <documento> (AAAA-MM-DD HH:MM)`, y deja esa
   colección seleccionada para que se vean los ítems al cerrar la
   pantalla de revisión.
5. Exporta la lista a RIS.
6. Si el origen es un `.docx`, genera una copia del documento con las
   citas enlazadas a Zotero y la bibliografía como campo
   `ADDIN ZOTERO_BIBL` (el mismo formato que usa el plugin oficial de
   Word).

## Alcance del parser

- Reconoce listas numeradas y, en PDF con encabezado de referencias,
  también listas sin numerar; recompone referencias que continúan en otra
  línea y detecta varias entradas pegadas en una línea.
- En Word respeta texto distribuido entre runs y separadores de tabulación
  o salto de línea. También acepta la primera referencia en la misma línea
  que el encabezado.
- Parsea artículos Vancouver, libros con edición explícita y capítulos
  introducidos por «En:» o «In:». Admite autores con iniciales o nombres
  completos separados por comas, autores institucionales, revistas
  abreviadas con puntos, rangos de páginas y DOI en URL de `doi.org`.
- Acepta el número de suplemento sin paréntesis (`2020;15 Suppl 2:45-50`),
  volúmenes con letra (`15A`), páginas con prefijo (`S10-5`, `e1234`) y
  ediciones en español (`3.ª ed.`).
- Acepta autores separados por «y», «and» o «&», y «y col.» como
  equivalente de «et al.».
- No se deja engañar por una línea suelta con el DOI (`10.1007/...`) ni
  por una continuación de página partida (`194-` / `204.`): ninguna de las
  dos se lee como referencia nueva ni corta la lista.
- Acepta saltos en la numeración (1→3) y listas cuya primera referencia
  no tiene cola Vancouver (libro o web) si las siguientes sí la tienen.
- Acepta bibliografías de solo webs sin año (la URL vale como evidencia
  de cita) y no borra en silencio un posible subtítulo numerado: se
  conserva como referencia con el aviso «posible subtítulo, revisar»
  para decidir en la revisión.
- La interpretación sigue siendo local y basada en reglas: los casos
  ambiguos se muestran en la revisión para que se puedan corregir antes de
  crear ítems. No se consulta Crossref ni se completan metadatos por
  internet.

## Requisitos

- Zotero 7.0 o superior.
- Word solo para el enlazado de citas en documentos `.docx` (opcional).

## Instalación

El repositorio contiene el código fuente del complemento. Para instalarlo
hay que empaquetarlo como `.xpi`:

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

El script crea `dist/refimport-<versión>.xpi` con las entradas del ZIP en
barra normal. No uses `Compress-Archive`: en Windows mete las rutas con
barra invertida y Zotero no encuentra `chrome://refimport/content/...`
dentro del `.xpi` (el diálogo abre "file not found"). El informe interno
`addon/INFORME.md` se excluye del paquete.

En Zotero: **Herramientas → Complementos → ⚙ → Instalar complemento desde
archivo…** y seleccionar el `.xpi`.

Tras reiniciar, el complemento aparece en **Herramientas → Importar
referencias…**.

## Uso

1. Abrir **Herramientas → Importar referencias…**.
2. Elegir un `.docx` o un PDF que contenga la lista de referencias.
3. Revisar las filas detectadas y desmarcar las que no se quieran
   importar.
4. Pulsar **Crear ítems en Zotero**.
5. Opcionalmente:
   - **Exportar RIS** para guardar la lista.
   - **Enlazar citas en el Word** (solo si el origen fue `.docx`) para
     generar una copia del documento con las citas conectadas a Zotero.
     El estado muestra las etapas del proceso y confirma la ruta al terminar.

## Estructura

```
addon/
  manifest.json            Metadatos y compatibilidad con Zotero
  bootstrap.js             Ciclo de vida del complemento y menú
  chrome.manifest          Registro del paquete chrome://refimport/
  prefs.js                 Preferencias por defecto
  refimport.js             Lectura de DOCX/PDF y apertura del diálogo
  content/
    reviewDialog.xhtml     Interfaz de revisión
    reviewDialog.js        Lógica del diálogo (crear ítems, RIS, enlazar)
    linkCitations.js       Inserción de campos de cita en el DOCX
    lib/
      vancouver.js         Parser de referencias Vancouver
      pdfExtract.js        Extracción de la lista desde texto de PDF
      ris.js               Exportación a RIS
      jszip.min.js         JSZip 3.10.1 (lectura/escritura de DOCX)
```

`tests/`, `js/` y `parser/` son material local de desarrollo y no se
publican en GitHub.

## Limitaciones

- **PDF a dos columnas**: el texto puede leerse mezclando columnas; la
  pantalla de revisión permite corregirlo.
- **PDF escaneado sin capa de texto**: no se puede extraer la lista (no
  hay OCR).
- **«et al.»**: si el documento solo lista los primeros autores, el ítem
  se crea con esos autores y se marca un aviso.
- **Variantes bibliográficas fuera de Vancouver**: pueden requerir
  corrección manual; los campos que no se reconocen no se inventan.
- **DOI ausente**: se deja vacío; no se inventa ni se busca en línea.
- **Citas partidas en varios fragmentos** del Word: esas citas no se
  enlazan y se informan como omitidas; el resto del documento sí se
  procesa.

## Historial de versiones

- **0.1.27** — Decimoquinta ronda del método Gauntlet: se corrigen los 5
  fallos del árbitro sobre la 0.1.26 (U1–U4, t2d). La variante sin espacio
  tras el guion solo vale cuando el resto parece referencia (U1: iniciales
  de autor —«1-Smith», «1-De la Cruz M.»— o cola de revista/libro
  —«1-World Health Organization. … Geneva: WHO; 2021.»—; «10-Year»,
  «5-Year», «2-Stage», «3-Dimensional» y «1-Phase» vuelven a dar 4 refs con
  flag, en PDF y DOCX); la línea de solo lugar:editorial («New York:
  Springer; 2021.») y el marcador pelado («Available from: URL») se
  conservan con flag en PDF en vez de llegar a revisión como refs normales
  (U2; en DOCX se descartan antes de la primera numerada, como antes); el
  sufijo «Epub» acepta año de 2 dígitos (U3: «Epub 20 Jan 15» sigue dando
  journal-article); U+2010 y U+2011 valen como guion de numeración (U4:
  «1‐Smith» da 3 refs) y el marcador «Disponible en» es insensible a
  mayúsculas (t2d: «disponible en:» y «DISPONIBLE EN:» valen). Límite
  documentado: un título con cola de revista («… J Urol. 2020;15:1-5.»)
  tras «N-» sin espacio cuenta como referencia por la vía de la cola.
- **0.1.26** — Decimocuarta ronda del método Gauntlet: se corrigen los 4
  fallos del árbitro sobre la 0.1.25 (T1–T4). La numeración «N-Palabra» sin
  espacio vuelve a leerse cuando la palabra siguiente empieza en mayúscula
  (T1: «1-Smith» da 3 refs; «5-year» y «194-204» siguen sin leerse como
  número); la URL envuelta con marcador en la línea siguiente ya no se traga
  la lista (T2: «2020. Ver en» / «Disponible en: https://…» da 3 limpias);
  el sufijo «Epub» solo se quita si tras él viene fecha o «ahead of print»
  (T4: «Kidney stones Epub.» conserva el título completo; las 4 variantes
  Epub con fecha siguen dando journal-article); las palabras del título
  admiten guiones largos (U+2010–U+2015/U+2212) y dos puntos (T3:
  «COVID–19», «5–year» y «2020 guidelines: kidney stones.» dan 4 refs con
  flag, en PDF y DOCX). La variante sin espacio tras el guion exige
  mayúscula inicial («1-smith» en minúscula no es número).
- **0.1.25** — Decimotercera ronda del método Gauntlet: se corrigen los 6
  fallos del árbitro sobre la 0.1.24 (S1–S6). Los títulos con dígitos,
  guiones y apóstrofos ya no se pierden en silencio (S1: «2020 COVID-19
  guidelines…», «type 2 diabetes», «Alzheimer's», «3D», «H1N1»,
  «SARS-CoV-2» y «5-year» dan 4 refs con flag, en PDF y DOCX); un año
  pelado con la URL en la línea siguiente ya no se lee como número de
  referencia (S2: «2020. Ver en» / «https://…» da 3 limpias; «2020.»
  solo + URL también); las webs partidas en el preámbulo se unen con
  la web COMPLETA y flag (S3: título con año partido en PDF y DOCX,
  y el preámbulo web de un párrafo se conserva con flag en DOCX como
  en PDF); el sufijo «Epub» final ya no degrada el artículo a webpage
  (S4); el fallback mixto literal+numPr sin encabezado vuelve a dar
  3 refs (S5: número efectivo local, sin tocar la síntesis); las
  páginas romanas ya casan en el patrón de artículo (S6: «iv-xii» →
  pages «iv», pagesEnd «xii»). Paridad PDF/DOCX en el preámbulo: las
  filas falsas se conservan con flag (m1 4, m2 5, m3 6 refs) y las 3
  filas casi idénticas se rechazan (k15/k15p 3 limpias).
- **0.1.24** — Duodécima ronda del método Gauntlet: se corrigen los 7
  fallos del árbitro sobre la 0.1.23 (R1–R7). El título con año ya no
  tiene tope de 6 palabras (R1: 7 y 9 palabras dan 4 refs con flag);
  el título que TERMINA en año con URL se conserva con flag (R2:
  «Kidney stones 2020. Available from: …» da 4 refs); la guarda de
  segunda corrida usa la variante sin veto de verbos también en la
  rama numerada del validador (R3: «Revisar» ya no traga a Smith, en
  PDF y DOCX); el apóstrofo curvo de Word (U+2019) se normaliza al
  mirar países en versales (R4: «COTE D’IVOIRE» da 3 refs); el
  fallback DOCX ya ve los números sintetizados numPr (R5: una sola
  fila falsa da 3 limpias, literal y numPr; R6: M3b numPr da 6 refs
  CON señal de reinicio, como el PDF); un año pelado con URL
  («2020. Ver en https://…») ya no se lee como número de referencia
  (R7: la lista ya no se traga en una sola ref; «2020. Resultados
  del estudio.» sigue conservándose con flag).
- **0.1.23** — Undécima ronda del método Gauntlet: se corrigen los 5
  fallos del árbitro sobre la 0.1.22 (Q1–Q5). La guarda P4 ya no
  salta la corrida: la CONSERVA con flag (Q2: C3 y N3-con-preámbulo
  dan 7 refs en PDF, 6 en DOCX); los títulos que empiezan por año
  con URL se conservan como ref con flag (Q1: H9 da 4 refs);
  `PAISES_VERSALES` suma 7 entradas (Q3: NORTHERN IRELAND, IRLANDA
  DEL NORTE, FALKLAND ISLANDS, ISLAS MALVINAS, BOSNIA-HERZEGOVINA,
  COTE D'IVOIRE y CÔTE D'IVOIRE); «The Ph.D.» ya no se lee como
  autor (Q4); `segundaCorrida` ve la numeración automática numPr
  (Q5). Residual documentado: d-m3b-numpr da 6 refs, no 3 (la guarda
  ya ve numPr, pero el fallback devuelve la corrida falsa por
  indistinguible de N3-con-encabezado; paridad con el PDF).
- **0.1.22** — Décima ronda del método Gauntlet (orden de Rey: seguir
  hasta que quede impecable): se corrigen los 7 fallos del árbitro
  sobre la 0.1.21 (P1–P7). La evidencia del resto inline es la
  variante SIN veto de verbos (P1: «Ver»/«Descargar»/«Consultar»
  inline dan 3 refs limpias en PDF y DOCX; M3b, J4'' y N12 intactos).
  El veto de país corre ANTES del atajo de ≥2 límites (P2: C1 da 3
  refs; L2, N18, C6 y J5' intactos; N8 en minúscula sigue siendo
  limitación documentada). `PAISES_VERSALES` suma los diez países
  confirmados (P3: VATICAN CITY, los dos CONGO, WESTERN SAHARA,
  CZECHIA, MACEDONIA, TIMOR-LESTE, SWAZILAND, BURMA + revisión ISO)
  y la serie multi-palabra ya no se parte por el guion. La guarda de
  segunda corrida vive también en la segmentación y en el fallback
  (P4: C3 da 4 refs en PDF con flag y 3 en DOCX; N3 sigue dando 6).
  El veto de país vale también sin estructura de cita (P5: C7 da 3
  refs en PDF; C6 y M9 intactos). El preámbulo acepta títulos de una
  palabra con URL (P6: C15 da 4 refs con flag; M15 y K3 intactos).
  Un título que termina en abreviatura con puntos ya no se lee como
  autor (P7: «Guidelines of the U.S.» completo, sin autores
  inventados; N13a/b y «Doe A. E.» intactos; «St. Louis» sigue en
  «St», preexistente). Corpus ampliado a 58 referencias + 16 listas
  (1.229 comprobaciones, 0 fallos). Sin regresiones: caso 16/16
  (191/192 campos por el Wojtas documentado), Onishi 20/20, estrés
  12/12 y extremo a extremo 21 campos / 36 instancias / 16 citadas /
  16 de bibliografía / 0 omitidas. Detalles en `DECISIONES.md` e
  `INFORME-GAUNTLET.md`.
- **0.1.21** — Novena ronda del método Gauntlet (orden de Rey: seguir
  hasta que quede impecable): se corrigen los 6 fallos del árbitro
  sobre la 0.1.20 (N1/N2, N4/N5/N6+M9, N12, N13/M14, N3). El preámbulo
  falso antes de la lista numerada ya NO se salta en silencio: se
  CONSERVA como ref con flag «posible fila de instrucciones, revisar»
  (`meta.posiblePreambulo`), porque una web real y una fila falsa
  tienen la misma forma (N1/N2 dan 4 refs; M1/M2/M3 dan 4/5/6 con
  flag; K3' y M19, 4 con flag). `PAISES_VERSALES` es ahora la lista
  exhaustiva ES/EN (N4/N5/N6 dan 3 refs; M9, sin numerar, también 3;
  N18 «Washington: DC» y L2 intactos) y el lugar solo vale con
  `tieneLugarConTitulo` cuando la línea tiene estructura de cita —
  un libro sin autor («Tratado de nefrología. New York: Springer»)
  sigue abriendo por título (N1/N12 de la ronda 6 intactos, 4 refs).
  La evidencia del resto inline se comprueba sin el prefijo numérico
  (N12 da 3 refs limpias en PDF y DOCX; M3b y J4'' intactos). El
  título ya no se corta en «U.S.»/«U.K.»/«E.U.» (N13/M14: título
  completo). El reinicio de numeración corta también tras una web
  completa (N3 da 6 refs). Corpus ampliado a 54 referencias + 15
  listas (1.123 comprobaciones, 0 fallos). Sin regresiones: caso
  16/16 (191/192 campos por el Wojtas documentado), Onishi 20/20,
  estrés 12/12 y extremo a extremo 21 campos / 36 instancias / 16
  citadas / 16 de bibliografía / 0 omitidas. Detalles en
  `DECISIONES.md` e `INFORME-GAUNTLET.md`.
- **0.1.20** — Octava ronda del método Gauntlet (orden de Rey: seguir
  hasta que quede impecable; sin tope de rondas): se corrigen los 8
  fallos nuevos del árbitro sobre la 0.1.19 (M1–M6, M8, M10, M11). La
  regla de casi-idénticas ya no veta listas reales: una corrida de 3
  webs al mismo título con URLs distintas se recuerda y se acepta con
  flag «posibles duplicados, revisar» si no hay otra lista detrás
  (M4/M5/M5b dan 3/4/3 refs; M17, 3 idénticas + 2 normales, da 5). El
  preámbulo falso antes de la lista real se salta por contexto, no por
  conteo (M1/M2/M3 dan 3 refs; en L1, sin corrida numerada después, la
  web real sigue abriéndose). La rama numerada no valida por título
  solo cuando hay una segunda corrida después (M3b da 3 refs reales).
  `urlIntroducidaPorMarcador` toma el fin del título como el ÚLTIMO
  «. » antes del marcador (M6 da 3 refs; K3' sigue bloqueado). Países
  en versales ya no valen como acrónimo de editorial (M8 da 3 refs en
  PDF y DOCX; N4 y J5' intactos). La guarda K3' vive también en el
  corte de mitad de lista y en `buscarCortePegado` (M10 da 2 refs) y
  en la fusión DOCX. La URL cuenta como marca de libro en L4 solo si
  el año viene tras el primer «. » (M11 da 3 refs; M15 intacto). M14
  («U.S. guidelines») ya no se pierde: 3 refs, con el título truncado
  en «U.S» (documentado en DECISIONES.md §R8.8). Corpus ampliado a 51
  referencias + 14 listas (1.042 comprobaciones, 0 fallos). Sin
  regresiones: caso 16/16 (191/192 campos por el Wojtas documentado),
  Onishi 20/20, estrés 12/12 y extremo a extremo 21 campos / 36
  instancias / 16 citadas / 16 de bibliografía / 0 omitidas. Detalles
  en `DECISIONES.md` e `INFORME-GAUNTLET.md`.
- **0.1.19** — Séptima ronda del método Gauntlet (orden de Rey: seguir
  hasta que quede impecable; sin tope de rondas): se corrigen los 6
  fallos nuevos del árbitro sobre la 0.1.18 (L1–L4, K3', K15'). Pérdida
  silenciosa L1 cerrada: la apertura ya no consulta `VERBOS_ENLACE`
  (`tieneTituloAlInicioSinVeto`) — una web sin numerar cuyo título es
  un imperativo («See the guidelines. Available from: …») vuelve a dar
  3 refs; el validador sigue guardando la puerta. Secuestros K3'/K15'
  cerrados por estructura, no por lista de palabras: regla de líneas
  casi idénticas (3 líneas con el mismo texto antes de la URL no
  validan como lista — en validador, fallback y segmentación, con
  espejos en DOCX) y guarda de URL (`urlIntroducidaPorMarcador`: entre
  el título y la URL solo puede haber el marcador «Available
  from:»/«Disponible en:» o nada — «Datos clínicos. Consultar en
  https://…» ya no es evidencia ni apertura). L2 cerrado:
  `tieneLugarConTitulo` vale si el editorial tras «: » es un acrónimo
  («Geneva: WHO»); L3 cerrado: la evidencia web numerada vuelve a
  aceptar título al inicio («Kidney stones. Available from: …» da 3
  refs con y sin encabezado, en PDF y DOCX — la limitación §R6.5 era
  peor de lo documentado y queda corregida); L4 cerrado: la 1ª forma de
  `esFilaClinica` no se dispara con marca de libro tras el primer
  segmento y la apertura conserva una línea descartada con año + marca
  de libro como ref con flag (la ref «Paciente…» ya no se pierde en
  silencio — la documentación §R6.6 era falsa y queda corregida).
  Corpus ampliado a 51 referencias + 13 listas (972 comprobaciones, 0
  fallos). Sin regresiones: caso 16/16 (191/192 campos por el Wojtas
  documentado), Onishi 20/20, estrés 12/12 y extremo a extremo 21
  campos / 36 instancias / 16 citadas / 16 de bibliografía / 0
  omitidas. Detalles en `DECISIONES.md` e `INFORME-GAUNTLET.md`.
- **0.1.18** — Sexta ronda del método Gauntlet (orden de Rey: seguir
  hasta que quede impecable; sin tope de rondas): se corrigen los 8
  fallos nuevos del árbitro sobre la 0.1.17 (K1–K4, J4'/J5', K3, K15,
  K14). Regresión K4 cerrada: el marcador de capítulo («En: Jones R,
  editor.») ya no se lee como lugar:editorial (`LUGAR_EDITORIAL_RE`
  excluye «En:»/«In:») y un capítulo partido en dos líneas ya no se
  corta (tampoco con título largo, y en DOCX se fusionan los dos
  párrafos); pérdida silenciosa K1/K2 cerrada: al abrir la primera
  ref de una lista sin numerar se usa `lineaPareceRef` (híbrido del
  árbitro: abrir con la forma literal, cortar con `esInicioRef`) y la
  mitad anterior se le pega delante si tiene pinta de
  institución/título — la web partida sobrevive COMPLETA en PDF
  (en DOCX sobrevive partida en dos, paridad documentada); secuestros
  del validador J4'/J5'/K3/K15 cerrados: en la rama numerada la
  evidencia URL/lugar exige `tieneEstructuraCita` (no título pelado)
  y el lugar exige título entre el autor y el lugar («Hospital
  Ameijeiras. La Habana: Cuba.» ya no valida), y `tieneTituloAlInicio`
  exige título de ≥2 palabras y rechaza verbos imperativos de enlace
  («Ver protocolo.», «Resultados.»); veto clínico K14 estrechado: la
  1ª forma de `esFilaClinica` solo mira el segmento antes del primer
  límite de frase («Gómez R. Paciente de 45 años…» ya no se veta) y
  un libro sin numerar se corta también al terminar en año. Corpus
  ampliado a 51 referencias + 12 listas (908 comprobaciones, 0
  fallos). Sin regresiones: caso 16/16 (191/192 campos por el Wojtas
  documentado), Onishi 20/20, estrés 12/12 y extremo a extremo 21
  campos / 36 instancias / 16 citadas / 16 de bibliografía / 0
  omitidas. Detalles en `DECISIONES.md` e `INFORME-GAUNTLET.md`.
- **0.1.17** — Quinta ronda del método Gauntlet (orden de Rey: seguir
  hasta que quede impecable; sin tope de rondas): se corrigen los 6
  fallos nuevos del árbitro sobre la 0.1.16 (J1–J6) + 3 leves (N7,
  N10, N17b). Una ref institucional web sin numerar («National Kidney
  Foundation. Kidney stones. Available from: ...») ya no se pierde en
  PDF: la rama sin numerar parte con `esInicioRef` (autor, o
  estructura/título + URL o lugar:editorial) y la puerta sin numerar
  del validador es en dos niveles (J1/J2, paridad PDF↔DOCX); la guarda
  clínica es `esFilaClinica` («paciente» + edad, o «ingreso/alta/
  egreso AAAA» al final de la línea — «Alta 2020» ya no secuestra la
  lista y «Mortalidad tras ingreso 2020 por litiasis renal» ya no se
  veta, J3/N17b); URL y lugar:editorial exigen estructura de cita
  («Ver protocolo en https://...» y «La Habana: Hospital...» ya no
  secuestran la lista, J4/J5); el enlazado traduce número de
  documento a posicional y omite con motivo claro las citas a números
  duplicados («1. Artículos» + «1. Smith»: la (2) enlaza a Doe, J6);
  prefijo «Nº» aceptado en PDF, DOCX y enlazado (N7); flag cuando hay
  varios DOI explícitos distintos (N10). Corpus ampliado a 51
  referencias + 11 listas (864 comprobaciones, 0 fallos). Sin
  regresiones: caso 16/16 (191/192 campos por el Wojtas documentado),
  Onishi 20/20, estrés 12/12 y extremo a extremo 21 campos / 36
  instancias / 16 citadas / 16 de bibliografía / 0 omitidas. Detalles
  en `DECISIONES.md` e `INFORME-GAUNTLET.md`.
- **0.1.16** — Cuarta ronda del método Gauntlet (orden de Rey: seguir
  hasta que quede impecable; el tope de 3 rondas queda anulado): se
  corrigen los 5 pendientes del árbitro sobre la 0.1.15 (H1–H5). El
  validador de encabezado ya no exige solo año o cola: una URL /
  «Available from:» / «Disponible en:» o un lugar:editorial
  («Geneva: WHO») también valen como evidencia de cita, así que una
  bibliografía de solo webs sin año vuelve a extraerse (H1, regresión
  de la ronda 3); un año suelto ya no basta — una fila de tabla
  clínica («Paciente A, 45 años, ingreso 2020») no valida el
  encabezado falso (H2); la rama sin numerar del validador aplica la
  misma regla año/cola/URL mirando la línea o las 2 siguientes sin
  numerar (H3); y el descarte de «abridor basura» YA NO BORRA EN
  SILENCIO: un subtítulo numerado («1. Artículos», de 8 o 9 palabras)
  o una ref institucional corta sin año ni cola se conserva como
  referencia con el flag «posible subtítulo, revisar» para que la
  revisión la muestre y el usuario decida (H4+H5, regresión de la
  ronda 3). Los arreglos se espejan en PDF (`pdfExtract.js`), DOCX
  (`refimport.js`) y enlazado (`linkCitations.js`). Corpus ampliado a
  50 referencias + 10 listas (819 comprobaciones, 0 fallos). Sin
  regresiones: caso 16/16 (191/192 campos por el Wojtas documentado),
  Onishi 20/20, estrés 12/12 y extremo a extremo 21 campos / 36
  instancias / 16 citadas / 16 de bibliografía / 0 omitidas. Detalles
  en `DECISIONES.md` e `INFORME-GAUNTLET.md`.
- **0.1.15** — Tercera y última ronda del método Gauntlet: se corrigen
  los fallos del árbitro sobre la 0.1.14 (G1–G3, L1–L2). El validador de
  encabezado ya no acepta una primera línea numerada con solo "pinta
  de autor" (una fila de tabla como «Paciente B, 52 años» validaba el
  encabezado falso; ahora exige año o cola en la línea o en las 2
  siguientes) y el 2º bucle inline acepta el resto solo si valida con
  la misma regla; un subtítulo numerado («1. Artículos») ya no se pega
  a la ref siguiente ni sale como ítem basura; el enlazado divide el
  párrafo del encabezado inline («Referencias: 1. Smith...») para que
  la ref 1 no se duplique tras un Refresh; numeración romana
  (`i./ii./iii.`) aceptada en PDF, DOCX y enlazado (lista vacía sin
  error explícito si no se reconoce nada); el DOI etiquetado «doi:»
  gana sobre el de una URL, con flag si difieren. Corpus ampliado a 50
  referencias + 9 listas (786 comprobaciones, 0 fallos). Sin
  regresiones: caso 16/16 (191/192 campos por el Wojtas documentado),
  Onishi 20/20, estrés 12/12 y extremo a extremo 21 campos / 36
  instancias / 16 citadas / 16 de bibliografía / 0 omitidas. Detalles
  en `DECISIONES.md` e `INFORME-GAUNTLET.md`.
- **0.1.14** — Segunda ronda del método Gauntlet: se corrigen los 9
  fallos del árbitro sobre la 0.1.13 (F1–F9). Encabezado validado igual
  para el exacto que para el parecido (un «Referencias» como título de
  tabla ya no secuestra la extracción; sin lista detrás, error explícito
  en vez de 0 refs en silencio); páginas con coma de miles (`1,234`);
  año entre corchetes (`[2020]`, `[2020 Jan]`) y limpieza de
  `[Epub YYYY]`; se quitan TODOS los DOI, no solo el primero; el flag
  «sin cola» ya no se borra cuando el fallback web no recupera una
  revista; numeración con letra (`1a.`); reinicio de numeración por
  sección (`1,2,1,2`) con flag; dos refs pegadas en una línea se dividen.
  Los mismos arreglos se espejan en el camino DOCX (`refimport.js`) y en
  el enlazado (`linkCitations.js`, que ahora carga `pdfExtract.js` en el
  diálogo). Corpus ampliado a 48 referencias + 8 listas (737
  comprobaciones, 0 fallos). Sin regresiones: caso 16/16 (191/192 campos
  por el Wojtas documentado), Onishi 20/20, estrés 12/12 y extremo a
  extremo 21 campos / 36 instancias / 16 citadas / 16 de bibliografía /
  0 omitidas. Detalles en `DECISIONES.md` e `INFORME-GAUNTLET.md`.
- **0.1.13** — Optimización de la extracción (método Gauntlet): se corrigen
  los fallos conocidos de la 0.1.12 y se amplía el corpus de pruebas
  (`corpus/`: 40 referencias trampa + 7 listas de líneas). Sin regresiones:
  caso 16/16, Onishi 20/20, estrés 12/12 y extremo a extremo 21 campos /
  36 instancias / 16 citadas / 16 de bibliografía / 0 omitidas. Detalles
  en `DECISIONES.md` e `INFORME-GAUNTLET.md`.
- **0.1.12** — Enlazado robusto de citas Word.
- **0.1.11** — Mejoras en el algoritmo de detección de referencias.

## Desarrollo

El complemento no tiene proceso de build: es JavaScript plano que Zotero
carga directamente.

Para probar cambios sin empaquetar:

1. Cerrar Zotero.
2. En la carpeta `extensions` del perfil de Zotero, crear un archivo de
   texto llamado `refimport@reynel.cu` que contenga la ruta absoluta a
   la carpeta `addon/` de este repositorio.
3. Borrar `extensions.lastAppBuildId` y `extensions.lastAppVersion` de
   `prefs.js` del perfil.
4. Abrir Zotero.
