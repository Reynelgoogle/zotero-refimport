/* reviewDialog.js — pantalla de revisión del plugin.
 *
 * Recibe en window.arguments[0]: { refs, sourcePath, isDocx, showFlags }.
 * Cada ref es lo que devuelve parseReferencia (vancouver.js) más
 * numero/included/raw. Nada se crea en Zotero hasta pulsar
 * "Crear ítems en Zotero".
 *
 * Botones:
 *   - Crear ítems en Zotero: new Zotero.Item + setField + setCreators +
 *     saveTx por cada referencia incluida. Guarda el mapa
 *     número -> { uri, itemData, key } en args.createdMap (lo necesita
 *     el enlazado) y en this.createdMap.
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
			let created = {};
			let n = 0;
			for (let ref of refs) {
				let item = await this._createOne(ref);
				created[String(ref.numero)] = {
					uri: this._itemURI(item),
					itemData: this._itemData(item, ref),
					key: item.key,
				};
				n++;
			}
			this.createdMap = created;
			this.args.createdMap = created;
			this._status("Creados " + n + " ítems en Zotero." +
				(this.args.isDocx
					? " Ya puedes pulsar «Enlazar citas en el Word»."
					: ""));
		}
		catch (e) {
			if (this.Zotero && this.Zotero.logError) this.Zotero.logError(e);
			this._status("Error al crear los ítems: " + (e && e.message ? e.message : e));
			btn.disabled = false;
		}
	},

	async _createOne(ref) {
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
			if (ref.url) this._safeSet(item, "url", ref.url);
			if (ref.accessed) this._safeSet(item, "accessDate", ref.accessed);
			if (ref.place) this._safeSet(item, "place", ref.place);
			if (ref.publisher) this._safeSet(item, "publisher", ref.publisher);
		}
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

	async linkCitations() {
		if (!this.createdMap) {
			this._status("Primero pulsa «Crear ítems en Zotero»: el enlazado necesita las claves de los ítems creados.");
			return;
		}
		let btn = document.getElementById("btn-link");
		btn.disabled = true;
		try {
			this._status("Enlazando citas en el Word…");
			let res = await RefImportLink.linkCitations(
				this.args.sourcePath,
				this.createdMap,
				this.args.refs.length
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
			this._status("Error al enlazar las citas: " + (e && e.message ? e.message : e));
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
