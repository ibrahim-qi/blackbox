/* downloads dark earth tiles along the BRS→SVQ corridor (build-time only) */
import { writeFileSync, mkdirSync } from 'fs';

function tileXY(lat, lng, z) {
  const n = 2 ** z;
  const x = Math.floor((lng + 180) / 360 * n);
  const latr = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latr) + 1 / Math.cos(latr)) / Math.PI) / 2 * n);
  return { x, y };
}

const corridor = { s: 36.8, n: 52.2, w: -6.5, e: -1.0 };
const airports = [                                  // zoom 9 detail around BRS and SVQ
  { s: 50.9, n: 51.9, w: -3.4, e: -2.0 },
  { s: 36.9, n: 37.9, w: -6.5, e: -5.3 }
];

const list = [];
for (const z of [7, 8]) {
  const tl = tileXY(corridor.n, corridor.w, z), br = tileXY(corridor.s, corridor.e, z);
  for (let y = tl.y; y <= br.y; y++)
    for (let x = tl.x; x <= br.x; x++) list.push({ z, x, y });
}
for (const b of airports) {
  const z = 9, tl = tileXY(b.n, b.w, z), br = tileXY(b.s, b.e, z);
  for (let y = tl.y; y <= br.y; y++)
    for (let x = tl.x; x <= br.x; x++) list.push({ z, x, y });
}

let done = 0;
for (const t of list) {
  const url = `https://basemaps.cartocdn.com/dark_all/${t.z}/${t.x}/${t.y}.png`;
  const res = await fetch(url, { headers: { 'User-Agent': 'blackbox-build/1.0' } });
  if (!res.ok) { console.log('FAIL', url, res.status); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(`tiles/${t.z}/${t.x}`, { recursive: true });
  writeFileSync(`tiles/${t.z}/${t.x}/${t.y}.png`, buf);
  done++;
  if (done % 20 === 0) console.log(done + '/' + list.length);
}
writeFileSync('tiles.json', JSON.stringify({ tiles: list }));
writeFileSync('tiles.js', 'window.BLACKBOX_TILES = ' + JSON.stringify(list) + ';\n');
console.log('saved', done, 'of', list.length, 'tiles');
