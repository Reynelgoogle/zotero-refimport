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
