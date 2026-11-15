# Home server FrecklesNight + Radarr/Sonarr

Piano rivisto il 13 novembre 2026, scritto sui dati reali di questo PC.

## La macchina

| | |
|---|---|
| Modello | HP Compaq 8200 Elite (desktop, non portatile) |
| Sistema | Linux Mint 22.3 XFCE, 64 bit |
| CPU | Intel i5-2400, 4 core, grafica integrata HD 2000 |
| RAM | 8 GB |
| Disco 1 (`sda`, 931 GB) | sistema (124 GB, ext4) + volume NTFS "New Volume" da 806 GB con la libreria attuale |
| Disco 2 (`sdb`, 465 GB) | ext4, quasi vuoto |
| Indirizzo in LAN | `192.168.1.10` |
| FrecklesNight | Node 22 senza dipendenze + ffmpeg, in `/home/vaith/Server/FRECKLES-SERVER` |

RAM e CPU bastano per Radarr, Sonarr, Prowlarr e qBittorrent insieme. Il limite è la conversione video: senza scheda video adatta passa tutta dal processore, quindi conviene scaricare formati che i dispositivi leggono da soli (vedi passo 10).

## Già fatto

- FrecklesNight gira su Linux, porta `8787`, con progressi e anteprime conservati.
- Parte da solo all'accensione (servizio utente `frecklesnight`, verificato con un riavvio).
- Si accorge dei nuovi file da solo: riscansiona ogni 10 minuti, oppure subito con `GET /api/rescan`.
- Pannello di controllo su `http://localhost:8788` (servizio `frecklesnight-admin`).
- Legge `Film` e `SerataTeleFilm` su entrambi i dischi.
- Claude Code è già installato su questo PC (passo 13 del piano originale).

## Cosa cambia rispetto al piano originale

1. **FrecklesNight resta fuori da Docker.** Funziona già come servizio di sistema e non ha dipendenze. Metterlo in un container significa costruire un'immagine con Node e ffmpeg e non porta vantaggi.
2. **I percorsi dei video non si cambiano alla leggera.** FrecklesNight identifica ogni file dal suo percorso: se il percorso cambia, progressi, anteprime e sottotitoli estratti restano orfani. Il passaggio a `/mnt/...` del passo 7 va fatto una volta sola, seguito dalla conversione degli id (la stessa già fatta nel passaggio da Windows).
3. **Radarr non gestisce la libreria vecchia.** Radarr vuole una cartella per ogni film, mentre i film attuali sono file sciolti in `Film`. Importarli vorrebbe dire spostarli tutti. Soluzione: Radarr e Sonarr lavorano solo sul disco da 500 GB; il volume NTFS resta un archivio che legge solo FrecklesNight.
4. **Download e libreria sullo stesso disco.** Solo così lo spostamento a fine download è istantaneo e senza doppia copia. Per questo anche la cartella dei download va sul disco da 500 GB.
5. **Serve un IP fisso.** L'app della TV e `nightUrl` puntano a `192.168.1.10`: va riservato nel router, altrimenti un giorno cambia.
6. **Il server non deve dipendere dal login grafico.** Oggi dischi e servizi partono perché Mint fa l'accesso automatico. Con `fstab` e il "linger" partono anche senza schermo e senza sessione.
7. **Sonarr vuole il `tvdbId`, FrecklesNight conosce solo il `tmdbId`.** Va previsto un passaggio di conversione nell'app (passo 14).

## Passi

### 6. SSH e rete

```
sudo apt update && sudo apt install -y openssh-server
sudo systemctl enable --now ssh
```

- Nel router: riservare `192.168.1.10` a questo PC (DHCP statico).
- Nel BIOS: "After Power Loss → Power On", così riparte da solo dopo un blackout.
- In XFCE, Gestione energia: sospensione disattivata.
- Dal PC principale: `ssh vaith@192.168.1.10`. Meglio poi passare alle chiavi (`ssh-copy-id`) e disattivare l'accesso con password.

### 7. Dischi montati in modo permanente

```
sudo mkdir -p /mnt/video /mnt/archivio
```

Righe da aggiungere a `/etc/fstab`:

```
UUID=7cfdaac5-7183-4e92-894a-cc3ea48105bf  /mnt/video     ext4     defaults,nofail                      0 2
UUID=FC1401DB140199B2                      /mnt/archivio  ntfs-3g  uid=1000,gid=1000,umask=022,nofail   0 0
```

`nofail` evita che il PC si blocchi all'avvio se un disco manca. Prova con `sudo mount -a` prima di riavviare.

Struttura del disco da 500 GB:

```
/mnt/video/Film             film scaricati (Radarr)
/mnt/video/SerataTeleFilm   serie scaricate (Sonarr)
/mnt/video/downloads        download in corso (qBittorrent)
```

Subito dopo, in una sola sessione:

- aggiornare `config.json` di FrecklesNight con `/mnt/video/...` e `/mnt/archivio/...`;
- convertire gli id salvati in `data/` ai nuovi percorsi;
- togliere da `start.sh` il montaggio con `udisksctl`, che non serve più;
- `sudo loginctl enable-linger vaith`, così i servizi partono senza login.

### 8. Docker

Su Mint il repository di Docker va puntato alla versione di Ubuntu su cui Mint si basa (`noble`), non al nome di Mint:

```
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker vaith     # poi uscire e rientrare
```

### 9. `docker-compose.yml`

In `/home/vaith/Server/arr/docker-compose.yml`:

```yaml
x-base: &base
  restart: unless-stopped
  environment:
    - PUID=1000
    - PGID=1000
    - TZ=Europe/Rome

services:
  prowlarr:
    <<: *base
    image: lscr.io/linuxserver/prowlarr:latest
    volumes:
      - ./config/prowlarr:/config
    ports:
      - "9696:9696"

  radarr:
    <<: *base
    image: lscr.io/linuxserver/radarr:latest
    volumes:
      - ./config/radarr:/config
      - /mnt/video:/data
    ports:
      - "7878:7878"

  sonarr:
    <<: *base
    image: lscr.io/linuxserver/sonarr:latest
    volumes:
      - ./config/sonarr:/config
      - /mnt/video:/data
    ports:
      - "8989:8989"

  qbittorrent:
    <<: *base
    image: lscr.io/linuxserver/qbittorrent:latest
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Rome
      - WEBUI_PORT=8080
    volumes:
      - ./config/qbittorrent:/config
      - /mnt/video:/data
    ports:
      - "8080:8080"
      - "6881:6881"
      - "6881:6881/udp"
```

Tutti e tre i container vedono lo stesso `/data`: è questo che rende istantaneo lo spostamento a fine download. Avvio con `docker compose up -d`.

### 10. Configurazione dalle interfacce web

Da un browser del PC principale, su `http://192.168.1.10:<porta>`.

- **qBittorrent (`:8080`)**: la password temporanea è in `docker logs qbittorrent`; cambiarla subito. Cartella di salvataggio `/data/downloads`. Impostare un limite di condivisione, altrimenti i download finiti restano e riempiono il disco.
- **Prowlarr (`:9696`)**: attivare l'autenticazione, aggiungere gli indexer, poi in *Apps* collegare Radarr (`http://radarr:7878`) e Sonarr (`http://sonarr:8989`) con le loro API key.
- **Radarr (`:7878`)**: autenticazione attiva; root folder `/data/Film`; download client qBittorrent con host `qbittorrent`, porta `8080`.
- **Sonarr (`:8989`)**: come Radarr, con root folder `/data/SerataTeleFilm`.
- **Rescan immediato**: in Radarr e Sonarr, *Connect → Webhook* su importazione, URL `http://192.168.1.10:8787/api/rescan`. Senza, il film compare comunque entro 10 minuti.
- **Profili di qualità**: preferire 1080p H.264 o HEVC a 8 bit. I 4K HEVC a 10 bit vanno bene solo sulla TV; sugli altri dispositivi richiederebbero la conversione, che questo processore non regge.
- **Spazio**: 500 GB sono pochi. Impostare in Radarr/Sonarr lo spazio libero minimo e spostare ogni tanto i titoli visti in `/mnt/archivio`.

Le API key di Radarr e Sonarr sono in *Settings → General*: serviranno all'app.

### 11. Verifica di FrecklesNight

- Scaricare un film di prova e controllare che compaia nell'app con copertina e trama.
- Controllare che un riavvio del PC faccia ripartire tutto senza login: FrecklesNight, pannello e container.
- `nightUrl` nell'app Android: `http://192.168.1.10:8787`.

Nomi delle cartelle compatibili con FrecklesNight: `Film/Titolo (Anno)/file.mkv` per Radarr e `SerataTeleFilm/Serie/Season 01/...S01E01...` per Sonarr funzionano entrambi senza modifiche.

### 12. Tailscale (facoltativo)

```
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Installarlo anche sul telefono con lo stesso account. Fuori casa `nightUrl` diventa l'indirizzo Tailscale del server (`100.x.y.z` o il nome MagicDNS). Lo stesso indirizzo funziona anche in casa, dove il traffico resta diretto in LAN, quindi si può usare sempre quello se Tailscale resta acceso sul telefono.

FrecklesNight non ha password: Tailscale è il modo giusto per uscire di casa, mai il port forwarding.

### 13. Sicurezza e manutenzione

- Nessun port forwarding sul router per `7878`, `8989`, `9696`, `8080`, `8787`, `8788`.
- Nel router, UPnP spento oppure controllato: qBittorrent può aprire da solo la porta dei torrent, che è normale, ma non deve aprirsi altro.
- Docker scavalca `ufw` per le porte pubblicate: il firewall del PC non le protegge, le protegge il router.
- Copia periodica di `arr/config/` e di `FRECKLES-SERVER/data/`: lì stanno tutte le impostazioni e i progressi.
- Aggiornamenti: `docker compose pull && docker compose up -d`.

### 14. L'app Android

- `RadarrApi` e `SonarrApi` sullo stile di `NightApi.kt`, con header `X-Api-Key`; URL e chiavi in `UserPrefs` e Impostazioni.
- Per riempire i menu servono `GET /api/v3/qualityprofile` e `GET /api/v3/rootfolder`.
- **Film**: `GET /api/v3/movie/lookup/tmdb?tmdbId=<id>`, poi `POST /api/v3/movie` con `qualityProfileId`, `rootFolderPath`, `monitored: true` e `addOptions: { searchForMovie: true }`.
- **Serie**: `GET /api/v3/series/lookup?term=tvdb:<id>`, poi `POST /api/v3/series` con `addOptions: { searchForMissingEpisodes: true }`.
- **Da tmdbId a tvdbId**: `GET https://api.themoviedb.org/3/tv/<tmdbId>/external_ids` restituisce `tvdb_id`.
- **Coda**: `GET /api/v3/queue` su entrambi; mostra avanzamento e tempo rimanente.
- Prima di mostrare "Scarica", controllare se il titolo esiste già (`GET /api/v3/movie?tmdbId=<id>`), per non aggiungerlo due volte.
- Gli endpoint qui sopra sono scritti a memoria: verificarli sulla documentazione ufficiale (`https://radarr.video/docs/api/` e `https://sonarr.tv/docs/api/`) prima di scrivere il codice.

## Ancora da decidere

- **Torrent o Usenet.** Il piano qui sopra assume torrent con qBittorrent. Con Usenet si sostituisce il container con SABnzbd (porta `8080` anch'esso) e il resto non cambia.
- **Il volume NTFS.** Funziona, ma su Linux è più lento e non adatto a Radarr/Sonarr. A lungo termine conviene svuotarlo e riformattarlo in ext4; richiede un posto dove appoggiare 640 GB di dati.
