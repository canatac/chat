# Chat d'équipe

Messagerie de chatroom unique, minimaliste et **auto-hébergeable**, pensée pour une petite
entreprise qui veut faire tourner la discussion sur **ses propres serveurs** (par ex. une VM
Scaleway), avec une **intégration LLM configurable** : la chatroom profite du modèle de votre
choix pour faire des comptes-rendus de réunion ou proposer des solutions aux problèmes soulevés.

## Fonctionnalités

- Chatroom unique en **temps réel** (WebSocket), interface **Material UI** responsive
- **Présence** : pastilles des membres en haut à droite (vert = en ligne, gris = hors ligne), avec détail au clic
- Comptes simples : nom d'utilisateur + mot de passe (hash bcrypt, sessions JWT 30 jours)
- Historique persistant en **SQLite** (fichier unique, sauvegardable)
- **Fichiers** : pièce jointe à n'importe quel message (bouton trombone) + **espace documentaire** dédié
  (bouton dossier en haut à droite : recherche, dépôt, téléchargement). Les fichiers texte/PDF sont
  indexés automatiquement
- **RAG** : `/ask` et `/solve` fouillent les documents déposés et citent leurs sources
- **Dashboard d'administration** (réservé aux noms de `ADMIN_NAMES`) : volume de tokens
  (entrée/sortie/total), **estimation du coût** en USD, activité par jour/commande/modèle, volumétrie
  messages/membres/documents/appels
- **Appels d'équipe avec partage d'écran** (bouton téléphone en haut) : WebRTC en mesh, un appel à la
  fois, micro coupable, partage d'écran, enregistrement audio de l'appel (bouton REC)
- **Transcription des appels** : l'enregistrement est transcrit (STT configurable, ex. Whisper) et la
  transcription brute est déposée automatiquement dans l'espace documentaire — donc indexée par le RAG ;
  boutons **Résumé** et **Compte-rendu** (générés par le LLM configuré) sur chaque transcription
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
- **Déploiement** : un seul conteneur Docker (le serveur sert aussi l'UI compilée), HTTPS optionnel via Caddy + Let's Encrypt

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
Sans STT configuré, l'audio reste déposé dans l'espace documentaire sans transcription.
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
2. **Security group** : autoriser en entrée TCP **22** (SSH), **80** et **443** (HTTP/HTTPS), et la plage
   UDP **10000-20000** si vous prévoyez plus tard un SFU (pas nécessaire en mesh WebRTC direct).
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
6. **Configurer `.env`** : `JWT_SECRET=$(openssl rand -hex 32)`, `ADMIN_NAMES`, puis `LLM_PROVIDER`,
   `LLM_API_KEY`, `LLM_MODEL` (et `LLM_BASE_URL` si fournisseur personnalisé), `STT_*` pour la
   transcription des appels (voir bloc Scaleway ci-dessus).
7. **Lancer** :
   ```bash
   docker compose up -d --build
   ```
   L'appli répond sur `http://<IP_PUBLIQUE>:4000`.
8. **HTTPS (recommandé)** : acheter/pointer un nom de domaine vers l'IP de la VM, définir
   `DOMAIN=chat.monentreprise.fr` dans `.env`, puis :
   ```bash
   docker compose --profile https up -d
   ```
   Caddy obtient automatiquement un certificat Let's Encrypt et fait reverse-proxy vers le chat
   (`deploy/Caddyfile`). Pour un accès strictement interne, laisser `CHAT_BIND=127.0.0.1` et
   passer par un tunnel SSH (`ssh -L 4000:127.0.0.1:4000 root@<IP>`).
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
- `GET /api/messages?limit=50&before=<id>` → `{messages: [...]}` (ordre chronologique, avec `files`)
- `POST /api/messages` `{content}` → `{message}`
- `POST /api/files` (multipart : `file`, `message?`, `post=true|false`) → `{file, message?}`
- `GET /api/files?limit=&before=&query=` → `{files: [...]}` (espace documentaire)
- `GET /api/files/:id/download` → téléchargement
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
docker-compose.yml / Dockerfile / .env.example
```

## Notes de sécurité

- Mots de passe hashés (bcrypt), tokens JWT signés (30 jours), `.env` jamais commité (`.gitignore`)
- Les commandes LLM envoient les `LLM_CONTEXT_MESSAGES` derniers messages **et** les `RAG_TOP_K`
  extraits de documents au fournisseur choisi : en hébergement interne pur, préférez Ollama/vLLM local
- Les transcriptions d'appels partent vers le fournisseur STT choisi : préférez un Whisper local pour
  que l'audio ne quitte jamais votre VM (Scaleway MaaS = données hébergées à Paris, conforme EU)
- `GET /api/admin/stats` est réservé aux noms de `ADMIN_NAMES` (403 sinon)
- Toujours exposer l'appli derrière **HTTPS** (profil `https` fourni) si elle est reachable depuis Internet
