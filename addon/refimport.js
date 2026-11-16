/* refimport.js — lógica principal del plugin "Importar Referencias Vancouver".
 *
 * Flujo:
 *   1. El usuario elige un .docx o .pdf con el FilePicker (menú Herramientas).
 *   2. DOCX: JSZip -> word/document.xml -> párrafos de texto; se localiza
 *      el encabezado Referencias/References y se toman los párrafos
 *      numerados siguientes.
 *      PDF: se importa como adjunto temporal, se extrae el texto con
 *      Zotero.PDFWorker.getFullText (el pdf.js que ya trae Zotero),
 *      se borra el temporal y las líneas van a pdfExtract.js.
 *   3. Cada referencia se parsea con vancouver.js (reglas deterministas).
 *   4. Se abre la pantalla de revisión (content/reviewDialog.xhtml, modal);
 *      crear los ítems, exportar RIS y enlazar las citas ocurre allí.
 *
 * Se carga con Services.scriptloader.loadSubScript desde bootstrap.js;
 * por eso las librerías (JSZip, parseReferencia, extraerReferencias,
 * aRis) son globales aquí, igual que Zotero, Services, ChromeUtils e
 * IOUtils.
 */

var RefImport = {
	id: "refimport@reynel.cu",
	version: "0.1.27",
	rootURI: null,
	_menuItems: new Map(),

	W_NS: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
	HEADINGS: ["references", "referencias", "referencia bibliografica",
		"referencias bibliograficas", "bibliography", "bibliografia",
		"bibliografica", "bibliograficas",
		"literature cited", "cited literature", "works cited",
		"cited references", "referencias citadas", "literatura citada",
		"list of references", "lista de referencias"],
	NUM_RE: /^(?:N[º°]\.?\s*|N\.\s+|No\.?\s+)?(?:\[(\d+)[a-zA-Z]?\]|\((\d+)[a-zA-Z]?\)|(\d+)[a-zA-Z]?[.)]|(\d+)[a-zA-Z]?\s*[-–—\u2010\u2011](?:\s+|(?=(?:[A-ZÁÉÍÓÚÜÑ][A-Za-zÁÉÍÓÚÜÑ'’\-]*(?: (?:[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ'’\-]+|[A-ZÁÉÍÓÚÜÑ]{2,}|de|la|van|der|den|ten|di|dos|das|do|el|al|bin|ibn)){0,3},? (?:[A-ZÁÉÍÓÚÜÑ]\.(?: ?[A-ZÁÉÍÓÚÜÑ]\.)*|[A-ZÁÉÍÓÚÜÑ]{2,3}\.|[A-ZÁÉÍÓÚÜÑ] (?:Jr|Sr)\.)|[A-ZÁÉÍÓÚÜÑ].*;\s*(?:\d+\s*:|(?:19|20)\d{2}\b)))))\s*(.*)$/,
	// Cola Vancouver ligera (solo para el fallback sin encabezado):
	// año;volumen:páginas, p. ej. "2020, 31:662-6" o "2014;81(3):144-7".
	TAIL_LIGERO_RE: /\b(?:19|20)\d{2}[;,]\s*\d+\s*(?:\([^)]*\))?\s*:\s*[A-Za-z]?\d+/,

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		Zotero.debug("RefImport: iniciado v" + version);
	},

	addToAllWindows() {
		let windows = Services.wm.getEnumerator("navigator:browser");
		while (windows.hasMoreElements()) {
			this.addToWindow(windows.getNext());
		}
	},

	removeFromAllWindows() {
		for (let window of Array.from(this._menuItems.keys())) {
			this.removeFromWindow(window);
		}
	},

	addToWindow(window) {
		if (this._menuItems.has(window)) return;
		let doc = window.document;
		let popup = doc.getElementById("menu_ToolsPopup");
		if (!popup) return;
		if (doc.getElementById("refimport-menuitem")) return;
		// En Zotero 7 no hay API de menús: inyección DOM (createXULElement).
		let item = doc.createXULElement("menuitem");
		item.setAttribute("id", "refimport-menuitem");
		item.setAttribute("label", "Importar referencias…");
		item.addEventListener("command", () => {
			this.importReferences(window);
		});
		popup.appendChild(item);
		this._menuItems.set(window, item);
	},

	removeFromWindow(window) {
		let item = this._menuItems.get(window);
		if (item && item.parentNode) {
			item.parentNode.removeChild(item);
		}
		this._menuItems.delete(window);
	},

	async importReferences(window) {
		try {
			var { FilePicker } = ChromeUtils.importESModule(
				"chrome://zotero/content/modules/filePicker.mjs"
			);
			let fp = new FilePicker();
			fp.init(window, "Elegir documento con referencias", fp.modeOpen);
			fp.appendFilter("Documentos Word y PDF", "*.docx; *.pdf");
			fp.appendFilter("Documentos Word (*.docx)", "*.docx");
			fp.appendFilter("Documentos PDF (*.pdf)", "*.pdf");
			fp.appendFilter("Todos los archivos", "*.*");
			let rv = await fp.show();
			if (rv !== fp.returnOK) return;
			// fp.file es la ruta (cadena) en Zotero 7; por si acaso,
			// aceptar también un nsIFile con .path.
			let path = typeof fp.file === "string" ? fp.file : fp.file.path;
			if (!path) return;

			let isDocx = /\.docx$/i.test(path);
			let isPdf = /\.pdf$/i.test(path);
			if (!isDocx && !isPdf) {
				Zotero.alert(window, "Importar Referencias",
					"El archivo debe ser .docx o .pdf");
				return;
			}
			let { refTexts, meta } = isDocx
				? await this._readDocx(path)
				: await this._readPdf(path);
			let refs = this._parseRefs(refTexts, meta);
			if (!refs.length) {
				Zotero.alert(window, "Importar Referencias",
					"No se encontraron referencias en el documento.");
				return;
			}
			let args = {
				refs,
				sourcePath: path,
				isDocx,
				showFlags: Zotero.Prefs.get("extensions.refimport.showFlags", true),
				createdMap: null,
				// El diálogo no tiene global Zotero propio: se le pasa
				// por los argumentos (patrón zotQDA), junto con rootURI
				// para que cargue sus librerías con loadSubScript.
				rootURI: this.rootURI,
				Zotero,
			};
			// Diálogo no modal (patrón zotQDA, "dialog=no"): si algo
			// falla al cargar, no bloquea la ventana principal.
			// v0.1.5: se abre por chrome:// (registrado en bootstrap.js)
			// porque una URL jar: como documento de ventana nueva deja
			// la ventana en blanco en Firefox 140.
			window.openDialog(
				"chrome://refimport/content/reviewDialog.xhtml",
				"refimport-review",
				"chrome,centerscreen,resizable,dialog=no",
				args
			);
		}
		catch (e) {
			Zotero.logError(e);
			Zotero.alert(window, "Importar Referencias",
				"Error: " + (e && e.message ? e.message : e));
		}
	},

	_parseRefs(refTexts, meta) {
		return refTexts.map((t, i) => {
			let r = parseReferencia(t);
			r.numero = i + 1;
			r.included = true;
			r.raw = t;
			// Reinicio de numeración por sección (meta.reinicioEn lo
			// llenan extraerReferencias en PDF y _detectarReinicios en
			// DOCX): se avisa con flag, no se inventa nada.
			if (meta && meta.reinicioEn && meta.reinicioEn.includes(i)) {
				r.flags.push("reinicio de numeración (posible nueva sección)");
			}
			// Posible subtítulo conservado en vez de borrado en silencio
			// (meta.posibleSubtitulo lo llenan extraerReferencias en PDF
			// y _readDocx en DOCX, H5): se avisa con flag para que la
			// revisión lo muestre y el usuario decida.
			if (meta && meta.posibleSubtitulo && meta.posibleSubtitulo.includes(i)) {
				r.flags.push("posible subtítulo, revisar");
			}
			// Posible fila de instrucciones conservada en vez de
			// borrada en silencio (meta.posiblePreambulo lo llena
			// extraerReferencias en PDF, N1/N2): una web real y una
			// fila falsa tienen la misma forma; se avisa con flag
			// para que la revisión lo muestre y el usuario decida.
			if (meta && meta.posiblePreambulo && meta.posiblePreambulo.includes(i)) {
				r.flags.push("posible fila de instrucciones, revisar");
			}
			// Posibles duplicados (meta.posiblesDuplicados, M4/M5/M17):
			// la lista validó por una corrida de líneas casi idénticas
			// (mismo título, URLs distintas). Se avisa con flag para
			// que la revisión lo muestre y el usuario decida.
			if (meta && meta.posiblesDuplicados) {
				r.flags.push("posibles duplicados, revisar");
			}
			return r;
		});
	},

	_paraText(p) {
		let parts = [];
		let walk = (node) => {
			for (let child of Array.from(node.childNodes || [])) {
				if (child.nodeType !== 1) continue;
				if (child.namespaceURI === this.W_NS) {
					if (child.localName === "t") {
						parts.push(child.textContent);
						continue;
					}
					if (child.localName === "tab" ||
						child.localName === "br" || child.localName === "cr") {
						parts.push(" ");
						continue;
					}
				}
				walk(child);
			}
		};
		walk(p);
		return parts.join("");
	},

	_isHeading(p) {
		let styles = p.getElementsByTagNameNS(this.W_NS, "pStyle");
		if (!styles.length) return false;
		let v = styles[0].getAttributeNS(this.W_NS, "val") || "";
		return /^Heading/i.test(v) || /^Titulo/i.test(v);
	},

	_normalizeHeading(text) {
		// Minúsculas, sin tildes, sin numeración inicial ("5. "), sin
		// puntuación final (".", ":") y sin número de página final
		// ("References 12"). Sin tildes: "BIBLIOGRAFIA" iguala a
		// "bibliografia" del conjunto.
		return text.trim().toLowerCase()
			.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
			.replace(/^\d+\s*[.)\]]\s*/, "")
			.replace(/\s+\d+\s*$/, "")
			.replace(/[\s.:;\-]+$/, "")
			.replace(/\s+/g, " ")
			.trim();
	},

	_isRefHeadingExacto(text) {
		return this.HEADINGS.includes(this._normalizeHeading(text));
	},

	_isRefHeadingParecido(text) {
		// Línea CORTA, sin cola de referencia, que contiene
		// "referenc" o "bibliograf". Excluye "de referencia(s)":
		// es el valor de referencia de un dato ("Calibre de
		// referencia"), no la sección de referencias.
		let s = this._normalizeHeading(text);
		if (!s || s.split(" ").length > 8) return false;
		if (this.TAIL_LIGERO_RE.test(s)) return false;
		if (/\bde referencias?\b/.test(s)) return false;
		return /referenc|bibliograf|fuentes consultadas|literature cited|works cited|cited literature|literatura citada/.test(s);
	},

	_isRefHeading(text) {
		return this._isRefHeadingExacto(text) || this._isRefHeadingParecido(text);
	},

	// Búsqueda en dos pasadas: exacto primero, parecido solo si no
	// hay exacto (una etiqueta corta del cuerpo no debe robar el
	// encabezado real que viene después).
	// Búsqueda en dos pasadas: exacto primero, parecido solo si no
	// hay exacto (una etiqueta corta del cuerpo no debe robar el
	// encabezado real que viene después). Cada candidato se VALIDA
	// con _encabezadoConListaValida: un «Referencias» como título de
	// tabla/sección con filas numeradas detrás ya no secuestra la
	// extracción (F1).
	_buscarEncabezado(paras, meta) {
		for (let i = 0; i < paras.length; i++) {
			let text = this._paraText(paras[i]);
			if ((this._isRefHeadingExacto(text) ||
				this._textoTrasEncabezado(text)) &&
				this._encabezadoConListaValida(paras, i, meta)) return i;
		}
		for (let i = 0; i < paras.length; i++) {
			if (this._isRefHeadingParecido(this._paraText(paras[i])) &&
				this._encabezadoConListaValida(paras, i, meta)) return i;
		}
		return -1;
	},

	// ¿Empieza una lista tras este encabezado? Espejo de
	// encabezadoConListaValida (pdfExtract.js): se aplica IGUAL al
	// exacto que al parecido. Solo vale con EVIDENCIA de cita (cola,
	// URL, lugar:editorial o año con estructura): un año suelto de
	// fila clínica («ingreso 2020», H2) no basta, y una línea con
	// pinta de autor pero sin evidencia («García M, López A,
	// Pérez J.») no valida la rama sin numerar (H3). Si ningún
	// candidato valida, se devuelve -1 y _readDocx prueba la corrida
	// numerada; si tampoco hay corrida, error explícito: un
	// encabezado exacto sin lista detrás ya no devuelve 0 refs en
	// silencio (F9).
	_encabezadoConListaValida(paras, i, meta) {
		// El resto de la propia línea (encabezado con la 1ª ref pegada:
		// «Referencias: 1. Smith...») también vale — pero solo con
		// evidencia NUMERADA (espejo de pdfExtract.js, J4'/J5').
		// Textos de los párrafos (para segundaCorrida /
		// haySegundaCorridaTras, globales de pdfExtract.js). Q5: con
		// numeración automática el número se sintetiza (ver
		// _textosConNumPr).
		let textos = this._textosConNumPr(paras.map((p) => ({ text: this._paraText(p).trim(), numPr: this._hasNumPr(p) })));
		let restoInline = this._textoTrasEncabezado(this._paraText(paras[i]));
		if (restoInline) {
			// Candidatas para la regla de casi-idénticas (K15'/J4'):
			// el resto + los 2 párrafos siguientes. Si los 3 son
			// casi idénticos, el resto no valida por esta vía.
			let cand = [restoInline];
			for (let k = i + 1; k < paras.length && cand.length < 3; k++) {
				let s2 = this._paraText(paras[k]).trim();
				if (!s2 || /^\d{1,4}$/.test(s2)) continue;
				cand.push(s2);
			}
			// M3b: si el resto abre una corrida de solo título+URL
			// seguida de otra corrida numerada (filas falsas + lista
			// real), el encabezado NO valida por el resto: se
			// rechaza y el fallback encuentra la lista real.
			// N12: la evidencia se comprueba sobre el texto SIN el
			// prefijo numérico («1. Buscar…»): el chequeo de título
			// está anclado al inicio y el «1. » lo hacía fallar, así
			// que la rama se saltaba entera sin consultar
			// segundaCorrida y la fila falsa inline se colaba como
			// ref 1 (con Smith tragada).
			// P1: la evidencia aquí es la variante SIN veto de
			// verbos (espejo de pdfExtract.js): con la vetada, un
			// resto «1. Ver el protocolo. …» daba false y la rama se
			// saltaba entera sin consultar segundaCorrida.
			let restoTexto = numDeLinea(restoInline) ? numDeLinea(restoInline).texto : restoInline;
			if (tieneEvidenciaRefNumeradaSinVeto(restoTexto) && !lineasCasiIdenticas(cand)) {
				let vistaInline = [restoInline].concat(textos.slice(i + 1, i + 9));
				if (segundaCorrida(vistaInline, 0, true) !== -1) return false;
				return true;
			}
		}
		for (let j = i + 1; j < paras.length && j <= i + 10; j++) {
			let s = this._paraText(paras[j]).trim();
			// Blancos y números de página sueltos se saltan.
			if (!s || /^\d{1,4}$/.test(s)) continue;
			// Otro encabezado antes que la lista: este no la encabeza.
			if (this._isRefHeadingExacto(s) || this._isRefHeadingParecido(s)) return false;
			let m = this.NUM_RE.exec(s);
			// R7 (espejo de numDeLinea en pdfExtract.js): un año PELADO
			// con URL en el resto («2020. Ver en https://…») no es el
			// número de la referencia.
			let anioPeladoConUrl = m && (m[3] || m[4]) && /^(?:19|20)\d{2}$/.test(m[3] || m[4]) && /https?:\/\/|www\./i.test(m[5]);
			let numerado = (m && !((m[1] || m[2]) && /^(?:19|20)\d{2}$/.test(m[1] || m[2])) && !anioPeladoConUrl) ||
				this._hasNumPr(paras[j]);
			if (numerado) {
				// M3b: si este párrafo abre una corrida de solo
				// título+URL seguida de otra corrida numerada (filas
				// falsas + lista real), el encabezado NO valida por
				// esta línea: se rechaza y el fallback encuentra la
				// lista real (espejo de pdfExtract.js). R3: la
				// variante SIN veto de verbos (el arreglo P1 solo
				// había llegado a la rama inline): con la vetada, una
				// fila «1. Revisar la guía. …» daba false y la rama se
				// saltaba sin consultar segundaCorrida.
				if (segundaCorrida(textos, j, true) !== -1) return false;
				// La ref puede venir partida: el año/cola puede estar en
				// los 2 párrafos siguientes. Pero solo vale con
				// EVIDENCIA NUMERADA (espejo de pdfExtract.js, J4'/J5'):
				// la "pinta de autor" sola NO basta — una fila de tabla
				// ("Paciente B, 52 años") también parece un autor y el
				// encabezado falso validaba por ella (G1).
				// Candidatas para la regla de casi-idénticas (K15'/J4'):
				// el resto inline + este párrafo + los 2 siguientes.
				// Se recogen por adelantado: la evidencia se comprueba
				// tras cada apéndice y el 3er idéntico aún no estaría
				// en el bloque.
				let candidatas = [];
				if (restoInline) candidatas.push(restoInline);
				candidatas.push(s);
				for (let k = j + 1; k < paras.length && k <= j + 2; k++) {
					let s2 = this._paraText(paras[k]).trim();
					if (s2) candidatas.push(s2);
				}
				let repetidas = lineasCasiIdenticas(candidatas);
				let bloque = m ? m[5] : s;
				if (tieneEvidenciaRefNumerada(bloque) && !repetidas) return true;
				for (let k = j + 1; k < paras.length && k <= j + 2; k++) {
					let s2 = this._paraText(paras[k]).trim();
					if (!s2) continue;
					bloque += " " + s2;
					if (tieneEvidenciaRefNumerada(bloque) && !repetidas) return true;
				}
				// M4 (espejo de pdfExtract.js): el bloque tiene
				// evidencia pero los candidatos son casi idénticos (3
				// webs reales al mismo título). NO rechazar de
				// inmediato: anotar (con flag) y seguir buscando otra
				// lista; si tras la corrida viene otra corrida
				// numerada (filas falsas + lista real), se rechaza y
				// el fallback encuentra la real; si no, el escaneo
				// valida por la cola de la corrida.
				if (tieneEvidenciaRefNumerada(bloque) && repetidas) {
					if (meta) meta.posiblesDuplicados = true;
					let finRun = j;
					let claveRun = claveCasiIdentica(m ? m[5] : s);
					while (finRun < paras.length) {
						let sR = this._paraText(paras[finRun]).trim();
						let mR = this.NUM_RE.exec(sR);
						if (!mR || claveCasiIdentica(sR) !== claveRun) break;
						finRun++;
					}
					if (haySegundaCorridaTras(textos, finRun)) return false;
					continue;
				}
				// Párrafo numerado que no parece referencia («1. Paciente
				// A»): es otro contenido (tabla, cuestionario), no la lista.
				return false;
			}
			// Párrafo sin numerar (H3): solo vale si el bloque (este
			// párrafo + los 2 siguientes SIN numerar) trae evidencia
			// de cita. Una línea con pinta de autor pero sin evidencia
			// es una lista de nombres, no el inicio de la bibliografía.
			if (pareceInicioSinNumero(s) || this.TAIL_LIGERO_RE.test(s)) {
				let bloque = s;
				let lineasBloque = [s];
				let tomadas = 0;
				for (let k = j + 1; k < paras.length && tomadas < 2; k++) {
					let s2 = this._paraText(paras[k]).trim();
					if (!s2 || /^\d{1,4}$/.test(s2)) continue;
					let m2 = this.NUM_RE.exec(s2);
					let numerado2 = (m2 && !((m2[1] || m2[2]) && /^(?:19|20)\d{2}$/.test(m2[1] || m2[2]))) ||
						this._hasNumPr(paras[k]);
					if (numerado2) break;
					bloque += " " + s2;
					lineasBloque.push(s2);
					tomadas++;
				}
				// Filas falsas casi idénticas (K15'): 3 párrafos con
				// el mismo texto antes de la URL no validan como lista...
				// salvo que no haya otra lista detrás (M4 sin numerar
				// con autor: la corrida idéntica ES la lista). Con
				// segunda corrida detrás se rechaza; sin ella se sigue
				// buscando y la cola de la corrida valida. Sin
				// evidencia, es una lista de nombres, no el inicio de
				// la bibliografía: se rechaza como antes (H3).
				if (tieneEvidenciaRef(bloque)) {
					if (!lineasCasiIdenticas(lineasBloque)) return true;
					if (meta) meta.posiblesDuplicados = true;
					if (haySegundaCorridaTras(textos, j + lineasBloque.length)) return false;
				} else {
					return false;
				}
			}
			// Párrafo con URL o lugar:editorial pero sin pinta de
			// autor (web institucional, J1): el bloque decide; si no
			// trae evidencia NO se rechaza el encabezado — el párrafo
			// puede ser la continuación partida de una ref — se sigue
			// buscando dentro de la ventana. Espejo de pdfExtract.js.
			if (tieneEvidenciaWebOLugar(s)) {
				let bloque = s;
				let lineasBloque = [s];
				let tomadas = 0;
				for (let k = j + 1; k < paras.length && tomadas < 2; k++) {
					let s2 = this._paraText(paras[k]).trim();
					if (!s2 || /^\d{1,4}$/.test(s2)) continue;
					let m2 = this.NUM_RE.exec(s2);
					let numerado2 = (m2 && !((m2[1] || m2[2]) && /^(?:19|20)\d{2}$/.test(m2[1] || m2[2]))) ||
						this._hasNumPr(paras[k]);
					if (numerado2) break;
					bloque += " " + s2;
					lineasBloque.push(s2);
					tomadas++;
				}
				// Filas falsas casi idénticas (K15'/K3'): 3 párrafos
				// con el mismo texto antes de la URL no validan — se
				// sigue buscando. Si el bloque trae evidencia y es
				// idéntico, se anota con flag (M4: puede ser la lista
				// real).
				if (tieneEvidenciaRef(bloque)) {
					if (!lineasCasiIdenticas(lineasBloque)) return true;
					if (meta) meta.posiblesDuplicados = true;
				}
			}
			// La prosa o un subtítulo no invalidan: se sigue buscando
			// dentro de la ventana.
		}
		return false;
	},

	_textoTrasEncabezado(text) {
		let colon = text.indexOf(":");
		if (colon !== -1 && this._isRefHeadingExacto(text.slice(0, colon))) {
			return text.slice(colon + 1).trim();
		}
		let marker = /\s+(?=(?:\d+\s*[.)]|\[\s*\d+\s*\]|\(\s*\d+\s*\)|\d+\s*[-–—\u2010\u2011])\s*\S)/g;
		let match;
		while ((match = marker.exec(text))) {
			if (this._isRefHeadingExacto(text.slice(0, match.index))) {
				return text.slice(match.index + match[0].length).trim();
			}
		}
		return "";
	},

	_esNumerado(text) {
		// ¿Empieza el párrafo con número de referencia ("1.", "[1]",
		// "(1)", "1)")? "(2024)"/"[2024]" es un año, no un número.
		// Numeración romana ("i.", "ii.") también vale (L1, espejo de
		// numDeLinea en pdfExtract.js).
		let m = this.NUM_RE.exec(text.trim());
		if (m) {
			if ((m[1] || m[2]) && /^(?:19|20)\d{2}$/.test(m[1] || m[2])) return false;
			// R7 (espejo de numDeLinea en pdfExtract.js): un año PELADO
			// con URL en el resto («2020. Ver en https://…») no es el
			// número de la referencia.
			if ((m[3] || m[4]) && /^(?:19|20)\d{2}$/.test(m[3] || m[4]) && /https?:\/\/|www\./i.test(m[5])) return false;
			return true;
		}
		return !!this._numeroRomano(text);
	},

	// Numeración romana ("i.", "ii.", "iii."): se convierte a arábigo
	// (L1). Tope en 50: una "c." o "d." suelta no es el nº 100/500.
	// Prefijo «Nº» (N7).
	_numeroRomano(text) {
		let m = /^(?:N[º°]\.?\s*|N\.\s+|No\.?\s+)?([ivxlcdm]+)[.)]\s*(.*)$/i.exec(text.trim());
		if (!m) return null;
		if (!/^(m{0,3})(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i.test(m[1])) return null;
		let VAL = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
		let total = 0;
		for (let i = 0; i < m[1].length; i++) {
			let v = VAL[m[1][i].toLowerCase()];
			let next = i + 1 < m[1].length ? VAL[m[1][i + 1].toLowerCase()] : 0;
			total += v < next ? -v : v;
		}
		if (total < 1 || total > 50) return null;
		return { num: total, text: m[2] };
	},

	_findNumberedRun(paras, meta) {
		// Fallback sin encabezado: primera corrida de 3+ párrafos
		// numerados seguidos de los que AL MENOS UNA referencia tenga
		// cola Vancouver. Antes se exigía la cola en la PRIMERA: si la
		// lista empezaba por un libro o una web sin cola, el fallback
		// fallaba aunque la 2ª y 3ª sí la tuvieran (espejo de
		// buscarCorridaNumerada en pdfExtract.js). Devuelve el índice
		// del primer párrafo, o -1. Un número no secuencial («204.» de
		// «194-204») se trata como continuación de la referencia
		// anterior, no como una nueva.
		// Q5: con numeración automática el número se sintetiza (ver
		// _textosConNumPr) — aquí se calcula UNA vez y lo usan tanto
		// la colección (R6) como la guarda P4 de abajo.
		let textos = this._textosConNumPr(paras.map((p) => ({ text: this._paraText(p).trim(), numPr: this._hasNumPr(p) })));
		// S5: número efectivo de un párrafo numPr en una lista mixta
		// (literal + numPr) sin encabezado. La síntesis de
		// _textosConNumPr reinicia la secuencia en el párrafo literal
		// («1. Smith» + NP(Doe) + NP(Roe) -> Doe=1, Roe=2) y la
		// colección del fallback fallaba: 0.1.23 daba 3 refs y 0.1.24
		// ERROR. El número efectivo continúa desde el literal
		// anterior SOLO si ese literal ES una referencia real (tiene
		// evidencia: cola, URL o lugar:editorial). Un literal sin
		// evidencia («3. Resultados») es una fila falsa: continuar
		// desde él haría que la corrida falsa + la real se leyera
		// como una sola (5 refs, 0.1.24); con la síntesis, la real
		// arranca en 1 y el fallback la encuentra sola (3 refs,
		// paridad 0.1.23). Y un literal real («2. Doe A. Title two.
		// Urology. 2021;20:10-2.») SÍ continúa la secuencia: sin
		// esto, [1. Smith, 2. Doe, NP(Roe)] daba ERROR en 0.1.23 y
		// 0.1.24 (la síntesis reinicia en 1 tras un literal y Roe
		// salía 1, no 3). SOLO se usa en el numOf LOCAL del
		// fallback: no se toca _textosConNumPr ni el ensamblaje (la
		// guarda R6 de reinicio sigue usando la síntesis compartida).
		// Sin recursión: la comprobación del párrafo anterior es
		// directa (literal o numPr), nunca vuelve a llamar a numOf.
		const numEfectivoNumPr = (idx) => {
			let k = idx;
			while (k >= 0 && this._hasNumPr(paras[k])) k--;
			if (k < 0) return null;
			const tk = this._paraText(paras[k]).trim();
			const mk = this.NUM_RE.exec(tk);
			if (!mk) return null;
			const nk = parseInt(mk[1] || mk[2] || mk[3] || mk[4], 10);
			if (!tieneEvidenciaCorrida(mk[5])) return null;
			return nk + (idx - k);
		};
		const numOf = (p, idx) => {
			let t = this._paraText(p).trim();
			if (!this._esNumerado(t)) {
				if (this._hasNumPr(p)) {
					// R6 (ronda 12): el número sintetizado (Q5) también
					// vale para la colección: antes el párrafo numPr
					// devolvía num: null y la colección lo aceptaba
					// como «cualquier número» — la fila falsa absorbía
					// a Smith/Doe y el fallback devolvía la fila falsa
					// como inicio de lista (R5-numPr). Con el número
					// sintetizado la secuencia se comprueba de verdad
					// y el reintento dispara cuando no cuadra.
					// S5: primero el número efectivo (continúa desde
					// un literal que sea inicio de corrida); si es
					// null, la síntesis de siempre.
					if (idx !== undefined) {
						const nEf = numEfectivoNumPr(idx);
						if (nEf !== null) return { num: nEf, text: t };
					}
					const ms = idx !== undefined ? numDeLinea(textos[idx]) : null;
					return { num: ms ? ms.num : null, text: t };
				}
				return null;
			}
			let m = this.NUM_RE.exec(t);
			if (m) {
				let n = m[1] || m[2] || m[3] || m[4];
				return { num: parseInt(n, 10), text: m[5] };
			}
			// Numeración romana (L1).
			return this._numeroRomano(t);
		};
		// Corrida idéntica con evidencia recordada (M4/M5, espejo de
		// buscarCorridaNumerada): si no aparece ninguna otra lista,
		// esta corrida ES la lista; si aparece otra DISJUNTA, es la
		// real; si SOLAPA, es la misma lista corrida un puesto (M17)
		// y manda la recordada.
		let candidatoIdentico = null;
		for (let i = 0; i < paras.length; i++) {
			let c0 = numOf(paras[i], i);
			if (!c0) continue;
			let bloques = [c0.text];
			let esperado = c0.num !== null ? c0.num + 1 : null;
			let encontrados = 1;
			let j = i + 1, recorridas = 0;
			while (j < paras.length && recorridas < 30) {
				let c = numOf(paras[j], j);
				if (c) {
					if (c.num === null || esperado === null || c.num === esperado) {
						encontrados++;
						bloques.push(c.text);
						if (c.num !== null) esperado = c.num + 1;
						if (encontrados === 3) break;
					}
					else if (encontrados === 1) {
						// Párrafo numerado que no es el siguiente: es
						// otra referencia (o una sección numerada, p.
						// ej. «1. Introduction»). Este candidato no es
						// la lista: reintentar desde ese párrafo (el
						// bucle exterior lo probará como inicio). Sin
						// esto, su texto se pegaba a bloques[0] y su cola
						// Vancouver hacía pasar el filtro.
						if (c.num !== null && esperado !== null) {
							i = j - 1;
							break;
						}
						bloques[0] += " " + this._paraText(paras[j]).trim();
					}
				}
				else {
					let t = this._paraText(paras[j]).trim();
					if (t) bloques[bloques.length - 1] += " " + t;
				}
				j++;
				recorridas++;
			}
			if (encontrados < 3) continue;
			// P4 (fallback, espejo de buscarCorridaNumerada): si esta
			// corrida es de solo título+URL seguida de otra corrida
			// tras un encabezado de sección, Y viene precedida de un
			// párrafo de preámbulo (web sin numerar), la lista
			// empieza en el preámbulo — se devuelve su índice para
			// que el preámbulo se conserve con flag y el ensamblaje
			// conserve la corrida con flag (Q2, ronda 11: ya no se
			// salta). Sin preámbulo antes, NO se salta: una primera
			// corrida real (N3 sin encabezado: 3 webs + Discusión +
			// lista real) es indistinguible por estructura de la
			// corrida falsa, y saltarla borraría 3 refs reales en
			// silencio (H5). Ver DECISIONES.md §R10.4 y §R11.2.
			// Q5: con numeración automática el número se sintetiza
			// (ver _textosConNumPr) — `textos` ya se calculó arriba.
			let idxSegunda = segundaCorrida(textos, i, true);
			if (idxSegunda !== -1) {
				let k = i - 1;
				while (k >= 0) {
					let sAnt = textos[k];
					if (!sAnt || /^\d{1,4}$/.test(sAnt)) { k--; continue; }
					break;
				}
				if (k >= 0 && esPreambuloFalso(textos[k])) return k;
			}
			// Filas falsas casi idénticas (K15'/J4' sin encabezado):
			// 3 párrafos con el mismo texto antes de la URL no son
			// una lista... salvo que no haya otra lista detrás
			// (M4/M5): se recuerda y se sigue buscando (espejo de
			// buscarCorridaNumerada en pdfExtract.js).
			if (lineasCasiIdenticas(bloques)) {
				if (!candidatoIdentico && bloques.some((b) => tieneEvidenciaCorrida(b))) {
					candidatoIdentico = { idx: i, fin: j + 1 };
					if (meta) meta.posiblesDuplicados = true;
				}
				continue;
			}
			// H1: una web sin año vale por su URL (o por su
			// lugar:editorial si es un libro); el año solo NO vale.
			if (!bloques.some((b) => tieneEvidenciaCorrida(b))) continue;
			if (candidatoIdentico && i < candidatoIdentico.fin) return candidatoIdentico.idx;
			return i;
		}
		return candidatoIdentico ? candidatoIdentico.idx : -1;
	},

	async _readDocx(path) {
		// IOUtils.read devuelve un Uint8Array del realm del módulo del
		// sistema; JSZip comprueba `instanceof Uint8Array` contra SU
		// realm y lo rechaza ("Can't read the data of 'the loaded zip
		// file'"). La copia con new Uint8Array() lo pasa a este realm.
		let bytes = new Uint8Array(await IOUtils.read(path));
		let zip = await JSZip.loadAsync(bytes);
		let entry = zip.file("word/document.xml");
		if (!entry) {
			throw new Error("El archivo no contiene word/document.xml; ¿es un .docx válido?");
		}
		let xml = await entry.async("string");
		let doc = new DOMParser().parseFromString(xml, "application/xml");
		let paras = Array.from(doc.getElementsByTagNameNS(this.W_NS, "p"));
		// Meta del validador/fallback (posiblesDuplicados, §R8): se
		// crea aquí y se devuelve al final junto a reinicioEn y
		// posibleSubtitulo.
		let metaVal = {};
		let idxRef = this._buscarEncabezado(paras, metaVal);
		let idxInicio;
		if (idxRef !== -1) {
			idxInicio = idxRef + 1;
		}
		else {
			// Sin encabezado: la lista empieza en la primera corrida
			// numerada de 3+ referencias con cola Vancouver.
			let idxCorrida = this._findNumberedRun(paras, metaVal);
			if (idxCorrida === -1) {
				throw new Error("No se encontró el encabezado de Referencias en el documento (se buscó References, Referencias, Bibliography, Works Cited y variantes, y tampoco una lista numerada). Revisa que el documento tenga su lista de referencias al final.");
			}
			idxInicio = idxCorrida;
		}
		// Párrafos siguientes: la lista puede venir numerada ("1. ...",
		// número literal o numeración automática de Word w:numPr) o sin
		// numerar (cada párrafo es una referencia). Regla en dos pasos:
		// si ALGÚN párrafo trae número, la lista es numerada y un
		// párrafo sin número es continuación del anterior (referencia
		// partida en dos párrafos); si NINGUNO trae número, cada
		// párrafo es una referencia.
		let cands = [];
		if (idxRef !== -1) {
			let inline = this._textoTrasEncabezado(this._paraText(paras[idxRef]));
			if (inline) {
				cands.push({
					numbered: this._esNumerado(inline),
					numPr: false,
					text: inline,
				});
			}
		}
		for (let i = idxInicio; i < paras.length; i++) {
			if (this._isHeading(paras[i])) break;
			let t = this._paraText(paras[i]).trim();
			if (!t) continue;
			cands.push({
				numbered: this._esNumerado(t) || this._hasNumPr(paras[i]),
				numPr: this._hasNumPr(paras[i]),
				text: t,
			});
		}
	let anyNumbered = cands.some((c) => c.numbered);
		let refTexts = [];
		// P4: textos para segundaCorrida (la guarda M3b en el ensamblaje).
		// Q5: con numeración automática el número se sintetiza (ver
		// _textosConNumPr).
		let textos = this._textosConNumPr(cands);
		// R6 (ronda 12): señal de reinicio de numeración para listas
		// numPr. _detectarReinicios(refTexts) lee el número del texto
		// y es ciego a w:numPr (el «1.» no está en el texto): una lista
		// numPr con reinicio («1,2,3,1,2,3», M3b) salía con 6 refs SIN
		// ninguna señal, mientras el PDF marca reinicioEn=[3]. Aquí el
		// número se conoce (textos sintetizados): cuando un párrafo
		// numerado reinicia (n <= 2, n < último) y la ref anterior trae
		// cola o URL (misma condición que el PDF), se anota el índice
		// que ocupará la ref (pre-split; se traslada tras los splits
		// con el mapa de pares de abajo).
		let reinicioEnEnsamble = [];
		let ultimoNumEnsamble = null;
		const registrarReinicio = (ci2) => {
			const d = numDeLinea(textos[ci2]);
			const n = d ? d.num : null;
			if (n !== null && ultimoNumEnsamble !== null && n < ultimoNumEnsamble && n <= 2 && refTexts.length > 0) {
				const prev = refTexts[refTexts.length - 1];
				if (prev && (this.TAIL_LIGERO_RE.test(prev) || tieneEvidenciaWeb(prev))) {
					reinicioEnEnsamble.push(refTexts.length);
				}
			}
			if (n !== null) ultimoNumEnsamble = n;
		};
		// Q2: textos de la primera corrida conservados con flag
		// (mismo patrón que meta.posiblePreambulo en PDF): se
		// registran por texto normalizado y se convierten en índices
		// tras los splits, en el filtro de subtítulo de abajo.
		let conservadosPreambulo = new Set();
		// ¿Se vio (y se descartó) un párrafo sin numerar antes de la
		// primera ref numerada? Solo entonces la corrida numerada que
		// sigue puede ser una corrida falsa tras preámbulo (C3).
		let vistoPreambulo = false;
		for (let ci = 0; ci < cands.length; ci++) {
			let c = cands[ci];
			if (anyNumbered) {
				if (c.numbered) {
					// P4: una corrida numerada de solo título+URL
					// seguida de un encabezado de sección + otra
					// corrida numerada son filas falsas (M3b) aunque
					// el encabezado ya haya validado por un preámbulo
					// sin numerar (C3): se salta la corrida entera.
					// Solo cuando antes se vio (y se descartó) un
					// párrafo sin numerar antes de la primera ref
					// numerada — sin preámbulo, la corrida ES la
					// lista (N3: 3 webs + Discusión + lista real).
					// Q2 (ronda 11): CONSERVAR la corrida con flag,
					// no saltarla: C3 (filas falsas) y
					// N3-con-preámbulo (3 webs reales) son
					// indistinguibles por estructura y saltar borraba
					// 3 refs reales en silencio (H5). Se empujan sus
					// párrafos numerados como refs y se marcan con
					// flag «posible fila de instrucciones, revisar»;
					// se sigue con la segunda corrida.
					// Ver DECISIONES.md §R11.2.
					if (vistoPreambulo) {
						let idxSegunda = segundaCorrida(textos, ci, true);
						if (idxSegunda !== -1) {
							for (let k = ci; k < idxSegunda; k++) {
								if (cands[k].numbered) {
									registrarReinicio(k);
									refTexts.push(cands[k].text);
									conservadosPreambulo.add(cands[k].text.replace(/\s+/g, " ").trim());
								}
							}
							ci = idxSegunda - 1;
							continue;
						}
					}
					registrarReinicio(ci);
					refTexts.push(c.text);
				}
				else if (refTexts.length > 0) {
					// R13 (paridad PDF m2/m3): un párrafo de
					// preámbulo web tras otro preámbulo conservado
					// es una ref propia, no la continuación de la
					// anterior (en PDF, m2 da 5 refs y m3 da 6, con
					// flags [0,1] y [0,1,2]; sin esto el DOCX pegaba
					// las 3 filas en una sola ref). Solo si la última
					// ref es un preámbulo conservado: si no, se pega
					// como continuación (p. ej. «Discusión» tras el
					// preámbulo, como en PDF, o la continuación de
					// una ref partida en mitad de lista).
					const ultimoEsPreambulo = conservadosPreambulo.has(
						refTexts[refTexts.length - 1].replace(/\s+/g, " ").trim());
					let web2 = null;
					if (ultimoEsPreambulo) {
						if (esPreambuloFalso(c.text)) {
							web2 = c.text;
						} else if (ci + 1 < cands.length && !cands[ci + 1].numbered &&
							(esMitadPartida(c.text) || esTituloAnioPartido(c.text)) &&
							esContinuacionPelada(cands[ci + 1].text.trim())) {
							web2 = c.text + " " + cands[ci + 1].text.trim();
						}
					}
					if (web2 !== null) {
						let kNum2 = ci + (web2 === c.text ? 1 : 2);
						while (kNum2 < cands.length && !cands[kNum2].numbered) kNum2++;
						if (kNum2 < cands.length && segundaCorrida(textos, kNum2, true) === -1) {
							refTexts.push(web2);
							conservadosPreambulo.add(web2.replace(/\s+/g, " ").trim());
							if (web2 !== c.text) ci++;
							continue;
						}
					}
					refTexts[refTexts.length - 1] += " " + c.text;
				}
				else {
					// S3: preámbulo web antes de la primera ref
					// numerada: un párrafo con solo título + URL
					// («Kidney stones. Available from: …») o un
					// título partido en dos párrafos («Kidney
					// stones 2020.» + «Available from: …»). En PDF
					// se conserva con flag (N1/N2, doctrina H5);
					// en DOCX se descartaba en silencio y la web
					// real se perdía (S1/S3). Se conserva con flag
					// SOLO si la corrida numerada que sigue es la
					// lista real (segundaCorrida === -1): si la
					// corrida que sigue es falsa (C3), se descarta
					// como antes y manda la guarda Q2 — así
					// C3-DOCX sigue dando 6 refs con flags [0,1,2]
					// y S1/S3-DOCX dan 4 refs con flag [0]. En
					// ambos casos se marca vistoPreambulo (la
					// guarda Q2 para corridas falsas posteriores
					// sigue valiendo).
					const tPre = c.text;
					let webPreambulo = null;
					if (esPreambuloFalso(tPre)) {
						webPreambulo = tPre;
					} else if (ci + 1 < cands.length && !cands[ci + 1].numbered &&
						(esMitadPartida(tPre) || esTituloAnioPartido(tPre)) &&
						esContinuacionPelada(cands[ci + 1].text.trim())) {
						webPreambulo = tPre + " " + cands[ci + 1].text.trim();
					}
					if (webPreambulo !== null) {
						// K15/k15p: tres filas casi idénticas antes de
						// la lista real son una corrida falsa, no tres
						// webs: si este párrafo y los dos siguientes
						// sin numerar son casi idénticos, se descarta
						// la corrida entera (las 3 filas) como antes
						// — el PDF las rechaza por la misma guarda en
						// el validador. Solo para el preámbulo de un
						// párrafo (el partido es una sola web). M5 no
						// se reabre: allí las webs SON la lista (sin
						// numerar, sin corrida numerada después) y
						// esta rama no corre.
						if (webPreambulo === tPre) {
							const sig = [];
							for (let q = ci + 1; q < cands.length && sig.length < 2; q++) {
								if (cands[q].numbered) break;
								sig.push(cands[q].text.trim());
							}
							if (sig.length === 2 && lineasCasiIdenticas([tPre, sig[0], sig[1]])) {
								vistoPreambulo = true;
								ci += 2;
								continue;
							}
						}
						let kNum = ci + (webPreambulo === tPre ? 1 : 2);
						while (kNum < cands.length && !cands[kNum].numbered) kNum++;
						if (kNum < cands.length && segundaCorrida(textos, kNum, true) === -1) {
							refTexts.push(webPreambulo);
							conservadosPreambulo.add(webPreambulo.replace(/\s+/g, " ").trim());
							vistoPreambulo = true;
							if (webPreambulo !== tPre) ci++;
							continue;
						}
					}
					// Párrafo sin numerar antes de la primera ref
					// numerada: se descarta (preexistente) y marca
					// que hubo preámbulo.
					vistoPreambulo = true;
				}
			}
			else {
				refTexts.push(c.text);
			}
		}
		// Espejo del camino PDF (pdfExtract.js): un párrafo puede
		// traer varias refs pegadas («1. ... 2. ...») o dos refs sin
		// número en una línea. Se dividen igual que en el PDF; por
		// párrafo, para no pegar entre sí refs sin numerar.
		// R6: los splits se hacen sobre pares (texto, índice
		// pre-split) para trasladar los índices de reinicio del
		// ensamblaje: cada trozo recuerda de qué ref pre-split viene.
		let pares = refTexts.map((t, i) => ({ t, i }));
		pares = pares.flatMap((p) => separarLineasNumeradas([p.t]).map((t2) => ({ t: t2, i: p.i })));
		pares = pares.flatMap((p) => separarRefsPegadas([p.t]).map((t2) => ({ t: t2, i: p.i })));
		refTexts = pares.map((p) => p.t.replace(/\s+/g, " ").trim());
		// Índices de reinicio del ensamblaje (pre-split) trasladados a
		// índices post-split: cada ref pre-split corresponde a su
		// primer trozo post-split. La fusión de abajo solo corre sin
		// numerar, donde no hay reinicios, así que no invalida esto.
		let reinicioEnPostSplit = reinicioEnEnsamble
			.map((pre) => pares.findIndex((p) => p.i === pre))
			.filter((x) => x !== -1);
		// Capítulo partido en dos párrafos (K4, DOCX) y libro partido
		// en dos párrafos (K8, DOCX): si una ref sin numerar termina
		// con el marcador de capítulo sin el libro («Smith J. Title.
		// En: Jones R, editor.»), el párrafo siguiente es su
		// continuación, no una ref nueva; y un párrafo pelado de
		// lugar+año («Madrid: Elsevier; 2020.») tampoco es una ref
		// por sí solo: es la cola del libro anterior. Se fusionan (en
		// bucle: el libro puede venir en dos párrafos). Solo sin
		// numerar: con numeración, cada párrafo numerado es una ref
		// (y el camino PDF ya pega la continuación al no cortar). Una
		// línea «Available from: URL» NO se fusiona: en PDF abre una
		// ref degenerada visible (híbrido K1/K2) y en DOCX sobrevive
		// partida en dos (paridad documentada).
		if (!anyNumbered) {
			let fusionados = [];
			for (let t of refTexts) {
				let ultimo = fusionados[fusionados.length - 1];
				// M10 (espejo del corte de mitad de lista en PDF):
				// un párrafo con solo título + URL pelada tras prosa
				// («Datos clínicos. Consultar en https://…») no es
				// una ref propia: se pega a la anterior y se ve en
				// revisión. Una línea «Available from: URL» NO se
				// fusiona (no trae título): en PDF abre una ref
				// degenerada visible (K1/K2) y en DOCX sobrevive
				// partida en dos (paridad documentada).
				if (ultimo !== undefined && (capituloIncompleto(ultimo) || esContinuacionLugar(t) || esPreambuloFalso(t))) {
					fusionados[fusionados.length - 1] = ultimo + " " + t;
				} else {
					fusionados.push(t);
				}
			}
			refTexts = fusionados;
		}
		// Subtítulo numerado ("1. Artículos") colado como referencia:
		// antes se descartaba en silencio si la referencia siguiente
		// SÍ parecía una (G3); ahora se CONSERVA como ref con flag
		// («posible subtítulo, revisar», H5) para que la revisión lo
		// muestre y lo decida el usuario. Sin tope de palabras (H4):
		// el tope de 8 se comía subtítulos de 9 palabras y refs
		// institucionales cortas. Espejo de empujar() en pdfExtract.js.
		let posibleSubtitulo = [];
		// Q2: índices de las filas conservadas de la primera corrida
		// tras preámbulo («posible fila de instrucciones, revisar»,
		// mismo patrón que meta.posiblePreambulo en PDF).
		let posiblePreambulo = [];
		let filtrados = [];
		refTexts.forEach((t, i) => {
			let esSub = false;
			let m = this.NUM_RE.exec(t.trim());
			let cuerpo = m ? m[5].trim() : null;
			if (cuerpo === null) {
				// Numeración romana (L1): "i. Artículos".
				let r = this._numeroRomano(t);
				if (r) cuerpo = r.text.trim();
			}
			if (cuerpo !== null && !lineaPareceRef(cuerpo)) {
				if (i < refTexts.length - 1) {
					let m2 = this.NUM_RE.exec(refTexts[i + 1].trim());
					let cuerpo2 = m2 ? m2[5].trim() : null;
					if (cuerpo2 === null) {
						let r2 = this._numeroRomano(refTexts[i + 1]);
						if (r2) cuerpo2 = r2.text.trim();
					}
					if (cuerpo2 === null) cuerpo2 = refTexts[i + 1].trim();
					if (lineaPareceRef(cuerpo2)) esSub = true;
				} else {
					// Última ref: sin línea siguiente que la rescate,
					// una línea numerada sin pinta de ref es subtítulo.
					esSub = true;
				}
			}
			if (esSub) posibleSubtitulo.push(filtrados.length);
			// Q2: la fila conservada de la primera corrida tras
			// preámbulo lleva flag de preámbulo. Se compara por texto
			// normalizado (los splits de arriba pueden reordenar los
			// índices, pero no cambian el texto). R13: por PREFIJO,
			// no por igualdad exacta: a la ref conservada se le
			// puede pegar una continuación («Discusión», k3p/m1/m3)
			// y la igualdad exacta perdía el flag — la ref quedaba
			// visible pero sin la marca de «posible preámbulo».
			// Un falso positivo exigiría que una ref real empezara
			// por el texto íntegro de un preámbulo conservado.
			const tNorm = t.replace(/\s+/g, " ").trim();
			let esPreambulo = conservadosPreambulo.has(tNorm);
			if (!esPreambulo) {
				for (const cp of conservadosPreambulo) {
					if (tNorm.startsWith(cp + " ")) { esPreambulo = true; break; }
				}
			}
			if (esPreambulo) {
				posiblePreambulo.push(filtrados.length);
			}
			filtrados.push(t);
		});
		refTexts = filtrados;
		if (!refTexts.length) {
			throw new Error("No se encontraron referencias tras el encabezado.");
		}
		// R6: el reinicio del ensamblaje (numPr) se fusiona con el
		// detectado en los textos finales (literal), sin duplicados.
		let reinicioEn = this._detectarReinicios(refTexts);
		for (const r of reinicioEnPostSplit) {
			if (!reinicioEn.includes(r)) reinicioEn.push(r);
		}
		reinicioEn.sort((a, b) => a - b);
		let metaOut = { reinicioEn, posibleSubtitulo };
		if (posiblePreambulo.length) metaOut.posiblePreambulo = posiblePreambulo;
		if (metaVal.posiblesDuplicados) metaOut.posiblesDuplicados = true;
		return { refTexts, meta: metaOut };
	},

	// Reinicio de numeración por sección («1,2,1,2») en la lista ya
	// extraída: la numeración vuelve a 1 (o 2) y la referencia
	// anterior está completa (tiene cola). Devuelve los índices de
	// las refs que abren sección, para marcarlas con flag en
	// _parseRefs. Espejo del meta.reinicioEn de extraerReferencias
	// (pdfExtract.js).
	_detectarReinicios(refTexts) {
		let reinicioEn = [];
		let ultimoNum = null;
		refTexts.forEach((t, i) => {
			let m = this.NUM_RE.exec(t.trim());
			let n = null;
			if (m) {
				// «(2024)» es un año, no un número de referencia.
				if (!((m[1] || m[2]) && /^(?:19|20)\d{2}$/.test(m[1] || m[2]))) {
					n = parseInt(m[1] || m[2] || m[3] || m[4], 10);
				}
			} else {
				// Numeración romana (L1).
				let r = this._numeroRomano(t);
				if (r) n = r.num;
			}
			if (n !== null) {
				if (ultimoNum !== null && n < ultimoNum && n <= 2 && i >= 1 &&
					this.TAIL_LIGERO_RE.test(refTexts[i - 1])) {
					reinicioEn.push(i);
				}
				ultimoNum = n;
			}
		});
		return reinicioEn;
	},

	_hasNumPr(p) {
		// Numeración automática de Word (el "1." no está en el texto).
		return p.getElementsByTagNameNS(this.W_NS, "numPr").length > 0;
	},

	// Q5: textos con numeración automática sintetizada para
	// segundaCorrida. Con w:numPr el «1.» no está en el texto y
	// segundaCorrida (que lee el número con numDeLinea) devolvía -1
	// siempre: la guarda P4 era ciega a la numeración automática.
	// items: [{ text, numPr }]. Se sintetiza «N. » por párrafo numPr
	// consecutivo; el contador se reinicia en cada párrafo sin numPr
	// (así una corrida falsa 1–3 y la real 1–3 tras «Discusión»
	// quedan 1–3 y 1–3). Solo importa la secuencia, no el valor
	// absoluto: segundaCorrida lee el número del texto sintetizado.
	_textosConNumPr(items) {
		let textos = [];
		let seq = 0;
		for (let it of items) {
			if (it.numPr) {
				seq++;
				textos.push(this._esNumerado(it.text) ? it.text : seq + ". " + it.text);
			} else {
				seq = 0;
				textos.push(it.text);
			}
		}
		return textos;
	},

	async _readPdf(path) {
		// Zotero.PDFWorker solo trabaja sobre adjuntos que ya están en
		// la biblioteca: se crea un ítem temporal con el PDF adjunto,
		// se extrae el texto y se borra el temporal (ítem + adjunto).
		let tmpItem = new Zotero.Item("document");
		tmpItem.setField("title", "RefImport temporal — se borra solo");
		await tmpItem.saveTx();
		let att = null;
		try {
			att = await Zotero.Attachments.importFromFile({
				file: path,
				parentItemID: tmpItem.id,
			});
			// v0.1.5: en Zotero 10 getFullText devuelve un OBJETO
			// { text, extractedPages, totalPages }, no una cadena.
			// El String(objeto) daba "[object Object]", no había ni una
			// línea y el error culpaba al encabezado ("no se encontró el
			// encabezado...") incluso con un PDF que sí tiene
			// "BIBLIOGRAFIA". Se aceptan las dos formas (Zotero 7
			// devolvía la cadena).
			let full = await Zotero.PDFWorker.getFullText(att.id);
			let text = typeof full === "string" ? full
				: (full && typeof full.text === "string" ? full.text : "");
			if (!text.trim()) {
				throw new Error("Zotero no devolvió texto del PDF (¿PDF escaneado sin capa de texto?).");
			}
			let lines = text.split(/\r\n|\r|\n/);
			let refTexts;
			let meta = {};
			try {
				refTexts = extraerReferencias(lines, meta);
			}
			catch (e) {
				// Error diagnóstico: si la lista no se reconoce, que el
				// mensaje traiga la forma real del texto para no volver a
				// arreglar a ciegas.
				let noVacias = lines.map((l) => l.trim()).filter(Boolean);
				let conPalabra = noVacias
					.filter((l) => /bibliograf|referenc/i.test(l))
					.slice(-20)
					.map((l) => l.length > 140 ? l.slice(0, 140) + "…" : l);
				let muestra = conPalabra.length
					? "Líneas con «bibliograf»/«referenc» (" + conPalabra.length + "): " + conPalabra.join(" | ")
					: "Últimas 12 líneas: " + noVacias.slice(-12)
						.map((l) => l.length > 140 ? l.slice(0, 140) + "…" : l).join(" | ");
				throw new Error((e && e.message ? e.message : e) +
					". Diagnóstico: " + lines.length + " líneas extraídas. " + muestra);
			}
			if (!refTexts.length) {
				throw new Error("No se extrajeron referencias del PDF.");
			}
			return { refTexts, meta };
		}
		finally {
			try { if (att) await att.eraseTx(); } catch (e) { /* ya borrado */ }
			try { await tmpItem.eraseTx(); } catch (e) { /* ya borrado */ }
		}
	},
};
