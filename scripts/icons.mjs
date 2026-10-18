// public/icon-*.png yaradır (asılılıqsız PNG yazıcı): yaşıl fon üzərində ağ zəng
import fs from "node:fs";
import zlib from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

function inBell(x, y) {
  // x,y ∈ [0,1]
  const dx = x - 0.5;
  if (Math.hypot(dx, y - 0.24) < 0.035) return true; // tutacaq
  if (Math.hypot(dx, y - 0.40) < 0.15 && y < 0.40) return true; // günbəz
  if (y >= 0.40 && y <= 0.66 && Math.abs(dx) < 0.15 + (y - 0.40) * 0.42) return true; // gövdə
  if (y > 0.66 && y < 0.71 && Math.abs(dx) < 0.29) return true; // kənar
  if (Math.hypot(dx, y - 0.76) < 0.065 && y > 0.71) return true; // dil
  return false;
}

function png(size) {
  const S = 4; // antialias
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const bg = [15, 118, 110];
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let w = 0;
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) if (inBell((px + (sx + 0.5) / S) / size, (py + (sy + 0.5) / S) / size)) w++;
      const a = w / (S * S);
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = Math.round(bg[0] + (255 - bg[0]) * a);
      raw[o + 1] = Math.round(bg[1] + (255 - bg[1]) * a);
      raw[o + 2] = Math.round(bg[2] + (255 - bg[2]) * a);
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const s of [180, 192, 512]) fs.writeFileSync(new URL(`../public/icon-${s}.png`, import.meta.url), png(s));
