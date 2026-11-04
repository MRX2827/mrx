import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [keyPath, sourcePath, outputPath] = process.argv.slice(2);
if (!keyPath || !sourcePath || !outputPath) {
  throw new Error('Usage: node tools/sign-config.mjs private.pem source.json config.json');
}
const key = createPrivateKey(readFileSync(keyPath));
if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') {
  throw new Error('Expected a P-256 private key');
}
const payload = readFileSync(sourcePath);
JSON.parse(payload);
const envelope = {
  payload: payload.toString('base64url'),
  signature: sign('sha256', payload, { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
};
writeFileSync(outputPath, JSON.stringify(envelope, null, 2) + '\n');
console.log(JSON.stringify(createPublicKey(key).export({ format: 'jwk' })));
