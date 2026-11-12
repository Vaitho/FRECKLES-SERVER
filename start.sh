#!/usr/bin/env bash
# Avvia FrecklesNight su Linux: aspetta (e se serve monta) il disco dei film, poi lancia il server.
# Lo esegue il servizio utente ~/.config/systemd/user/frecklesnight.service ad ogni accesso.
cd "$(dirname "$(readlink -f "$0")")" || exit 1
export PATH="$HOME/.local/bin:$PATH" # node e ffmpeg sono installati qui

DISK_UUID=FC1401DB140199B2 # il volume NTFS con Film e SerataTeleFilm
dev=/dev/disk/by-uuid/$DISK_UUID

# Senza disco il server partirebbe con la libreria vuota: aspetto fino a 2 minuti.
for _ in $(seq 60); do
  findmnt -rn -S "UUID=$DISK_UUID" >/dev/null && break
  [ -e "$dev" ] && udisksctl mount -b "$dev" >/dev/null 2>&1
  sleep 2
done
findmnt -rn -S "UUID=$DISK_UUID" >/dev/null || echo "Disco dei film non montato: avvio comunque" >&2

exec node server.js
