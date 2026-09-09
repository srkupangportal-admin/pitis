const fs = require("fs");

function readUInt16(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
}

function readUInt32(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function getAsciiValue(buffer, tiffStart, littleEndian, count, valueOffset) {
  if (count <= 0) return "";
  const valueBytes = count <= 4
    ? buffer.slice(valueOffset, valueOffset + count)
    : buffer.slice(tiffStart + readUInt32(buffer, valueOffset, littleEndian), tiffStart + readUInt32(buffer, valueOffset, littleEndian) + count);
  return valueBytes.toString("ascii").replace(/\0/g, "").trim();
}

function parseExifDate(raw) {
  const value = String(raw || "").trim();
  const match = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
}

function parseIfd(buffer, tiffStart, ifdOffset, littleEndian) {
  const result = {};
  if (!ifdOffset || tiffStart + ifdOffset + 2 > buffer.length) return result;

  const entryCount = readUInt16(buffer, tiffStart + ifdOffset, littleEndian);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = tiffStart + ifdOffset + 2 + index * 12;
    if (entryOffset + 12 > buffer.length) break;
    const tag = readUInt16(buffer, entryOffset, littleEndian);
    const type = readUInt16(buffer, entryOffset + 2, littleEndian);
    const count = readUInt32(buffer, entryOffset + 4, littleEndian);
    const valueOffset = entryOffset + 8;

    if (type === 2) {
      result[tag] = getAsciiValue(buffer, tiffStart, littleEndian, count, valueOffset);
    } else if (type === 4) {
      result[tag] = count === 1
        ? readUInt32(buffer, valueOffset, littleEndian)
        : readUInt32(buffer, tiffStart + readUInt32(buffer, valueOffset, littleEndian), littleEndian);
    }
  }

  return result;
}

function extractJpegExifTakenAt(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) break;

    if (marker === 0xe1 && buffer.slice(offset + 4, offset + 10).toString("ascii") === "Exif\0\0") {
      const tiffStart = offset + 10;
      const endianMark = buffer.slice(tiffStart, tiffStart + 2).toString("ascii");
      const littleEndian = endianMark === "II";
      if (!littleEndian && endianMark !== "MM") return null;

      const firstIfdOffset = readUInt32(buffer, tiffStart + 4, littleEndian);
      const ifd0 = parseIfd(buffer, tiffStart, firstIfdOffset, littleEndian);
      const exifIfdOffset = Number(ifd0[0x8769] || 0);
      const exifIfd = exifIfdOffset ? parseIfd(buffer, tiffStart, exifIfdOffset, littleEndian) : {};
      const raw = exifIfd[0x9003] || exifIfd[0x9004] || ifd0[0x0132] || "";
      return parseExifDate(raw);
    }

    offset += 2 + segmentLength;
  }

  return null;
}

function extractPhotoMetadataFromFile(filePath, mimeType) {
  try {
    const buffer = fs.readFileSync(filePath);
    const type = String(mimeType || "").toLowerCase();
    if (type.includes("jpeg") || type.includes("jpg") || (buffer[0] === 0xff && buffer[1] === 0xd8)) {
      const capturedAt = extractJpegExifTakenAt(buffer);
      if (capturedAt) {
        return {
          capturedAt,
          capturedAtSource: "exif"
        };
      }
    }
  } catch (_error) {}

  return {
    capturedAt: null,
    capturedAtSource: null
  };
}

module.exports = {
  extractPhotoMetadataFromFile
};
