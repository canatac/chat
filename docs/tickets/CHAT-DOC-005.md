# CHAT-DOC-005 — rendre Tika joignable depuis le réseau hôte

## Incident et cause

Le serveur Tika démarre et écoute sur `0.0.0.0:9998` dans son conteneur, mais `curl http://127.0.0.1:9998/version` depuis la VM échoue immédiatement avec une connexion refusée. `docker compose ps tika` affiche seulement `9998/tcp`.

Le Compose V2 associait une publication `127.0.0.1:9998:9998` à un conteneur uniquement connecté à un réseau Docker `internal`. Docker ne met pas en place cette publication. Le backend en réseau `host` ne peut donc pas atteindre Tika avec son URL locale. Cela bloque l’extraction avant le contrôle LinGuard et l’appel IA ; ce diagnostic ne prouve rien sur le contenu du fichier.

## Correction

Tika reste uniquement sur le réseau `documents-local` sans accès sortant. Le nouveau service `tika-access`, une image officielle HAProxy 3.2.27 Alpine, partage ce réseau et rejoint un réseau bridge ordinaire `documents-access`, sur lequel Docker peut publier le port. Il n’autorise qu’une destination : `tika:9998`. L’URL du backend reste `http://127.0.0.1:9998`.

Le relais fonctionne en TCP, avec un seul thread, huit connexions, des tampons de transport bornés et aucun stockage de corps HTTP. Les délais de 180 secondes couvrent le budget client de 135 secondes. Le DNS Docker est réinterrogé après changement d’IP de Tika. Le conteneur est en lecture seule, sans capacités ni montages de données ou secrets, avec un plafond de 64 Mio de RAM, 0,10 CPU, 16 processus et deux journaux de 1 Mio. Les plafonds du chat et de Tika restent applicables.

## Déployer sur la V2 existante

Ce patch est basé sur `86cbd27` (PR 39, diagnostic documentaire). Il modifie le déploiement et sa documentation ; aucune reconstruction de la chatroom ni migration de données n’est nécessaire.

```sh
cd /root/chat
git am /chemin/vers/chatroom-v2-reseau-tika.patch
docker compose config --quiet
docker compose pull tika-access
docker compose up -d --no-deps --force-recreate tika tika-access
docker compose exec -T tika-access haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
docker compose ps tika tika-access
curl --fail --retry 15 --retry-connrefused --retry-delay 2 --retry-max-time 60 --max-time 5 http://127.0.0.1:9998/version
```

Le port `127.0.0.1:9998->9998/tcp` apparaît sur **tika-access**, tandis que Tika peut afficher seulement `9998/tcp`. Attendre la réponse `Apache Tika 4.2.0`. Si elle ne vient pas, consulter `docker compose logs --tail=80 tika tika-access`. Après démarrage du relais, une commande passée pendant l’initialisation de Tika peut devoir être réessayée.

Dans l’application, choisir **Vérifier le service**, puis **Relancer l’extraction** sur le fichier bloqué. Attendre **Texte disponible**, puis utiliser **Résumer** ou **Analyser / questionner**. La vérification de `/version` valide la connexion ; la relance du fichier valide son extraction et son OCR.

Le message `pipesClientId=0 ... socket timeout while waiting for task, shutting down` après 60 secondes sans document concerne le processus d’extraction inactif. Tika le redémarre à la prochaine utilisation ; son serveur HTTP reste actif. L’avertissement CPU indique une contrainte de performance avec le plafond d’un CPU, pas une cause de connexion refusée.

## Validation

La syntaxe du fichier HAProxy est vérifiée avec le binaire officiel 3.2.27. Le relais est exercé avec des requêtes `/version` et `/rmeta`, y compris un corps de 10 Mio et une reprise après interruption du backend. Les tests d’intégration documentaires sont également exécutés derrière ce relais avec Tika 4.2.0 et Tesseract. Les vérifications locales n’exécutent pas Docker ; les commandes ci-dessus valident la publication sur la VM.

Références : [publication sur réseau internal, Moby](https://github.com/moby/moby/issues/53960), [image officielle HAProxy](https://hub.docker.com/_/haproxy), [configuration HAProxy 3.2](https://docs.haproxy.org/3.2/configuration.html), [arrêt des processus Tika inactifs](https://tika.apache.org/docs/4.2.x/pipes/configuration.html).
