# Chatroom V2 — analyse documentaire locale

Lorsqu’un membre dépose un PDF, une image ou un document bureautique, la chatroom extrait son texte localement. Tika 4.2.0 utilise Tesseract en français et en anglais, notamment pour les PDF scannés et les images intégrées aux documents Word. Les fichiers texte UTF-8 sont lus directement, avec les mêmes limites de taille et de longueur.

Le texte et les propriétés documentaires restent dans le SQLite du salon. Seuls les extraits retenus par le RAG ou le résumé demandé entrent dans le contexte IA. LinGuard réanalyse ce contexte avant chaque envoi au fournisseur : sa politique de blocage, de masquage et les choix mémorisés restent applicables. Les binaires documentaires ne sont pas envoyés au LLM. La transcription audio conserve son fournisseur STT existant ; cette V2 ne transforme pas un STT distant en service local.

L’explorateur affiche l’extraction en attente, en cours, disponible ou bloquée. « Texte disponible » signifie que l’extraction a abouti ; le contrôle LinGuard intervient lors de l’envoi à l’IA. Une extraction interrompue, chiffrée, vide, trop longue ou signalée comme partielle ne fournit aucun extrait au RAG. Le motif et le bouton **Réessayer l’analyse** se trouvent dans les détails du fichier.

Dans le chat, joindre un fichier puis choisir **Résumer le fichier**, **Analyser / questionner**, ou une commande `/ask`, `/resume` ou `/solve` du menu IA. Cliquer sur **Envoyer** : le serveur attend la fin de l’extraction et utilise le contenu du fichier ciblé, même si la question ne partage aucun mot avec celui-ci. Les actions **Résumer** et **Analyser / questionner** d’un fichier déjà publié permettent de le sélectionner sans nouveau téléversement. Le statut de l’extraction est visible dans le message. Si elle échoue, la demande IA est arrêtée avec son motif. Sans fichier sélectionné, `/resume` résume la conversation comme auparavant.

Un échec précise désormais sa cause et l’action conseillée : service injoignable, réponse invalide, délai, document illisible/chiffré ou limite atteinte. **Vérifier le service** permet de contrôler sa connexion depuis la chatroom ; une connexion réussie ne garantit pas l’extraction ni l’OCR. Les erreurs d’extraction indiquent que le contrôle LinGuard reste à effectuer. Les anciennes erreurs ambiguës sont précisées lors de leur prochaine relance.

## Limites pour une VM de 2 CPU et 8 Go

| Ressource | Plafond livré |
| --- | --- |
| Document déposé | 10 Mio ; `MAX_UPLOAD_MB` permet de diminuer cette valeur |
| PDF, y compris les pages à OCR | 20 pages ; un PDF plus long est refusé pour l’IA |
| Image d’entrée | 16 millions de pixels ; TIFF limité à 20 images |
| Texte et métadonnées extraits | 200 000 caractères par document, sans troncature acceptée |
| Réponse Tika | 4 Mio, contrôlés pendant la lecture |
| Documents intégrés | 32, profondeur 3 ; dépassement bloquant |
| Extraction / OCR | Un document à la fois pour tous les salons ; 120 s par document, 15 s par appel Tesseract |
| Nouveaux travaux en attente | 16 ; au-delà le fichier est conservé avec un état bloqué et peut être relancé |
| Dépôts, téléchargements et traitements média | Deux opérations d’écriture au maximum pour le serveur entier |
| Dépôt HTTP | 60 s ; un fichier, 12 champs, 16 Kio par champ |
| Enregistrement / téléchargement distant | 50 Mio maximum, réception sur disque en flux |
| Données du backend | 2 Gio par défaut pour tous les salons, fichiers générés et bases SQLite compris |
| Réserve de disque | Arrêt des nouvelles écritures sous 512 Mio libres, réservations en cours comprises |
| Tika + ses processus + ses temporaires | 2 Gio de RAM, 1 CPU, 128 processus, swap désactivé pour ce conteneur |
| Chatroom + traitement média | 2 Gio de RAM, 0,75 CPU, 192 processus ; heap Node de 1 Gio |
| Temporaires | Tika : tmpfs de 512 Mio ; chatroom : tmpfs de 256 Mio, inclus dans leurs plafonds mémoire |
| Journaux Docker chat/Tika | Deux fichiers de 5 Mio par service |

Ces budgets laissent environ 4 Gio à Linux, LinGuard, Caddy et aux autres services. Ce sont des plafonds d’usage, pas des allocations permanentes. La taille des images Docker et les journaux des autres services ne font pas partie du quota applicatif. Les métadonnées d’activité et la base de messages peuvent continuer à croître ; le quota de données est un contrôle d’admission des écritures de fichiers et de l’index documentaire, pas un quota de volume au niveau du système de fichiers.

Les anciennes valeurs `MAX_UPLOAD_MB=25`, `RECORDING_MAX_MB=200` et `MAX_LINK_FETCH_MB=500` sont automatiquement plafonnées à 10/50/50. Les diminuer dans le `.env` est possible. Modifier les plafonds documentaires supérieurs nécessite de revoir ensemble le client et `deploy/tika-config.json`.

## Mise à jour d’une installation existante

Appliquer le patch depuis le dépôt de la chatroom, par exemple `/root/chat`. Le patch est basé sur `33c90624ac1d467d0b3626499ab4ff0faea24506`, qui contient déjà le masquage mémorisé LinGuard. Sauvegarder les volumes de données selon la procédure habituelle avant une mise à jour avec migration SQLite.

```sh
cd /root/chat
git am /chemin/vers/chatroom-v2-tika-tesseract.patch
docker compose config --quiet
docker compose pull tika
docker compose build chat
docker compose up -d --no-deps --force-recreate tika chat
```

Conserver le `.env` existant. Les nouveaux réglages ont des valeurs par défaut ; voici ceux à rendre explicites si souhaité :

```dotenv
MAX_UPLOAD_MB=10
RECORDING_MAX_MB=50
MAX_LINK_FETCH_MB=50
FILE_STORAGE_MAX_MB=2048
FILE_STORAGE_MIN_FREE_MB=512
TIKA_URL=http://127.0.0.1:9998
```

Le backend conserve le réseau hôte pour joindre LinGuard sur `127.0.0.1:8898`. Tika est isolé sur un réseau Docker sans accès sortant et publie seulement `127.0.0.1:9998`. Il n’a accès ni au volume de données ni aux secrets de la chatroom. Aucun port Tika public ni route Caddy supplémentaire ne sont nécessaires. La recréation de `chat` applique ses nouvelles limites CPU/mémoire et provoque une brève interruption ; les autres services gardent leur configuration.

Au premier démarrage, les anciens documents du salon sont réextraits, un par un. Un salon est chargé à sa première utilisation. Les fichiers qui dépassent les nouveaux plafonds restent disponibles au téléchargement, avec un motif de blocage pour l’IA. Les travaux interrompus sont repris au redémarrage ; aucune copie partielle n’est réutilisée.

```sh
curl --fail --max-time 10 http://127.0.0.1:9998/version
docker compose logs --tail=80 tika chat
docker stats --no-stream
```

Dans l’application, déposer un PDF scanné, attendre **Texte disponible**, puis poser une question avec `/ask`. Avec une adresse personnelle détectable dans le document, vérifier que LinGuard bloque l’envoi ou propose le masquage suivant la politique du salon. Un scan de mauvaise qualité peut être mal reconnu : l’OCR n’offre pas de garantie d’exhaustivité de détection.

## Installation avec docker run

Le même fichier `deploy/tika-config.json` et la même image conviennent à une installation sans Compose. Ne pas lancer ce conteneur en plus du service Compose sur le même port.

```sh
docker network create --internal chat-documents
docker run -d --name chat-tika --restart unless-stopped --init \
  --network chat-documents -p 127.0.0.1:9998:9998 \
  --cpus=1 --memory=2g --memory-swap=2g --pids-limit=128 \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges:true \
  --tmpfs /tmp:size=512m,mode=1777,noexec,nosuid \
  --log-opt max-size=5m --log-opt max-file=2 \
  -e JAVA_TOOL_OPTIONS='-Xms64m -Xmx256m -XX:ActiveProcessorCount=1 -Djava.io.tmpdir=/tmp' \
  -e OMP_THREAD_LIMIT=1 -e OMP_NUM_THREADS=1 \
  -v "$PWD/deploy/tika-config.json:/etc/tika-config.json:ro" \
  apache/tika:4.2.0-full -c /etc/tika-config.json
```

Lors de la recréation habituelle de la chatroom, conserver son réseau `host`, son fichier d’environnement, ses montages et son volume de données exacts. Ajouter `--cpus=0.75 --memory=2g --memory-swap=2g --pids-limit=192 --tmpfs /tmp:size=256m,mode=1777,noexec,nosuid --log-opt max-size=5m --log-opt max-file=2 -e NODE_OPTIONS=--max-old-space-size=1024` à sa commande `docker run`. Ne pas créer de nouveau volume de données pour la mise à jour.

## Vérification des sources

```sh
npm ci --no-audit --no-fund
npm run build
npm test
TIKA_TEST_URL=http://127.0.0.1:9998 node --import tsx --test server/tests/tika.integration.test.ts
npx playwright test tests/e2e/document-explorer.spec.ts tests/e2e/security.spec.ts
```

Les fixtures de `server/tests/fixtures/documents` sont synthétiques : un contact fictif figure dans un PDF texte, un scan, une image et une image dans Word. Deux autres PDF vérifient le refus au-delà de 20 pages et le refus des documents chiffrés. Les tests Tika sont optionnels dans la suite habituelle et doivent être lancés explicitement avec le service disponible. Les tests serveur couvrent aussi les réponses HTTP 200 partielles, l’admission globale, les plafonds multipart, le nettoyage des téléchargements et le blocage/masquage LinGuard de texte extrait par OCR.

Références techniques utilisées : [Tika 4.2 — serveur](https://tika.apache.org/docs/4.2.x/using-tika/server/index.html), [limites](https://tika.apache.org/docs/4.2.x/advanced/setting-limits.html), [PDF](https://tika.apache.org/docs/4.2.x/configuration/parsers/pdf-parser.html), [Tesseract](https://tika.apache.org/docs/4.2.x/configuration/parsers/tesseract-ocr-parser.html).
