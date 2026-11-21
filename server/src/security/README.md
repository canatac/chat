# Contrôle local MaelGard

Le backend analyse chaque contenu des messages préparés pour le fournisseur IA,
avec les instructions système, l’historique et les documents de contexte. Le
contrôle s’applique aux commandes du chat, à l’assistant agenda et aux résumés et
comptes rendus. Le service local reçoit uniquement les requêtes de l’API v1
fournie, sur http://127.0.0.1:8898.

## Utiliser le module

Le module TypeScript utilise HTTP et JSON natifs de Node.js, sans dépendance
supplémentaire.

```ts
import { LinGuardClient, maskText } from './linguard-client.js';

const client = await LinGuardClient.connect();
const entities = await client.analyze_text(prompt);
const safePrompt = maskText(prompt, entities);
```

`analyze_text` et `analyze_texts` renvoient les entités avec leurs offsets
originaux en octets UTF-8. `displayOffsets` fournit des positions UTF-16 pour
`String.slice` et l’affichage JavaScript. Les plages invalides, les extraits
incohérents et les réponses non conformes bloquent le traitement. Le masquage
fusionne les plages qui se chevauchent et les remplace par des libellés comme
`[EMAIL]`. Les répétitions d’un même type utilisent le même libellé.

Le délai par requête vaut cinq secondes et peut être réglé entre une milliseconde
et dix secondes dans le constructeur. Une analyse vérifie d’abord health, donc
sa durée réseau maximale par défaut est de dix secondes. Il n’y a aucun retry
automatique, suivi de redirection ou recours à un proxy. Le client fixe l’hôte
127.0.0.1 et le port 8898 et envoie `Connection: close`.

Les textes trop longs et les lots dont le corps JSON sérialisé dépasse
16 × 1024 × 1024 octets sont refusés avant l’envoi. Ce calcul inclut les
échappements JSON. Le client conserve les textes entiers pour l’analyse.

## Administrer les décisions

Dans le menu du compte, ouvrir **Sécurité MaelGard**. La politique est persistée
par salon et seuls ses administrateurs et superadministrateurs peuvent la modifier.

| Politique de détection | Résultat |
| --- | --- |
| Bloquer l’envoi | Une détection empêche l’appel au fournisseur IA. |
| Masquer automatiquement et envoyer | Les extraits détectés sont remplacés avant l’appel IA. |
| Laisser l’utilisateur masquer ou annuler | Une fenêtre personnelle présente les types, le nombre et le score maximal brut. |

Le choix utilisateur expire après deux minutes. Une seule décision est acceptée
pour chaque demande, y compris avec plusieurs onglets. Une modification de
politique ou la révocation de l’accès au salon annule les décisions en attente.
Les requêtes initiales restent dans l’historique de la chatroom selon son
fonctionnement habituel.

La politique initiale bloque les détections et les erreurs de modèles.
L’administrateur peut autoriser **Continuer avec les détections disponibles**
pour `model_errors`. Les entités détectées suivent alors la politique habituelle.
Les pannes, timeouts, erreurs HTTP et réponses invalides bloquent toujours
l’envoi au fournisseur IA.

Le journal `security_events` conserve la date, le membre, l’action, les types,
le nombre et le score maximal. Les contenus de prompts, extraits détectés et
messages d’erreur bruts de LinGuard en sont exclus. Les demandes de confirmation
restent en mémoire jusqu’à leur résolution ou expiration.

## Raccordement au serveur

LinGuard doit répondre sur le loopback du processus Node.js. Vérifier depuis
le même espace réseau que le backend.

```sh
curl --http1.1 --max-time 5 -H 'Connection: close' http://127.0.0.1:8898/api/v1/health
```

Avec Docker en réseau bridge, 127.0.0.1 désigne le conteneur. Pour joindre
linguard-server installé sur l’hôte Linux, le backend doit partager cet espace
réseau, par exemple avec le mode réseau host. Adapter alors l’adresse d’écoute
HTTP et le reverse proxy au déploiement utilisé. La configuration Docker
actuelle utilise un réseau bridge et doit être adaptée sur ce point avant le
raccordement. L’écoute LinGuard reste strictement locale.

Pour Docker Engine sur Linux avec un reverse proxy exécuté sur l’hôte, placer
ces réglages dans le fichier .env de la chatroom.

```dotenv
HOST=127.0.0.1
PORT=4000
```

Construire l’image puis recréer le conteneur avec le volume et le fichier .env
du déploiement. Dans cet exemple, remplacer chat-data par le nom exact du
volume existant avant le lancement.

```sh
docker build -t chat-pme:linguard .
docker run -d --name chat-pme --restart unless-stopped --network host \
  --env-file "$PWD/.env" \
  -v chat-data:/app/data \
  -v "$PWD/.env:/app/.env:ro" \
  chat-pme:linguard
```

Le conteneur précédent nommé chat-pme doit avoir été arrêté et retiré avant
ce lancement. Configurer le reverse proxy de l’hôte vers 127.0.0.1:4000.
Si le reverse proxy est lui-même conteneurisé, son espace réseau et sa cible
doivent être adaptés également. Le paramètre HOST fixe l’adresse HTTP
d’écoute du backend.

LINGUARD_API_LISTEN doit activer l’API sur 127.0.0.1:8898. Les valeurs off et
none désactivent l’API et provoquent le blocage des envois IA dans la chatroom.

Le contrôle de ce module porte sur les textes. L’envoi de fichiers audio au
service de transcription suit le circuit STT existant.

## Vérification

```sh
npm run build
npm test
npm run test:e2e -- security.spec.ts
```

Les tests du client démarrent un serveur HTTP mock sur 127.0.0.1:8898 dans
l’environnement de test. Ce port doit y être disponible. Les scénarios
d’intégration vérifient le corps reçu par un fournisseur IA simulé, les droits
administrateur, les décisions utilisateur et l’absence d’extraits dans l’audit.
