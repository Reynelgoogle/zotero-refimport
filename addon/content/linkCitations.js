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
	// (n), (n,m), (n, m, k) y rangos (n-m) — igual que CITA_PAT en Python.
	var CITA_RE = /\((\d+(?:\s*,\s*\d+)*|\d+\s*-\s*\d+)\)/g;
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

	function expandir(numsTxt) {
		/* '(2,4)' -> [2,4]; '(1-3)' -> [1,2,3]. Igual que en Python. */
		numsTxt = numsTxt.trim();
		if (numsTxt.indexOf("-") !== -1) {
			var parts = numsTxt.split("-", 2);
			var out = [];
			for (var n = parseInt(parts[0], 10); n <= parseInt(parts[1], 10); n++) {
				out.push(n);
			}
			return out;
		}
		return numsTxt.split(/\s*,\s*/).map(function (x) { return parseInt(x, 10); });
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
		var avisar = typeof onProgress === "function" ? onProgress : function () {};
		// Igual que en _readDocx: IOUtils.read devuelve un Uint8Array
		// de otro realm y JSZip lo rechaza sin la copia.
		avisar("Leyendo documento…");
		var bytes = new Uint8Array(await IOUtils.read(docxPath));
		var zip = await JSZip.loadAsync(bytes);
		var entry = zip.file("word/document.xml");
		if (!entry) throw new Error("El DOCX no contiene word/document.xml");
		avisar("Buscando citas y bibliografía…");
		var xml = await entry.async("string");
		var doc = new DOMParser().parseFromString(xml, "application/xml");
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
		for (var pi = 0; pi < idxRef; pi++) {
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
		avisar("Generando el documento enlazado…");
		var out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
		var outPath = docxPath.replace(/\.docx$/i, "") + "-zotero.docx";
		avisar("Guardando…");
		await IOUtils.write(outPath, out);
		return {
			outputPath: outPath,
			fields: nCampos,
			instances: nInstancias,
			cited: citados.size,
			bibItems: itemsBib.length,
			skipped: skipped,
		};
	}

	return { linkCitations: linkCitations, _expandir: expandir };
})();
