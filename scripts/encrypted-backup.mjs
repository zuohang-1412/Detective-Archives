import {
  decryptBackup,
  encryptBackup,
  verifyEncryptedBackup
} from "./lib/backup-encryption.mjs";

const [command, input, output, ...extra] = process.argv.slice(2);
if (extra.length > 0 || !["encrypt", "decrypt", "verify"].includes(command)) {
  throw new Error(
    "Usage: encrypted-backup.mjs encrypt INPUT [OUTPUT] | decrypt INPUT OUTPUT | verify INPUT"
  );
}
if (!input) throw new Error("An absolute backup input path is required");

const passphrase = process.env.BACKUP_ENCRYPTION_PASSPHRASE;
let result;
if (command === "encrypt") {
  result = await encryptBackup({ input, ...(output ? { output } : {}), passphrase });
} else if (command === "decrypt") {
  if (!output) throw new Error("An absolute decrypted output path is required");
  result = await decryptBackup({ input, output, passphrase });
} else {
  if (output) throw new Error("verify does not accept an output path");
  result = await verifyEncryptedBackup({ input, passphrase });
}

console.log(JSON.stringify({
  status: `encrypted_backup_${command}_ok`,
  ...result
}, null, 2));
