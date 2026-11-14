# Chat d'équipe

Messagerie de chatroom unique, minimaliste et **auto-hébergeable**, pensée pour une petite
entreprise qui veut faire tourner la discussion sur **ses propres serveurs** (par ex. une VM
Scaleway), avec une **intégration LLM configurable** : la chatroom profite du modèle de votre
choix pour faire des comptes-rendus de réunion ou proposer des solutions aux problèmes soulevés.

## Mode d'emploi (utilisateur)

**Envoyer un fichier (audio, PDF, doc…) dans la conversation**
1. Bouton **trombone** à gauche de la zone de message → choisir le fichier (le texte saisi sert de légende).
2. Le fichier est posté dans la chat (chip cliquable pour le télécharger/relire) **et** déposé dans
   l'**espace documentaire** (icône **dossier** en haut à droite : recherche, dépôt, téléchargement).
3. **Fichier audio** (`.webm`, `.mp3`, `.wav`…) : il est **transcrit automatiquement** si le STT est
   configuré → la transcription `.txt` apparaît dans l'espace documentaire. Sinon, bouton
   **🎙️ Transcrire** sur la ligne du fichier dans l'espace documentaire.

**Télécharger et résumer un média distant (émission radio, podcast…)**
- Colle simplement le lien dans la chat (ex. un `.m4a` de 1 h) → il est téléchargé automatiquement, ou
  utilise la commande **`/lien <url> [titre]`**. Le bot poste un récap : média original déposé,
  transcription (STT), copie **webm/opus** (archivage léger, via ffmpeg), et **compte-rendu** généré par le LLM.
- Garde-fous : `LINK_FETCH_ALLOWED_DOMAINS` (liste blanche de domaines, `*.` supporté), IP privées/localhost
  bloquées (anti-SSRF), plafond `MAX_LINK_FETCH_MB` (500 Mo par défaut).

**Démarrer / rejoindre un appel (audio + caméra optionnelle + partage d'écran)**
1. Bouton **📞 téléphone** en haut → « Démarrer l'appel » (titre optionnel). Les autres voient une
   pastille rouge sur le 📞 et peuvent « Rejoindre l'appel ».
2. Dans l'appel : micro on/off, **📷 caméra** (optionnelle), **🖥️ partage d'écran**, **REC**
   (enregistrement partagé de tout l'appel, pastille `REC — <nom>` synchronisée pour tous), « Quitter l'appel » ou « Terminer l'appel » (pour tout le monde).

> **Appels depuis un téléphone / entre réseaux différents (4G ↔ box)** : le serveur **TURN (coturn)**
> tourne dans `docker-compose`. Réglage obligatoire dans le `.env` de la VM :
> `TURN_EXTERNAL_IP=<IP publique de la VM>`, `TURN_URLS=turn:<IP publique>:3478`,
> `TURN_USERNAME` / `TURN_CREDENTIAL`. Security group Scaleway : ouvrir **UDP 3478** et **UDP 49160-49200**.
> Sans TURN, la signalisation passe (la session « démarre ») mais **aucun média ne circule** (pas de son ni
> d'image) entre deux réseaux NAT différents — symptôme classique.
> **iOS** : Safari iPhone/iPad ne supporte pas `getDisplayMedia` → partage d'écran impossible depuis un iPhone
> (message explicite affiché) ; PC ou Android requis pour partager son écran. Caméra et audio OK sur iOS.
> **Contexte sécurisé requis** : micro/caméra/écran exigent HTTPS (`https://…`) ou `http://localhost`
> (tunnel SSH `ssh -L 4000:127.0.0.1:4000 root@<IP>`).

**Enregistrer → transcrire → archiver → résumer → relire**
1. REC pendant l'appel, second clic pour arrêter (n'importe qui peut arrêter) : l'audio est envoyé au serveur, posté dans la chat
   et déposé dans l'espace documentaire (lié à l'appel).
2. Si le STT est configuré, la **transcription brute** est déposée automatiquement dans l'espace
   documentaire (et indexée par le RAG : interrogeable avec `/ask`).
3. Sur la ligne de la transcription dans l'espace documentaire : icônes **Résumé** et
   **Compte-rendu** → génèrent un fichier `.md` déposé à son tour (coût tracé dans le dashboard admin).
4. Relire : bouton **télécharger** sur n'importe quel fichier de l'espace documentaire.

**Commandes LLM dans la chat** : `/resume [n]`, `/solve <problème>`, `/ask <question>`, `/lien <url> [titre]`, `/aide`.

## Fonctionnalités

- Chatroom unique en **temps réel** (WebSocket), interface **Material UI** responsive
- **Présence** : pastilles des membres en haut à droite (vert = en ligne, gris = hors ligne), avec détail au clic
- Comptes simples : nom d'utilisateur + mot de passe (hash bcrypt, sessions JWT 30 jours)
- Historique persistant en **SQLite** (fichier unique, sauvegardable)
- **Fichiers** : pièce jointe à n'importe quel message (bouton trombone) + **espace documentaire** dédié
  (bouton dossier en haut à droite : recherche, dépôt, téléchargement). Les fichiers texte/PDF sont
  indexés automatiquement, les fichiers audio transcrits (STT)
- **/lien** : médias distants (émissions radio…) téléchargés, transcrits, CR auto, copie webm
- **RAG** : `/ask` et `/solve` fouillent les documents déposés et citent leurs sources
- **Dashboard d'administration** (réservé aux noms de `ADMIN_NAMES`) : volume de tokens
  (entrée/sortie/total), **estimation du coût** en USD, activité par jour/commande/modèle, volumétrie
  messages/membres/documents/appels
- **Appels d'équipe** (bouton téléphone en haut) : WebRTC en mesh, audio + caméra optionnelle + partage
  d'écran, enregistrement partagé (REC synchronisé), TURN coturn pour les appels cross-réseaux
- **Transcription des appels et notes vocales** : transcription brute déposée automatiquement dans
  l'espace documentaire — indexée par le RAG ; boutons **Résumé** et **Compte-rendu** (LLM) sur chaque
  transcription
- **VPN WireGuard** intégré pour donner au PC et au téléphone une IP fixe (filtrage par IP possible)
- **Commandes LLM** dans la chatroom : le résultat est posté par le bot « Assistant »

| Commande | Effet |
| --- | --- |
| `/resume [n]` | Compte-rendu des `n` derniers messages (50 par défaut) : thèmes, décisions, actions à suivre, questions ouvertes |
| `/solve <problème>` | 2 à 4 pistes de solution concrètes pour un problème soulevé dans la chatroom |
| `/ask <question>` | Réponse à une question, en s'appuyant sur la chatroom **et les documents déposés (RAG)** |
| `/lien <url> [titre]` | Télécharge le média, le transcrit (STT), génère un CR, archive une copie webm (ffmpeg) |
| `/aide` | Liste des commandes |

## Stack

- **Backend** : Node.js 22 + TypeScript, Express (REST), `ws` (WebSocket), `node:sqlite`, `bcryptjs`, `jsonwebtoken`, `multer` (upload), `ffmpeg` (transcodage webm)
- **Frontend** : React 18 + Vite + TypeScript + Material UI (`@mui/material`) + WebRTC natif (appels mesh)
- **Déploiement** : conteneurs Docker (`chat` + `coturn` TURN + `wireguard` VPN + `caddy` optionnel HTTPS), volume `chat-data` pour les données

## Configuration du LLM

Tout se configure par variables d'environnement (voir `.env.example`). Aucune dépendance à un
fournisseur précis : choisissez le vôtre.

| Fournisseur | `LLM_PROVIDER` | `LLM_BASE_URL` (défaut) | `LLM_API_KEY` | Exemple de `LLM_MODEL` |
| --- | --- | --- | --- | --- |
| OpenAI | `openai` (ou `openai-compatible`) | `https://api.openai.com/v1` | oui | `gpt-4o-mini` |
| Anthropic | `anthropic` | `https://api.anthropic.com` | oui | `claude-sonnet-4-5` |
| Mistral AI | `mistral` | `https://api.mistral.ai/v1` | oui | `mistral-small-latest` |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` | oui | `openai/gpt-4o-mini` |
| Groq | `groq` | `https://api.groq.com/openai/v1` | oui | `llama-3.3-70b-versatile` |
| Ollama (local, gratuit) | `ollama` | `http://127.0.0.1:11434/v1` | non | `llama3.2` |
| Autre compatible OpenAI (vLLM, LM Studio…) | `openai-compatible` | **votre URL** (requis) | selon le serveur | votre modèle |

Autres variables : `LLM_TEMPERATURE` (0.4), `LLM_MAX_TOKENS` (1024), `LLM_CONTEXT_MESSAGES`
(nombre de messages envoyés comme contexte au LLM, 50).

### Coût et administration

- `ADMIN_NAMES=alice,bob` : ces utilisateurs voient l'icône **dashboard** (en haut à droite) avec les
  tokens consommés et le coût estimé. Les prix par modèle sont intégrés pour les modèles usuels ;
  sinon définir `LLM_INPUT_PRICE_PER_1M` et `LLM_OUTPUT_PRICE_PER_1M` (USD / million de tokens).
- Chaque appel LLM est enregistré (commande, modèle, tokens entrée/sortie, coût, erreurs) dans la
  table `llm_usage`.

### VPN WireGuard (IP fixe pour le PC et le téléphone)

Un service `wireguard` (image `linuxserver/wireguard`) tourne dans `docker-compose` :

```bash
# .env : WG_SERVERURL=chat.tonentreprise.fr   (ou IP publique ; auto = détection)
docker compose up -d --build
# récupérer la config du téléphone (QR code à scanner avec l'app WireGuard iOS/Android) :
docker compose logs wireguard
# ou dans le volume : wg-config/peer_telephone/peer_telephone.conf (+ .png)
```

- Réseau du tunnel : `10.66.66.0/24` (PC = 10.66.66.2, téléphone = 10.66.66.3, VM = 10.66.66.1), `ALLOWEDIPS=0.0.0.0/0` (tunnel complet : tout le trafic du téléphone sort par la VM).
- **Security group** : ouvrir **UDP 51820** à 0.0.0.0/0 (le handshake WG doit être joignable de partout). Le trafic HTTPS du téléphone vers la VM arrive ensuite par l'interface `wg0` : il n'est **pas** re-filtré par le security group, donc la règle TCP 443 peut rester limitée à l'IP publique de ton PC (/32) — le téléphone y accède quand même via le VPN.
- Garder TCP 80 ouvert à tous pour le renouvellement Let's Encrypt (défi HTTP-01 de Caddy).

### Appels, enregistrement et transcription (STT)

- Appel WebRTC **mesh** (pair-à-pair) : le serveur ne relaie que la signalisation (`{type:"signal"}` sur le
  WebSocket) et l'état de l'appel (`{type:"call"}`, incluant l'état `recording`). Conçu pour ~5-6 participants ;
  au-delà, prévoir un SFU (LiveKit, mediasoup, Jitsi). Le partage d'écran utilise `getDisplayMedia`.
- **ICE** : `GET /api/rtc-config` renvoie les serveurs ICE (STUN public + TURN coturn si `TURN_URLS` est défini).
  Le TURN est **indispensable** pour les appels entre réseaux différents (mobile 4G/5G ↔ box) : sans lui,
  pas de média (son/image) même si la session démarre. `coturn` est déployé par `docker-compose`
  (ports UDP 3478 + 49160-49200 à ouvrir dans le security group Scaleway).
- L'enregistrement se fait **côté navigateur** (mix micro local + flux distants via MediaRecorder, webm ou
  m4a selon le navigateur) puis envoyé au serveur à l'arrêt : pas de serveur d'enregistrement lourd.
  Un seul enregistrement à la fois, piloté par tous les participants. **Garder l'onglet ouvert pendant l'enregistrement.**
- Transcription via un provider **OpenAI-compatible** (`/audio/transcriptions`) — **m4a/mp3/webm acceptés
  directement, pas besoin de convertir en webm pour transcrire** :

| Fournisseur | `STT_PROVIDER` | `STT_BASE_URL` | `STT_MODEL` |
| --- | --- | --- | --- |
| OpenAI | `openai` | `https://api.openai.com/v1` | `whisper-1` |
| Groq (économique) | `groq` | `https://api.groq.com/openai/v1` | `whisper-large-v3` |
| **Scaleway Model-as-a-Service** (données hébergées à Paris, 0,003 €/min audio) | `openai-compatible` | `https://api.scaleway.ai/v1` | `whisper-large-v3` |
| Whisper local (données 100 % chez vous) | `openai-compatible` | `http://127.0.0.1:9000/v1` | selon votre serveur |

Configuration Scaleway (clé secrète IAM, console Scaleway → IAM → API Keys) :

```bash
STT_PROVIDER=openai-compatible
STT_BASE_URL=https://api.scaleway.ai/v1
STT_API_KEY=<SCW_SECRET_KEY>
STT_MODEL=whisper-large-v3
STT_LANGUAGE=fr
STT_COST_PER_AUDIO_MIN=0.0032   # ~0,003 €/min converti ; active le suivi du coût STT dans le dashboard
```

`STT_COST_PER_AUDIO_MIN` demande `response_format=verbose_json` à l'API pour récupérer la durée audio et
valoriser chaque transcription dans `llm_usage` (visible dans le dashboard admin).
`STT_API_KEY` sinon `LLM_API_KEY` est réutilisée ; `STT_LANGUAGE=fr` pour forcer la langue.
Tout fichier audio déposé (note vocale, enregistrement d'appel, média téléchargé via `/lien`) est transcrit
automatiquement si le STT est configuré ; sinon `POST /api/files/:id/transcribe` (bouton 🎙️ dans l'espace documentaire).

> **Dépannage « STT non configuré » alors que le `.env` contient `STT_*`** : le `.env` est monté en lecture
> seule dans le conteneur et **relu à chaque démarrage de l'app**. Après modification du `.env` :
> ```bash
> docker compose restart chat
> docker compose logs chat | grep '\[config\]'
> ```
> la log doit afficher `[config] STT : configuré (...)`. Sinon, vérifiez que les lignes `STT_*` ne sont
> pas commentées (`#`) dans le `.env`.

La transcription brute est déposée automatiquement dans l'espace documentaire (indexée RAG) ; les boutons
**Résumé** / **Compte-rendu** de l'espace documentaire appellent le LLM configuré (`POST /api/files/:id/derive`).

### /lien : médias distants (émissions radio, podcasts)

`/lien <url> [titre]` (ou juste coller le lien média seul) :
1. Le serveur télécharge le fichier (plafond `MAX_LINK_FETCH_MB`, anti-SSRF : `LINK_FETCH_ALLOWED_DOMAINS`,
   IP privées bloquées) et le dépose dans l'espace documentaire, attaché au message.
2. S'il est audio (m4a, mp3, webm…) : **transcription directe** via le STT (pas besoin de convertir en webm),
   puis **compte-rendu** généré par le LLM si configuré.
3. Si `ffmpeg` est présent (installé dans l'image Docker) : une **copie webm/opus 64k** est produite pour
   l'archivage léger (1 h de m4a ≈ 60-90 Mo → ~30 Mo en webm).
4. Le bot poste un récap dans la chat avec les noms des fichiers créés (tous dans l'espace documentaire, indexés RAG).

Coût indicatif pour 1 h d'émission (Scaleway) : transcription 0,003 €/min ≈ **0,18 €** + CR LLM (quelques
centimes selon le modèle), tracé dans le dashboard admin.

### RAG sur les documents

Les fichiers déposés (`.txt`, `.md`, `.csv`, `.json`, `.html`, `.pdf`) sont découpés en passages
(`RAG_CHUNK_SIZE`, ~1200 caractères) et indexés dans `doc_chunks`. `/ask` et `/solve` retrouvent les
`RAG_TOP_K` passages les plus pertinents (recherche lexicale, sans appel d'embeddings donc **sans coût
LLM supplémentaire**) et les injectent dans le prompt avec citation du document.

Exemple Ollama sur la même VM (gratuit, données chez vous) :

```bash
LLM_PROVIDER=ollama
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=llama3.2
```

Sans `LLM_MODEL`, l'appli fonctionne normalement ; les commandes LLM répondent que le LLM n'est pas configuré.

## Développement local

```bash
npm install
npm run dev:server   # API + WebSocket sur http://localhost:4000
npm run dev:web      # UI sur http://localhost:5173 (proxy /api et /ws vers :4000)
npm test             # tests du serveur (node:test)
```

Build de production local (le serveur sert alors l'UI sur le même port) :

```bash
npm run build
npm start            # http://localhost:4000
```

## Déploiement sur une VM Scaleway

1. **Créer l'instance** : console Scaleway → Compute → Instances → *Créer une instance*
   (ex. `DEV1-S`, image Ubuntu 24.04 LTS). Noter l'IP publique.
2. **Security group** : autoriser en entrée
   - TCP **22** (SSH) ← IP publique de ton PC en /32 uniquement
   - TCP **80** ← 0.0.0.0/0 (renouvellement Let's Encrypt, défi HTTP-01)
   - TCP **443** ← IP publique de ton PC en /32 (le téléphone passe par le VPN WireGuard, voir ci-dessus)
   - **UDP 51820** ← 0.0.0.0/0 (handshake WireGuard)
   - **UDP 3478** et **UDP 49160-49200** ← 0.0.0.0/0 (TURN coturn, appels WebRTC cross-réseaux)
   - tout le reste : DROP
   (procédure de switch mode test/prod : `deploy/security-groups.md`)
3. **Se connecter** : `ssh root@<IP_PUBLIQUE>`.
4. **Installer Docker** :
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
5. **Récupérer le code** :
   ```bash
   git clone https://github.com/canatac/chat.git && cd chat
   cp .env.example .env
   ```
6. **Configurer `.env`** : `JWT_SECRET=$(openssl rand -hex 32)`, `ADMIN_NAMES`, `WG_SERVERURL=<domaine ou IP publique>`,
   `TURN_EXTERNAL_IP=<IP publique>`, `TURN_URLS=turn:<IP publique>:3478`, `TURN_USERNAME`, `TURN_CREDENTIAL`,
   `LINK_FETCH_ALLOWED_DOMAINS=proxycast.radiofrance.fr,...`, puis `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`, `STT_*`.
7. **Lancer** :
   ```bash
   docker compose up -d --build
   ```
8. **HTTPS (requis pour micro/caméra/écran côté navigateur)** : DNS `chat.tonentreprise.fr` → IP de la VM,
   `DOMAIN=chat.tonentreprise.fr` dans `.env`, puis :
   ```bash
   docker compose --profile https up -d
   ```
   Caddy obtient automatiquement un certificat Let's Encrypt. Sur le port 80, Caddy ne sert **que** la
   redirection 301 vers HTTPS + le défi ACME (`deploy/Caddyfile`) — jamais l'app en clair.
9. **Mises à jour** :
   ```bash
   git pull && docker compose up -d --build
   ```
   Après une **modification du `.env`**, redémarrer le conteneur pour que l'app relise le fichier
   (monté en lecture seule dans le conteneur) :
   ```bash
   docker compose restart chat
   docker compose logs chat | grep '\[config\]'   # contrôle : STT/LLM vus par l'app
   ```
   (`up -d` seul peut laisser l'ancien conteneur tourner avec l'ancien `.env` si l'image n'a pas changé —
   c'est le piège classique « STT non configuré » alors que le `.env` est bon.)
10. **Sauvegarde** : base + fichiers + config WireGuard dans les volumes Docker :
    ```bash
    docker run --rm -v chat_chat-data:/data -v chat_wg-config:/wg -v "$(pwd)":/backup alpine \
      sh -c 'tar czf /backup/chat-data-$(date +%F).tgz -C /data . && tar czf /backup/wg-config-$(date +%F).tgz -C /wg .'
    ```

## API

### REST (Bearer token)

- `POST /api/auth/register` `{name, password}` → `{token, user}`
- `POST /api/auth/login` `{name, password}` → `{token, user}`
- `GET /api/me` → `{user}` (avec `isAdmin`)
- `GET /api/users` → `{users: [...]}` (avec `online`)
- `GET /api/rtc-config` → `{iceServers: [...]}` (STUN + TURN) pour les appels WebRTC
- `GET /api/messages?limit=50&before=<id>` → `{messages: [...]}` (ordre chronologique, avec `files`)
- `POST /api/messages` `{content}` → `{message}`
- `POST /api/files` (multipart : `file`, `message?`, `post=true|false`) → `{file, message?}` — **fichier audio transcrit automatiquement si STT configuré**
- `GET /api/files?limit=&before=&query=` → `{files: [...]}` (espace documentaire)
- `GET /api/files/:id/download` → téléchargement
- `POST /api/files/:id/transcribe` → transcrit un fichier audio (STT)
- `POST /api/files/:id/derive` `{kind: "resume"|"cr"}` → résumé / CR (LLM) déposé dans l'espace documentaire
- `GET /api/calls/active`, `POST /api/calls/start|join|leave|end` → cycle de vie de l'appel
- `POST /api/calls/:id/recording/start|stop` → état d'enregistrement partagé (diffusé en WS)
- `POST /api/calls/:id/recording` (multipart `file`) → enregistre l'appel + transcription STT automatique
- `GET /api/admin/stats` → statistiques LLM + appels (admin uniquement)

### WebSocket `/ws?token=<jwt>`

- Client → serveur : `{type: "message", content}`, `{type: "history", before?, limit?}`,
  `{type: "signal", to, data}` (relayé vers l'utilisateur `to`, pour WebRTC)
- Serveur → client : `{type: "hello", user}`, `{type: "message", message}`, `{type: "history", messages}`, `{type: "presence", online: [ids]}`, `{type: "call", call}`,
  `{type: "signal", from, data}`, `{type: "error", error}`

## Structure du projet

```
server/   API REST + WebSocket, SQLite, upload, appels, RAG, STT, /lien, suivi de conso LLM (Node.js/TypeScript)
  src/llm/ providers (OpenAI-compatible, Anthropic) + pricing + rag + stt + derive + link + commandes
web/      Interface React + Material UI (Vite) : chat, présence, espace documentaire, appels WebRTC, dashboard admin
deploy/   Caddyfile + security-groups.md
docker-compose.yml (chat + coturn + wireguard + caddy) / Dockerfile (avec ffmpeg) / .env.example
```

## Notes de sécurité

- Mots de passe hashés (bcrypt), tokens JWT signés (30 jours), `.env` jamais commité (`.gitignore`)
- Security group restrictif (voir déploiement) : 22/443 limités à l'IP du PC, 80/51820/UDP TURN ouverts, reste en DROP ; le téléphone accède via le VPN WireGuard
- `/lien` : allowlist de domaines (`LINK_FETCH_ALLOWED_DOMAINS`), IP privées/localhost/métadonnées cloud bloquées (anti-SSRF), plafond de taille `MAX_LINK_FETCH_MB` ; ne jamais mettre `LINK_FETCH_ALLOW_PRIVATE=1` en production
- Les commandes LLM envoient les `LLM_CONTEXT_MESSAGES` derniers messages **et** les `RAG_TOP_K`
  extraits de documents au fournisseur choisi : en hébergement interne pur, préférez Ollama/vLLM local
- Les transcriptions d'appels partent vers le fournisseur STT choisi : préférez un Whisper local pour
  que l'audio ne quitte jamais votre VM (Scaleway MaaS = données hébergées à Paris, conforme EU)
- Le TURN coturn et WireGuard ont des credentials dans le `.env` (`TURN_CREDENTIAL`) : ne les partagez pas
- `GET /api/admin/stats` est réservé aux noms de `ADMIN_NAMES` (403 sinon)
- Toujours exposer l'appli derrière **HTTPS** (profil `https` fourni) — obligatoire pour micro/caméra/partage d'écran côté navigateur
