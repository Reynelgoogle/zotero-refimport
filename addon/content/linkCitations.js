/* linkCitations.js — port a JavaScript de construir_doc_zotero.py.
 *
 * Dada la ruta del DOCX original y el mapa número -> { uri, itemData }
 * de los ítems ya creados en Zotero, produce una copia "-zotero.docx"
 * con las citas del cuerpo convertidas en campos ADDIN ZOTERO_ITEM
 * CSL_CITATION y la bibliografía en un campo ADDIN ZOTERO_BIBL
 * CSL_BIBLIOGRAPHY. El Word original queda intacto.
 *
 * La estructura del campo es LITERALMENTE la que genera el script
 * Python (verificado contra Zotero 7.0): el mismo JSON, las mismas
 * claves (citationID de 8 caracteres alfanuméricos, properties con
 * formattedCitation/plainCitation/noteIndex, citationItems con id
 * secuencial por orden de primer uso, uris e itemData, schema CSL) y
 * la misma secuencia de runs (fldChar begin, instrText, fldChar
 * separate, texto visible, fldChar end).
 *
 * Diferencias con Python (solo robustez, mismo resultado):
 *   - Las citas se procesan de derecha a izquierda por párrafo, igual
 *     que en Python, para que los offsets no se muevan.
 *   - Si una cita está partida entre varios runs o cita un número no
 *     creado (excluido en la revisión), NO se rompe: se anota en
 *     `skipped` y se sigue con las demás. Python abortaba con assert.
 *   - Se trabaja con DOM (DOMParser/XMLSerializer) en vez de
 *     python-docx; el texto visible del campo conserva el rPr del run
 *     original, igual que en Python.
 *
 * Se carga en la ventana del diálogo de revisión (<script> en
 * reviewDialog.xhtml); usa los globales JSZip, DOMParser,
 * XMLSerializer e IOUtils de esa ventana chrome.
 */

var RefImportLink = (function () {
	"use strict";

	// Shim setImmediate (v0.1.3, forzado en v0.1.8): JSZip (utils.delay)
	// lo llama pelado en loadAsync/generateAsync. El polyfill de
	// setImmediate que trae el propio JSZip define uno con estrategia
	// postMessage/MessageChannel al cargar, así que el shim condicional
	// ("solo si falta") no se aplicaba... y esa estrategia no dispara
	// en la ventana XUL del diálogo: loadAsync/generateAsync no se
	// resuelven nunca y el enlazado se queda en "Enlazando..." sin
	// error ni archivo. Por eso se fuerza SIEMPRE la versión con
	// setTimeout, que funciona en cualquier ventana. Se asigna sobre
	// globalThis (la ventana del diálogo): JSZip resuelve el
	// setImmediate pelado en ese mismo ámbito, así que la asignación
	// posterior a la carga del bundle vale igual.
	globalThis.setImmediate = function (fn) {
		var args = Array.prototype.slice.call(arguments, 1);
		return setTimeout(function () { fn.apply(null, args); }, 0);
	};
	globalThis.clearImmediate = function (id) { clearTimeout(id); };

	var W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
	var XML_NS = "http://www.w3.org/XML/1998/namespace";
	var SCHEMA = "https://github.com/citation-style-language/schema/raw/master/csl-citation.json";
	// Guiones que aparecen en las citas: ASCII, guion Unicode, raya,
	// guion largo y signo menos. Word cambia "-" por "–" con la
	// autocorrección y antes esas citas no se enlazaban.
	var DASH = "\\-\\u2010-\\u2015\\u2212";
	// (n), (n,m), (n-m), (n–m), (n-m,k), (n, m, k), (n–m, k–j)...
	var CITA_RE = new RegExp(
		"\\(\\s*(\\d+(?:\\s*[,;]\\s*\\d+|\\s*[" + DASH + "]\\s*\\d+)*)\\s*\\)",
		"g"
	);
	// Encabezados de referencias (misma lista que refimport.js; sin
	// tildes: el normalizador las quita antes de comparar).
	var HEADINGS = ["references", "referencias", "referencia bibliografica",
		"referencias bibliograficas", "bibliography", "bibliografia",
		"bibliografica", "bibliograficas",
		"literature cited", "cited literature", "works cited",
		"cited references", "referencias citadas", "literatura citada",
		"list of references", "lista de referencias"];
	// Parecido (v0.1.4): línea corta con "referenc" o "bibliograf".
	var PARECIDO_RE = /referenc|bibliograf|fuentes consultadas|literature cited|works cited|cited literature|literatura citada/;
	// Cola Vancouver ligera (solo para el fallback sin encabezado).
	var TAIL_LIGERO_RE = /\b(?:19|20)\d{2}[;,]\s*\d+\s*(?:\([^)]*\))?\s*:\s*[A-Za-z]?\d+/;
	var NUM_RE = /^(?:\[(\d+)\]|\((\d+)\)|(\d+)[.)]|(\d+)\s*[-–—])\s*(.*)$/;
	// Un solo número o un rango "a-b" con cualquiera de los guiones
	// que mete Word.
	var RANGO_RE = new RegExp("^(\\d+)\\s*[" + DASH + "]\\s*(\\d+)$");

	function expandir(numsTxt) {
		/* '(2,4)' -> [2,4]; '(1-3)' -> [1,2,3];
		 * '(1–3, 6)' -> [1,2,3,6]; '(6;11)' -> [6,11].
		 * Antes solo partía por "-" y por ",": con el guion largo de
		 * Word ("–") o el punto y coma de Vancouver se quedaba con el
		 * primer número y la cita salía incompleta o se omitía. */
		var out = [];
		var tokens = String(numsTxt).split(/\s*[,;]\s*/);
		for (var i = 0; i < tokens.length; i++) {
			var tk = tokens[i].trim();
			if (!tk) continue;
			var r = RANGO_RE.exec(tk);
			if (r) {
				var a = parseInt(r[1], 10);
				var b = parseInt(r[2], 10);
				if (a > b) {
					var t = a;
					a = b;
					b = t;
				}
				// Tope de seguridad: un "rango" que en realidad son dos
				// años no debe generar decenas de números.
				if (b - a > 50) {
					out.push(a);
					continue;
				}
				for (var n = a; n <= b; n++) out.push(n);
				continue;
			}
			if (/^\d+$/.test(tk)) out.push(parseInt(tk, 10));
		}
		return out;
	}

	// --- acceso a disco ------------------------------------------------
	// IOUtils existe en las ventanas chrome de Zotero, pero el diálogo
	// puede quedarse sin él según cómo se cargue la ventana. Se prueban
	// tres caminos y, si ninguno sirve, se usa Zotero.File (que siempre
	// está, porque el diálogo recibe el objeto Zotero).
	function getIO() {
		try {
			if (typeof IOUtils !== "undefined" && IOUtils && IOUtils.read) {
				return IOUtils;
			}
		}
		catch (e) { /* sin IOUtils en este ámbito */ }
		try {
			var w = (typeof Zotero !== "undefined" && Zotero.getMainWindow)
				? Zotero.getMainWindow()
				: null;
			if (w && w.IOUtils && w.IOUtils.read) return w.IOUtils;
		}
		catch (e) { /* sin ventana principal */ }
		try {
			var m = ChromeUtils.importESModule("resource://gre/modules/IOUtils.sys.mjs");
			if (m && m.IOUtils) return m.IOUtils;
		}
		catch (e) { /* módulo no disponible */ }
		return null;
	}

	async function leerBytes(path) {
		var io = getIO();
		if (io) return new Uint8Array(await io.read(path));
		if (typeof Zotero !== "undefined" && Zotero.File &&
			typeof Zotero.File.getBinaryContentsAsync === "function") {
			// Respaldo: cadena binaria (un carácter por byte).
			var bin = await Zotero.File.getBinaryContentsAsync(path);
			var out = new Uint8Array(bin.length);
			for (var i = 0; i < bin.length; i++) {
				out[i] = bin.charCodeAt(i) & 0xff;
			}
			return out;
		}
		throw new Error("esta ventana no tiene forma de leer archivos (falta IOUtils)");
	}

	async function escribirBytes(path, bytes) {
		var io = getIO();
		if (io) {
			await io.write(path, bytes);
			return;
		}
		if (typeof Zotero !== "undefined" && Zotero.File &&
			typeof Zotero.File.putContentsAsync === "function") {
			var buf = bytes.buffer.slice(bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength);
			await Zotero.File.putContentsAsync(path, buf);
			return;
		}
		throw new Error("esta ventana no tiene forma de escribir archivos (falta IOUtils)");
	}

	function diagnostico() {
		/* Foto del entorno para el mensaje de error del diálogo. */
		var d = [];
		function tipo(n, f) {
			try { d.push(n + "=" + f()); }
			catch (e) { d.push(n + "=ERROR(" + e + ")"); }
		}
		tipo("IOUtils", function () { return typeof IOUtils; });
		tipo("DOMParser", function () { return typeof DOMParser; });
		tipo("XMLSerializer", function () { return typeof XMLSerializer; });
		tipo("JSZip", function () { return typeof JSZip; });
		tipo("Zotero", function () { return typeof Zotero; });
		tipo("ChromeUtils", function () { return typeof ChromeUtils; });
		tipo("IOUtils efectivo", function () { return getIO() ? "sí" : "no"; });
		return d.join(", ");
	}

	function nuevoCitationID(usados) {
		var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
		var id;
		do {
			id = "";
			for (var i = 0; i < 8; i++) {
				id += chars.charAt(Math.floor(Math.random() * chars.length));
			}
		} while (usados.has(id));
		usados.add(id);
		return id;
	}

	function paraText(p) {
		var ts = p.getElementsByTagNameNS(W_NS, "t");
		var s = "";
		for (var i = 0; i < ts.length; i++) s += ts[i].textContent;
		return s;
	}

	function runText(r) {
		var ts = r.getElementsByTagNameNS(W_NS, "t");
		var s = "";
		for (var i = 0; i < ts.length; i++) s += ts[i].textContent;
		return s;
	}

	function isHeading(p) {
		var styles = p.getElementsByTagNameNS(W_NS, "pStyle");
		if (!styles.length) return false;
		var v = styles[0].getAttributeNS(W_NS, "val") || "";
		return /^Heading/i.test(v) || /^Titulo/i.test(v);
	}

	function hasNumPr(p) {
		// Numeración automática de Word (el "1." no está en el texto).
		return p.getElementsByTagNameNS(W_NS, "numPr").length > 0;
	}

	function setRunText(r, text) {
		var ts = r.getElementsByTagNameNS(W_NS, "t");
		if (!ts.length) {
			var t = r.ownerDocument.createElementNS(W_NS, "w:t");
			t.setAttributeNS(XML_NS, "xml:space", "preserve");
			t.textContent = text;
			r.appendChild(t);
			return;
		}
		ts[0].textContent = text;
		for (var i = ts.length - 1; i >= 1; i--) {
			ts[i].parentNode.removeChild(ts[i]);
		}
	}

	function rPrOf(r) {
		var prs = r.getElementsByTagNameNS(W_NS, "rPr");
		return prs.length ? prs[0] : null;
	}

	function makeFldChar(doc, type) {
		var r = doc.createElementNS(W_NS, "w:r");
		var fc = doc.createElementNS(W_NS, "w:fldChar");
		fc.setAttributeNS(W_NS, "w:fldCharType", type);
		r.appendChild(fc);
		return r;
	}

	function makeInstr(doc, text) {
		var r = doc.createElementNS(W_NS, "w:r");
		var it = doc.createElementNS(W_NS, "w:instrText");
		it.setAttributeNS(XML_NS, "xml:space", "preserve");
		it.textContent = text;
		r.appendChild(it);
		return r;
	}

	function makeTextRun(doc, text, rPr) {
		var r = doc.createElementNS(W_NS, "w:r");
		if (rPr) r.appendChild(rPr.cloneNode(true));
		var t = doc.createElementNS(W_NS, "w:t");
		t.setAttributeNS(XML_NS, "xml:space", "preserve");
		t.textContent = text;
		r.appendChild(t);
		return r;
	}

	function insertarCampoCita(doc, p, s, e, nums, textoVisible, citItems, usados) {
		/* Reemplaza la cita en [s, e) del texto del párrafo por un campo
		 * de cita Zotero. La cita debe caer dentro de un solo run
		 * (igual que en Python); si no, devuelve false y el llamador
		 * la anota como omitida. */
		var obj = {
			citationID: nuevoCitationID(usados),
			properties: {
				formattedCitation: textoVisible,
				plainCitation: textoVisible,
				noteIndex: 0,
			},
			citationItems: citItems(nums),
			schema: SCHEMA,
		};
		var instr = " ADDIN ZOTERO_ITEM CSL_CITATION " + JSON.stringify(obj);
		var runs = Array.prototype.slice.call(p.getElementsByTagNameNS(W_NS, "r"));
		var pos = 0;
		for (var i = 0; i < runs.length; i++) {
			var t = runText(runs[i]);
			if (pos <= s && s < pos + t.length) {
				if (e > pos + t.length) return false;
				var rEl = runs[i];
				var rPr = rPrOf(rEl);
				var antes = t.slice(0, s - pos);
				var dentro = t.slice(s - pos, e - pos);
				var despues = t.slice(e - pos);
				if (dentro !== textoVisible) return false;
				setRunText(rEl, antes);
				var cursor = rEl;
				[makeFldChar(doc, "begin"), makeInstr(doc, instr),
					makeFldChar(doc, "separate"),
					makeTextRun(doc, textoVisible, rPr),
					makeFldChar(doc, "end")].forEach(function (el) {
					cursor.parentNode.insertBefore(el, cursor.nextSibling);
					cursor = el;
				});
				if (despues) {
					var r2 = makeTextRun(doc, despues, rPr);
					cursor.parentNode.insertBefore(r2, cursor.nextSibling);
				}
				return true;
			}
			pos += t.length;
		}
		return false;
	}

	function normalizeHeading(text) {
		// Minúsculas, sin tildes, sin numeración inicial ("5. "), sin
		// puntuación final (".", ":") y sin número de página final
		// ("References 12"). Sin tildes: "BIBLIOGRAFIA" iguala a
		// "bibliografia" del conjunto.
		return text.trim().toLowerCase()
			.normalize("NFD").replace(/[̀-ͯ]/g, "")
			.replace(/^\d+\s*[.)\]]\s*/, "")
			.replace(/\s+\d+\s*$/, "")
			.replace(/[\s.:;\-]+$/, "")
			.replace(/\s+/g, " ")
			.trim();
	}

	function isRefHeadingExacto(text) {
		return HEADINGS.indexOf(normalizeHeading(text)) !== -1;
	}

	function isRefHeadingParecido(text) {
		// Línea CORTA, sin cola de referencia, que contiene
		// "referenc" o "bibliograf". Excluye "de referencia(s)":
		// es el valor de referencia de un dato ("Calibre de
		// referencia"), no la sección de referencias.
		var s = normalizeHeading(text);
		if (!s || s.split(" ").length > 8) return false;
		if (TAIL_LIGERO_RE.test(s)) return false;
		if (/\bde referencias?\b/.test(s)) return false;
		return PARECIDO_RE.test(s);
	}

	function isRefHeading(text) {
		return isRefHeadingExacto(text) || isRefHeadingParecido(text);
	}

	// Búsqueda en dos pasadas: exacto primero, parecido solo si no
	// hay exacto (una etiqueta corta del cuerpo no debe robar el
	// encabezado real que viene después).
	function buscarEncabezado(paras) {
		var i;
		for (i = 0; i < paras.length; i++) {
			if (isRefHeadingExacto(paraText(paras[i]))) return i;
		}
		for (i = 0; i < paras.length; i++) {
			if (isRefHeadingParecido(paraText(paras[i]))) return i;
		}
		return -1;
	}

	function esNumerado(text) {
		// ¿Empieza el párrafo con número de referencia ("1.", "[1]",
		// "(1)", "1)")? "(2024)"/"[2024]" es un año, no un número.
		var m = NUM_RE.exec(text.trim());
		if (!m) return false;
		if ((m[1] || m[2]) && /^(?:19|20)\d{2}$/.test(m[1] || m[2])) return false;
		return true;
	}

	function findNumberedRun(paras) {
		// Fallback sin encabezado: primera corrida de 3+ párrafos
		// numerados seguidos cuya primera referencia tenga cola
		// Vancouver. Devuelve el índice del primer párrafo, o -1.
		function numOf(p) {
			var t = paraText(p).trim();
			if (!esNumerado(t)) {
				if (hasNumPr(p)) return { num: null, text: t };
				return null;
			}
			var m = NUM_RE.exec(t);
			var n = m[1] || m[2] || m[3] || m[4];
			return { num: parseInt(n, 10), text: m[5] };
		}
		for (var i = 0; i < paras.length; i++) {
			var c0 = numOf(paras[i]);
			if (!c0) continue;
			var bloque1 = c0.text;
			var esperado = c0.num !== null ? c0.num + 1 : null;
			var encontrados = 1;
			var j = i + 1, recorridas = 0;
			while (j < paras.length && recorridas < 30) {
				var c = numOf(paras[j]);
				if (c) {
					if (c.num === null || esperado === null || c.num === esperado) {
						encontrados++;
						if (c.num !== null) esperado = c.num + 1;
						if (encontrados === 3) break;
					}
					else if (encontrados === 1) {
						bloque1 += " " + paraText(paras[j]).trim();
					}
				}
				else if (encontrados === 1) {
					var t = paraText(paras[j]).trim();
					if (t) bloque1 += " " + t;
				}
				j++;
				recorridas++;
			}
			if (encontrados < 3) continue;
			if (!TAIL_LIGERO_RE.test(bloque1)) continue;
			return i;
		}
		return -1;
	}

	async function linkCitations(docxPath, createdMap, totalRefs, onProgress) {
		/* createdMap: { "1": { uri, itemData }, ... } (claves = nº de ref).
		 * totalRefs: nº total de referencias parseadas (para validar rango).
		 * onProgress (opcional): se llama con el paso en curso para que
		 * el diálogo muestre dónde va; si un paso se atasca, el último
		 * mensaje dice cuál fue (v0.1.8).
		 * Devuelve { outputPath, fields, instances, cited, bibItems, skipped }. */
		function progress(message) {
			if (typeof onProgress === "function") onProgress(message);
		}
		function yieldToUI() {
			return new Promise(function (resolve) { setTimeout(resolve, 0); });
		}

		// Igual que en _readDocx: IOUtils.read devuelve un Uint8Array
		// de otro realm y JSZip lo rechaza sin la copia.
		var bytes, zip, entry, xml, doc;
		progress("Leyendo el archivo Word…");
		try {
			bytes = await leerBytes(docxPath);
		}
		catch (e) {
			throw new Error("No se pudo leer el Word («" + docxPath + "»): " +
				(e && e.message ? e.message : e));
		}
		progress("Abriendo el DOCX…");
		try {
			zip = await JSZip.loadAsync(bytes);
		}
		catch (e) {
			throw new Error("El archivo no es un .docx válido (no se pudo abrir el ZIP): " +
				(e && e.message ? e.message : e));
		}
		entry = zip.file("word/document.xml");
		if (!entry) throw new Error("El DOCX no contiene word/document.xml");
		progress("Extrayendo word/document.xml…");
		xml = await entry.async("string", function (metadata) {
			progress("Extrayendo word/document.xml… " +
				Math.floor(metadata.percent) + "%");
		});
		progress("Analizando el documento…");
		await yieldToUI();
		try {
			doc = new DOMParser().parseFromString(xml, "application/xml");
		}
		catch (e) {
			throw new Error("No se pudo interpretar word/document.xml: " +
				(e && e.message ? e.message : e));
		}
		var paras = Array.prototype.slice.call(doc.getElementsByTagNameNS(W_NS, "p"));

		var idxRef = buscarEncabezado(paras);
		var conEncabezado = idxRef !== -1;
		if (idxRef === -1) {
			// Sin encabezado: la bibliografía empieza en la primera
			// corrida numerada de 3+ referencias con cola Vancouver.
			idxRef = findNumberedRun(paras);
		}
		if (idxRef === -1) {
			throw new Error("No se encontró el encabezado de Referencias en el documento");
		}
		// Con encabezado, la bibliografía empieza DESPUÉS de él; con
		// el fallback, idxRef YA es la primera referencia.
		var idxBib = conEncabezado ? idxRef + 1 : idxRef;
		// Párrafos de la bibliografía: misma regla que _readDocx en
		// refimport.js (lista numerada con "N. " o numeración automática
		// w:numPr, o lista sin numerar donde cada párrafo es una ref).
		var cands = [];
		for (var j = idxBib; j < paras.length; j++) {
			if (isHeading(paras[j])) break;
			var t = paraText(paras[j]).trim();
			if (!t) continue;
			cands.push({
				p: paras[j],
				numbered: esNumerado(t) || hasNumPr(paras[j]),
			});
		}
		var anyNumbered = cands.some(function (c) { return c.numbered; });
		var bibParas = [];
		for (var k = 0; k < cands.length; k++) {
			// En lista numerada, un párrafo sin número es continuación
			// de la ref anterior y NO abre párrafo de bibliografía
			// propio; en lista sin numerar, cada párrafo es una ref.
			if (anyNumbered && !cands[k].numbered) continue;
			bibParas.push(cands[k].p);
		}
		if (!bibParas.length) {
			throw new Error("No se encontraron párrafos de bibliografía numerados");
		}

		// id secuencial por URI, por orden de primer uso (igual que Python).
		var idPorUri = {};
		function citItems(nums) {
			var out = [];
			for (var k = 0; k < nums.length; k++) {
				var info = createdMap[String(nums[k])];
				var uri = info.uri;
				if (!(uri in idPorUri)) {
					idPorUri[uri] = Object.keys(idPorUri).length + 1;
				}
				out.push({ id: idPorUri[uri], uris: [uri], itemData: info.itemData });
			}
			return out;
		}

		var usados = new Set();
		var nCampos = 0;
		var nInstancias = 0;
		var citados = new Set();
		var skipped = [];

		// Citas del cuerpo, de derecha a izquierda por párrafo.
		progress("Enlazando citas del texto…");
		for (var pi = 0; pi < idxRef; pi++) {
			if (pi > 0 && pi % 100 === 0) {
				progress("Enlazando citas del texto… (" + pi + "/" + idxRef + " párrafos)");
				await yieldToUI();
			}
			var p = paras[pi];
			var pText = paraText(p);
			var matches = [];
			var m;
			CITA_RE.lastIndex = 0;
			while ((m = CITA_RE.exec(pText)) !== null) {
				matches.push({ s: m.index, e: m.index + m[0].length, vis: m[0] });
			}
			for (var mi = matches.length - 1; mi >= 0; mi--) {
				var mt = matches[mi];
				var nums = expandir(mt.vis.slice(1, -1));
				var validos = nums.filter(function (n) {
					return n >= 1 && n <= totalRefs && createdMap[String(n)];
				});
				if (validos.length !== nums.length) {
					skipped.push({
						parrafo: pi + 1,
						texto: mt.vis,
						motivo: "número fuera de rango o referencia excluida en la revisión",
					});
					continue;
				}
				var ok = insertarCampoCita(doc, p, mt.s, mt.e, nums, mt.vis, citItems, usados);
				if (!ok) {
					skipped.push({
						parrafo: pi + 1,
						texto: mt.vis,
						motivo: "la cita está partida entre varios runs; no se enlazó",
					});
					continue;
				}
				nums.forEach(function (n) { citados.add(n); });
				nInstancias += nums.length;
				nCampos++;
			}
		}

		// Campo de bibliografía (solo los ítems creados, en orden numérico).
		progress("Preparando el campo de bibliografía…");
		var itemsBib = [];
		Object.keys(createdMap).map(Number).sort(function (a, b) { return a - b; })
			.forEach(function (n) {
				var info = createdMap[String(n)];
				var uri = info.uri;
				if (!(uri in idPorUri)) {
					idPorUri[uri] = Object.keys(idPorUri).length + 1;
				}
				itemsBib.push({ id: idPorUri[uri], uris: [uri], itemData: info.itemData });
			});
		var bibObj = { items: itemsBib, schema: SCHEMA };
		var instrBib = " ADDIN ZOTERO_BIBL " + JSON.stringify(bibObj) + " CSL_BIBLIOGRAPHY";
		var p0 = bibParas[0];
		var r0 = p0.getElementsByTagNameNS(W_NS, "r")[0];
		if (!r0) throw new Error("El primer párrafo de la bibliografía no tiene runs");
		[makeFldChar(doc, "begin"), makeInstr(doc, instrBib), makeFldChar(doc, "separate")]
			.forEach(function (el) { r0.parentNode.insertBefore(el, r0); });
		var plast = bibParas[bibParas.length - 1];
		plast.appendChild(makeFldChar(doc, "end"));

		var outXml = new XMLSerializer().serializeToString(doc);
		zip.file("word/document.xml", outXml);
		// DEFLATE explícito: sin esto JSZip guarda en STORE (sin
		// comprimir) y el .docx sale ~4x más grande que el original.
		progress("Generando la copia del Word…");
		var out = await zip.generateAsync(
			{ type: "uint8array", compression: "DEFLATE" },
			function (metadata) {
				if (typeof onProgress === "function") {
					onProgress("Generando la copia del Word… " +
						Math.floor(metadata.percent) + "%");
				}
			}
		);
		var outPath = String(docxPath).replace(/\.docx$/i, "") + "-zotero.docx";
		progress("Guardando la copia en la carpeta del documento…");
		try {
			await escribirBytes(outPath, out);
		}
		catch (e) {
			throw new Error("No se pudo guardar «" + outPath + "»: " +
				(e && e.message ? e.message : e));
		}
		progress("Copia guardada correctamente.");
		return {
			outputPath: outPath,
			fields: nCampos,
			instances: nInstancias,
			cited: citados.size,
			bibItems: itemsBib.length,
			skipped: skipped,
		};
	}

	return {
		linkCitations: linkCitations,
		diagnostico: diagnostico,
		_expandir: expandir,
	};
})();
