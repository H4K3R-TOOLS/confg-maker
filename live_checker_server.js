
// Enhanced server with auto-inference so user only gives "name + link"
const express = require('express');
const axios = require('axios').default;
const { wrapper } = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const cheerio = require('cheerio');

const app = express();
app.use(express.json({limit:'2mb'}));

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
  return wrapper(axios.create({jar, withCredentials:true, maxRedirects:5, timeout:12000, validateStatus:()=>true}));
}

function guessFramework($, html){
  const scripts = $('script[src]').map((i,el)=>String($(el).attr('src'))).get().join(' ');
  const htmlTxt = html.toLowerCase();
  if(/wp-content|wordpress/.test(htmlTxt)) return 'WordPress';
  if(/cdn\.shopify\.com|Shopify.theme/.test(html)) return 'Shopify';
  if(/react|__NEXT_DATA__|next-data|_app\.js/.test(htmlTxt)) return 'React/Next.js';
  if(/vue|__NUXT__|nuxt/.test(htmlTxt)) return 'Vue/Nuxt';
  if(/angular|ng-version/.test(htmlTxt)) return 'Angular';
  return 'Unknown';
}

function pickHeaders(contentTypeGuess){
  if(contentTypeGuess==='json'){
    return {"Accept":"application/json, text/plain, */*","X-Requested-With":"XMLHttpRequest","User-Agent":"Mozilla/5.0"};
  }
  return {"Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","User-Agent":"Mozilla/5.0"};
}

function emailFromText(text){
  const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
}

function validatorSuggestionsFromHTML($, html){
  const list = [];
  const mail = emailFromText(html);
  if(mail) list.push({mode:'text', value:`text:"${mail}"`, confidence:0.95});

  // Common logged-in markers
  const needles = ['logout','my account','settings','profile','billing','subscriptions'];
  for(const n of needles){
    if(html.toLowerCase().includes(n)){
      list.push({mode:'text', value:`text:"${n}"`, confidence:0.7});
    }
  }
  // JSON blobs inside scripts
  const scripts = $('script:not([src])').map((i,el)=>$(el).html()||'').get().join('\n');
  if(/"email":"[^"]+"/.test(scripts)){
    list.push({mode:'text', value:'text:"\"email\":\""', confidence:0.8});
  }
  if(/"isLogin"\s*:\s*1/.test(scripts)){
    list.push({mode:'text', value:'text:"\"isLogin\":1"', confidence:0.85});
  }
  if(/"loggedIn"\s*:\s*(true|1)/i.test(scripts)){
    list.push({mode:'text', value:'text:"loggedIn"', confidence:0.75});
  }
  return uniqBy(list, x=>x.value).slice(0,6);
}

function endpointCandidatesFromHTML($, baseUrl){
  const base = new URL(baseUrl);
  const set = new Set();
  const add = (p)=>{ try{ set.add(new URL(p, base.origin).toString()); }catch(e){} };
  // anchors/forms
  $('a[href],form[action]').each((i,el)=>{
    const href = el.name==='a' ? el.attribs.href : el.attribs.action;
    if(!href) return;
    if(/settings|account|profile|dashboard|billing|subscriptions|user/i.test(href)){
      add(href);
    }
  });
  // common guesses
  ['/settings','/account','/profile','/dashboard','/me','/user','/billing'].forEach(add);
  return Array.from(set).slice(0,10);
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

async function fetchOnce(client, url, headers){
  const resp = await client.request({url, method:'GET', headers: headers||{}, maxRedirects:5, validateStatus:()=>true});
  const contentType = String(resp.headers['content-type']||'').toLowerCase();
  const body = typeof resp.data==='string' ? resp.data : JSON.stringify(resp.data);
  const finalURL = resp.request && resp.request.res && resp.request.res.responseUrl ? resp.request.res.responseUrl : url;
  return {status:resp.status, headers:resp.headers, body, contentType, finalURL};
}

app.post('/auto', async (req,res)=>{
  const { url, cookieStr='', cookieJson='', headers={} } = req.body || {};
  if(!url) return res.status(400).json({error:'url required'});
  try{
    const jar = jarFromInputs(url, cookieStr, cookieJson);
    const client = buildClient(jar);
    const hdr = Object.keys(headers).length ? headers : pickHeaders('html');
    const first = await fetchOnce(client, url, hdr);

    const domain = new URL(first.finalURL||url).hostname;
    const $ = cheerio.load(first.body||'');
    const framework = first.contentType.includes('json') ? 'JSON API' : guessFramework($, first.body||'');
    const endpoints = first.contentType.includes('json') ? [url] : endpointCandidatesFromHTML($, first.finalURL||url);
    const validators = first.contentType.includes('json')
      ? [{mode:'text', value:'text:"email"', confidence:0.5},{mode:'text', value:'text:"loggedIn"', confidence:0.5}]
      : validatorSuggestionsFromHTML($, first.body||'');
    const best = {
      url: endpoints[0] || (first.finalURL||url),
      method: 'GET',
      validator: chooseBestValidator(validators) || 'text:"account"',
      headers: hdr,
      domain
    };
    res.json({
      framework,
      domain,
      status:first.status,
      content_type:first.contentType,
      final_url:first.finalURL,
      suggestions: endpoints.map(ep=>({url:ep, method:'GET', headers: hdr})),
      validatorSuggestions: validators,
      best
    });
  }catch(e){
    res.status(500).json({error:String(e)});
  }
});

function checkValidator(validator, body){
  if(!validator) return {pass:false,reason:'no validator'};
  const v = validator.trim();
  if(v.toLowerCase().startsWith('text:')){
    const needle = v.slice(5).trim().replace(/^['"]|['"]$/g,'');
    const pass = (body||'').includes(needle);
    return {pass, mode:'text', needle, reason: pass?'found':'not found'};
  }
  // fallback: contains
  const needle = v.replace(/^['"]|['"]$/g,'');
  const pass = (body||'').includes(needle);
  return {pass, mode:'text', needle, reason: pass?'found':'not found'};
}

app.post('/auto-check', async (req,res)=>{
  const { url, cookieStr='', cookieJson='', headers={} } = req.body || {};
  if(!url) return res.status(400).json({error:'url required'});
  try{
    const jar = jarFromInputs(url, cookieStr, cookieJson);
    const client = buildClient(jar);
    const hdr = Object.keys(headers).length ? headers : pickHeaders('html');
    const first = await fetchOnce(client, url, hdr);

    const $ = cheerio.load(first.body||'');
    const endpoints = first.contentType.includes('json') ? [url] : endpointCandidatesFromHTML($, first.finalURL||url);
    const validators = first.contentType.includes('json')
      ? [{mode:'text', value:'text:"email"', confidence:0.5},{mode:'text', value:'text:"loggedIn"', confidence:0.5}]
      : validatorSuggestionsFromHTML($, first.body||'');
    const bestValidator = chooseBestValidator(validators) || 'text:"account"';
    const v = checkValidator(bestValidator, first.body||'');

    const redirectedToLogin = /login|signin|auth/i.test(first.finalURL||'');
    res.json({
      ok: v.pass && first.status>=200 && first.status<400 && !redirectedToLogin,
      status: first.status,
      content_type: first.contentType,
      final_url: first.finalURL,
      domain: new URL(first.finalURL||url).hostname,
      validator: bestValidator,
      best: {url: endpoints[0]||url, method:'GET', validator: bestValidator, headers: hdr},
      redirectedToLogin,
      body_sample: (first.body||'').slice(0,1200)
    });
  }catch(e){
    res.status(500).json({error:String(e)});
  }
});

const port = process.env.PORT || 8787;
app.listen(port, ()=>console.log('Live checker listening on http://localhost:'+port));
