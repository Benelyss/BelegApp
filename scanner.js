/* BelegApp – unabhängiges Scan-Modul
 * Läuft erst nach Auswahl/Aufnahme eines Fotos. Bei Fehler bleibt das Original erhalten.
 * Abhängigkeit: OpenCV.js wird bei Bedarf von jsdelivr geladen.
 */
(function (global) {
  'use strict';

  let cvPromise = null;
  const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';

  function loadOpenCV() {
    if (global.cv && global.cv.Mat) return Promise.resolve(global.cv);
    if (cvPromise) return cvPromise;

    cvPromise = new Promise((resolve, reject) => {
      let script = document.querySelector('script[data-belegapp-opencv]');
      if (!script) {
        script = document.createElement('script');
        script.src = OPENCV_URL;
        script.async = true;
        script.dataset.belegappOpencv = '1';
        document.head.appendChild(script);
      }
      const started = Date.now();
      const poll = () => {
        if (global.cv && global.cv.Mat && global.cv.imread) return resolve(global.cv);
        if (Date.now() - started > 30000) return reject(new Error('OpenCV konnte nicht geladen werden. Bitte Internetverbindung prüfen.'));
        setTimeout(poll, 100);
      };
      script.addEventListener('error', () => reject(new Error('OpenCV-Skript konnte nicht geladen werden.')), { once: true });
      poll();
    }).catch(err => {
      cvPromise = null;
      throw err;
    });
    return cvPromise;
  }

  function imageFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Foto konnte nicht geöffnet werden.')); };
      img.src = url;
    });
  }

  function orderCorners(points) {
    const center = points.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
    const sorted = points.slice().sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
    let start = 0;
    for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
    const rotated = sorted.slice(start).concat(sorted.slice(0, start));
    // Ensure order: top-left, top-right, bottom-right, bottom-left
    const cross = (rotated[1].x - rotated[0].x) * (rotated[2].y - rotated[1].y) - (rotated[1].y - rotated[0].y) * (rotated[2].x - rotated[1].x);
    if (cross < 0) return [rotated[0], rotated[3], rotated[2], rotated[1]];
    return rotated;
  }

  function findDocument(cv, src) {
    const gray = new cv.Mat();
    const blurred = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    let best = null;
    let bestArea = 0;
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
      cv.Canny(blurred, edges, 50, 150);
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
      cv.dilate(edges, edges, kernel);
      kernel.delete();
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const imageArea = src.cols * src.rows;
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const perimeter = cv.arcLength(contour, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const area = Math.abs(cv.contourArea(approx));
          if (area > imageArea * 0.12 && area > bestArea) {
            const pts = [];
            for (let j = 0; j < 4; j++) pts.push({ x: approx.intAt(j, 0), y: approx.intAt(j, 1) });
            best = orderCorners(pts);
            bestArea = area;
          }
        }
        approx.delete();
        contour.delete();
      }
    } finally {
      gray.delete(); blurred.delete(); edges.delete(); contours.delete(); hierarchy.delete();
    }
    return best;
  }

  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  async function scan(file, options = {}) {
    if (!(file instanceof Blob)) throw new TypeError('Bitte eine Bilddatei übergeben.');
    const maxSide = options.maxSide || 1800;
    const quality = options.quality || 0.88;
    const original = file;
    let src, dst, transform;
    try {
      const cv = await loadOpenCV();
      const img = await imageFromBlob(file);
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      src = cv.imread(canvas);
      const corners = findDocument(cv, src);
      if (!corners) return { blob: original, detected: false, message: 'Keine sicheren vier Ecken gefunden. Originalfoto bleibt erhalten.' };

      const [tl, tr, br, bl] = corners;
      const width = Math.max(distance(tl, tr), distance(bl, br));
      const height = Math.max(distance(tl, bl), distance(tr, br));
      if (width < 100 || height < 100) return { blob: original, detected: false, message: 'Beleg zu klein erkannt. Originalfoto bleibt erhalten.' };

      const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
      const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]);
      transform = cv.getPerspectiveTransform(srcPts, dstPts);
      dst = new cv.Mat();
      cv.warpPerspective(src, dst, transform, new cv.Size(Math.round(width), Math.round(height)), cv.INTER_CUBIC, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
      srcPts.delete(); dstPts.delete();
      const outCanvas = document.createElement('canvas');
      cv.imshow(outCanvas, dst);
      const result = await new Promise(resolve => outCanvas.toBlob(resolve, 'image/jpeg', quality));
      if (!result) return { blob: original, detected: false, message: 'Zuschneiden fehlgeschlagen. Originalfoto bleibt erhalten.' };
      return { blob: result, detected: true, width: outCanvas.width, height: outCanvas.height, message: 'Beleg erkannt und zugeschnitten.' };
    } catch (error) {
      return { blob: original, detected: false, error, message: error.message || 'Scan fehlgeschlagen. Originalfoto bleibt erhalten.' };
    } finally {
      if (src) src.delete();
      if (dst) dst.delete();
      if (transform) transform.delete();
    }
  }

  global.BelegScanner = { scan, load: loadOpenCV };
})(window);
