import { deflateSync } from 'node:zlib'

// A real, decodable synthetic PNG (3x2, solid color) built in code so tests can assert the browser actually renders it.
export const PNG_WIDTH = 3
export const PNG_HEIGHT = 2

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

function buildPng(): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(PNG_WIDTH, 0)
  ihdr.writeUInt32BE(PNG_HEIGHT, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: PNG_WIDTH }, () => [0x14, 0x6c, 0x5f]).flat())])
  const raw = Buffer.concat(Array.from({ length: PNG_HEIGHT }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export const PNG_BUFFER = buildPng()
export const PNG_BYTES = new Uint8Array(PNG_BUFFER)
