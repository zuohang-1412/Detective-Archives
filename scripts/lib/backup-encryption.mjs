import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  appendFile,
  constants,
  link,
  lstat,
  open,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const MAGIC = Buffer.from("DABAK001", "ascii");
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + SALT_LENGTH + IV_LENGTH;
const KEY_LENGTH = 32;
const ARCHIVE_PATTERN = /^detective-archives-\d{8}T\d{6}Z\.dump$/;
const ENCRYPTED_ARCHIVE_PATTERN = /^detective-archives-\d{8}T\d{6}Z\.dump\.enc$/;

function validatePassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 32 || passphrase.length > 1024) {
    throw new Error("BACKUP_ENCRYPTION_PASSPHRASE must contain 32 to 1024 characters");
  }
}

function absoluteFilePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(value);
}

async function regularFile(file, label) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file and not a symbolic link`);
  }
  return metadata;
}

async function missing(file, label) {
  try {
    await access(file, constants.F_OK);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists; refusing to overwrite it`);
}

async function deriveKey(passphrase, salt) {
  return scrypt(passphrase, salt, KEY_LENGTH, {
    N: 32_768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function temporaryPath(finalPath) {
  return path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
}

async function publishExclusive(temporaryFile, finalFile) {
  await link(temporaryFile, finalFile);
  try {
    await rm(temporaryFile);
  } catch (error) {
    await rm(finalFile, { force: true });
    throw error;
  }
}

async function syncFile(file) {
  const handle = await open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readEnvelope(encryptedFile) {
  const metadata = await regularFile(encryptedFile, "Encrypted backup");
  if (metadata.size <= HEADER_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted backup is truncated");
  }
  const handle = await open(encryptedFile, "r");
  try {
    const header = Buffer.alloc(HEADER_LENGTH);
    const tag = Buffer.alloc(TAG_LENGTH);
    const headerRead = await handle.read(header, 0, header.length, 0);
    const tagRead = await handle.read(tag, 0, tag.length, metadata.size - TAG_LENGTH);
    if (headerRead.bytesRead !== HEADER_LENGTH || tagRead.bytesRead !== TAG_LENGTH) {
      throw new Error("Encrypted backup is truncated");
    }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("Encrypted backup format or version is unsupported");
    }
    return {
      header,
      salt: header.subarray(MAGIC.length, MAGIC.length + SALT_LENGTH),
      iv: header.subarray(MAGIC.length + SALT_LENGTH),
      tag,
      size: metadata.size,
      plaintextSize: metadata.size - HEADER_LENGTH - TAG_LENGTH
    };
  } finally {
    await handle.close();
  }
}

async function verifyChecksum(encryptedFile, { required = true } = {}) {
  const checksumFile = `${encryptedFile}.sha256`;
  let source;
  try {
    await regularFile(checksumFile, "Encrypted backup checksum");
    source = await readFile(checksumFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return null;
    if (error?.code === "ENOENT") throw new Error("Encrypted backup checksum sidecar is missing");
    throw error;
  }
  const match = source.match(/^([0-9a-f]{64})  ([^\r\n]+)\r?\n$/i);
  if (!match || match[2] !== path.basename(encryptedFile)) {
    throw new Error("Encrypted backup checksum sidecar is invalid");
  }
  const expected = Buffer.from(match[1], "hex");
  const actualHex = await sha256(encryptedFile);
  const actual = Buffer.from(actualHex, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Encrypted backup checksum does not match the archive");
  }
  return { checksumFile, sha256: actualHex };
}

function authenticationError(error) {
  return error?.code === "ERR_OSSL_EVP_BAD_DECRYPT"
    || /authenticate data|authentication tag/i.test(error?.message ?? "");
}

async function decryptPipeline(encryptedFile, passphrase, destination) {
  const envelope = await readEnvelope(encryptedFile);
  const key = await deriveKey(passphrase, envelope.salt);
  const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv);
  decipher.setAAD(envelope.header);
  decipher.setAuthTag(envelope.tag);
  try {
    await pipeline(
      createReadStream(encryptedFile, {
        start: HEADER_LENGTH,
        end: envelope.size - TAG_LENGTH - 1
      }),
      decipher,
      destination
    );
  } catch (error) {
    if (authenticationError(error)) throw new Error("Encrypted backup authentication failed");
    throw error;
  }
  return envelope;
}

export async function encryptBackup({ input, output = `${input}.enc`, passphrase }) {
  validatePassphrase(passphrase);
  const inputFile = absoluteFilePath(input, "Backup input");
  const outputFile = absoluteFilePath(output, "Encrypted backup output");
  if (!ARCHIVE_PATTERN.test(path.basename(inputFile))) {
    throw new Error("Backup input name must match detective-archives-TIMESTAMP.dump");
  }
  if (outputFile !== `${inputFile}.enc`) {
    throw new Error("Encrypted backup output must be the input path with .enc appended");
  }
  const inputMetadata = await regularFile(inputFile, "Backup input");
  if (inputMetadata.size === 0) throw new Error("Backup input must not be empty");
  await missing(outputFile, "Encrypted backup output");
  await missing(`${outputFile}.sha256`, "Encrypted backup checksum");

  const outputDirectory = await realpath(path.dirname(outputFile));
  const canonicalOutput = path.join(outputDirectory, path.basename(outputFile));
  const checksumFile = `${canonicalOutput}.sha256`;
  const temporaryOutput = temporaryPath(canonicalOutput);
  const temporaryChecksum = temporaryPath(checksumFile);
  let outputPublished = false;
  let checksumPublished = false;
  try {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const header = Buffer.concat([MAGIC, salt, iv]);
    const key = await deriveKey(passphrase, salt);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(header);

    await writeFile(temporaryOutput, header, { flag: "wx", mode: 0o600 });
    await pipeline(
      createReadStream(inputFile),
      cipher,
      createWriteStream(temporaryOutput, { flags: "a", mode: 0o600 })
    );
    await appendFile(temporaryOutput, cipher.getAuthTag());
    await syncFile(temporaryOutput);

    const digest = await sha256(temporaryOutput);
    await writeFile(
      temporaryChecksum,
      `${digest}  ${path.basename(canonicalOutput)}\n`,
      { flag: "wx", mode: 0o600 }
    );
    await syncFile(temporaryChecksum);
    await publishExclusive(temporaryOutput, canonicalOutput);
    outputPublished = true;
    await publishExclusive(temporaryChecksum, checksumFile);
    checksumPublished = true;

    return {
      encryptedFile: canonicalOutput,
      checksumFile,
      plaintextBytes: inputMetadata.size,
      encryptedBytes: (await lstat(canonicalOutput)).size,
      sha256: digest,
      algorithm: "aes-256-gcm+scrypt"
    };
  } finally {
    await rm(temporaryOutput, { force: true });
    await rm(temporaryChecksum, { force: true });
    if (outputPublished && !checksumPublished) await rm(canonicalOutput, { force: true });
  }
}

export async function verifyEncryptedBackup({ input, passphrase, requireChecksum = true }) {
  validatePassphrase(passphrase);
  const inputFile = absoluteFilePath(input, "Encrypted backup input");
  if (!ENCRYPTED_ARCHIVE_PATTERN.test(path.basename(inputFile))) {
    throw new Error("Encrypted backup name must match detective-archives-TIMESTAMP.dump.enc");
  }
  const checksum = await verifyChecksum(inputFile, { required: requireChecksum });
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const envelope = await decryptPipeline(inputFile, passphrase, sink);
  return {
    encryptedFile: inputFile,
    checksumFile: checksum?.checksumFile ?? null,
    plaintextBytes: envelope.plaintextSize,
    encryptedBytes: envelope.size,
    sha256: checksum?.sha256 ?? null,
    authenticated: true
  };
}

export async function decryptBackup({ input, output, passphrase }) {
  validatePassphrase(passphrase);
  const inputFile = absoluteFilePath(input, "Encrypted backup input");
  const outputFile = absoluteFilePath(output, "Decrypted backup output");
  if (!ENCRYPTED_ARCHIVE_PATTERN.test(path.basename(inputFile))) {
    throw new Error("Encrypted backup name must match detective-archives-TIMESTAMP.dump.enc");
  }
  if (!outputFile.endsWith(".dump")) {
    throw new Error("Decrypted backup output must end with .dump");
  }
  await regularFile(inputFile, "Encrypted backup input");
  await missing(outputFile, "Decrypted backup output");
  await verifyChecksum(inputFile);

  const outputDirectory = await realpath(path.dirname(outputFile));
  const canonicalOutput = path.join(outputDirectory, path.basename(outputFile));
  const temporaryOutput = temporaryPath(canonicalOutput);
  try {
    await writeFile(temporaryOutput, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
    const envelope = await decryptPipeline(
      inputFile,
      passphrase,
      createWriteStream(temporaryOutput, { flags: "a", mode: 0o600 })
    );
    await syncFile(temporaryOutput);
    await publishExclusive(temporaryOutput, canonicalOutput);
    return {
      encryptedFile: inputFile,
      decryptedFile: canonicalOutput,
      plaintextBytes: envelope.plaintextSize,
      sha256: await sha256(canonicalOutput),
      authenticated: true
    };
  } finally {
    await rm(temporaryOutput, { force: true });
  }
}
