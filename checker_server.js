
// Minimal backend for real HTTP validation (avoids browser CORS / cookie limits)
const express = require('express');
const axios = require('axios').default;
const tough = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const app = express();
app.use(express.json({limit:'1mb'}));

// Helper: merge cookies from raw string and JSON array (EditThisCookie-like)
function cookiesFromInput(cookieStr, cookieJson, url){
  const jar = new tough.CookieJar();
  const origin = new URL(url).origin;
  // raw "k=v; a=b"
  if(cookieStr){
    for(const part of cookieStr.split(';')){
      const p = part.trim();
      if(!p) continue;
      const idx = p.indexOf('=');
      if(idx>0){
        const k = p.slice(0,idx).trim();
        const v = p.slice(idx+1).trim();
        const ck = new tough.Cookie({key:k,value:v,domain:new URL(url).hostname,path:'/',secure:url.startsWith('https://')});
        jar.setCookieSync(ck, origin);
      }
    }
  }
  // JSON array
  if(cookieJson){
    try{
      const arr = JSON.parse(cookieJson);
      for(const c of arr){
        if(!c.name) continue;
        const ck = new tough.Cookie({
          key: c.name,
          value: String(c.value ?? ''),
          domain: (c.domain || new URL(url).hostname).replace(/^\./,''),
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          expires: c.expires ? new Date(c.expires*1000) : 'Infinity',
          sameSite: c.sameSite || 'Lax'
        });
        const cookieUrl = `${url.startsWith('https://')?'https':'http'}://${ck.domain}${ck.path}`;
        jar.setCookieSync(ck, cookieUrl);
      }
    }catch(e){ /* ignore */ }
  }
  return jar;
}

// Very light "validator" logic:
// - If validator starts with "text:" -> we check text includes substring after text:
// - If validator starts with "json:" -> use basic dotted path equality check like "json: data.user.email"
function checkValidator(validator, body, contentType){
  if(!validator) return {pass:false, reason:'No validator set'};
  const s = validator.trim();
  if(s.toLowerCase().startsWith('text:')){
    const needle = s.slice(5).trim().replace(/^['"]|['"]$/g,'');
    const pass = (body||'').includes(needle);
    return {pass, reason: pass?'substring found':'substring not found', mode:'text', needle};
  }
  if(s.toLowerCase().startsWith('json:')){
    const path = s.slice(5).trim();
    try{
      const json = typeof body==='string' ? JSON.parse(body) : body;
      const val = path.split('.').reduce((acc,k)=>acc && acc[k], json);
      const pass = typeof val !== 'undefined' && val !== null && String(val).length>0;
      return {pass, reason: pass?'json path present':'json path missing', mode:'json', path, value:val};
    }catch(e){
      return {pass:false, reason:'response not JSON or parse failed'};
    }
  }
  // fallback: treat as plain text includes
  const needle = s.replace(/^['"]|['"]$/g,'');
  const pass = (body||'').includes(needle);
  return {pass, reason: pass?'substring found':'substring not found', mode:'text', needle};
}

app.post('/check', async (req,res)=>{
  const { url, method='GET', headers={}, validator='', cookieStr='', cookieJson='' } = req.body || {};
  if(!url) return res.status(400).json({ok:false,error:'url required'});
  try{
    const jar = cookiesFromInput(cookieStr, cookieJson, url);
    const client = wrapper(axios.create({ jar, withCredentials: true, maxRedirects: 5, timeout: 12000 }));

    const start = Date.now();
    const resp = await client.request({
      url,
      method,
      headers: headers || {},
      validateStatus: ()=>true // we handle status ourselves
    });
    const ms = Date.now() - start;

    const contentType = String(resp.headers['content-type']||'').toLowerCase();
    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);

    const v = checkValidator(validator, body, contentType);

    // Basic "login redirect" heuristics
    const finalURL = resp.request && resp.request.res && resp.request.res.responseUrl ? resp.request.res.responseUrl : url;
    const redirectedToLogin = /login|signin|auth/gi.test(finalURL);

    res.json({
      ok: v.pass && resp.status>=200 && resp.status<400 && !redirectedToLogin,
      status: resp.status,
      time_ms: ms,
      content_type: contentType,
      final_url: finalURL,
      redirectedToLogin,
      validator: v,
      sampleOfBody: body ? body.slice(0,1200) : '',
      setCookies: resp.headers['set-cookie'] || [],
      headersEcho: headers
    });
  }catch(e){
    res.status(500).json({ok:false,error:String(e)});
  }
});

const port = process.env.PORT || 8787;
app.listen(port, ()=>console.log('Checker server listening on http://localhost:'+port));
