// One-time setup script: run `npm run google:auth` on a machine with a
// browser and localhost access (your own laptop/desktop, not a headless
// server). It walks you through Google's OAuth consent screen and appends
// the resulting refresh token to your .env file.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';
import { config } from '../lib/config.js';

const REDIRECT_URI = 'http://localhost:8991/oauth2callback';
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

if (!config.google.clientId || !config.google.clientSecret) {
  console.error(
    'Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.\n' +
      'Create an OAuth client (type: Desktop app) at https://console.cloud.google.com/apis/credentials,\n' +
      'add "http://localhost:8991/oauth2callback" as an authorized redirect URI, and put the\n' +
      'client id/secret in .env before running this again.'
  );
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  config.google.clientId,
  config.google.clientSecret,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // forces a refresh_token even if you've authorized before
  scope: SCOPES,
});

console.log('\nOpen this URL in a browser and approve access:\n');
console.log(authUrl + '\n');

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(400);
    res.end('Missing authorization code.');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Done — you can close this tab and return to the terminal.');
    server.close();

    console.log('\nGot a refresh token.');
    persistRefreshToken(tokens.refresh_token);
  } catch (err) {
    res.writeHead(500);
    res.end('Token exchange failed — see the terminal for details.');
    server.close();
    console.error('Token exchange failed:', err.message);
    process.exit(1);
  }
});

server.listen(8991, () => {
  console.log('Waiting for the OAuth redirect on http://localhost:8991 ...');
});

function persistRefreshToken(refreshToken) {
  if (!refreshToken) {
    console.warn(
      'No refresh_token in the response (Google only issues one the first time you consent).\n' +
        'Go to https://myaccount.google.com/permissions, remove this app, then run this script again.'
    );
    return;
  }

  const backendRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');
  const envPath = path.join(backendRoot, '.env');

  let envContents = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  if (envContents.match(/^GOOGLE_REFRESH_TOKEN=.*$/m)) {
    envContents = envContents.replace(
      /^GOOGLE_REFRESH_TOKEN=.*$/m,
      `GOOGLE_REFRESH_TOKEN=${refreshToken}`
    );
  } else {
    envContents += `${envContents.endsWith('\n') || envContents === '' ? '' : '\n'}GOOGLE_REFRESH_TOKEN=${refreshToken}\n`;
  }

  fs.writeFileSync(envPath, envContents);
  console.log(`Saved GOOGLE_REFRESH_TOKEN to ${envPath}`);
  console.log('You can now run: npm run sync:google');
}
