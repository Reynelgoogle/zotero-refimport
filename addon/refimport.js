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
	version: "0.1.7",
	rootURI: null,
	_menuItems: new Map(),

	W_NS: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
	HEADINGS: ["references", "referencias", "referencia bibliografica",
		"referencias bibliograficas", "bibliography", "bibliografia",
		"bibliografica", "bibliograficas",
		"literature cited", "cited literature", "works cited",
		"cited references", "referencias citadas", "literatura citada",
		"list of references", "lista de referencias"],
	NUM_RE: /^(?:\[(\d+)\]|\((\d+)\)|(\d+)[.)]|(\d+)\s*[-–—])\s*(.*)$/,
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
			let refTexts = isDocx
				? await this._readDocx(path)
				: await this._readPdf(path);
			let refs = this._parseRefs(refTexts);
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

	_parseRefs(refTexts) {
		return refTexts.map((t, i) => {
			let r = parseReferencia(t);
			r.numero = i + 1;
			r.included = true;
			r.raw = t;
			return r;
		});
	},

	_paraText(p) {
		let ts = p.getElementsByTagNameNS(this.W_NS, "t");
		let s = "";
		for (let i = 0; i < ts.length; i++) s += ts[i].textContent;
		return s;
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
	_buscarEncabezado(paras) {
		for (let i = 0; i < paras.length; i++) {
			if (this._isRefHeadingExacto(this._paraText(paras[i]))) return i;
		}
		for (let i = 0; i < paras.length; i++) {
			if (this._isRefHeadingParecido(this._paraText(paras[i]))) return i;
		}
		return -1;
	},

	_esNumerado(text) {
		// ¿Empieza el párrafo con número de referencia ("1.", "[1]",
		// "(1)", "1)")? "(2024)"/"[2024]" es un año, no un número.
		let m = this.NUM_RE.exec(text.trim());
		if (!m) return false;
		if ((m[1] || m[2]) && /^(?:19|20)\d{2}$/.test(m[1] || m[2])) return false;
		return true;
	},

	_findNumberedRun(paras) {
		// Fallback sin encabezado: primera corrida de 3+ párrafos
		// numerados seguidos cuya primera referencia tenga cola
		// Vancouver. Devuelve el índice del primer párrafo, o -1.
		// Un número no secuencial ("204." de "194-204") se trata como
		// continuación de la referencia anterior, no como una nueva.
		const numOf = (p) => {
			let t = this._paraText(p).trim();
			if (!this._esNumerado(t)) {
				if (this._hasNumPr(p)) return { num: null, text: t };
				return null;
			}
			let m = this.NUM_RE.exec(t);
			let n = m[1] || m[2] || m[3] || m[4];
			return { num: parseInt(n, 10), text: m[5] };
		};
		for (let i = 0; i < paras.length; i++) {
			let c0 = numOf(paras[i]);
			if (!c0) continue;
			let bloque1 = c0.text;
			let esperado = c0.num !== null ? c0.num + 1 : null;
			let encontrados = 1;
			let j = i + 1, recorridas = 0;
			while (j < paras.length && recorridas < 30) {
				let c = numOf(paras[j]);
				if (c) {
					if (c.num === null || esperado === null || c.num === esperado) {
						encontrados++;
						if (c.num !== null) esperado = c.num + 1;
						if (encontrados === 3) break;
					}
					else if (encontrados === 1) {
						// Párrafo numerado que no es el siguiente: es
						// otra referencia (o una sección numerada, p.
						// ej. "1. Introduction"). Este candidato no es
						// la lista: reintentar desde ese párrafo (el
						// bucle exterior lo probará como inicio). Sin
						// esto, su texto se pegaba a bloque1 y su cola
						// Vancouver hacía pasar el filtro.
						if (c.num !== null && esperado !== null) {
							i = j - 1;
							break;
						}
						bloque1 += " " + this._paraText(paras[j]).trim();
					}
				}
				else if (encontrados === 1) {
					let t = this._paraText(paras[j]).trim();
					if (t) bloque1 += " " + t;
				}
				j++;
				recorridas++;
			}
			if (encontrados < 3) continue;
			if (!this.TAIL_LIGERO_RE.test(bloque1)) continue;
			return i;
		}
		return -1;
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
		let idxRef = this._buscarEncabezado(paras);
		let idxInicio;
		if (idxRef !== -1) {
			idxInicio = idxRef + 1;
		}
		else {
			// Sin encabezado: la lista empieza en la primera corrida
			// numerada de 3+ referencias con cola Vancouver.
			let idxCorrida = this._findNumberedRun(paras);
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
		for (let i = idxInicio; i < paras.length; i++) {
			if (this._isHeading(paras[i])) break;
			let t = this._paraText(paras[i]).trim();
			if (!t) continue;
			cands.push({
				numbered: this._esNumerado(t) || this._hasNumPr(paras[i]),
				text: t,
			});
		}
		let anyNumbered = cands.some((c) => c.numbered);
		let refTexts = [];
		for (let c of cands) {
			if (anyNumbered) {
				if (c.numbered) {
					refTexts.push(c.text);
				}
				else if (refTexts.length > 0) {
					refTexts[refTexts.length - 1] += " " + c.text;
				}
			}
			else {
				refTexts.push(c.text);
			}
		}
		if (!refTexts.length) {
			throw new Error("No se encontraron referencias tras el encabezado.");
		}
		return refTexts;
	},

	_hasNumPr(p) {
		// Numeración automática de Word (el "1." no está en el texto).
		return p.getElementsByTagNameNS(this.W_NS, "numPr").length > 0;
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
			try {
				refTexts = extraerReferencias(lines);
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
			return refTexts;
		}
		finally {
			try { if (att) await att.eraseTx(); } catch (e) { /* ya borrado */ }
			try { await tmpItem.eraseTx(); } catch (e) { /* ya borrado */ }
		}
	},
};
