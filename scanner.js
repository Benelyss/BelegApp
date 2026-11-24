/* BelegApp Scanner – mobile-schonende Version
   Verarbeitung erst nach Fotoaufnahme. Original bleibt bei jedem Fehler erhalten. */
(function (global) {
  'use strict';
  let cvPromise = null;
  const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';

  function loadOpenCV() {
    if (global.cv && global.cv.Mat && global.cv.imread) return Promise.resolve(global.cv);
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
      let finished = false;
      const finish = (fn, value) => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        fn(value);
      };
      const started = Date.now();
      const timer = setInterval(() => {
        if (global.cv && global.cv.Mat && global.cv.imread) finish(resolve, global.cv);
        else if (Date.now() - started > 20000) finish(reject, new Error('Scanner konnte nicht geladen werden. Bitte Internetverbindung prüfen und erneut versuchen.'));
      }, 100);
      script.addEventListener('error', () => finish(reject, new Error('Scanner-Bibliothek konnte nicht geladen werden.')), { once: true });
    }).catch(err => { cvPromise = null; throw err; });
    return cvPromise;
  }

  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Foto konnte nicht geöffnet werden.')); };
      img.src = url;
    });
  }
  const dist = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);

  function sortCorners(points) {
    const c = points.reduce((s,p)=>({x:s.x+p.x/4,y:s.y+p.y/4}),{x:0,y:0});
    const a=points.slice().sort((p,q)=>Math.atan2(p.y-c.y,p.x-c.x)-Math.atan2(q.y-c.y,q.x-c.x));
    let k=0; for(let i=1;i<4;i++) if(a[i].x+a[i].y<a[k].x+a[k].y) k=i;
    let r=a.slice(k).concat(a.slice(0,k));
    const cross=(r[1].x-r[0].x)*(r[2].y-r[1].y)-(r[1].y-r[0].y)*(r[2].x-r[1].x);
    if(cross<0) r=[r[0],r[3],r[2],r[1]];
    return r;
  }

  function findDocument(cv, src) {
    let gray, blur, edges, contours, hierarchy, kernel, best=null, bestArea=0;
    try {
      gray=new cv.Mat(); blur=new cv.Mat(); edges=new cv.Mat();
      contours=new cv.MatVector(); hierarchy=new cv.Mat();
      cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray,blur,new cv.Size(5,5),0);
      cv.Canny(blur,edges,60,160);
      kernel=cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(5,5));
      cv.morphologyEx(edges,edges,cv.MORPH_CLOSE,kernel);
      // Nur äussere Konturen: deutlich weniger Rechenaufwand auf dem iPhone.
      cv.findContours(edges,contours,hierarchy,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);
      const areaLimit=src.cols*src.rows*0.10;
      for(let i=0;i<contours.size();i++){
        let contour=null, approx=null;
        try {
          contour=contours.get(i);
          const area=Math.abs(cv.contourArea(contour));
          if(area<areaLimit || area<=bestArea) continue;
          const perimeter=cv.arcLength(contour,true);
          approx=new cv.Mat();
          cv.approxPolyDP(contour,approx,0.025*perimeter,true);
          if(approx.rows===4 && cv.isContourConvex(approx)){
            const pts=[];
            for(let j=0;j<4;j++) pts.push({x:approx.intAt(j,0),y:approx.intAt(j,1)});
            best=sortCorners(pts); bestArea=area;
          }
        } finally {
          if(approx) approx.delete();
          if(contour) contour.delete();
        }
      }
      return best;
    } finally {
      if(kernel) kernel.delete();
      if(gray) gray.delete(); if(blur) blur.delete(); if(edges) edges.delete();
      if(contours) contours.delete(); if(hierarchy) hierarchy.delete();
    }
  }

  async function scan(file, options={}) {
    if(!(file instanceof Blob)) throw new TypeError('Bitte ein Foto auswählen.');
    const original=file;
    let src=null,dst=null,transform=null,srcPts=null,dstPts=null;
    try {
      const cv=await loadOpenCV();
      const img=await loadImage(file);
      // Bewusst klein halten: reduziert Speicher und Rechenzeit auf iPhones erheblich.
      const maxSide=Math.min(options.maxSide||1000,1200);
      const scale=Math.min(1,maxSide/Math.max(img.naturalWidth,img.naturalHeight));
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));
      canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
      const ctx=canvas.getContext('2d');
      if(!ctx) throw new Error('Bildverarbeitung ist auf diesem Gerät nicht verfügbar.');
      ctx.drawImage(img,0,0,canvas.width,canvas.height);
      src=cv.imread(canvas);
      const corners=findDocument(cv,src);
      if(!corners) return {blob:original,detected:false,message:'Keine eindeutigen Belegecken erkannt. Das Originalfoto bleibt erhalten.'};
      const [tl,tr,br,bl]=corners;
      const w=Math.round(Math.max(dist(tl,tr),dist(bl,br)));
      const h=Math.round(Math.max(dist(tl,bl),dist(tr,br)));
      if(w<120||h<120) return {blob:original,detected:false,message:'Erkanntes Dokument ist zu klein. Originalfoto bleibt erhalten.'};
      srcPts=cv.matFromArray(4,1,cv.CV_32FC2,[tl.x,tl.y,tr.x,tr.y,br.x,br.y,bl.x,bl.y]);
      dstPts=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,w-1,0,w-1,h-1,0,h-1]);
      transform=cv.getPerspectiveTransform(srcPts,dstPts);
      dst=new cv.Mat();
      cv.warpPerspective(src,dst,transform,new cv.Size(w,h),cv.INTER_LINEAR,cv.BORDER_CONSTANT,new cv.Scalar(255,255,255,255));
      const out=document.createElement('canvas');
      cv.imshow(out,dst);
      const blob=await new Promise(resolve=>out.toBlob(resolve,'image/jpeg',options.quality||0.88));
      if(!blob) return {blob:original,detected:false,message:'Zuschneiden fehlgeschlagen. Originalfoto bleibt erhalten.'};
      return {blob,detected:true,message:'Beleg erkannt und zugeschnitten.'};
    } catch(error) {
      return {blob:original,detected:false,error,message:error.message||'Scan fehlgeschlagen. Originalfoto bleibt erhalten.'};
    } finally {
      if(src) src.delete(); if(dst) dst.delete(); if(transform) transform.delete();
      if(srcPts) srcPts.delete(); if(dstPts) dstPts.delete();
    }
  }
  global.BelegScanner={scan,load:loadOpenCV};
})(window);
