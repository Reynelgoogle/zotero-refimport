/* reviewDialog.js — pantalla de revisión del plugin.
 *
 * Recibe en window.arguments[0]: { refs, sourcePath, isDocx, showFlags }.
 * Cada ref es lo que devuelve parseReferencia (vancouver.js) más
 * numero/included/raw. Nada se crea en Zotero hasta pulsar
 * "Crear ítems en Zotero".
 *
 * Botones:
 *   - Crear ítems en Zotero: crea una colección nueva por cada tanda
 *     (nombre = documento + fecha/hora local), después new Zotero.Item +
 *     setField + setCreators + setCollections + saveTx por cada
 *     referencia incluida. Guarda el mapa número -> { uri, itemData,
 *     key } en args.createdMap (lo necesita el enlazado) y en
 *     this.createdMap. Al terminar selecciona la colección en la
 *     ventana principal.
 *   - Exportar RIS: aRis (ris.js) de las incluidas, junto al documento
 *     original con sufijo "-refs.ris".
 *   - Enlazar citas en el Word: solo si el origen fue DOCX y los ítems
 *     ya se crearon; llama a RefImportLink.linkCitations.
 *
 * La URI del ítem sale de Zotero.URI.getItemURI (si existe) y el
 * itemData CSL de Zotero.Cite.getItemData (si existe); si alguna de las
 * dos no está, hay fallback manual documentado abajo. Son los dos
 * puntos de API con más dependencia de la versión de Zotero.
 */

var RefImportDialog = {
	args: null,
	createdMap: null,
	Zotero: null,
	_inited: false,

	init() {
		// El onload del <window> y el listener de "load" pueden
		// dispararse los dos: init solo se ejecuta una vez.
		if (this._inited) return;
		this._inited = true;
		try {
			this.args = (window.arguments && window.arguments[0]) || null;
			if (!this.args || !this.args.refs) {
				document.getElementById("refimport-summary").textContent =
					"No llegaron las referencias al diálogo (window.arguments vacío). " +
					"Cierra esta ventana y vuelve a intentarlo desde Herramientas → Importar referencias…";
				return;
			}
			// El diálogo no tiene global Zotero propio: llega por los
			// argumentos (patrón zotQDA) o por include.js; sin él, la
			// revisión se muestra igual pero no se puede crear nada.
			this.Zotero = this.args.Zotero ||
				(typeof Zotero !== "undefined" ? Zotero : null);
			if (!this.Zotero) {
				document.getElementById("refimport-status").textContent =
					"Aviso: no se encontró el objeto Zotero en este diálogo; " +
					"la revisión se muestra, pero crear ítems puede fallar.";
			}
			this._renderRows();
			let refs = this.args.refs;
			let nFlags = refs.reduce((a, r) => a + (r.flags && r.flags.length ? 1 : 0), 0);
			let src = this.args.sourcePath.split(/[\\/]/).pop();
			document.getElementById("refimport-summary").textContent =
				refs.length + " referencias extraídas de " + src +
				(nFlags ? " — " + nFlags + " con avisos (revisar la columna Avisos)." :
					" — sin avisos.") +
				" Desmarca las que no quieras importar.";
			document.getElementById("btn-create")
				.addEventListener("click", () => this.createItems());
			document.getElementById("btn-ris")
				.addEventListener("click", () => this.exportRIS());
			let btnLink = document.getElementById("btn-link");
			btnLink.addEventListener("click", () => this.linkCitations());
			if (!this.args.isDocx) {
				btnLink.disabled = true;
				btnLink.title = "El enlazado de citas solo funciona con documentos Word (.docx); del PDF solo se importan los ítems.";
			}
			document.getElementById("btn-close")
				.addEventListener("click", () => window.close());
		}
		catch (e) {
			let el = document.getElementById("refimport-status");
			if (el) el.textContent = "Error al abrir la revisión: " +
				(e && e.message ? e.message : e);
		}
	},

	_renderRows() {
		let body = document.getElementById("refimport-body");
		body.textContent = "";
		this.args.refs.forEach((ref) => {
			let tr = document.createElement("tr");
			if (!ref.included) tr.className = "excluida";
			let tdCheck = document.createElement("td");
			let check = document.createElement("input");
			check.type = "checkbox";
			check.checked = !!ref.included;
			check.addEventListener("change", () => {
				ref.included = check.checked;
				tr.className = check.checked ? "" : "excluida";
			});
			tdCheck.appendChild(check);
			tr.appendChild(tdCheck);
			let cells = [
				String(ref.numero),
				ref.authors.map((a) => a.family + (a.given ? " " + a.given : "")).join(", ") || "—",
				ref.title || "—",
				ref.journal || ref.book || "—",
				(ref.year || "—") + (ref.month ? " " + ref.month : ""),
				ref.pagesEnd ? ref.pages + "-" + ref.pagesEnd : (ref.pages || "—"),
				ref.doi || "—",
			];
			cells.forEach((text) => {
				let td = document.createElement("td");
				td.textContent = text;
				tr.appendChild(td);
			});
			let tdFlags = document.createElement("td");
			tdFlags.className = "flags";
			tdFlags.textContent = this.args.showFlags && ref.flags && ref.flags.length
				? ref.flags.join("; ")
				: "";
			tr.appendChild(tdFlags);
			body.appendChild(tr);
		});
	},

	_status(msg) {
		document.getElementById("refimport-status").textContent = msg;
	},

	_includedRefs() {
		return this.args.refs.filter((r) => r.included);
	},

	_collectionName() {
		/* Nombre visible para saber dónde buscar: documento + fecha y
		 * hora local. Ej.: "Referencias de caso renal (2026-11-14 22:20)". */
		let base = String(this.args.sourcePath || "referencias")
			.split(/[\\/]/).pop()
			.replace(/\.[^.]+$/, "")
			.trim() || "referencias";
		let d = new Date();
		let pad = (n) => String(n).padStart(2, "0");
		let stamp = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" +
			pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
		return "Referencias de " + base + " (" + stamp + ")";
	},

	async _createCollection(name) {
		/* Una colección nueva por cada pulsación de "Crear ítems". Si ya
		 * existe una con el mismo nombre (dos tandas en el mismo minuto),
		 * se añade " (2)", " (3)"... */
		let Z = this.Zotero;
		let libraryID = 1;
		try {
			libraryID = (Z.Libraries && Z.Libraries.userLibraryID) || 1;
		}
		catch (e) {
			libraryID = 1;
		}
		let finalName = name;
		try {
			let existing = new Set();
			if (Z.Collections && typeof Z.Collections.getByLibrary === "function") {
				let cols = await Z.Collections.getByLibrary(libraryID);
				for (let c of cols) existing.add(c.name);
			}
			let i = 2;
			while (existing.has(finalName)) {
				finalName = name + " (" + i + ")";
				i++;
			}
		}
		catch (e) {
			// Si no se pueden listar, se intenta crear con el nombre base.
		}
		let col;
		try {
			// Zotero 7/10 admiten los parámetros en el constructor.
			col = new Z.Collection({ libraryID: libraryID, name: finalName });
		}
		catch (e) {
			col = new Z.Collection();
		}
		// Se fijan igualmente: así funciona también si el constructor
		// de esa versión no aceptara parámetros.
		col.libraryID = libraryID;
		col.name = finalName;
		await col.saveTx();
		return col;
	},

	_selectCollection(collectionID) {
		/* Deja seleccionada la colección recién creada en la ventana
		 * principal, para que el usuario vea los ítems al cerrar el
		 * diálogo. Si la API cambia, no se rompe la importación. */
		try {
			let Z = this.Zotero;
			let win = Z.getMainWindow ? Z.getMainWindow() : null;
			let pane = win && win.ZoteroPane;
			let view = pane && pane.collectionsView;
			if (!view) return;
			if (typeof view.selectCollection === "function") {
				view.selectCollection(collectionID);
			}
			else if (typeof view.selectByID === "function") {
				view.selectByID("C" + collectionID);
			}
		}
		catch (e) {
			if (this.Zotero && this.Zotero.debug) {
				this.Zotero.debug("RefImport: no se pudo seleccionar la colección (" + e + ")");
			}
		}
	},

	_safeSet(item, field, value) {
		/* setField puede fallar si el campo no vale para ese tipo de
		 * ítem (p. ej. "edition" en un artículo). No se rompe la
		 * importación por un campo: se anota en el registro. */
		try {
			item.setField(field, value);
		}
		catch (e) {
			if (this.Zotero && this.Zotero.debug) this.Zotero.debug("RefImport: no se pudo fijar " + field + " (" + e + ")");
		}
	},

	async createItems() {
		let btn = document.getElementById("btn-create");
		btn.disabled = true;
		try {
			let refs = this._includedRefs();
			if (!refs.length) {
				this._status("No hay referencias marcadas para importar.");
				btn.disabled = false;
				return;
			}
			this._status("Creando " + refs.length + " ítems…");
			// v0.1.7: cada tanda va a una colección nueva. Así el usuario
			// sabe exactamente dónde buscar y no quedan ítems perdidos
			// en Mi biblioteca.
			let collection = null;
			let collectionName = "";
			let collectionError = "";
			try {
				collection = await this._createCollection(this._collectionName());
				collectionName = collection.name;
				this._status("Creando " + refs.length + " ítems en la colección «" +
					collectionName + "»…");
			}
			catch (e) {
				if (this.Zotero && this.Zotero.logError) this.Zotero.logError(e);
				collectionError = e && e.message ? e.message : String(e);
				collection = null;
			}
			let created = {};
			let n = 0;
			for (let ref of refs) {
				let item = await this._createOne(ref, collection ? collection.id : null);
				created[String(ref.numero)] = {
					uri: this._itemURI(item),
					itemData: this._itemData(item, ref),
					key: item.key,
				};
				n++;
			}
			this.createdMap = created;
			this.args.createdMap = created;
			let donde = collection
				? " en la colección «" + collectionName + "»"
				: " en Zotero (sin colección" +
					(collectionError ? ": " + collectionError : "") + ")";
			this._status("Creados " + n + " ítems" + donde + "." +
				(this.args.isDocx
					? " Ya puedes pulsar «Enlazar citas en el Word»."
					: ""));
			if (collection) this._selectCollection(collection.id);
		}
		catch (e) {
			if (this.Zotero && this.Zotero.logError) this.Zotero.logError(e);
			this._status("Error al crear los ítems: " + (e && e.message ? e.message : e));
			btn.disabled = false;
		}
	},

	async _createOne(ref, collectionID) {
		let type = ref.type === "chapter" ? "bookSection"
			: ref.type === "webpage" ? "webpage"
			: ref.type === "unknown" ? (ref.journal ? "journalArticle" : "document")
			: "journalArticle";
		let item = new this.Zotero.Item(type);
		if (ref.title) this._safeSet(item, "title", ref.title);
		if (type === "journalArticle") {
			if (ref.journal) this._safeSet(item, "publicationTitle", ref.journal);
		}
		else if (type === "bookSection") {
			if (ref.book) this._safeSet(item, "bookTitle", ref.book);
			if (ref.place) this._safeSet(item, "place", ref.place);
			if (ref.publisher) this._safeSet(item, "publisher", ref.publisher);
			if (ref.edition) this._safeSet(item, "edition", ref.edition);
		}
		else if (type === "webpage") {
			if (ref.place) this._safeSet(item, "place", ref.place);
			if (ref.publisher) this._safeSet(item, "publisher", ref.publisher);
		}
		// v0.1.7: el enlace de "Disponible en:" también vale para un
		// artículo de revista; se guarda en cualquier tipo.
		if (ref.url) this._safeSet(item, "url", ref.url);
		if (ref.accessed) this._safeSet(item, "accessDate", ref.accessed);
		if (ref.year) {
			this._safeSet(item, "date", ref.month ? ref.year + " " + ref.month : ref.year);
		}
		if (ref.volume) this._safeSet(item, "volume", ref.volume);
		if (ref.issue) this._safeSet(item, "issue", ref.issue);
		if (ref.pages) {
			this._safeSet(item, "pages",
				ref.pagesEnd ? ref.pages + "-" + ref.pagesEnd : ref.pages);
		}
		if (ref.doi) this._safeSet(item, "DOI", ref.doi);
		if (ref.flags && ref.flags.length) {
			this._safeSet(item, "extra", "RefImport: " + ref.flags.join("; "));
		}
		let creators = [];
		for (let a of ref.authors || []) {
			if (a.given) {
				creators.push({ firstName: a.given, lastName: a.family, creatorType: "author" });
			}
			else {
				// Autor corporativo (sin iniciales): un solo campo.
				creators.push({ lastName: a.family, fieldMode: 1, creatorType: "author" });
			}
		}
		for (let e of ref.editors || []) {
			if (e.given) {
				creators.push({ firstName: e.given, lastName: e.family, creatorType: "editor" });
			}
			else {
				creators.push({ lastName: e.family, fieldMode: 1, creatorType: "editor" });
			}
		}
		if (creators.length) item.setCreators(creators);
		if (collectionID) {
			// setCollections antes de saveTx: un solo guardado por ítem.
			if (typeof item.setCollections === "function") {
				item.setCollections([collectionID]);
			}
			else if (typeof item.addToCollection === "function") {
				item.addToCollection(collectionID);
			}
		}
		await item.saveTx();
		return item;
	},

	_itemURI(item) {
		/* La URI canónica del ítem (http://zotero.org/users/.../items/<key>)
		 * es lo que va en los campos de cita de Word. */
		try {
			if (this.Zotero.URI && this.Zotero.URI.getItemURI) {
				return this.Zotero.URI.getItemURI(item);
			}
		}
		catch (e) { /* fallback */ }
		return "http://zotero.org/users/local/items/" + item.key;
	},

	_itemData(item, ref) {
		/* itemData es el CSL JSON del ítem, lo que Zotero guarda dentro
		 * de cada campo de cita. Primero se intenta la vía oficial
		 * (Zotero.Cite.getItemData); si no existe en esta versión, se
		 * construye a mano desde los campos parseados. */
		try {
			if (this.Zotero.Cite && this.Zotero.Cite.getItemData) {
				let d = this.Zotero.Cite.getItemData(item);
				if (d) return d;
			}
		}
		catch (e) { /* fallback */ }
		return this._buildCSL(ref, this._itemURI(item));
	},

	_buildCSL(ref, uri) {
		let csl = {
			id: uri,
			type: ref.type === "chapter" ? "chapter"
				: ref.type === "webpage" ? "webpage" : "article-journal",
			title: ref.title || "",
		};
		if (ref.authors && ref.authors.length) {
			csl.author = ref.authors.map((a) => ({ family: a.family, given: a.given || "" }));
		}
		if (ref.editors && ref.editors.length) {
			csl.editor = ref.editors.map((a) => ({ family: a.family, given: a.given || "" }));
		}
		if (ref.journal) csl["container-title"] = ref.journal;
		if (ref.book) csl["container-title"] = ref.book;
		if (ref.year) csl.issued = { "date-parts": [[parseInt(ref.year, 10)]] };
		if (ref.volume) csl.volume = ref.volume;
		if (ref.issue) csl.issue = ref.issue;
		if (ref.pages) csl.page = ref.pagesEnd ? ref.pages + "-" + ref.pagesEnd : ref.pages;
		if (ref.doi) csl.DOI = ref.doi;
		if (ref.url) csl.URL = ref.url;
		if (ref.publisher) csl.publisher = ref.publisher;
		if (ref.place) csl["publisher-place"] = ref.place;
		if (ref.edition) csl.edition = ref.edition;
		return csl;
	},

	async exportRIS() {
		try {
			let refs = this._includedRefs();
			if (!refs.length) {
				this._status("No hay referencias marcadas para exportar.");
				return;
			}
			let lines = [];
			for (let ref of refs) lines.push(...aRis(ref));
			let text = lines.join("\n") + "\n";
			let outPath = this.args.sourcePath.replace(/\.[^.]+$/, "") + "-refs.ris";
			await this.Zotero.File.putContentsAsync(outPath, text);
			this._status("RIS guardado: " + outPath + " (" + refs.length + " referencias).");
		}
		catch (e) {
			if (this.Zotero && this.Zotero.logError) this.Zotero.logError(e);
			this._status("Error al exportar el RIS: " + (e && e.message ? e.message : e));
		}
	},

	_diagnosticoTexto(detalle) {
		/* Todo lo que hace falta para saber por qué falló el enlazado,
		 * sin pedirle al usuario que abra la consola. */
		let Z = this.Zotero;
		let l = [];
		l.push("RefImport — error al enlazar citas en el Word");
		l.push("Fecha: " + new Date().toString());
		try { l.push("Zotero: " + Z.version + " / " + Z.platform); } catch (e) { /* nada */ }
		l.push("Documento: " + (this.args ? this.args.sourcePath : "?"));
		l.push("Referencias parseadas: " +
			(this.args && this.args.refs ? this.args.refs.length : "?"));
		l.push("Ítems creados: " +
			(this.createdMap ? Object.keys(this.createdMap).length : 0));
		try {
			l.push("Entorno: " + (RefImportLink && RefImportLink.diagnostico
				? RefImportLink.diagnostico()
				: "RefImportLink no cargó"));
		}
		catch (e) {
			l.push("Entorno: no se pudo consultar (" + e + ")");
		}
		l.push("");
		l.push(detalle);
		return l.join("\n");
	},

	async _guardarDiagnostico(texto) {
		/* Se guarda en la carpeta temporal de Zotero (solo si hay error). */
		let Z = this.Zotero;
		let path = "";
		try {
			if (Z.getTempDirectory) {
				let directory = Z.getTempDirectory().path;
				let separator = directory.indexOf("\\") === -1 ? "/" : "\\";
				path = directory.replace(/[\\/]+$/, "") +
					separator + "refimport-enlazar-error.txt";
			}
		}
		catch (e) {
			path = "";
		}
		if (!path) return "";
		try {
			await Z.File.putContentsAsync(path, texto);
			return path;
		}
		catch (e) {
			return "";
		}
	},

	async linkCitations() {
		if (!this.createdMap) {
			this._status("Primero pulsa «Crear ítems en Zotero»: el enlazado necesita las claves de los ítems creados.");
			return;
		}
		if (typeof RefImportLink === "undefined") {
			this._status("Error al enlazar las citas: no se cargó linkCitations.js. " +
				"Cierra el diálogo, reinicia Zotero y vuelve a intentarlo.");
			return;
		}
		let btn = document.getElementById("btn-link");
		btn.disabled = true;
		try {
			this._status("Enlazando citas en el Word…");
			let res = await RefImportLink.linkCitations(
				this.args.sourcePath,
				this.createdMap,
				this.args.refs.length,
				(message) => this._status(message)
			);
			let msg = "Listo: " + res.fields + " campos de cita (" + res.instances +
				" instancias, " + res.cited + " referencias distintas) y bibliografía con " +
				res.bibItems + " entradas.\nGuardado: " + res.outputPath +
				"\nEl documento original quedó intacto.";
			if (res.skipped && res.skipped.length) {
				msg += "\nOmitidas " + res.skipped.length + " citas: " +
					res.skipped.map((s) => s.texto + " (párr. " + s.parrafo + ": " + s.motivo + ")").join("; ");
			}
			this._status(msg);
		}
		catch (e) {
			if (this.Zotero && this.Zotero.logError) this.Zotero.logError(e);
			let detalle = e && e.stack ? e.stack : String(e);
			let msg = "Error al enlazar las citas: " +
				(e && e.message ? e.message : e);
			let ruta = await this._guardarDiagnostico(this._diagnosticoTexto(detalle));
			msg += ruta
				? "\nDetalles guardados en: " + ruta
				: "\n" + detalle;
			this._status(msg);
			btn.disabled = false;
		}
	},
};

window.addEventListener("error", (ev) => {
	// Autodiagnóstico: si algo revienta al cargar el diálogo, el
	// error se ve en la propia pantalla en vez de una ventana vacía.
	let el = document.getElementById("refimport-status");
	if (el) {
		el.textContent = "Error en el diálogo: " +
			(ev && ev.message ? ev.message : ev);
	}
});

window.addEventListener("load", () => RefImportDialog.init());
