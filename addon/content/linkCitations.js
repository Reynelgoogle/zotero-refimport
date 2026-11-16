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
	var NUM_RE = /^(?:N[º°]\.?\s*|N\.\s+|No\.?\s+)?(?:\[(\d+)[a-zA-Z]?\]|\((\d+)[a-zA-Z]?\)|(\d+)[a-zA-Z]?[.)]|(\d+)[a-zA-Z]?\s*[-–—\u2010\u2011](?:\s+|(?=(?:[A-ZÁÉÍÓÚÜÑ][A-Za-zÁÉÍÓÚÜÑ'’\-]*(?: (?:[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ'’\-]+|[A-ZÁÉÍÓÚÜÑ]{2,}|de|la|van|der|den|ten|di|dos|das|do|el|al|bin|ibn)){0,3},? (?:[A-ZÁÉÍÓÚÜÑ]\.(?: ?[A-ZÁÉÍÓÚÜÑ]\.)*|[A-ZÁÉÍÓÚÜÑ]{2,3}\.|[A-ZÁÉÍÓÚÜÑ] (?:Jr|Sr)\.)|[A-ZÁÉÍÓÚÜÑ].*;\s*(?:\d+\s*:|(?:19|20)\d{2}\b)))))\s*(.*)$/;
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

	// Q5: textos con numeración automática sintetizada para
	// segundaCorrida (espejo de _textosConNumPr en refimport.js). Con
	// w:numPr el «1.» no está en el texto y segundaCorrida (que lee
	// el número con numDeLinea) devolvía -1 siempre: la guarda P4 era
	// ciega a la numeración automática. Se sintetiza «N. » por
	// párrafo numPr consecutivo; el contador se reinicia en cada
	// párrafo sin numPr (así una corrida falsa 1–3 y la real 1–3 tras
	// «Discusión» quedan 1–3 y 1–3). Solo importa la secuencia, no el
	// valor absoluto: segundaCorrida lee el número del texto
	// sintetizado.
	function textosConNumPr(paras) {
		var textos = [];
		var seq = 0;
		for (var i = 0; i < paras.length; i++) {
			var t = paraText(paras[i]).trim();
			if (hasNumPr(paras[i])) {
				seq++;
				textos.push(esNumerado(t) ? t : seq + ". " + t);
			} else {
				seq = 0;
				textos.push(t);
			}
		}
		return textos;
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
	// Búsqueda en dos pasadas: exacto primero, parecido solo si no
	// hay exacto (una etiqueta corta del cuerpo no debe robar el
	// encabezado real que viene después). Cada candidato se VALIDA
	// con encabezadoConListaValida: un «Referencias» como título de
	// tabla/sección con filas numeradas detrás ya no secuestra el
	// enlazado (F1). Espejo de _buscarEncabezado en refimport.js.
	function buscarEncabezado(paras) {
		var i;
		for (i = 0; i < paras.length; i++) {
			if ((isRefHeadingExacto(paraText(paras[i])) ||
				textoTrasEncabezado(paraText(paras[i]))) &&
				encabezadoConListaValida(paras, i)) return i;
		}
		for (i = 0; i < paras.length; i++) {
			if (isRefHeadingParecido(paraText(paras[i])) &&
				encabezadoConListaValida(paras, i)) return i;
		}
		return -1;
	}

	// Resto de la línea tras un encabezado exacto («Referencias:
	// 1. Smith...» o «Referencias 1. Smith...»). Espejo de
	// _textoTrasEncabezado en refimport.js; aquí solo se usa para
	// validar el encabezado.
	function textoTrasEncabezado(text) {
		var colon = text.indexOf(":");
		if (colon !== -1 && isRefHeadingExacto(text.slice(0, colon))) {
			return text.slice(colon + 1).trim();
		}
		var marker = /\s+(?=(?:\d+\s*[.)]|\[\s*\d+\s*\]|\(\s*\d+\s*\)|\d+\s*[-–—\u2010\u2011])\s*\S)/g;
		var match;
		while ((match = marker.exec(text))) {
			if (isRefHeadingExacto(text.slice(0, match.index))) {
				return text.slice(match.index + match[0].length).trim();
			}
		}
		return "";
	}

	// Encabezado con la 1ª ref pegada («Referencias: 1. Smith...»):
	// divide el párrafo en dos — el encabezado queda solo
	// («Referencias:») y el resto pasa a un párrafo nuevo insertado
	// detrás, que es el primer párrafo de bibliografía (G2). Sin
	// esto, el texto plano de la ref 1 quedaba fuera del campo BIBL
	// y tras un Refresh en Zotero la ref 1 salía duplicada.
	// Devuelve el párrafo nuevo, o null si no se pudo dividir (el
	// llamador usa entonces el párrafo entero como bibParas[0]).
	function dividirParrafoEncabezado(doc, p, resto) {
		var full = paraText(p);
		var idx = full.lastIndexOf(resto);
		if (idx <= 0) return null;
		var runs = Array.prototype.slice.call(p.getElementsByTagNameNS(W_NS, "r"));
		if (!runs.length) return null;
		var pos = 0, restoRuns = [];
		for (var i = 0; i < runs.length; i++) {
			var t = runText(runs[i]);
			var ini = pos, fin = pos + t.length;
			if (fin <= idx) { /* run entero antes del resto: se queda */ }
			else if (ini >= idx) { restoRuns.push(runs[i]); }
			else { setRunText(runs[i], t.slice(0, idx - ini)); }
			pos = fin;
		}
		var rPr = restoRuns.length ? rPrOf(restoRuns[0]) : rPrOf(runs[0]);
		restoRuns.forEach(function (r) { r.parentNode.removeChild(r); });
		var np = doc.createElementNS(W_NS, "w:p");
		np.appendChild(makeTextRun(doc, resto, rPr));
		p.parentNode.insertBefore(np, p.nextSibling);
		return np;
	}

	// Numeración romana ("i.", "ii.", "iii."): se convierte a
	// arábigo (L1, espejo de numDeLinea en pdfExtract.js). Tope en
	// 50: una "c." o "d." suelta no es el nº 100/500. Prefijo «Nº» (N7).
	function numeroRomano(text) {
		var m = /^(?:N[º°]\.?\s*|N\.\s+|No\.?\s+)?([ivxlcdm]+)[.)]\s*(.*)$/i.exec(text.trim());
		if (!m) return null;
		if (!/^(m{0,3})(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i.test(m[1])) return null;
		var VAL = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
		var total = 0;
		for (var i = 0; i < m[1].length; i++) {
			var v = VAL[m[1][i].toLowerCase()];
			var next = i + 1 < m[1].length ? VAL[m[1][i + 1].toLowerCase()] : 0;
			total += v < next ? -v : v;
		}
		if (total < 1 || total > 50) return null;
		return { num: total, text: m[2] };
	}

	// ¿Empieza una lista tras este encabezado? Espejo de
	// encabezadoConListaValida (pdfExtract.js) y de
	// _encabezadoConListaValida (refimport.js). Requiere pdfExtract.js
	// cargado en el diálogo (reviewDialog.xhtml): lineaPareceRef,
	// pareceInicioSinNumero y tieneEvidenciaRef son globales suyas.
	// Solo vale con EVIDENCIA de cita (cola, URL, lugar:editorial o
	// año con estructura): un año suelto de fila clínica
	// («ingreso 2020», H2) no basta, y una línea con pinta de autor
	// pero sin evidencia no valida la rama sin numerar (H3).
	function encabezadoConListaValida(paras, i) {
		var restoInline = textoTrasEncabezado(paraText(paras[i]));
		// Textos de los párrafos (para segundaCorrida /
		// haySegundaCorridaTras, globales de pdfExtract.js). Q5: con
		// numeración automática el número se sintetiza (ver
		// textosConNumPr).
		var textos = textosConNumPr(paras);
		// El resto inline solo vale con evidencia NUMERADA de cita:
		// un resto con solo "pinta de autor" es el mismo agujero que
		// G1 (espejo de encabezadoConListaValida en pdfExtract.js,
		// J4'/J5').
		if (restoInline) {
			// Candidatas para la regla de casi-idénticas (K15'/J4'):
			// el resto + los 2 párrafos siguientes.
			var cand = [restoInline];
			for (var kc = i + 1; kc < paras.length && cand.length < 3; kc++) {
				var sc = paraText(paras[kc]).trim();
				if (!sc || /^\d{1,4}$/.test(sc)) continue;
				cand.push(sc);
			}
			// M3b: si el resto abre una corrida de solo título+URL
			// seguida de otra corrida numerada (filas falsas + lista
			// real), el encabezado NO valida por el resto: se
			// rechaza y el fallback encuentra la lista real.
			// N12: la evidencia se comprueba sobre el texto SIN el
			// prefijo numérico («1. Buscar…»): el chequeo de título
			// está anclado al inicio y el «1. » lo hacía fallar, así
			// que la rama se saltaba entera sin consultar
			// segundaCorrida.
			var restoTexto = numDeLinea(restoInline) ? numDeLinea(restoInline).texto : restoInline;
			// P1: la evidencia aquí es la variante SIN veto de verbos
			// (espejo de pdfExtract.js): con la vetada, un resto
			// «1. Ver el protocolo. …» daba false y la rama se
			// saltaba entera sin consultar segundaCorrida.
			if (tieneEvidenciaRefNumeradaSinVeto(restoTexto) && !lineasCasiIdenticas(cand)) {
				var vistaInline = [restoInline].concat(textos.slice(i + 1, i + 9));
				if (segundaCorrida(vistaInline, 0, true) !== -1) return false;
				return true;
			}
		}
		for (var j = i + 1; j < paras.length && j <= i + 10; j++) {
			var s = paraText(paras[j]).trim();
			if (!s || /^\d{1,4}$/.test(s)) continue;
			if (isRefHeadingExacto(s) || isRefHeadingParecido(s)) return false;
			var m = NUM_RE.exec(s);
			// R7 (espejo de numDeLinea en pdfExtract.js): un año PELADO
			// con URL en el resto («2020. Ver en https://…») no es el
			// número de la referencia.
			var anioPeladoConUrl = m && (m[3] || m[4]) && /^(?:19|20)\d{2}$/.test(m[3] || m[4]) && /https?:\/\/|www\./i.test(m[5]);
			var numerado = (m && !((m[1] || m[2]) && /^(?:19|20)\d{2}$/.test(m[1] || m[2])) && !anioPeladoConUrl) ||
				hasNumPr(paras[j]);
			if (numerado) {
				// M3b: si este párrafo abre una corrida de solo
				// título+URL seguida de otra corrida numerada (filas
				// falsas + lista real), el encabezado NO valida por
				// esta línea: se rechaza y el fallback encuentra la
				// lista real (espejo de pdfExtract.js). R3: la
				// variante SIN veto de verbos (el arreglo P1 solo
				// había llegado a la rama inline).
				if (segundaCorrida(textos, j, true) !== -1) return false;
				// La ref puede venir partida: el año/cola puede estar en
				// los 2 párrafos siguientes. Pero solo vale con
				// EVIDENCIA NUMERADA: la "pinta de autor" sola NO basta
				// — una fila de tabla ("Paciente B, 52 años") también
				// parece un autor y el encabezado falso validaba por
				// ella (G1); un título pelado con URL («Ver protocolo.
				// Disponible en https://…», J4') tampoco, y un lugar
				// justo tras la institución («Hospital Ameijeiras. La
				// Habana: Cuba.», J5') tampoco.
				// Candidatas para la regla de casi-idénticas (K15'/J4'):
				// el resto inline + este párrafo + los 2 siguientes.
				var candidatas = [];
				if (restoInline) candidatas.push(restoInline);
				candidatas.push(s);
				for (var k0 = j + 1; k0 < paras.length && k0 <= j + 2; k0++) {
					var s0 = paraText(paras[k0]).trim();
					if (s0) candidatas.push(s0);
				}
				var repetidas = lineasCasiIdenticas(candidatas);
				var bloque = m ? m[5] : s;
				if (tieneEvidenciaRefNumerada(bloque) && !repetidas) return true;
				for (var k = j + 1; k < paras.length && k <= j + 2; k++) {
					var s2 = paraText(paras[k]).trim();
					if (!s2) continue;
					bloque += " " + s2;
					if (tieneEvidenciaRefNumerada(bloque) && !repetidas) return true;
				}
				// M4 (espejo de pdfExtract.js): el bloque tiene
				// evidencia pero los candidatos son casi idénticos (3
				// webs reales al mismo título). NO rechazar de
				// inmediato: seguir buscando otra lista; si tras la
				// corrida viene otra corrida numerada (filas falsas +
				// lista real), se rechaza y el fallback encuentra la
				// real; si no, el escaneo valida por la cola de la
				// corrida. (Sin meta aquí: el camino de enlazado no
				// propaga flags de revisión.)
				if (tieneEvidenciaRefNumerada(bloque) && repetidas) {
					var finRun = j;
					var claveRun = claveCasiIdentica(m ? m[5] : s);
					while (finRun < paras.length) {
						var sR = paraText(paras[finRun]).trim();
						var mR = NUM_RE.exec(sR);
						if (!mR || claveCasiIdentica(sR) !== claveRun) break;
						finRun++;
					}
					if (haySegundaCorridaTras(textos, finRun)) return false;
					continue;
				}
				return false;
			}
			// Párrafo sin numerar (H3): solo vale si el bloque (este
			// párrafo + los 2 siguientes SIN numerar) trae evidencia
			// de cita.
			if (pareceInicioSinNumero(s) || TAIL_LIGERO_RE.test(s)) {
				var bloque2 = s;
				var lineasBloque2 = [s];
				var tomadas = 0;
				for (var k2 = j + 1; k2 < paras.length && tomadas < 2; k2++) {
					var s3 = paraText(paras[k2]).trim();
					if (!s3 || /^\d{1,4}$/.test(s3)) continue;
					var m3 = NUM_RE.exec(s3);
					var numerado3 = (m3 && !((m3[1] || m3[2]) && /^(?:19|20)\d{2}$/.test(m3[1] || m3[2]))) ||
						hasNumPr(paras[k2]);
					if (numerado3) break;
					bloque2 += " " + s3;
					lineasBloque2.push(s3);
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
				if (tieneEvidenciaRef(bloque2)) {
					if (!lineasCasiIdenticas(lineasBloque2)) return true;
					if (haySegundaCorridaTras(textos, j + lineasBloque2.length)) return false;
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
				var bloque3 = s;
				var lineasBloque3 = [s];
				var tomadas3 = 0;
				for (var k3 = j + 1; k3 < paras.length && tomadas3 < 2; k3++) {
					var s4 = paraText(paras[k3]).trim();
					if (!s4 || /^\d{1,4}$/.test(s4)) continue;
					var m4 = NUM_RE.exec(s4);
					var numerado4 = (m4 && !((m4[1] || m4[2]) && /^(?:19|20)\d{2}$/.test(m4[1] || m4[2]))) ||
						hasNumPr(paras[k3]);
					if (numerado4) break;
					bloque3 += " " + s4;
					lineasBloque3.push(s4);
					tomadas3++;
				}
				// Filas falsas casi idénticas (K15'/K3'): 3 párrafos
				// con el mismo texto antes de la URL no validan — se
				// sigue buscando.
				if (tieneEvidenciaRef(bloque3) && !lineasCasiIdenticas(lineasBloque3)) return true;
			}
		}
		return false;
	}

	function esNumerado(text) {
		// ¿Empieza el párrafo con número de referencia ("1.", "[1]",
		// "(1)", "1)")? "(2024)"/"[2024]" es un año, no un número.
		// Numeración romana ("i.", "ii.") también vale (L1).
		var m = NUM_RE.exec(text.trim());
		if (m) {
			if ((m[1] || m[2]) && /^(?:19|20)\d{2}$/.test(m[1] || m[2])) return false;
			// R7 (espejo de numDeLinea en pdfExtract.js): un año PELADO
			// con URL en el resto («2020. Ver en https://…») no es el
			// número de la referencia.
			if ((m[3] || m[4]) && /^(?:19|20)\d{2}$/.test(m[3] || m[4]) && /https?:\/\/|www\./i.test(m[5])) return false;
			return true;
		}
		return !!numeroRomano(text);
	}

	// Número de DOCUMENTO de un párrafo de bibliografía: el número
	// literal («1.», «[1]», «i.», «Nº 1.») si lo trae; si no (lista
	// sin numerar o numeración automática w:numPr), el índice
	// posicional. Las citas del cuerpo usan el número de documento;
	// createdMap usa el posicional de revisión; en la lista normal
	// coinciden, pero con un subtítulo que duplica el número («1.
	// Artículos» + «1. Smith», J6) o un reinicio de numeración, no.
	function numDocDeParrafo(p, pos) {
		var t = paraText(p).trim();
		var m = NUM_RE.exec(t);
		if (m) {
			if ((m[1] || m[2]) && /^(?:19|20)\d{2}$/.test(m[1] || m[2])) return pos;
			// R7 (espejo de numDeLinea): un año PELADO con URL en el
			// resto no es número de documento: se usa el posicional.
			if ((m[3] || m[4]) && /^(?:19|20)\d{2}$/.test(m[3] || m[4]) && /https?:\/\/|www\./i.test(m[5])) return pos;
			return parseInt(m[1] || m[2] || m[3] || m[4], 10);
		}
		var r = numeroRomano(t);
		if (r) return r.num;
		return pos;
	}

	function findNumberedRun(paras) {
		// Fallback sin encabezado: primera corrida de 3+ párrafos
		// numerados seguidos de los que AL MENOS UNA referencia tenga
		// cola Vancouver. Antes se exigía la cola en la PRIMERA: si la
		// lista empezaba por un libro o una web sin cola, el fallback
		// fallaba aunque la 2ª y 3ª sí la tuvieran (espejo de
		// buscarCorridaNumerada en pdfExtract.js y de _findNumberedRun
		// en refimport.js). Devuelve el índice del primer párrafo, o -1.
		// Q5: con numeración automática el número se sintetiza (ver
		// textosConNumPr) — aquí se calcula UNA vez y lo usan tanto
		// la colección (R6) como la guarda P4 de abajo.
		var textos = textosConNumPr(paras);
		// S5 (espejo de _findNumberedRun en refimport.js): número
		// efectivo de un párrafo numPr en una lista mixta (literal +
		// numPr) sin encabezado. La síntesis reinicia la secuencia
		// en el párrafo literal y la colección del fallback fallaba.
		// Se continúa desde el literal SOLO si es una referencia
		// real (tiene evidencia: cola, URL o lugar:editorial); un
		// literal sin evidencia es una fila falsa y manda la
		// síntesis, con la que la lista real arranca en 1. Solo se
		// usa en el numOf LOCAL del fallback.
		function numEfectivoNumPr(idx) {
			var k = idx;
			while (k >= 0 && hasNumPr(paras[k])) k--;
			if (k < 0) return null;
			var tk = paraText(paras[k]).trim();
			var mk = NUM_RE.exec(tk);
			if (!mk) return null;
			var nk = parseInt(mk[1] || mk[2] || mk[3] || mk[4], 10);
			if (!tieneEvidenciaCorrida(mk[5])) return null;
			return nk + (idx - k);
		}
		function numOf(p, idx) {
			var t = paraText(p).trim();
			if (!esNumerado(t)) {
				if (hasNumPr(p)) {
					// R6 (ronda 12): el número sintetizado (Q5) también
					// vale para la colección: antes el párrafo numPr
					// devolvía num: null y la colección lo aceptaba
					// como «cualquier número» (espejo de refimport.js).
					// S5: primero el número efectivo; si es null, la
					// síntesis de siempre.
					if (idx !== undefined) {
						var nEf = numEfectivoNumPr(idx);
						if (nEf !== null) return { num: nEf, text: t };
					}
					var ms = idx !== undefined ? numDeLinea(textos[idx]) : null;
					return { num: ms ? ms.num : null, text: t };
				}
				return null;
			}
			var m = NUM_RE.exec(t);
			if (m) {
				var n = m[1] || m[2] || m[3] || m[4];
				return { num: parseInt(n, 10), text: m[5] };
			}
			// Numeración romana (L1).
			return numeroRomano(t);
		}
		// Corrida idéntica con evidencia recordada (M4/M5, espejo de
		// buscarCorridaNumerada): si no aparece ninguna otra lista,
		// esta corrida ES la lista; si aparece otra DISJUNTA, es la
		// real; si SOLAPA, es la misma lista corrida un puesto (M17)
		// y manda la recordada.
		var candidatoIdentico = null;
		for (var i = 0; i < paras.length; i++) {
			var c0 = numOf(paras[i], i);
			if (!c0) continue;
			var bloques = [c0.text];
			var esperado = c0.num !== null ? c0.num + 1 : null;
			var encontrados = 1;
			var j = i + 1, recorridas = 0;
			while (j < paras.length && recorridas < 30) {
				var c = numOf(paras[j], j);
				if (c) {
					if (c.num === null || esperado === null || c.num === esperado) {
						encontrados++;
						bloques.push(c.text);
						if (c.num !== null) esperado = c.num + 1;
						if (encontrados === 3) break;
					}
					else if (encontrados === 1) {
						// Párrafo numerado que no es el siguiente: es otra
						// referencia (o una sección numerada). Reintentar desde
						// ese párrafo; sin esto, su texto se pegaba a bloques[0]
						// y su cola Vancouver hacía pasar el filtro.
						if (c.num !== null && esperado !== null) {
							i = j - 1;
							break;
						}
						bloques[0] += " " + paraText(paras[j]).trim();
					}
				}
				else {
					var t = paraText(paras[j]).trim();
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
			// que se conserve con flag y el ensamblaje conserve la
			// corrida con flag (Q2, ronda 11). Sin preámbulo antes,
			// NO se salta: una primera corrida real (N3 sin
			// encabezado) es indistinguible por estructura de la
			// corrida falsa. Ver DECISIONES.md §R10.4 y §R11.2.
			// Q5: con numeración automática el número se sintetiza
			// (ver textosConNumPr) — `textos` ya se calculó arriba.
			var idxSegunda = segundaCorrida(textos, i, true);
			if (idxSegunda !== -1) {
				var k = i - 1;
				while (k >= 0) {
					var sAnt = textos[k];
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
				if (!candidatoIdentico && bloques.some(function (b) { return tieneEvidenciaCorrida(b); })) {
					candidatoIdentico = { idx: i, fin: j + 1 };
				}
				continue;
			}
			// H1: una web sin año vale por su URL (o por su
			// lugar:editorial si es un libro); el año solo NO vale.
			if (!bloques.some(function (b) { return tieneEvidenciaCorrida(b); })) continue;
			if (candidatoIdentico && i < candidatoIdentico.fin) return candidatoIdentico.idx;
			return i;
		}
		return candidatoIdentico ? candidatoIdentico.idx : -1;
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
		// Encabezado con la 1ª ref pegada («Referencias: 1. Smith...»):
		// el resto del párrafo es el primer párrafo de bibliografía
		// (G2). Se divide el párrafo: el encabezado queda solo y el
		// resto pasa a un párrafo nuevo (bibParas[0]). Si no se puede
		// dividir, el campo BIBL cubre el párrafo entero — el texto
		// de la ref 1 queda dentro del campo y no se duplica, aunque
		// el rótulo se pierda al refrescar.
		var restoInline = conEncabezado ? textoTrasEncabezado(paraText(paras[idxRef])) : "";
		var bibExtra = [];
		if (restoInline) {
			var nuevo = dividirParrafoEncabezado(doc, paras[idxRef], restoInline);
			bibExtra.push(nuevo || paras[idxRef]);
		}
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
		var bibParas = bibExtra.slice();
		// P4 (espejo de _readDocx): si el resto inline es una web sin
		// numerar, es el preámbulo (en _readDocx se descarta y marca).
		var vistoPreambulo = bibExtra.length > 0 && !esNumerado(paraText(bibExtra[0]).trim());
		// Q5: con numeración automática el número se sintetiza (ver
		// textosConNumPr).
		var textos = textosConNumPr(cands.map(function (c) { return c.p; }));
		var primerNumeradoVisto = false;
		for (var k = 0; k < cands.length; k++) {
			// En lista numerada, un párrafo sin número es continuación
			// de la ref anterior y NO abre párrafo de bibliografía
			// propio; en lista sin numerar, cada párrafo es una ref.
			if (anyNumbered && !cands[k].numbered) {
				if (!primerNumeradoVisto) vistoPreambulo = true;
				continue;
			}
			// P4: corrida numerada de solo título+URL seguida de otra
			// corrida tras un encabezado de sección son filas falsas
			// tras preámbulo (C3): se salta la corrida entera. Sin
			// preámbulo antes, la corrida ES la lista (N3).
			// Q2 (ronda 11): CONSERVAR la primera corrida en
			// bibParas, no saltarla — si no, bibParas quedaría
			// desalineado con refTexts (que la conserva con flag) y
			// las citas (1)..(3) se omitirían por ambigüedad J6.
			// Ver DECISIONES.md §R11.2.
			if (anyNumbered && vistoPreambulo) {
				var idxSegunda = segundaCorrida(textos, k, true);
				if (idxSegunda !== -1) {
					for (var kc = k; kc < idxSegunda; kc++) {
						if (cands[kc].numbered) {
							bibParas.push(cands[kc].p);
							primerNumeradoVisto = true;
						}
					}
					k = idxSegunda - 1;
					continue;
				}
			}
			if (cands[k].numbered) primerNumeradoVisto = true;
			bibParas.push(cands[k].p);
		}
		if (!bibParas.length) {
			throw new Error("No se encontraron párrafos de bibliografía numerados");
		}
		// J6: mapa número de documento -> índices posicionales de
		// revisión (1-based, mismo orden que refTexts). Un número con
		// dos posiciones es ambiguo: las citas a él se omiten en vez
		// de enlazarse al ítem equivocado.
		var docNumAIndices = {};
		bibParas.forEach(function (bp, bi) {
			var nd = numDocDeParrafo(bp, bi + 1);
			(docNumAIndices[nd] = docNumAIndices[nd] || []).push(bi + 1);
		});

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
				// J6: las citas del cuerpo usan el número de DOCUMENTO;
				// createdMap usa el posicional de revisión. Se traduce
				// por docNumAIndices: si un número aparece dos veces en
				// la bibliografía (subtítulo que duplica el número,
				// reinicio de numeración), es ambiguo y la cita se omite
				// con motivo claro en vez de enlazarse al ítem
				// equivocado en silencio.
				var traducidos = [];
				var ambiguo = null;
				var invalido = false;
				for (var ni = 0; ni < nums.length; ni++) {
					var cands = docNumAIndices[nums[ni]];
					if (cands && cands.length > 1) { ambiguo = nums[ni]; break; }
					var pos = cands && cands.length === 1 ? cands[0] : null;
					if (pos === null || !createdMap[String(pos)]) { invalido = true; break; }
					traducidos.push(pos);
				}
				if (ambiguo !== null) {
					skipped.push({
						parrafo: pi + 1,
						texto: mt.vis,
						motivo: "número duplicado en la bibliografía, ambiguo (el " + ambiguo + " aparece dos veces)",
					});
					continue;
				}
				if (invalido || traducidos.length !== nums.length) {
					skipped.push({
						parrafo: pi + 1,
						texto: mt.vis,
						motivo: "número fuera de rango o referencia excluida en la revisión",
					});
					continue;
				}
				var ok = insertarCampoCita(doc, p, mt.s, mt.e, traducidos, mt.vis, citItems, usados);
				if (!ok) {
					skipped.push({
						parrafo: pi + 1,
						texto: mt.vis,
						motivo: "la cita está partida entre varios runs; no se enlazó",
					});
					continue;
				}
				traducidos.forEach(function (n) { citados.add(n); });
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
