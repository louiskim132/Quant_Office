import { crc32, deflateSync } from 'node:zlib';

/**
 * A 16x16 amber dot as PNG bytes, for the Windows taskbar overlay. Drawn here so the packaged app
 * needs no image asset; the count itself is carried by the overlay's accessible description.
 */
export function attentionBadgePng(size = 16): Buffer {
  const rows: Buffer[] = [];
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const inside = d <= size / 2 - 1;
      const edge = d > size / 2 - 2;
      const at = 1 + x * 4;
      // amber fill, darker rim so the dot reads on light and dark taskbars
      row[at] = edge ? 0x9a : 0xf0;
      row[at + 1] = edge ? 0x5a : 0xa8;
      row[at + 2] = edge ? 0x0a : 0x3c;
      row[at + 3] = inside ? 255 : 0;
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
