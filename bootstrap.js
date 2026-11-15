/* bootstrap.js — ciclo de vida del plugin "Importar Referencias Vancouver"
 * (Zotero 7, stack clásico sin build, basado en el ejemplo oficial
 * zotero/make-it-red).
 *
 * startup(): espera las 3 promesas (initialization, unlock, uiReady),
 * carga las librerías (JSZip + parsers verificados) y refimport.js,
 * y añade el menú a todas las ventanas principales abiertas.
 * La UI vive en onMainWindowLoad/Unload: cada ventana que se abre
 * recibe su elemento de menú, y al cerrarse se quita.
 */

var RefImport;
var _chromeHandle = null;

function install() {
	// Nada que hacer al instalar.
}

async function startup({ id, version, rootURI }) {
	await Zotero.initializationPromise;
	await Zotero.unlockPromise;
	await Zotero.uiReadyPromise;

	// Registrar el paquete chrome://refimport/ (v0.1.5). El diálogo se
	// abre como chrome://refimport/content/reviewDialog.xhtml: una URL
	// jar:file:///...xpi!/ como documento de una ventana nueva queda en
	// blanco en Firefox 140 (base de Zotero 10). Patrón de Zutilo:
	// registerChrome con la raíz del
	// propio XPI. chrome.manifest va dentro del .xpi como respaldo.
	try {
		let { classes: Cc, interfaces: Ci } = Components;
		let aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"]
			.getService(Ci.amIAddonManagerStartup);
		let manifestURI = Services.io.newURI(rootURI + "manifest.json");
		_chromeHandle = aomStartup.registerChrome(manifestURI, [
			["content", "refimport", "content/"],
		]);
	}
	catch (e) {
		Zotero.logError(e);
	}

	// Shim setImmediate (v0.1.3): JSZip (utils.delay) llama a
	// setImmediate pelado en sus rutas asíncronas (loadAsync y
	// generateAsync), pero en el ámbito chrome del bootstrap NO existe
	// y el polyfill que trae el bundle lo define en otro objeto
	// (su wrapper resuelve el global como global -> self -> window
	// -> {} y no cae en el global compartido). Sin esto, importar un
	// DOCX revienta con "setImmediate is not defined". setTimeout sí
	// existe aquí, así que el shim es un alias con los mismos args.
	if (typeof setImmediate === "undefined") {
		globalThis.setImmediate = function (fn) {
			var args = Array.prototype.slice.call(arguments, 1);
			return setTimeout(function () { fn.apply(null, args); }, 0);
		};
	}
	if (typeof clearImmediate === "undefined") {
		globalThis.clearImmediate = function (id) { clearTimeout(id); };
	}

	// Librerías propias (cargadas en el ámbito global del bootstrap).
	Services.scriptloader.loadSubScript(rootURI + "content/lib/jszip.min.js");
	Services.scriptloader.loadSubScript(rootURI + "content/lib/vancouver.js");
	Services.scriptloader.loadSubScript(rootURI + "content/lib/pdfExtract.js");
	Services.scriptloader.loadSubScript(rootURI + "content/lib/ris.js");
	Services.scriptloader.loadSubScript(rootURI + "refimport.js");

	RefImport.init({ id, version, rootURI });
	RefImport.addToAllWindows();
}

function onMainWindowLoad({ window }) {
	RefImport.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	RefImport.removeFromWindow(window);
}

function shutdown() {
	// Cerrar diálogos de revisión que queden abiertos.
	try {
		let enumerator = Services.wm.getEnumerator("refimport:review");
		while (enumerator.hasMoreElements()) {
			enumerator.getNext().close();
		}
	}
	catch (e) {
		// Si no hay ventanas, no pasa nada.
	}
	RefImport.removeFromAllWindows();
	// Quitar el registro de chrome://refimport/ (si se registró).
	try {
		if (_chromeHandle) {
			_chromeHandle.destruct();
			_chromeHandle = null;
		}
	}
	catch (e) {
		// Si ya no existe, no pasa nada.
	}
	RefImport = undefined;
}

function uninstall() {
	// Nada que limpiar: no se crean archivos ni preferencias propias
	// fuera de la rama extensions.refimport.* (que Zotero gestiona).
}
