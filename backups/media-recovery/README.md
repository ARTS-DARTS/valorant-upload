# Media recovery snapshots

This directory contains encrypted recovery manifests for lineup media. The
repository is public, so raw Firestore exports and decryption keys must never be
committed.

Each encrypted snapshot contains lineup identifiers, public content metadata,
video URLs, screenshot URLs, and Spike placement fields needed to restore media
references. User identities, email addresses, moderation notes, payments, and
credentials are excluded before encryption.

The matching key is stored outside the repository in
`D:\Projects\valorant\private-backups`. Keep a separate offline copy of that key.

Generate a snapshot from the repository root:

```powershell
node scripts/export-media-recovery-snapshot.mjs `
  --credentials=D:\path\to\firebase-service-account.json `
  --output=backups\media-recovery `
  --key-output=D:\Projects\valorant\private-backups
```

Verify that a snapshot and its separately stored key match:

```powershell
node scripts/decrypt-media-recovery-snapshot.mjs `
  --input=backups\media-recovery\lineups-media-2026-08-26.json.enc `
  --key=D:\Projects\valorant\private-backups\lineups-media-2026-08-26.key.txt
```
