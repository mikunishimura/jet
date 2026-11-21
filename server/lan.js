#!/usr/bin/env node
// One command for a LAN party: the co-op server (:5200) + the game (:5199),
// both reachable from other machines on the network.
//   npm run lan            then everyone opens http://<this machine>:5199/?mp
import { createServer } from 'vite';
import { startServer, lanAddresses } from './index.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const gamePort = +arg('port', 5199), mpPort = +arg('mp-port', 5200);

startServer({ port: mpPort, lag: +arg('lag', 0), jitter: +arg('jitter', 0), loss: +arg('loss', 0) });
const vite = await createServer({ server: { host: '0.0.0.0', port: gamePort, strictPort: true } });
await vite.listen();
console.log(`\nJET//LAB co-op · LAN`);
console.log(`  this machine: http://127.0.0.1:${gamePort}/?mp`);
for (const ip of lanAddresses()) console.log(`  LAN:          http://${ip}:${gamePort}/?mp`);
console.log(`  co-op server: ws://0.0.0.0:${mpPort} (rooms by name; ?room=<name>&name=<pilot>)\n`);
