const { jarFromInputs, buildClient, validatorSuggestionsFromHTML, endpointCandidatesFromHTML, chooseBestValidator, checkValidator } = require('./_common');

module.exports = async (req, res) => {
  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const { url, cookieStr='', cookieJson='', headers={} } = body;
    if(!url) return res.status(400).json({error:'url required'});

    const jar = jarFromInputs(url, cookieStr, cookieJson);
    const client = buildClient(jar);
    const hdr = Object.keys(headers).length ? headers : {"Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"};

    const resp = await client.request({url, method:'GET', headers: hdr, maxRedirects:5, validateStatus:()=>true});
    const contentType = String(resp.headers['content-type']||'').toLowerCase();
    const bodyStr = typeof resp.data==='string' ? resp.data : JSON.stringify(resp.data);
    const finalURL = resp.request && resp.request.res && resp.request.res.responseUrl ? resp.request.res.responseUrl : url;

    const redirectedToLogin = /login|signin|auth/i.test(finalURL||'');
    const validators = contentType.includes('json')
      ? [{mode:'text', value:'text:"email"', confidence:0.5},{mode:'text', value:'text:"loggedIn"', confidence:0.5}]
      : validatorSuggestionsFromHTML(bodyStr);
    const bestValidator = chooseBestValidator(validators) || 'text:"account"';
    const v = checkValidator(bestValidator, bodyStr);

    res.status(200).json({
      ok: v.pass && resp.status>=200 && resp.status<400 && !redirectedToLogin,
      status: resp.status,
      content_type: contentType,
      final_url: finalURL,
      domain: new URL(finalURL||url).hostname,
      validator: bestValidator,
      best: {url: finalURL||url, method:'GET', validator: bestValidator, headers: hdr},
      redirectedToLogin,
      body_sample: (bodyStr||'').slice(0,1200)
    });
  }catch(e){
    res.status(500).json({error:String(e)});
  }
};