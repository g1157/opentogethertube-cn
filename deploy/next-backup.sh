#!/bin/sh
set -eu
umask 077
deployment_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$deployment_dir/backups"
backup_path="$deployment_dir/backups/ott-next-$(date -u +%Y%m%dT%H%M%SZ).dump"
# A dump that failed part-way leaves only the `.partial` file (the `mv` never runs). Those
# were outside the retention glob and accumulated forever, each looking like a usable
# backup to anyone glancing at the directory.
cleanup_partial() {
	rm -f -- "$backup_path.partial"
}
trap cleanup_partial EXIT HUP INT TERM
sudo -n docker compose --project-directory "$deployment_dir" -f "$deployment_dir/compose.yml" \
  exec -T postgres pg_dump -U ott -d ott --format=custom > "$backup_path.partial"
mv "$backup_path.partial" "$backup_path"
trap - EXIT HUP INT TERM
printf 'Backup saved: %s\n' "$backup_path"

# Retention: keep the newest 14 dumps so the backup directory cannot eat the disk.
ls -1t "$deployment_dir"/backups/ott-next-*.dump 2>/dev/null | tail -n +15 | while IFS= read -r old; do
  rm -f -- "$old"
  printf 'Pruned old backup: %s\n' "$old"
done

# Also sweep any `.partial` left by an older run that was killed before this trap existed.
find "$deployment_dir/backups" -name 'ott-next-*.dump.partial' -mtime +0 -delete 2>/dev/null || true

# Restoring is a manual step on purpose: `pg_restore -U ott -d ott --clean <file>`, run
# against a stopped application. Nothing in this repository automates it, so a reader
# should not assume the backup is proven restorable.
printf 'Restore with: pg_restore -U ott -d ott --clean <file>\n'
