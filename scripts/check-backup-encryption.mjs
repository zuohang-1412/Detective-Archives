import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  decryptBackup,
  encryptBackup,
  verifyEncryptedBackup
} from "./lib/backup-encryption.mjs";

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "detective-backup-encryption-"));
const backup = path.join(temporaryDirectory, "detective-archives-20260722T000000Z.dump");
const encrypted = `${backup}.enc`;
const checksum = `${encrypted}.sha256`;
const restoreDirectory = path.join(temporaryDirectory, "restore");
const restored = path.join(restoreDirectory, "restored.dump");
const passphrase = "correct horse battery staple for encrypted database backups";
const source = Buffer.concat([
  Buffer.from("PostgreSQL custom backup fixture\n"),
  randomBytes(2 * 1024 * 1024)
]);

try {
  await mkdir(restoreDirectory);
  await writeFile(backup, source, { mode: 0o600 });
  const encryptedResult = await encryptBackup({ input: backup, passphrase });
  assert.equal(encryptedResult.algorithm, "aes-256-gcm+scrypt");
  assert.equal(encryptedResult.plaintextBytes, source.length);
  assert.equal(encryptedResult.encryptedFile, encrypted);
  assert.equal(encryptedResult.checksumFile, checksum);
  assert.ok((await lstat(encrypted)).size > source.length);
  assert.match(await readFile(checksum, "utf8"), /^[0-9a-f]{64}  detective-archives-.*\.dump\.enc\n$/);
  assert.notDeepEqual((await readFile(encrypted)).subarray(0, 32), source.subarray(0, 32));

  const verification = await verifyEncryptedBackup({ input: encrypted, passphrase });
  assert.equal(verification.authenticated, true);
  assert.equal(verification.plaintextBytes, source.length);
  assert.ok(verification.sha256);

  const decrypted = await decryptBackup({ input: encrypted, output: restored, passphrase });
  assert.equal(decrypted.authenticated, true);
  assert.deepEqual(await readFile(restored), source);
  if (process.platform !== "win32") {
    assert.equal((await lstat(restored)).mode & 0o777, 0o600);
  }

  await assert.rejects(
    encryptBackup({ input: backup, passphrase }),
    /refusing to overwrite/
  );
  await assert.rejects(
    decryptBackup({ input: encrypted, output: restored, passphrase }),
    /refusing to overwrite/
  );
  await assert.rejects(
    verifyEncryptedBackup({ input: encrypted, passphrase: "wrong passphrase that is still long enough 123" }),
    /authentication failed/
  );
  await assert.rejects(
    encryptBackup({ input: backup, passphrase: "too-short" }),
    /32 to 1024 characters/
  );

  const tampered = path.join(temporaryDirectory, "detective-archives-20260722T000001Z.dump.enc");
  await copyFile(encrypted, tampered);
  const tamperedHandle = await open(tampered, "r+");
  try {
    const changed = Buffer.alloc(1);
    await tamperedHandle.read(changed, 0, 1, 64);
    changed[0] ^= 0xff;
    await tamperedHandle.write(changed, 0, 1, 64);
  } finally {
    await tamperedHandle.close();
  }
  await assert.rejects(
    verifyEncryptedBackup({ input: tampered, passphrase, requireChecksum: false }),
    /authentication failed/
  );

  const truncated = path.join(temporaryDirectory, "detective-archives-20260722T000002Z.dump.enc");
  await writeFile(truncated, Buffer.from("DABAK001"));
  await assert.rejects(
    verifyEncryptedBackup({ input: truncated, passphrase, requireChecksum: false }),
    /truncated/
  );

  const missingChecksum = path.join(temporaryDirectory, "detective-archives-20260722T000003Z.dump.enc");
  await copyFile(encrypted, missingChecksum);
  await assert.rejects(
    verifyEncryptedBackup({ input: missingChecksum, passphrase }),
    /checksum sidecar is missing/
  );

  const concurrentBackup = path.join(temporaryDirectory, "detective-archives-20260722T000004Z.dump");
  await writeFile(concurrentBackup, source, { mode: 0o600 });
  const concurrent = await Promise.allSettled([
    encryptBackup({ input: concurrentBackup, passphrase }),
    encryptBackup({ input: concurrentBackup, passphrase })
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
  await verifyEncryptedBackup({ input: `${concurrentBackup}.enc`, passphrase });

  const symlinked = path.join(temporaryDirectory, "detective-archives-20260722T000005Z.dump");
  try {
    await symlink(backup, symlinked, "file");
    await assert.rejects(
      encryptBackup({ input: symlinked, passphrase }),
      /regular file and not a symbolic link/
    );
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) throw error;
  }

  console.log(
    "Encrypted off-host backup: OK (streaming round-trip, checksum, authentication, no-overwrite and concurrency)"
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
