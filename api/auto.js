const { jarFromInputs, buildClient, guessFramework, validatorSuggestionsFromHTML, endpointCandidatesFromHTML, chooseBestValidator } = require('./_common');

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

    const domain = new URL(finalURL||url).hostname;
    const framework = contentType.includes('json') ? 'JSON API' : guessFramework(bodyStr);
    const endpoints = contentType.includes('json') ? [url] : endpointCandidatesFromHTML(bodyStr, finalURL||url);
    const validators = contentType.includes('json')
      ? [{mode:'text', value:'text:"email"', confidence:0.5},{mode:'text', value:'text:"loggedIn"', confidence:0.5}]
      : validatorSuggestionsFromHTML(bodyStr);
    const best = {url:endpoints[0]||finalURL||url, method:'GET', validator: chooseBestValidator(validators) || 'text:"account"', headers: hdr, domain};

    res.status(200).json({
      framework, domain,
      status: resp.status,
      content_type: contentType,
      final_url: finalURL,
      suggestions: endpoints.map(ep=>({url:ep, method:'GET', headers: hdr})),
      validatorSuggestions: validators,
      best
    });
  }catch(e){
    res.status(500).json({error:String(e)});
  }
};