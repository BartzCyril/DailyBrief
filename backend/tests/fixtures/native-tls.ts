import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

/** Create a one-use self-signed test certificate entirely in memory.
 * No test private key is committed, persisted, printed or used outside loopback.
 */
export function nativeTlsFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = (tag: number, body: Buffer): Buffer => {
    const size = body.length;
    const length =
      size < 128
        ? Buffer.from([size])
        : size < 256
          ? Buffer.from([0x81, size])
          : Buffer.from([0x82, size >> 8, size & 255]);
    return Buffer.concat([Buffer.from([tag]), length, body]);
  };
  const sequence = (...values: Buffer[]) => der(0x30, Buffer.concat(values));
  const algorithm = sequence(
    der(0x06, Buffer.from("2a864886f70d01010b", "hex")),
    der(0x05, Buffer.alloc(0)),
  );
  const name = sequence(
    der(
      0x31,
      sequence(der(0x06, Buffer.from("550403", "hex")), der(0x0c, Buffer.from("publisher.test"))),
    ),
  );
  const time = (offset: number) =>
    der(
      0x18,
      Buffer.from(
        new Date(Date.now() + offset)
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/T/, "")
          .replace(/\.\d{3}Z$/, "Z"),
      ),
    );
  const serial = randomBytes(16);
  serial[0] = serial[0]! | 0x80;
  const certificate = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.concat([Buffer.from([0]), serial])),
    algorithm,
    name,
    sequence(time(-86400000), time(86400000)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signed = sequence(
    certificate,
    algorithm,
    der(0x03, Buffer.concat([Buffer.from([0]), sign("sha256", certificate, privateKey)])),
  );
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: `-----BEGIN CERTIFICATE-----\n${signed
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n")}\n-----END CERTIFICATE-----`,
  };
}
