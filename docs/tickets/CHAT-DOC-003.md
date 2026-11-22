# CHAT-DOC-003 — commandes IA avec les fichiers du chat

Le chat désactivait son menu IA dès la sélection d’un fichier. Le dépôt d’une pièce jointe publiait la légende sans exécuter sa commande, et `/resume` ne ciblait que les échanges.

Le correctif permet de choisir `/ask`, `/resume` ou `/solve` avec une pièce jointe. Le serveur attend l’extraction locale du fichier ciblé puis transmet son texte au contrôle LinGuard avant tout appel au fournisseur. Une extraction bloquée ou incomplète arrête la demande sans résumé de remplacement de la conversation. Les limites V2 restent appliquées.

Les fichiers déjà publiés proposent **Résumer** et **Analyser / questionner**. La sélection est attachée au nouveau message par une relation SQLite, sans copie du fichier et en conservant son message d’origine. Les identifiants sont résolus uniquement dans le salon courant. Le statut de l’extraction est mis à jour par WebSocket dans les messages.

Sans pièce jointe sélectionnée, `/resume` conserve le résumé de la conversation et `/ask` conserve la recherche documentaire existante.

Validation : tests des dépôts multipart avec commande, attente OCR, contenu complet hors recherche par mots clés, références sans duplication, isolation des salons, blocage des extractions partielles, masquage LinGuard mémorisé, fermeture du serveur pendant l’extraction et comportement historique sans pièce jointe. Scénarios Playwright ajoutés à 320 et 1440 px.

Mise à jour sur la V2 déployée :

```sh
cd /root/chat
git am /chemin/vers/chatroom-v2-commandes-ia-chat.patch
docker compose build chat
docker compose up -d --no-deps --force-recreate chat
```

Actualiser ensuite la page du navigateur. Les processus Tika et LinGuard existants restent utilisables sans modification de configuration. La nouvelle relation SQLite est créée automatiquement.
