const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PROJECTS = path.join(ROOT, 'storage', 'projects');
const PORT = process.env.PORT || 8787;
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.openai.com/v1';
const AI_MODEL = process.env.AI_MODEL || 'gpt-5-mini';
fs.mkdirSync(PROJECTS, { recursive: true });

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(body);
}
function readBody(req) { return new Promise((resolve,reject)=>{ let b=''; req.on('data',c=>{b+=c; if(b.length>2e6) req.destroy();}); req.on('end',()=>resolve(b)); req.on('error',reject); }); }
function safeUrl(raw) { try { const u = new URL(raw); if (!['http:','https:'].includes(u.protocol)) throw new Error('Only HTTP(S) URLs are allowed.'); return u.toString(); } catch { throw new Error('Please enter a valid product URL.'); } }
function escapeHtml(s='') { return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function stripHtml(s='') { return s.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }
function absUrl(src, base) { try { return new URL(src, base).toString(); } catch { return null; } }
function firstMatch(re, s) { const m=s.match(re); return m ? (m[1]||'').trim() : null; }
function allMatches(re,s) { const a=[]; let m; while((m=re.exec(s))) a.push(m[1]||m[2]||''); return a; }
function meta(html, key, attr='property') { const re = new RegExp(`<meta[^>]+${attr}=["']${key.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}["'][^>]*content=["']([^"']*)["'][^>]*>|<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${key.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}["'][^>]*>`, 'i'); return firstMatch(re,html); }
function parseJsonLd(html) {
  const blocks = allMatches(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,html);
  const out=[];
  for(const raw of blocks){ try { const x=JSON.parse(raw.trim()); if(Array.isArray(x)) out.push(...x); else out.push(x); } catch{} }
  return out;
}
function productFromJsonLd(items) {
  let p = items.find(x => x && (x['@type']==='Product' || (Array.isArray(x['@type'])&&x['@type'].includes('Product'))));
  if(!p) { const graph=items.flatMap(x=>Array.isArray(x?.['@graph'])?x['@graph']:[]); p=graph.find(x=>x?.['@type']==='Product'); }
  if(!p) return {};
  const offer=Array.isArray(p.offers)?p.offers[0]:p.offers||{};
  const agg=p.aggregateRating||{};
  const brand=typeof p.brand==='string'?p.brand:p.brand?.name;
  const imgs=Array.isArray(p.image)?p.image:(p.image?[p.image]:[]);
  return { name:p.name, brand, description:p.description, category:p.category, price:offer.price, currency:offer.priceCurrency, originalPrice:offer.highPrice, rating:agg.ratingValue, reviewCount:agg.reviewCount||agg.ratingCount, images:imgs, sku:p.sku, mpn:p.mpn, availability:offer.availability };
}
function detectPrice(text) { const m=text.match(/(?:₹|Rs\.?|INR\s*)[\s]*([0-9][0-9,]*(?:\.\d{1,2})?)/i); return m?m[1].replace(/,/g,''):null; }
function detectRating(text) { const m=text.match(/(?:rating|rated)[^\d]{0,20}([0-5](?:\.\d)?)[^\d]{0,20}(?:\/\s*5|out of 5)?/i); return m?m[1]:null; }
function detectReviewCount(text) { const m=text.match(/([0-9][0-9,]*)\s+(?:ratings|reviews)/i); return m?m[1].replace(/,/g,''):null; }
async function fetchUrl(url) {
  const ctrl = new AbortController(); const t=setTimeout(()=>ctrl.abort(),15000);
  try { const r=await fetch(url,{redirect:'follow',signal:ctrl.signal,headers:{'User-Agent':'Mozilla/5.0 (compatible; AffiliateContentBot/1.0; +https://localhost)'}}); const ct=r.headers.get('content-type')||''; const text=await r.text(); return {status:r.status,contentType:ct,url:r.url,body:text}; }
  finally { clearTimeout(t); }
}
async function analyzeProduct(rawUrl) {
  const url=safeUrl(rawUrl); const r=await fetchUrl(url);
  if(r.status<200||r.status>=400) throw new Error('Unable to retrieve verified product information from this page.');
  if(r.contentType.includes('application/json') || /^[\s\n]*[{[]/.test(r.body)) {
    let d; try{d=JSON.parse(r.body)}catch{d=null}
    if(d && !Array.isArray(d)) {
      const images=(d.images||d.image||[]); const p={
        product_url:url, product_name:d.title||d.name||'Not available', brand:d.brand||'Not available', category:d.category||'Not available',
        description:d.description||'Not available', price:d.price??'Not available', original_price:d.originalPrice??'Not available', discount:d.discountPercentage?`${d.discountPercentage}%`:'Not available',
        rating:d.rating??'Not available', review_count:d.reviews?.length??'Not available', colors:d.colors||'Not available', sizes:d.sizes||'Not available', variants:d.variants||'Not available',
        specifications:d.specifications||'Not available', features:d.features||[], warranty:d.warrantyInformation||'Not available', return_policy:d.returnPolicy||'Not available', delivery:d.shippingInformation||'Not available', cod:'Not available', seller:d.seller||'Not available', stock:d.stock??'Not available',
        images:Array.isArray(images)?images:[], thumbnail:d.thumbnail||images?.[0]||null, source:r.url
      }; return finalizeProduct(p);
    }
  }
  const html=r.body, ld=productFromJsonLd(parseJsonLd(html));
  const title=ld.name||meta(html,'og:title')||firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i,html)||'Not available';
  const desc=ld.description||meta(html,'og:description')||meta(html,'description','name')||'Not available';
  const text=stripHtml(html);
  let images=[]; for(const x of [meta(html,'og:image'),meta(html,'twitter:image'),...ld.images||[],...allMatches(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/gi,html)]) { if(!x) continue; const a=absUrl(x,url); if(a && !images.includes(a)) images.push(a); }
  const p={product_url:url,product_name:title,brand:ld.brand||'Not available',category:ld.category||'Not available',description:desc,price:ld.price||detectPrice(text)||'Not available',original_price:ld.originalPrice||'Not available',discount:'Not available',rating:ld.rating||detectRating(text)||'Not available',review_count:ld.reviewCount||detectReviewCount(text)||'Not available',colors:'Not available',sizes:'Not available',variants:'Not available',specifications:'Not available',features:'Not available',warranty:'Not available',return_policy:'Not available',delivery:'Not available',cod:'Not available',seller:'Not available',stock:ld.availability||'Not available',images,thumbnail:images[0]||null,source:r.url};
  // Derive discount only when both numeric prices are verifiable.
  const a=Number(String(p.original_price).replace(/[^0-9.]/g,'')), b=Number(String(p.price).replace(/[^0-9.]/g,''));
  if(a>0&&b>0&&a>b) p.discount=`${Math.round((a-b)/a*100)}%`;
  return finalizeProduct(p);
}
function finalizeProduct(p) { const fields=['product_name','brand','category','description','price','original_price','discount','rating','review_count','colors','sizes','variants','specifications','features','warranty','return_policy','delivery','cod','seller','stock']; for(const f of fields) if(p[f]===undefined||p[f]===null||p[f]==='') p[f]='Not available'; p.verification={}; for(const f of fields) p.verification[f]=p[f]==='Not available'?'NOT AVAILABLE':'VERIFIED'; p.images=[...new Set((p.images||[]).filter(Boolean))].slice(0,30); p.thumbnail=p.thumbnail||p.images[0]||null; return p; }

function disclosure(){ return 'Affiliate link: I may earn a commission if you purchase through this link, at no extra cost to you.'; }
function cleanList(v){ if(Array.isArray(v)) return v; if(typeof v==='string'&&v!=='Not available') return v.split(/[,•|]/).map(s=>s.trim()).filter(Boolean); return []; }
function makeCopy(p, affiliate, mode='Professional', language='English') {
  const name=p.product_name, price=p.price, disc=p.discount; const feats=cleanList(p.features); const featureText=feats.length?feats.slice(0,4).join(' • '): (p.description!=='Not available'?String(p.description).slice(0,180):'Verified product details available on the product page.');
  const priceLine=price!=='Not available'?`Price: ${price}${p.currency?' '+p.currency:''}`:'Price: Not available';
  const discLine=disc!=='Not available'?` | ${disc} off`:'';
  const hook = mode==='Budget Deal'&&price!=='Not available'?`Worth a look at ${price}.` : mode==='Problem → Solution' ? `Looking for a practical option? Meet ${name}.` : mode==='Luxury' ? `${name} — a polished choice worth discovering.` : mode==='Viral' ? `This one caught my eye 👀 ${name}` : `${name} — a smart find worth checking out.`;
  const cta='Check the product details and current offer here:';
  const langNote=language==='English'?'':`\nLanguage requested: ${language}. If an AI provider is configured, regenerate this copy in natural ${language}.`;
  const base={headline:name,hook,body:`${hook}\n\n${featureText}\n\n${priceLine}${discLine}\n\n${cta}\n${affiliate}\n\n${disclosure()}${langNote}`,cta:`Shop / view product → ${affiliate}`,disclosure:disclosure()};
  const hashtags=['#AffiliateFinds','#ProductFinds','#Deals','#Shopping'].join(' ');
  return {professional:base,instagram:{hook,caption:`${hook}\n\n${featureText}\n\n${priceLine}${discLine}\n\n${cta}\n${affiliate}\n\n${disclosure()}`,hashtags,first_comment:`Product link: ${affiliate}\n\n${disclosure()}`,link_instruction:'Use a permitted link placement for the specific Instagram surface; do not assume a caption URL is clickable.'},facebook:{short:`${hook} ${priceLine}${discLine}\n${affiliate}\n\n${disclosure()}`,long:base.body,hashtags,link:affiliate},youtube:{shorts_title:`${name} | Quick Product Find`,description:`${base.body}\n\n${hashtags}`,tags:`${name}, product review, deals, shopping`,link_instruction:'Place the affiliate URL in a permitted description/profile area and disclose the relationship.'},pinterest:{title:name,description:`${hook} ${featureText}\n\n${priceLine}${discLine}\n\n${disclosure()}`,keywords:`${name}, shopping, deals, product finds`,destination_url:affiliate},whatsapp:{status:`${name}\n${priceLine}${discLine}\n${featureText}\n${affiliate}\n${disclosure()}`,message:`🔥 ${hook}\n\n${priceLine}${discLine}\n${featureText}\n\n${affiliate}\n\n${disclosure()}`},telegram:{title:name,description:featureText,price:`${priceLine}${discLine}`,cta:`View product: ${affiliate}`,disclosure:disclosure()}};
}
async function aiRewrite(payload){
  if(!AI_API_KEY) return {available:false,reason:'AI_API_KEY is not configured. The app is using its verified-data template engine.'};
  const prompt=`Create affiliate marketing copy using ONLY the verified product facts below. Never invent missing values. Tone: ${payload.mode}. Language: ${payload.language}. Return JSON with keys headline,hook,caption,cta,hashtags,instagram,facebook,youtube,pinterest,whatsapp,telegram.\nVERIFIED DATA:\n${JSON.stringify(payload.product)}\nAffiliate URL: ${payload.affiliate}`;
  const r=await fetch(`${AI_BASE_URL.replace(/\/$/,'')}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${AI_API_KEY}`},body:JSON.stringify({model:AI_MODEL,messages:[{role:'system',content:'You are a factual affiliate content writer. Do not invent product claims.'},{role:'user',content:prompt}],temperature:.5,response_format:{type:'json_object'}})});
  if(!r.ok) return {available:false,reason:`AI provider error (${r.status}). Template generation remains available.`};
  const d=await r.json(); let content=d.choices?.[0]?.message?.content||'{}'; try{return {available:true,data:JSON.parse(content)}}catch{return {available:false,reason:'AI returned invalid JSON. Template generation remains available.'}}
}
function posterSvg(p,affiliate,format='portrait'){
  const dims={portrait:[1080,1350],square:[1080,1080],pinterest:[1000,1500],facebook:[1200,1500],youtube:[1080,1080]}[format]||[1080,1350]; const [w,h]=dims; const img=p.thumbnail||p.images?.[0]||''; const price=p.price!=='Not available'?String(p.price):''; const disc=p.discount!=='Not available'?String(p.discount):'';
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#f7f7f7"/><rect x="0" y="0" width="100%" height="180" fill="#111827"/><text x="70" y="90" fill="white" font-size="42" font-family="Arial" font-weight="700">${escapeHtml(p.brand!=='Not available'?p.brand:'PRODUCT FIND')}</text><text x="70" y="140" fill="#d1d5db" font-size="25" font-family="Arial">Verified product information</text>${img?`<image href="${escapeHtml(img)}" x="80" y="220" width="${w-160}" height="${Math.round(h*.45)}" preserveAspectRatio="xMidYMid meet"/>`:''}<text x="70" y="${Math.round(h*.72)}" fill="#111827" font-size="48" font-family="Arial" font-weight="700">${escapeHtml(String(p.product_name).slice(0,42))}</text>${price?`<text x="70" y="${Math.round(h*.79)}" fill="#111827" font-size="54" font-family="Arial" font-weight="700">${escapeHtml(price)}</text>`:''}${disc?`<text x="70" y="${Math.round(h*.84)}" fill="#b91c1c" font-size="38" font-family="Arial" font-weight="700">${escapeHtml(disc)} OFF</text>`:''}<text x="70" y="${h-105}" fill="#374151" font-size="25" font-family="Arial">View current offer • Affiliate link in publishing package</text><text x="70" y="${h-60}" fill="#6b7280" font-size="20" font-family="Arial">${escapeHtml(affiliate).slice(0,80)}</text></svg>`;
}
function projectFile(id){ return path.join(PROJECTS,`${id}.json`); }
function saveProject(project){ const id=project.id||crypto.randomUUID(); project.id=id; project.created_at=project.created_at||new Date().toISOString(); fs.writeFileSync(projectFile(id),JSON.stringify(project,null,2)); return project; }
function listProjects(){ return fs.readdirSync(PROJECTS).filter(x=>x.endsWith('.json')).map(x=>JSON.parse(fs.readFileSync(path.join(PROJECTS,x),'utf8'))).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).map(p=>({id:p.id,product_name:p.product?.product_name||'Untitled',product_url:p.product?.product_url,affiliate_url:p.affiliate_url,created_at:p.created_at,thumbnail:p.product?.thumbnail||p.product?.images?.[0]||null})); }
function serveStatic(req,res){ let p=new URL(req.url,'http://localhost').pathname; if(p==='/' ) p='/index.html'; const fp=path.normalize(path.join(PUBLIC,p)); if(!fp.startsWith(PUBLIC)) return json(res,403,{error:'Forbidden'}); fs.readFile(fp,(e,b)=>{if(e)return json(res,404,{error:'Not found'}); const ext=path.extname(fp); const ct={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'}[ext]||'application/octet-stream'; res.writeHead(200,{'Content-Type':ct,'Cache-Control':'no-cache'});res.end(b);}); }
async function handler(req,res){
  try {
    const u=new URL(req.url,'http://localhost');
    if(req.method==='POST' && u.pathname==='/api/analyze'){ const b=JSON.parse(await readBody(req)); if(!b.product_url) return json(res,400,{error:'Please enter a valid product URL.'}); const p=await analyzeProduct(b.product_url); return json(res,200,{product:p}); }
    if(req.method==='POST' && u.pathname==='/api/generate'){ const b=JSON.parse(await readBody(req)); if(!b.product||!b.affiliate_url)return json(res,400,{error:'Product data and affiliate/profit link are required.'}); const copy=makeCopy(b.product,b.affiliate_url,b.mode||'Professional',b.language||'English'); const ai=await aiRewrite(b); const project=saveProject({product:b.product,affiliate_url:b.affiliate_url,mode:b.mode||'Professional',language:b.language||'English',copy:ai.available?{...copy,ai:ai.data}:copy,ai_status:ai,posters:{portrait:posterSvg(b.product,b.affiliate_url,'portrait'),square:posterSvg(b.product,b.affiliate_url,'square'),pinterest:posterSvg(b.product,b.affiliate_url,'pinterest'),facebook:posterSvg(b.product,b.affiliate_url,'facebook'),youtube:posterSvg(b.product,b.affiliate_url,'youtube')}}); return json(res,200,{project}); }
    if(req.method==='GET' && u.pathname==='/api/history') return json(res,200,{projects:listProjects()});
    if(req.method==='GET' && u.pathname.startsWith('/api/project/')){ const id=u.pathname.split('/').pop(); const f=projectFile(id); if(!fs.existsSync(f))return json(res,404,{error:'Project not found'}); return json(res,200,{project:JSON.parse(fs.readFileSync(f,'utf8'))}); }
    if(req.method==='DELETE' && u.pathname.startsWith('/api/project/')){ const id=u.pathname.split('/').pop(); const f=projectFile(id); if(fs.existsSync(f))fs.unlinkSync(f); return json(res,200,{ok:true}); }
    if(req.method==='POST' && u.pathname==='/api/manual'){ const b=JSON.parse(await readBody(req)); const p=finalizeProduct({...b.product,product_url:b.product.product_url||'Manual input',images:b.product.images||[]}); return json(res,200,{product:p}); }
    if(req.method==='GET' && u.pathname.startsWith('/api/poster/')){ const parts=u.pathname.split('/'); const id=parts[3]; const format=parts[4]||'portrait'; const f=projectFile(id); if(!fs.existsSync(f))return json(res,404,{error:'Project not found'}); const p=JSON.parse(fs.readFileSync(f,'utf8')); const svg=p.posters?.[format]||posterSvg(p.product,p.affiliate_url,format); res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8','Content-Disposition':`attachment; filename="affiliate-${format}.svg"`}); return res.end(svg); }
    if(req.method==='POST' && u.pathname==='/api/video'){ const b=JSON.parse(await readBody(req)); const p=b.product; const out=path.join(PROJECTS,`video-${Date.now()}.mp4`); const img=(p.images||[]).filter(Boolean).slice(0,5); if(!img.length) return json(res,400,{error:'No product images available. Upload or provide product images first.'}); const tmp=path.join(PROJECTS,`frames-${Date.now()}`); fs.mkdirSync(tmp); try{ for(let i=0;i<img.length;i++){ const rr=await fetch(img[i],{headers:{'User-Agent':'Mozilla/5.0'}}); if(!rr.ok) continue; const buf=Buffer.from(await rr.arrayBuffer()); fs.writeFileSync(path.join(tmp,`${String(i).padStart(3,'0')}.img`),buf); } const files=fs.readdirSync(tmp).filter(x=>x.endsWith('.img')); if(!files.length) throw new Error('Product images could not be retrieved. Please upload product images manually.'); // normalize images via ffmpeg
      const norm=path.join(tmp,'norm'); fs.mkdirSync(norm); for(let i=0;i<files.length;i++){ const ext='.jpg'; await new Promise((resolve,reject)=>execFile('ffmpeg',['-y','-i',path.join(tmp,files[i]),'-vf','scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=white',path.join(norm,`${String(i).padStart(3,'0')}${ext}`)],(e)=>e?reject(e):resolve())); }
      await new Promise((resolve,reject)=>execFile('ffmpeg',['-y','-framerate','1/4','-i',path.join(norm,'%03d.jpg'),'-c:v','libx264','-pix_fmt','yuv420p','-r','30','-t',String(Math.min(30,Math.max(15,files.length*4))),out],(e)=>e?reject(e):resolve()));
      fs.rmSync(tmp,{recursive:true,force:true}); b.project_id && fs.existsSync(projectFile(b.project_id)) && (()=>{const pr=JSON.parse(fs.readFileSync(projectFile(b.project_id),'utf8'));pr.video_file=path.basename(out);saveProject(pr)})(); return json(res,200,{video:`/api/download-video/${path.basename(out)}`,message:'Image-to-video fallback generated from the verified product images.'}); }catch(e){fs.rmSync(tmp,{recursive:true,force:true}); return json(res,500,{error:'Video generation failed. Poster/slideshow fallback remains available.',detail:e.message}); }
    }
    if(req.method==='GET' && u.pathname.startsWith('/api/download-video/')){ const f=path.join(PROJECTS,path.basename(u.pathname)); if(!fs.existsSync(f))return json(res,404,{error:'Video not found'}); res.writeHead(200,{'Content-Type':'video/mp4','Content-Disposition':'attachment; filename="affiliate-reel.mp4"'}); return fs.createReadStream(f).pipe(res); }
    if(req.method==='GET' && u.pathname.startsWith('/api/package/')){ const id=u.pathname.split('/').pop(); const f=projectFile(id); if(!fs.existsSync(f))return json(res,404,{error:'Project not found'}); const p=JSON.parse(fs.readFileSync(f,'utf8')); const dir=path.join(PROJECTS,'pkg-'+id); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'product.json'),JSON.stringify(p.product,null,2)); fs.writeFileSync(path.join(dir,'affiliate-link.txt'),p.affiliate_url+'\n\n'+disclosure()); fs.writeFileSync(path.join(dir,'platform-copy.txt'),JSON.stringify(p.copy,null,2)); for(const [k,v] of Object.entries(p.posters||{})) fs.writeFileSync(path.join(dir,`poster-${k}.svg`),v); fs.mkdirSync(path.join(dir,'product-images'),{recursive:true}); for(let i=0;i<(p.product?.images||[]).slice(0,15).length;i++){ try{ const rr=await fetch(p.product.images[i],{headers:{'User-Agent':'Mozilla/5.0'}}); if(rr.ok) fs.writeFileSync(path.join(dir,'product-images',`product-${String(i+1).padStart(2,'0')}.bin`),Buffer.from(await rr.arrayBuffer())); }catch{} } if(p.video_file && fs.existsSync(path.join(PROJECTS,p.video_file))) fs.copyFileSync(path.join(PROJECTS,p.video_file),path.join(dir,'affiliate-reel.mp4')); const zip=path.join(PROJECTS,`affiliate-package-${id}.zip`); await new Promise((resolve,reject)=>execFile('zip',['-qr',zip,'.'],{cwd:dir},e=>e?reject(e):resolve())); res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="affiliate-content-package.zip"'}); return fs.createReadStream(zip).pipe(res); }
    return serveStatic(req,res);
  } catch(e){ console.error(e); return json(res,500,{error:e.message||'Server error'}); }
}
http.createServer(handler).listen(PORT,()=>console.log(`AI Affiliate Creator running at http://localhost:${PORT}`));
