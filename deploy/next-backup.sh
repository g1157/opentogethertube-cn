#!/bin/sh
set -eu
umask 077
deployment_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$deployment_dir/backups"
backup_path="$deployment_dir/backups/ott-next-$(date -u +%Y%m%dT%H%M%SZ).dump"
sudo -n docker compose --project-directory "$deployment_dir" -f "$deployment_dir/compose.yml" \
  exec -T postgres pg_dump -U ott -d ott --format=custom > "$backup_path.partial"
mv "$backup_path.partial" "$backup_path"
printf 'Backup saved: %s\n' "$backup_path"

# Retention: keep the newest 14 dumps so the backup directory cannot eat the disk.
ls -1t "$deployment_dir"/backups/ott-next-*.dump 2>/dev/null | tail -n +15 | while IFS= read -r old; do
  rm -f -- "$old"
  printf 'Pruned old backup: %s\n' "$old"
done
