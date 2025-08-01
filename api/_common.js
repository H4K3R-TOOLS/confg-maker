const axios = require('axios').default;
const { wrapper } = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const cheerio = require('cheerio');

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
    jar, withCredentials:true, maxRedirects:5, timeout:12000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    validateStatus: ()=>true
  }));
}

function guessFramework(html){
  const lower = (html||'').toLowerCase();
  if(/wp-content|wordpress/.test(lower)) return 'WordPress';
  if(/cdn\.shopify\.com|shopify/.test(lower)) return 'Shopify';
  if(/__NEXT_DATA__|next-data|_app\.js|react/.test(lower)) return 'React/Next.js';
  if(/__NUXT__|nuxt|vue/.test(lower)) return 'Vue/Nuxt';
  if(/ng-version|angular/.test(lower)) return 'Angular';
  return 'Unknown';
}

function validatorSuggestionsFromHTML(html){
  const list = [];
  const lower = (html||'').toLowerCase();
  ['logout','my account','settings','profile','billing','subscriptions','dashboard'].forEach(n=>{
    if(lower.includes(n)) list.push({mode:'text', value:`text:"${n}"`, confidence:0.6});
  });
  const m = (html||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if(m) list.push({mode:'text', value:`text:"${m[0]}"`, confidence:0.9});
  if(/"email":"[^"]+"/.test(html)) list.push({mode:'text', value:'text:"\"email\":\""', confidence:0.75});
  if(/"isLogin"\s*:\s*1/.test(html)) list.push({mode:'text', value:'text:"\"isLogin\":1"', confidence:0.8});
  if(/"loggedIn"\s*:\s*(true|1)/i.test(html)) list.push({mode:'text', value:'text:"loggedIn"', confidence:0.65});
  return Array.from(new Map(list.map(x=>[x.value,x])).values()).slice(0,8);
}

function endpointCandidatesFromHTML(html, baseUrl){
  const base = new URL(baseUrl);
  const $ = cheerio.load(html||'');
  const set = new Set();
  function add(p){ try{ set.add(new URL(p, base.origin).toString()); }catch(e){} }
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

async function fetchOnceHTTP(url, headers){
  const jar = new tough.CookieJar(); // ephemeral when used standalone
  const client = buildClient(jar);
  const resp = await client.request({url, method:'GET', headers: headers||{}, maxRedirects:5});
  const contentType = String(resp.headers['content-type']||'').toLowerCase();
  const body = typeof resp.data==='string' ? resp.data : JSON.stringify(resp.data);
  const finalURL = resp.request && resp.request.res && resp.request.res.responseUrl ? resp.request.res.responseUrl : url;
  return {status:resp.status, headers:resp.headers, body, contentType, finalURL};
}

function checkValidator(validator, htmlOrJson){
  if(!validator) return {pass:false,reason:'no validator'};
  const v = validator.trim();
  if(/^re:/i.test(v)){
    const body = htmlOrJson || '';
    const pattern = v.slice(3).trim();
    try{
      const re = new RegExp(pattern, 'i');
      const pass = re.test(body);
      return {pass, mode:'re', pattern};
    }catch(e){ return {pass:false,reason:'bad regex'}; }
  }
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
  const needle = v.replace(/^text:/i,'').trim().replace(/^['"]|['"]$/g,'');
  const pass = (htmlOrJson||'').includes(needle);
  return {pass, mode:'text', needle};
}

module.exports = {
  jarFromInputs, buildClient, guessFramework, validatorSuggestionsFromHTML,
  endpointCandidatesFromHTML, chooseBestValidator, fetchOnceHTTP, checkValidator
};