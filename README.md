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

**Démarrer / rejoindre un appel (audio + caméra optionnelle + partage d'écran)**
1. Bouton **📞 téléphone** en haut → « Démarrer l'appel » (titre optionnel). Les autres voient une
   pastille rouge sur le 📞 et peuvent « Rejoindre l'appel ».
2. Dans l'appel : micro on/off, **📷 caméra** (optionnelle), **🖥️ partage d'écran**, **REC**
   (enregistrement de tout l'appel), « Quitter l'appel » ou « Terminer l'appel » (pour tout le monde).

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
1. REC pendant l'appel, second clic pour arrêter : l'audio est envoyé au serveur, posté dans la chat
   et déposé dans l'espace documentaire (lié à l'appel).
2. Si le STT est configuré, la **transcription brute** est déposée automatiquement dans l'espace
   documentaire (et indexée par le RAG : interrogeable avec `/ask`).
3. Sur la ligne de la transcription dans l'espace documentaire : icônes **Résumé** et
   **Compte-rendu** → génèrent un fichier `.md` déposé à son tour (coût tracé dans le dashboard admin).
4. Relire : bouton **télécharger** sur n'importe quel fichier de l'espace documentaire.

**Commandes LLM dans la chat** : `/resume [n]`, `/solve <problème>`, `/ask <question>`, `/aide`.

## Fonctionnalités

- Chatroom unique en **temps réel** (WebSocket), interface **Material UI** responsive
- **Présence** : pastilles des membres en haut à droite (vert = en ligne, gris = hors ligne), avec détail au clic
- Comptes simples : nom d'utilisateur + mot de passe (hash bcrypt, sessions JWT 30 jours)
- Historique persistant en **SQLite** (fichier unique, sauvegardable)
- **Fichiers** : pièce jointe à n'importe quel message (bouton trombone) + **espace documentaire** dédié
  (bouton dossier en haut à droite : recherche, dépôt, téléchargement). Les fichiers texte/PDF sont
  indexés automatiquement, les fichiers audio transcrits (STT)
- **RAG** : `/ask` et `/solve` fouillent les documents déposés et citent leurs sources
- **Dashboard d'administration** (réservé aux noms de `ADMIN_NAMES`) : volume de tokens
  (entrée/sortie/total), **estimation du coût** en USD, activité par jour/commande/modèle, volumétrie
  messages/membres/documents/appels
- **Appels d'équipe** (bouton téléphone en haut) : WebRTC en mesh, audio + caméra optionnelle + partage
  d'écran, enregistrement audio de l'appel (bouton REC), TURN coturn pour les appels cross-réseaux
- **Transcription des appels et notes vocales** : transcription brute déposée automatiquement dans
  l'espace documentaire — indexée par le RAG ; boutons **Résumé** et **Compte-rendu** (LLM) sur chaque
  transcription
- **Commandes LLM** dans la chatroom : le résultat est posté par le bot « Assistant »

| Commande | Effet |
| --- | --- |
| `/resume [n]` | Compte-rendu des `n` derniers messages (50 par défaut) : thèmes, décisions, actions à suivre, questions ouvertes |
| `/solve <problème>` | 2 à 4 pistes de solution concrètes pour un problème soulevé dans la chatroom |
| `/ask <question>` | Réponse à une question, en s'appuyant sur la chatroom **et les documents déposés (RAG)** |
| `/aide` | Liste des commandes |

## Stack

- **Backend** : Node.js 22 + TypeScript, Express (REST), `ws` (WebSocket), `node:sqlite`, `bcryptjs`, `jsonwebtoken`, `multer` (upload)
- **Frontend** : React 18 + Vite + TypeScript + Material UI (`@mui/material`) + WebRTC natif (appels mesh)
- **Déploiement** : conteneurs Docker (`chat` + `coturn` TURN + `caddy` optionnel pour le HTTPS), volume `chat-data` pour les données

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

### Appels, enregistrement et transcription (STT)

- Appel WebRTC **mesh** (pair-à-pair) : le serveur ne relaie que la signalisation (`{type:"signal"}` sur le
  WebSocket) et l'état de l'appel (`{type:"call"}`). Conçu pour ~5-6 participants ; au-delà, prévoir un
  SFU (LiveKit, mediasoup, Jitsi). Le partage d'écran utilise `getDisplayMedia`.
- **ICE** : `GET /api/rtc-config` renvoie les serveurs ICE (STUN public + TURN coturn si `TURN_URLS` est défini).
  Le TURN est **indispensable** pour les appels entre réseaux différents (mobile 4G/5G ↔ box) : sans lui,
  pas de média (son/image) même si la session démarre. `coturn` est déployé par `docker-compose`
  (ports UDP 3478 + 49160-49200 à ouvrir dans le security group Scaleway).
- L'enregistrement se fait **côté navigateur** (mix micro local + flux distants via MediaRecorder) puis
  envoyé au serveur à l'arrêt : pas de serveur d'enregistrement lourd. Le fichier audio est déposé dans
  l'espace documentaire et posté dans la chatroom. **Garder l'onglet ouvert pendant l'enregistrement.**
- Transcription via un provider **OpenAI-compatible** (`/audio/transcriptions`) :

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

Le format `audio/webm` produit par le navigateur est accepté par Scaleway (webm supporté). `STT_COST_PER_AUDIO_MIN`
demande `response_format=verbose_json` à l'API pour récupérer la durée audio et valoriser chaque transcription
dans `llm_usage` (visible dans le dashboard admin).

`STT_API_KEY` sinon `LLM_API_KEY` est réutilisée ; `STT_LANGUAGE=fr` pour forcer la langue.
Tout fichier audio déposé (note vocale, enregistrement d'appel) est transcrit automatiquement si le STT est
configuré ; sinon `POST /api/files/:id/transcribe` (bouton 🎙️ dans l'espace documentaire).
La transcription brute est déposée automatiquement dans l'espace documentaire (indexée RAG) ; les boutons
**Résumé** / **Compte-rendu** de l'espace documentaire appellent le LLM configuré (`POST /api/files/:id/derive`).

### RAG sur les documents

Les fichiers déposés (`.txt`, `.md`, `.csv`, `.json`, `.html`, `.pdf`) sont découpés en passages
(`RAG_CHUNK_SIZE`, ~1200 caractères) et indexés dans `doc_chunks`. `/ask` et `/solve` retrouvent les
`RAG_TOP_K` passages les plus pertinents (recherche lexicale, sans appel d'embeddings donc **sans coût
LLM supplémentaire**) et les injectent dans le prompt avec citation du document. Pour un RAG sémantique
par embeddings, il faudra brancher un endpoint d'embeddings — possible en évolution, mais inutile pour
des volumes documentaires PME modestes.

Exemple Ollama sur la même VM (gratuit, données chez vous) :

```bash
LLM_PROVIDER=ollama
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=llama3.2
```

Sans `LLM_MODEL`, l'appli fonctionne normalement ; les commandes `/resume`, `/solve` et `/ask`
répondent simplement que le LLM n'est pas configuré.

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
2. **Security group** : autoriser en entrée TCP **22** (SSH), **80** et **443** (HTTP/HTTPS), plus
   **UDP 3478** et **UDP 49160-49200** (TURN coturn pour les appels WebRTC entre réseaux différents).
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
6. **Configurer `.env`** : `JWT_SECRET=$(openssl rand -hex 32)`, `ADMIN_NAMES`, `TURN_EXTERNAL_IP=<IP publique>`,
   `TURN_URLS=turn:<IP publique>:3478`, `TURN_USERNAME`, `TURN_CREDENTIAL`, puis `LLM_PROVIDER`,
   `LLM_API_KEY`, `LLM_MODEL` (et `LLM_BASE_URL` si fournisseur personnalisé), `STT_*` pour la
   transcription des appels (voir bloc Scaleway ci-dessus).
7. **Lancer** :
   ```bash
   docker compose up -d --build
   ```
   L'appli répond sur `http://<IP_PUBLIQUE>:4000`.
8. **HTTPS (recommandé — requis pour micro/caméra/écran dans le navigateur)** : acheter/pointer un nom de
   domaine vers l'IP de la VM, définir `DOMAIN=chat.monentreprise.fr` dans `.env`, puis :
   ```bash
   docker compose --profile https up -d
   ```
   Caddy obtient automatiquement un certificat Let's Encrypt et fait reverse-proxy vers le chat
   (`deploy/Caddyfile`). Sans domaine, utiliser un tunnel SSH depuis le poste client
   (`ssh -L 4000:127.0.0.1:4000 root@<IP>` puis ouvrir `http://localhost:4000`).
9. **Mises à jour** :
   ```bash
   git pull && docker compose up -d --build
   ```
10. **Sauvegarde** : toute la base et les fichiers déposés tiennent dans le volume Docker `chat-data` :
    ```bash
    docker run --rm -v chat_chat-data:/data -v "$(pwd)":/backup alpine \
      tar czf /backup/chat-data-$(date +%F).tgz -C /data .
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
- `POST /api/files/:id/transcribe` → transcrit un fichier audio (STT) et dépose la transcription dans l'espace documentaire
- `POST /api/files/:id/derive` `{kind: "resume"|"cr"}` → génère un résumé / compte-rendu (LLM) déposé dans l'espace documentaire
- `GET /api/calls/active`, `POST /api/calls/start|join|leave|end` → cycle de vie de l'appel
- `POST /api/calls/:id/recording` (multipart `file`) → enregistre l'appel + transcription STT automatique
- `GET /api/admin/stats` → statistiques LLM + appels (admin uniquement)

### WebSocket `/ws?token=<jwt>`

- Client → serveur : `{type: "message", content}`, `{type: "history", before?, limit?}`,
  `{type: "signal", to, data}` (relayé vers l'utilisateur `to`, pour WebRTC)
- Serveur → client : `{type: "hello", user}`, `{type: "message", message}`,
  `{type: "history", messages}`, `{type: "presence", online: [ids]}`, `{type: "call", call}`,
  `{type: "signal", from, data}`, `{type: "error", error}`

## Structure du projet

```
server/   API REST + WebSocket, SQLite, upload, appels, RAG, STT, suivi de conso LLM (Node.js/TypeScript)
  src/llm/ providers (OpenAI-compatible, Anthropic) + pricing + rag + stt + derive + commandes
web/      Interface React + Material UI (Vite) : chat, présence, espace documentaire, appels WebRTC, dashboard admin
deploy/   Caddyfile pour le HTTPS
docker-compose.yml (chat + coturn + caddy) / Dockerfile / .env.example
```

## Notes de sécurité

- Mots de passe hashés (bcrypt), tokens JWT signés (30 jours), `.env` jamais commité (`.gitignore`)
- Les commandes LLM envoient les `LLM_CONTEXT_MESSAGES` derniers messages **et** les `RAG_TOP_K`
  extraits de documents au fournisseur choisi : en hébergement interne pur, préférez Ollama/vLLM local
- Les transcriptions d'appels partent vers le fournisseur STT choisi : préférez un Whisper local pour
  que l'audio ne quitte jamais votre VM (Scaleway MaaS = données hébergées à Paris, conforme EU)
- Le TURN coturn a des credentials dans le `.env` (`TURN_USERNAME`/`TURN_CREDENTIAL`) : ne les partagez pas
- `GET /api/admin/stats` est réservé aux noms de `ADMIN_NAMES` (403 sinon)
- Toujours exposer l'appli derrière **HTTPS** (profil `https` fourni) si elle est reachable depuis Internet
  (obligatoire pour micro/caméra/partage d'écran côté navigateur)
