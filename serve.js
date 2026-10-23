/* 本地测试静态服务器：
 * 1) 提供语音原型页面；
 * 2) /hf/* 同源代理 hf-mirror.com 模型文件（配合 COEP 跨域隔离，启用 WASM 多线程）；
 * 3) /stt 代理到百度智能云语音识别 API（免下载本地模型、零等待识别）。 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const PORT = process.env.PORT || 8765;
const types = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.mjs': 'text/javascript;charset=utf-8',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml'
};

/* ========== 百度语音识别 /stt 代理 ========== */
let cfg = null;
let baiduToken = null;   // { token: string, expireAt: timestamp_ms }
function loadConfig(){
  // 优先环境变量（Railway/Render 部署方式），其次配置文件（本机方式）
  const envApi = process.env.BAIDU_API_KEY;
  const envSec = process.env.BAIDU_SECRET_KEY;
  if(envApi && envSec){
    cfg = { baiduApiKey: envApi, baiduSecretKey: envSec };
    console.log('[OK] 已从环境变量加载百度配置');
    return;
  }
  try{
    const raw = fs.readFileSync(path.join(root, 'stt-config.json'), 'utf8');
    cfg = JSON.parse(raw);
    if(!cfg.baiduApiKey || cfg.baiduApiKey.startsWith('在此')) cfg = null;
    if(!cfg.baiduSecretKey || cfg.baiduSecretKey.startsWith('在此')) cfg = null;
  }catch(e){ cfg = null; }
}
loadConfig();
if(!cfg){
  console.log('[提醒] 未配置百度 API Key，/stt 端点会返回 401。请编辑 stt-config.json 或设置环境变量 BAIDU_API_KEY / BAIDU_SECRET_KEY');
}else{
  console.log('[OK] 已加载百度语音识别配置');
}

function getBaiduToken(){
  return new Promise((resolve, reject)=>{
    const now = Date.now();
    if(baiduToken && baiduToken.expireAt > now + 60000){
      return resolve(baiduToken.token);
    }
    const url = '/oauth/2.0/token?grant_type=client_credentials&client_id=' + cfg.baiduApiKey + '&client_secret=' + cfg.baiduSecretKey;
    https.get({ hostname: 'aip.baidubce.com', path: url, method: 'GET' }, (res)=>{
      let data = '';
      res.on('data', c => data += c);
      res.on('end', ()=>{
        try{
          const j = JSON.parse(data);
          if(j.access_token){
            baiduToken = { token: j.access_token, expireAt: now + (j.expires_in || 2592000) * 1000 };
            resolve(j.access_token);
          }else{
            reject(new Error('token 失败: ' + JSON.stringify(j)));
          }
        }catch(e){ reject(e); }
      });
    }).on('error', reject);
  });
}

function callBaiduSTT(pcmBuffer){
  return getBaiduToken().then(token=>{
    return new Promise((resolve, reject)=>{
      const body = JSON.stringify({
        format: 'pcm',
        rate: 16000,
        channel: 1,
        cuid: 'renyin-voice-test',
        token: token,
        speech: pcmBuffer.toString('base64'),
        len: pcmBuffer.length
      });
      const req = https.request({
        hostname: 'vop.baidu.com', path: '/server_api', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res)=>{
        let data = '';
        res.on('data', c => data += c);
        res.on('end', ()=>{
          try{ resolve(JSON.parse(data)); }catch(e){ reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  });
}

function handleStt(req, res){
  if(!cfg){
    res.writeHead(401, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ error: '未配置百度 API Key，请编辑 stt-config.json' }));
  }
  if(req.method !== 'POST'){
    res.writeHead(405); res.end(); return;
  }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async ()=>{
    const buf = Buffer.concat(chunks);
    // 前端发 Int16 PCM 原始字节（已 16k / 单声道）
    // 或者发 wav，我们自动跳过 44 字节头
    let pcm = buf;
    if(buf.length > 44 && buf.slice(0,4).toString() === 'RIFF' && buf.slice(8,12).toString() === 'WAVE'){
      pcm = buf.slice(44);
    }
    if(pcm.length < 16000 * 2 * 0.3){  // < 0.3 秒
      res.writeHead(400, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ error: '音频太短' }));
    }
    try{
      const start = Date.now();
      const j = await callBaiduSTT(pcm);
      const ms = Date.now() - start;
      if(j.err_no){
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ error: j.err_msg, code: j.err_no }));
      }
      const text = (j.result || []).join('');
      console.log('[STT] ' + ms + 'ms → ' + text.slice(0,60));
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ text, ms, raw: j }));
    }catch(e){
      res.writeHead(502, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function proxyToHfMirror(req, res) {
  const targetPath = req.url.replace(/^\/hf/, ''); // /hf/Xenova/... -> /Xenova/...
  const options = {
    hostname: 'hf-mirror.com',
    port: 443,
    path: targetPath,
    method: req.method,
    headers: {
      'User-Agent': 'Mozilla/5.0 renyin-local-test',
      'Accept': '*/*',
      'Accept-Encoding': 'identity'
    }
  };
  const upReq = https.request(options, (upRes) => {
    // 跟随 302（镜像站可能重定向到存储后端），最多 5 次
    if ([301, 302, 303, 307, 308].includes(upRes.statusCode) && upRes.headers.location) {
      upRes.resume();
      let loc;
      try { loc = new URL(upRes.headers.location, 'https://hf-mirror.com'); }
      catch (_) { res.writeHead(502); res.end('bad redirect'); return; }
      const hop = {
        hostname: loc.hostname,
        port: loc.port || 443,
        path: loc.pathname + loc.search,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 renyin-local-test', 'Accept': '*/*', 'Accept-Encoding': 'identity' }
      };
      let hops = 0;
      const follow = (opt) => {
        const r2 = https.request(opt, (rr) => {
          if ([301, 302, 303, 307, 308].includes(rr.statusCode) && rr.headers.location && hops++ < 5) {
            rr.resume();
            const u2 = new URL(rr.headers.location, 'https://' + opt.hostname);
            follow({ hostname: u2.hostname, port: u2.port || 443, path: u2.pathname + u2.search, method: 'GET',
              headers: { 'User-Agent': 'Mozilla/5.0 renyin-local-test', 'Accept': '*/*', 'Accept-Encoding': 'identity' } });
            return;
          }
          const h = {
            'Content-Type': rr.headers['content-type'] || 'application/octet-stream',
            'Cache-Control': 'public, max-age=86400'
          };
          if (rr.headers['content-length']) h['Content-Length'] = rr.headers['content-length'];
          if (rr.headers['content-range']) h['Content-Range'] = rr.headers['content-range'];
          if (rr.headers['accept-ranges']) h['Accept-Ranges'] = rr.headers['accept-ranges'];
          res.writeHead(rr.statusCode, h);
          rr.pipe(res);
        });
        r2.on('error', () => { try { res.writeHead(502); res.end('upstream error'); } catch (_) {} });
        r2.end();
      };
      follow(hop);
      return;
    }
    const h = {
      'Content-Type': upRes.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400'
    };
    if (upRes.headers['content-length']) h['Content-Length'] = upRes.headers['content-length'];
    res.writeHead(upRes.statusCode, h);
    upRes.pipe(res);
  });
  upReq.on('error', () => { try { res.writeHead(502); res.end('hf-mirror proxy error'); } catch (_) {} });
  upReq.end();
}

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath.startsWith('/stt')) { handleStt(req, res); return; }
  if (urlPath.startsWith('/hf/')) { proxyToHfMirror(req, res); return; }
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.join(root, filePath);
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': types[path.extname(full)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless'
    });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => console.log('serving on port ' + PORT + ' (COOP/COEP + /stt proxy)'));
