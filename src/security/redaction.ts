const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{12,}\b/g,
  /\b(AUTHORIZATION|PRIVATE-TOKEN|JOB-TOKEN)\s*[:=]\s*[^\s,;]+/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
}

const DENIED_BASENAMES = new Set([
  ".env",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
]);

const DENIED_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);

export function isSensitivePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.split("/").at(-1) ?? "";
  if (DENIED_BASENAMES.has(basename) || basename.startsWith(".env.")) {
    return true;
  }
  return [...DENIED_EXTENSIONS].some((extension) => basename.endsWith(extension));
}
