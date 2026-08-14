const CASTAGNOLI_REFLECTED_POLYNOMIAL = 0x82f63b78;

const CRC32C_TABLE = new Uint32Array(256);
for (let value = 0; value < CRC32C_TABLE.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : CASTAGNOLI_REFLECTED_POLYNOMIAL);
  }
  CRC32C_TABLE[value] = crc >>> 0;
}

export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC32C_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
