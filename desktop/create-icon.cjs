// Generates the application's own small four-pane Windows icon using Node built-ins.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
const width = 256;
const rgba = Buffer.alloc((width * 4 + 1) * width);
const squares = [[24, 24, 255], [144, 24, 102], [24, 144, 166], [144, 144, 255]];
for (let y = 0; y < width; y += 1) {
  for (let x = 0; x < width; x += 1) {
    for (const [left, top, alpha] of squares) {
      const size = 88;
      const radius = 20;
      const dx = Math.max(left + radius - x, 0, x - (left + size - radius));
      const dy = Math.max(top + radius - y, 0, y - (top + size - radius));
      if (x < left || x >= left + size || y < top || y >= top + size || dx * dx + dy * dy > radius * radius) continue;
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      rgba.set([53, 106, 230, alpha], offset);
    }
  }
}
const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0);
header.writeUInt32BE(width, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rgba)), chunk('IEND', Buffer.alloc(0))]);
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(png.length, 14);
icoHeader.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(__dirname, 'pane.ico'), Buffer.concat([icoHeader, png]));
