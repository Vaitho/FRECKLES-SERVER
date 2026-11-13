#!/usr/bin/env bash
# Avvia FrecklesNight su Linux: aspetta (e se serve monta) il disco dei film, poi lancia il server.
# Lo esegue il servizio utente ~/.config/systemd/user/frecklesnight.service ad ogni accesso.
cd "$(dirname "$(readlink -f "$0")")" || exit 1
export PATH="$HOME/.local/bin:$PATH" # node e ffmpeg sono installati qui

# I dischi con Film e SerataTeleFilm: il volume NTFS da 800 GB e quello ext4 da 500 GB
DISKS="FC1401DB140199B2 7cfdaac5-7183-4e92-894a-cc3ea48105bf"

mounted() { findmnt -rn -S "UUID=$1" >/dev/null; }

# Senza dischi il server partirebbe con la libreria vuota: aspetto fino a 2 minuti.
for _ in $(seq 60); do
  missing=0
  for u in $DISKS; do
    mounted "$u" && continue
    missing=1
    [ -e "/dev/disk/by-uuid/$u" ] && udisksctl mount -b "/dev/disk/by-uuid/$u" >/dev/null 2>&1
  done
  [ $missing = 0 ] && break
  sleep 2
done
for u in $DISKS; do mounted "$u" || echo "Disco $u non montato: avvio comunque" >&2; done

exec node server.js
