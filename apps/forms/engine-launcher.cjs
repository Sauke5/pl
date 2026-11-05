'use strict';
// Runtime-only secrets are read from one root-owned file, never Docker Env/argv.
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync('/run/secrets/forms-engine.json', 'utf8'));
const fields = ['session_key', 'encryption_key', 'keydb_password'];
if (Object.keys(config).sort().join(',') !== fields.sort().join(',') || fields.some(key => !/^[0-9a-f]{64}$/.test(config[key]))) {
  throw new Error('Invalid private Forms engine configuration');
}
Object.assign(process.env, {
  SESSION_KEY: config.session_key,
  FORM_ENCRYPTION_KEY: config.encryption_key,
  REDIS_PASSWORD: config.keydb_password,
  APP_DISABLE_REGISTRATION: process.env.PL_FORMS_BOOTSTRAP === '1' ? 'false' : 'true',
});
const main = ['dist/main.js', 'dist/src/main.js', 'dist/packages/server/main.js'].find(name => fs.existsSync(name));
if (!main) throw new Error('Pinned HeyForm entrypoint unavailable');
require(path.resolve(main));
