// Local S3 protocol fixture: validates the SDK's SigV4 requests, not a live R2 account.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export async function createR2Fixture() {
  const access = 'infohub-test-access';
  const secret = 'infohub-test-secret-never-used-outside-fixture';
  const bucket = 'infohub-test';
  const fixture = {
    objects: new Map(),
    requests: 0,
    failPut: false,
    failDelete: false,
    corruptReads: false,
    failProbe: false,
    deleteDelayMs: 0,
    errors: [],
  };
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://' + req.headers.host);
      const auth = req.headers.authorization?.match(
        /^AWS4-HMAC-SHA256 Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([a-f0-9]+)$/,
      );
      assert.ok(auth, 'SigV4 Authorization header required');
      const [key, date, region, service, terminal] = auth[1].split('/');
      assert.deepEqual([key, region, service, terminal], [access, 'auto', 's3', 'aws4_request']);
      const signedHeaders = auth[2].split(';');
      assert.ok(signedHeaders.includes('host'));
      const headers = signedHeaders
        .map((name) => name + ':' + String(req.headers[name]).trim().replace(/\s+/g, ' ') + '\n')
        .join('');
      const query = [...url.searchParams]
        .map(([k, v]) => [encode(k), encode(v)])
        .sort(([a, b], [c, d]) => a.localeCompare(c) || b.localeCompare(d))
        .map(([k, v]) => k + '=' + v)
        .join('&');
      const payloadHash = req.headers['x-amz-content-sha256'];
      assert.ok(payloadHash);
      if (payloadHash !== 'UNSIGNED-PAYLOAD') assert.equal(payloadHash, sha256(body));
      const canonical = [req.method, url.pathname, query, headers, auth[2], payloadHash].join('\n');
      const scope = [date, region, service, terminal].join('/');
      const toSign = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], scope, sha256(canonical)].join('\n');
      const signingKey = hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), terminal);
      assert.equal(auth[3], hmac(signingKey, toSign).toString('hex'), 'SigV4 signature mismatch');
      assert.ok(url.pathname.startsWith('/' + bucket + '/'));
      const objectKey = decodeURIComponent(url.pathname.slice(bucket.length + 2));
      fixture.requests++;
      const error = (status, code) => {
        res.writeHead(status, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>' + code + '</Code><Message>Fixture failure</Message></Error>');
      };
      if (
        (fixture.failProbe && objectKey.startsWith('checks/')) ||
        (req.method === 'PUT' && fixture.failPut) ||
        (req.method === 'DELETE' && fixture.failDelete)
      ) {
        error(403, 'AccessDenied');
      } else if (req.method === 'PUT') {
        fixture.objects.set(objectKey, Buffer.from(body));
        res.setHeader('ETag', '"' + sha256(body) + '"');
        res.end();
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        const bytes = fixture.objects.get(objectKey);
        if (!bytes) return error(404, 'NoSuchKey');
        res.writeHead(200, {
          'Content-Length': bytes.length,
          'Content-Type': 'application/octet-stream',
          'Last-Modified': new Date().toUTCString(),
          ETag: '"' + sha256(bytes) + '"',
        });
        res.end(
          req.method === 'HEAD'
            ? undefined
            : fixture.corruptReads && !objectKey.startsWith('checks/')
              ? Buffer.alloc(bytes.length, 42)
              : bytes,
        );
      } else if (req.method === 'DELETE') {
        if (fixture.deleteDelayMs) await new Promise((done) => setTimeout(done, fixture.deleteDelayMs));
        fixture.objects.delete(objectKey);
        res.writeHead(204);
        res.end();
      } else {
        error(400, 'NotImplemented');
      }
    } catch (error) {
      fixture.errors.push(error.message);
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  fixture.env = {
    FILE_STORAGE: 'r2',
    R2_ENDPOINT: 'http://127.0.0.1:' + server.address().port,
    R2_BUCKET: bucket,
    R2_ACCESS_KEY_ID: access,
    R2_SECRET_ACCESS_KEY: secret,
    R2_ALLOW_HTTP: 'true',
  };
  fixture.close = () => server.close();
  return fixture;
}
