import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeHarnessTempRoot } from './support/temp-root.js';
import { startServer, stopServer } from '../src/wf-ui-server/server.mjs';

function getJson(baseUrl, route) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, baseUrl);
    const request = http.get(url, { timeout: 3000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(new Error(`invalid JSON response (${response.statusCode}): ${error.message}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('health request timed out')));
    request.on('error', reject);
  });
}

test('server health exposes the package version at the real HTTP boundary', async () => {
  const projectRoot = makeHarnessTempRoot('review-server-version-092-');
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  let started = null;
  try {
    started = await startServer({
      projectRoot,
      host: '127.0.0.1',
      port: 0,
      eventsWs: false,
      chatWs: false,
    });
    const response = await getJson(`http://127.0.0.1:${started.port}/`, '/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
    assert.equal(response.body.version, packageJson.version,
      `health must expose package.json.version (actual=${response.body.version})`);
  } finally {
    if (started?.server) await stopServer(started.server);
    fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
