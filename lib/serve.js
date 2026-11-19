'use strict';
// Serve a file with HTTP Range support (needed so videos can seek).
const fs = require('node:fs');
const { pipeline } = require('node:stream');

// pipeline() (unlike .pipe()) forwards errors and destroys the file stream when the client disconnects.
const send = (stream, res) => pipeline(stream, res, () => {});

function serveFile(req, res, file, mime, cache, fsImpl = fs) {
  fsImpl.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
    if (cache) headers['Cache-Control'] = cache;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start, end;
      if (range[1] === '') { start = Math.max(0, st.size - Number(range[2])); end = st.size - 1; }
      else { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1; }
      if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return send(fsImpl.createReadStream(file, { start, end }), res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    send(fsImpl.createReadStream(file), res);
  });
}

module.exports = { serveFile };
