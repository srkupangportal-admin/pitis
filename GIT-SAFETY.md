# Safe Git and deployment boundary

This repository stores application source code only. Production and local
runtime data must remain outside Git.

Never commit or push:

- completed `.env` files or secrets;
- SQLite databases or their WAL/SHM files;
- backups or private migration snapshots;
- uploaded pupil/staff files or photos;
- certificates, private keys, logs, or dependency folders.

Before committing, run:

```powershell
npm.cmd run check:git-safety
```

Before pushing, the repository's configured pre-push hook also checks the
history reachable from the current commit. Deploy code from the allowlisted
host release; transfer databases and uploads only through the private migration
process.
