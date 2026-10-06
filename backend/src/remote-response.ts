import type { IncomingMessage } from "node:http";
import { Readable, Transform, Writable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createGunzip,
  createInflate,
  createBrotliDecompress,
  createZstdDecompress,
} from "node:zlib";
import { AppError } from "./errors";

export const MAX_REMOTE_BYTES = 2 * 1024 * 1024;
function tooLarge() {
  return new AppError(
    413,
    "Réponse distante trop volumineuse, avant ou après décompression.",
    "RESPONSE_TOO_LARGE",
  );
}
class ByteLimit extends Transform {
  private size = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
    this.size += chunk.length;
    if (this.size > MAX_REMOTE_BYTES) done(tooLarge());
    else done(null, chunk);
  }
}
class BodyBuffer extends Writable {
  private size = 0;
  private chunks: Buffer[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.size += chunk.length;
    if (this.size > MAX_REMOTE_BYTES) {
      done(tooLarge());
      return;
    }
    this.chunks.push(chunk);
    done();
  }
  bytes() {
    return Buffer.concat(this.chunks, this.size);
  }
}
function decompressor(encoding: string) {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    case "zstd":
      return createZstdDecompress();
    default:
      throw new AppError(
        502,
        "Le site utilise une compression HTTP non prise en charge.",
        "UNSUPPORTED_CONTENT_ENCODING",
      );
  }
}
function decodeText(body: Buffer, contentType?: string): string {
  const utf16le =
    (body[0] === 0xff && body[1] === 0xfe) ||
    (body[0] === 0x3c && body[1] === 0 && body[2] === 0x3f && body[3] === 0);
  const utf16be =
    (body[0] === 0xfe && body[1] === 0xff) ||
    (body[0] === 0 && body[1] === 0x3c && body[2] === 0 && body[3] === 0x3f);
  const utf8Bom = body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf;
  const charset = contentType?.match(/\bcharset\s*=\s*["']?([^;\s"']+)/i)?.[1];
  const declaration = body
    .subarray(0, 512)
    .toString("latin1")
    .match(/^\s*<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)["']/i)?.[1];
  const encoding = utf16le
    ? "utf-16le"
    : utf16be
      ? "utf-16be"
      : utf8Bom
        ? "utf-8"
        : (charset ?? declaration ?? "utf-8");
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding, { fatal: true });
  } catch {
    throw new AppError(
      502,
      "L'encodage du texte renvoyé par le site n'est pas pris en charge.",
      "UNSUPPORTED_TEXT_ENCODING",
    );
  }
  try {
    return decoder.decode(body);
  } catch {
    throw new AppError(
      502,
      "La réponse du site ne peut pas être décodée dans l'encodage annoncé. Vérifiez sa compression et son encodage ; le problème précède la lecture du XML.",
      "INVALID_TEXT_ENCODING",
    );
  }
}

export async function readRemoteResponse(response: IncomingMessage): Promise<string> {
  const wire = new BodyBuffer();
  try {
    await pipeline(response, wire);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      502,
      "La réception de la réponse du site a été interrompue.",
      "NETWORK_ERROR",
    );
  }
  let body = wire.bytes();
  let encodings = (response.headers["content-encoding"] ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && value !== "identity");
  // Some caches send gzip despite identity negotiation, occasionally without the header.
  if (!encodings.length && body[0] === 0x1f && body[1] === 0x8b) encodings = ["gzip"];
  if (encodings.length > 4)
    throw new AppError(
      502,
      "Le site renvoie trop de couches de compression HTTP.",
      "UNSUPPORTED_CONTENT_ENCODING",
    );
  if (encodings.length) {
    const decoders = encodings
      .reverse()
      .flatMap((encoding) => [decompressor(encoding), new ByteLimit()]);
    const decoded = new BodyBuffer();
    try {
      await pipeline([Readable.from([body]), ...decoders, decoded]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        502,
        "La réponse compressée du site est corrompue ou incomplète.",
        "DECOMPRESSION_FAILED",
      );
    }
    body = decoded.bytes();
  }
  return decodeText(body, response.headers["content-type"]);
}
