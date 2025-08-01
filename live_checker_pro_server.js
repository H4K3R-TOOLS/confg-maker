
// Live Checker PRO server with Playwright fallback and stronger validator options
const express = require('express');
const axios = require('axios').default;
const { wrapper } = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const cheerio = require('cheerio');

let playwright;
try { playwright = require('playwright'); } catch(e) { playwright = null; }

const app = express();
app.use(express.json({limit:'2mb'}));

app.get('/ping', (req,res)=> res.send('ok'));

function jarFromInputs(url, cookieStr, cookieJson){
  const jar = new tough.CookieJar();
  const origin = new URL(url).origin;
  if(cookieStr){
    for(const part of cookieStr.split(';')){
      const p = part.trim(); if(!p) continue;
      const i = p.indexOf('='); if(i<1) continue;
      const k = p.slice(0,i).trim(), v = p.slice(i+1).trim();
      const ck = new tough.Cookie({key:k,value:v,domain:new URL(url).hostname,path:'/',secure:url.startsWith('https')});
      jar.setCookieSync(ck, origin);
    }
  }
  if(cookieJson){
    try{
      const arr = JSON.parse(cookieJson);
      for(const c of arr){
        if(!c.name) continue;
        const ck = new tough.Cookie({
          key: c.name, value: String(c.value ?? ''),
          domain: (c.domain || new URL(url).hostname).replace(/^\./,''),
          path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly,
          expires: c.expires ? new Date(c.expires*1000) : 'Infinity',
          sameSite: c.sameSite || 'Lax'
        });
        const cookieUrl = `${url.startsWith('https://')?'https':'http'}://${ck.domain}${ck.path}`;
        jar.setCookieSync(ck, cookieUrl);
      }
    }catch(e){}
  }
  return jar;
}

function buildClient(jar){
  return wrapper(axios.create({
    jar, withCredentials:true, maxRedirects:5, timeout:15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    validateStatus: ()=>true
  }));
}

function guessFramework($, html){
  const htmlTxt = (html||'').toLowerCase();
  if(/wp-content|wordpress/.test(htmlTxt)) return 'WordPress';
  if(/cdn\.shopify\.com|shopify/.test(htmlTxt)) return 'Shopify';
  if(/__NEXT_DATA__|next-data|_app\.js|react/.test(htmlTxt)) return 'React/Next.js';
  if(/__NUXT__|nuxt|vue/.test(htmlTxt)) return 'Vue/Nuxt';
  if(/ng-version|angular/.test(htmlTxt)) return 'Angular';
  return 'Unknown';
}

function pickHeaders(type){
  if(type==='json'){
    return {"Accept":"application/json, text/plain, */*","X-Requested-With":"XMLHttpRequest"};
  }
  return {"Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"};
}

function validatorSuggestionsFromHTML($, html){
  const list = [];
  const lower = (html||'').toLowerCase();
  // common markers
  ['logout','my account','settings','profile','billing','subscriptions','dashboard'].forEach(n=>{
    if(lower.includes(n)) list.push({mode:'text', value:`text:"${n}"`, confidence:0.6});
  });
  // email
  const m = (html||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if(m) list.push({mode:'text', value:`text:"${m[0]}"`, confidence:0.9});
  // script blobs
  if(/"email":"[^"]+"/.test(html)) list.push({mode:'text', value:'text:"\"email\":\""', confidence:0.75});
  if(/"isLogin"\s*:\s*1/.test(html)) list.push({mode:'text', value:'text:"\"isLogin\":1"', confidence:0.8});
  if(/"loggedIn"\s*:\s*(true|1)/i.test(html)) list.push({mode:'text', value:'text:"loggedIn"', confidence:0.65});
  // css-based ui hints (we only suggest text validators here)
  return uniqBy(list, x=>x.value).slice(0,8);
}

function endpointCandidatesFromHTML($, baseUrl){
  const base = new URL(baseUrl);
  const set = new Set();
  const add = (p)=>{ try{ set.add(new URL(p, base.origin).toString()); }catch(e){} };
  $('a[href],form[action]').each((i,el)=>{
    const href = el.name==='a' ? el.attribs.href : el.attribs.action;
    if(!href) return;
    if(/settings|account|profile|dashboard|billing|subscriptions|user|me/i.test(href)){
      add(href);
    }
  });
  ['/settings','/account','/profile','/dashboard','/me','/user','/billing'].forEach(add);
  return Array.from(set).slice(0,12);
}

function chooseBestValidator(suggestions){
  if(!suggestions || !suggestions.length) return '';
  return suggestions.sort((a,b)=> (b.confidence||0)-(a.confidence||0))[0].value;
}

function uniqBy(arr,fn){
  const seen=new Set(); const out=[];
  for(const x of arr){ const k=fn(x); if(!seen.has(k)){ seen.add(k); out.push(x);} }
  return out;
}

async function fetchOnceHTTP(client, url, headers){
  const resp = await client.request({url, method:'GET', headers: headers||{}, maxRedirects:5});
  const contentType = String(resp.headers['content-type']||'').toLowerCase();
  const body = typeof resp.data==='string' ? resp.data : JSON.stringify(resp.data);
  const finalURL = resp.request && resp.request.res && resp.request.res.responseUrl ? resp.request.res.responseUrl : url;
  return {status:resp.status, headers:resp.headers, body, contentType, finalURL};
}

async function fetchOnceRendered(url, cookieStr, cookieJson){
  if(!playwright) throw new Error('Playwright not installed');
  const browser = await playwright.chromium.launch({headless:true});
  const context = await browser.newContext({
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    locale:'en-US'
  });
  // Set cookies if provided
  const cookieList = [];
  const host = new URL(url).hostname;
  if(cookieStr){
    for(const part of cookieStr.split(';')){
      const p = part.trim(); if(!p) continue;
      const i = p.indexOf('='); if(i<1) continue;
      const name = p.slice(0,i).trim(), value = p.slice(i+1).trim();
      cookieList.push({name,value,domain:host,path:'/', secure:url.startsWith('https')});
    }
  }
  if(cookieJson){
    try{
      const arr = JSON.parse(cookieJson);
      for(const c of arr){
        if(!c.name) continue;
        cookieList.push({name:c.name, value:String(c.value??''), domain:(c.domain||host).replace(/^\./,''), path:c.path||'/', secure:!!c.secure});
      }
    }catch(e){}
  }
  if(cookieList.length) await context.addCookies(cookieList);

  const page = await context.newPage();
  const resp = await page.goto(url, {waitUntil:'domcontentloaded', timeout:20000}).catch(()=>null);
  // Give SPA a moment to render UI text
  await page.waitForTimeout(1200);
  const body = await page.content();
  const finalURL = page.url();
  const status = resp ? resp.status() : 0;
  const headers = resp ? resp.headers() : {};
  await context.close(); await browser.close();
  return {status, headers, body, contentType: String(headers['content-type']||'text/html').toLowerCase(), finalURL, rendered:true};
}

function checkValidator(validator, htmlOrJson){
  if(!validator) return {pass:false,reason:'no validator'};
  const v = validator.trim();

  // regex: re:/pattern/i
  if(/^re:/i.test(v)){
    const body = htmlOrJson || '';
    const m = v.slice(3).trim();
    const flags = /\/(?!.*\/).*$/i.test(m) ? m.split('/').pop() : 'i';
    const pattern = m.replace(/^\//,'').replace(/\/[a-z]*$/i,'');
    try{
      const re = new RegExp(pattern, flags);
      const pass = re.test(body);
      return {pass, mode:'re', pattern, flags};
    }catch(e){ return {pass:false,reason:'bad regex'}; }
  }

  // css:text selector: css:.selector >> contains("text")
  if(/^css:/i.test(v)){
    return {pass:false,reason:'css validator only supported client-side render; use text: instead'};
  }

  // json:path[==value]
  if(/^json:/i.test(v)){
    const pathExpr = v.slice(5).trim();
    try{
      const json = JSON.parse(htmlOrJson);
      let path = pathExpr;
      let expected = null, hasEq=false;
      const eqIdx = pathExpr.indexOf('==');
      if(eqIdx>0){ hasEq=true; path = pathExpr.slice(0,eqIdx).trim(); expected = pathExpr.slice(eqIdx+2).trim().replace(/^["']|["']$/g,''); }
      const val = path.split('.').reduce((acc,k)=> acc && acc[k], json);
      if(hasEq){ const pass = String(val)===expected; return {pass, mode:'json-eq', path, value:val, expected}; }
      const pass = typeof val!=='undefined' && val!==null && String(val).length>0;
      return {pass, mode:'json', path, value:val};
    }catch(e){
      return {pass:false,reason:'response not JSON or parse failed'};
    }
  }

  // default: text includes
  const needle = v.replace(/^text:/i,'').trim().replace(/^['"]|['"]$/g,'');
  const pass = (htmlOrJson||'').includes(needle);
  return {pass, mode:'text', needle};
}

function summarize(first, validator, redirectedToLogin){
  const $ = cheerio.load(first.body||'');
  const endpoints = first.contentType.includes('json') ? [first.finalURL] : endpointCandidatesFromHTML($, first.finalURL||'');
  const validators = first.contentType.includes('json')
    ? [{mode:'text', value:'text:"email"', confidence:0.5},{mode:'text', value:'text:"loggedIn"', confidence:0.5}]
    : validatorSuggestionsFromHTML($, first.body||'');
  const bestValidator = validator || chooseBestValidator(validators) || 'text:"account"';
  return {endpoints, validators, bestValidator};
}

async function analyze({url, cookieStr, cookieJson, headers={}, render=false}){
  const jar = jarFromInputs(url, cookieStr, cookieJson);
  const client = buildClient(jar);
  const hdr = Object.keys(headers).length ? headers : pickHeaders('html');

  let first;
  if(render){
    first = await fetchOnceRendered(url, cookieStr, cookieJson);
  } else {
    first = await fetchOnceHTTP(client, url, hdr);
    if((first.status===403 || first.status===503) && playwright){
      // fallback to rendered if blocked
      first = await fetchOnceRendered(url, cookieStr, cookieJson);
    }
  }
  const redirectedToLogin = /login|signin|auth/i.test(first.finalURL||'');
  const {endpoints, validators, bestValidator} = summarize(first, '', redirectedToLogin);
  return {first, endpoints, validators, bestValidator, redirectedToLogin, headers:hdr};
}

app.post('/auto', async (req,res)=>{
  const { url, cookieStr='', cookieJson='', headers={}, render=false } = req.body || {};
  if(!url) return res.status(400).json({error:'url required'});
  try{
    const out = await analyze({url, cookieStr, cookieJson, headers, render});
    const {first, endpoints, validators, bestValidator} = out;
    const domain = new URL(first.finalURL||url).hostname;
    const framework = first.contentType.includes('json') ? 'JSON API' : guessFramework(cheerio.load(first.body||''), first.body||'');
    const best = {url:endpoints[0]||first.finalURL||url, method:'GET', validator:bestValidator, headers: out.headers, domain};
    res.json({
      framework,
      domain,
      status: first.status,
      content_type: first.contentType,
      final_url: first.finalURL,
      suggestions: endpoints.map(ep=>({url:ep, method:'GET', headers: out.headers})),
      validatorSuggestions: validators,
      best,
      rendered: !!first.rendered
    });
  }catch(e){
    res.status(500).json({error:String(e)});
  }
});

app.post('/auto-check', async (req,res)=>{
  const { url, cookieStr='', cookieJson='', headers={}, render=false } = req.body || {};
  if(!url) return res.status(400).json({error:'url required'});
  try{
    const out = await analyze({url, cookieStr, cookieJson, headers, render});
    const {first, endpoints, validators, bestValidator, redirectedToLogin} = out;
    const v = checkValidator(bestValidator, first.body||'');
    res.json({
      ok: v.pass && first.status>=200 && first.status<400 && !redirectedToLogin,
      status: first.status,
      content_type: first.contentType,
      final_url: first.finalURL,
      domain: new URL(first.finalURL||url).hostname,
      validator: bestValidator,
      best: {url: endpoints[0]||url, method:'GET', validator: bestValidator, headers: out.headers},
      redirectedToLogin,
      rendered: !!first.rendered,
      body_sample: (first.body||'').slice(0,1200)
    });
  }catch(e){
    res.status(500).json({error:String(e)});
  }
});

const port = process.env.PORT || 8787;
app.listen(port, ()=>console.log('Live checker PRO listening on http://localhost:'+port));
