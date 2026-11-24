// BelegApp scanner.js
// Separate, lightweight browser scanner. Uses @quannqit/doc-scanner 0.2.3.
// No OpenCV, no camera processing while taking the photo.
let scannerModulePromise;

async function loadDocumentScanner() {
  if (!scannerModulePromise) {
    scannerModulePromise = import("https://esm.sh/@quannqit/doc-scanner@0.2.3");
  }
  return scannerModulePromise;
}

export async function scanReceiptImage(file) {
  if (!file || !file.type || !file.type.startsWith("image/")) {
    throw new Error("Bitte zuerst ein Foto auswählen.");
  }

  const { scanImage, canvasToBlob } = await loadDocumentScanner();
  const result = await scanImage(file, { mode: "color" });

  if (!result || !result.canvas) {
    throw new Error("Der Scanner konnte kein Ergebnis erzeugen.");
  }

  const blob = await canvasToBlob(result.canvas);
  if (!blob) throw new Error("Das zugeschnittene Bild konnte nicht erstellt werden.");

  return {
    blob,
    detected: Boolean(result.detected),
    width: result.canvas.width,
    height: result.canvas.height
  };
}
