# Chat d'équipe

Messagerie de chatroom unique, minimaliste et **auto-hébergeable**, pensée pour une petite
entreprise qui veut faire tourner la discussion sur **ses propres serveurs** (par ex. une VM
Scaleway), avec une **intégration LLM configurable** : la chatroom profite du modèle de votre
choix pour faire des comptes-rendus de réunion ou proposer des solutions aux problèmes soulevés.

## Fonctionnalités

- Chatroom unique en **temps réel** (WebSocket), interface **Material UI** responsive
- Comptes simples : nom d'utilisateur + mot de passe (hash bcrypt, sessions JWT 30 jours)
- Historique persistant en **SQLite** (fichier unique, sauvegardable)
- **Commandes LLM** dans la chatroom : le résultat est posté par le bot « Assistant »

| Commande | Effet |
| --- | --- |
| `/resume [n]` | Compte-rendu des `n` derniers messages (50 par défaut) : thèmes, décisions, actions à suivre, questions ouvertes |
| `/solve <problème>` | 2 à 4 pistes de solution concrètes pour un problème soulevé dans la chatroom |
| `/ask <question>` | Réponse à une question, en s'appuyant sur le contexte récent de la chatroom |
| `/aide` | Liste des commandes |

## Stack

- **Backend** : Node.js 22 + TypeScript, Express (REST), `ws` (WebSocket), `node:sqlite`, `bcryptjs`, `jsonwebtoken`
- **Frontend** : React 18 + Vite + TypeScript + Material UI (`@mui/material`)
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
2. **Security group** : autoriser en entrée TCP **22** (SSH), **80** et **443** (HTTP/HTTPS).
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
6. **Configurer `.env`** : `JWT_SECRET=$(openssl rand -hex 32)`, puis `LLM_PROVIDER`,
   `LLM_API_KEY`, `LLM_MODEL` (et `LLM_BASE_URL` si fournisseur personnalisé).
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
10. **Sauvegarde** : toute la base tient dans le volume Docker `chat-data` :
    ```bash
    docker run --rm -v chat_chat-data:/data -v "$(pwd)":/backup alpine \
      tar czf /backup/chat-data-$(date +%F).tgz -C /data .
    ```

## API

### REST (Bearer token)

- `POST /api/auth/register` `{name, password}` → `{token, user}`
- `POST /api/auth/login` `{name, password}` → `{token, user}`
- `GET /api/me` → `{user}`
- `GET /api/messages?limit=50&before=<id>` → `{messages: [...]}` (ordre chronologique)
- `POST /api/messages` `{content}` → `{message}`

### WebSocket `/ws?token=<jwt>`

- Client → serveur : `{type: "message", content}` ou `{type: "history", before?, limit?}`
- Serveur → client : `{type: "hello", user}`, `{type: "message", message}`,
  `{type: "history", messages}`, `{type: "error", error}`

## Structure du projet

```
server/   API REST + WebSocket, SQLite, intégration LLM (Node.js/TypeScript)
  src/llm/ providers (OpenAI-compatible, Anthropic) + commandes /resume, /solve, /ask
web/      Interface React + Material UI (Vite)
deploy/   Caddyfile pour le HTTPS
docker-compose.yml / Dockerfile / .env.example
```

## Notes de sécurité

- Mots de passe hashés (bcrypt), tokens JWT signés (30 jours), `.env` jamais commité (`.gitignore`)
- Les commandes LLM envoient les `LLM_CONTEXT_MESSAGES` derniers messages au fournisseur choisi :
  en hébergement interne pur, préférez Ollama/vLLM local
- Toujours exposer l'appli derrière **HTTPS** (profil `https` fourni) si elle est reachable depuis Internet
