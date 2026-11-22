# CHAT-DOC-004 — expliquer les échecs d’extraction

Le badge « Analyse bloquée » et le préfixe « Erreur lors de l’appel au LLM » confondaient un échec d’extraction avec un problème de contenu ou de fournisseur IA. L’ancienne erreur « service indisponible ou réponse invalide » ne permet pas de connaître la cause exacte après coup.

Le correctif enregistre désormais l’étape, la catégorie, le code, le motif, l’action conseillée et les informations techniques sûres pour chaque extraction échouée. L’utilisateur voit directement ces informations dans le chat, le brouillon et les détails documentaires. Les erreurs de connexion, réponses JSON invalides, HTTP, délais, documents chiffrés, formats non pris en charge et limites ont des explications distinctes.

Le bouton **Vérifier le service** contrôle la connexion à Tika depuis le backend de la chatroom. Il est réservé aux sessions authentifiées, mutualisé entre salons et mis en cache pendant trois secondes. Il ne relance ni l’extraction, ni LinGuard, ni le fournisseur IA. Une réponse de `/version` prouve que Tika répond ; l’extraction et l’OCR doivent encore être vérifiés en relançant le fichier.

Les anciens échecs sans code sont signalés comme **Échec d’extraction à préciser**. Une relance remplace l’ancien motif par le diagnostic précis. Les anciens messages du chat restent dans l’historique ; les nouvelles demandes affichent l’étape correcte.

Les détails ne contiennent ni réponse brute du service, ni extrait du document, ni trace d’exception. Les redirections HTTP ne sont pas suivies. Les contrôles de taille, la file globale et la politique LinGuard restent applicables.

Après application du patch et reconstruction de la chatroom, actualiser la page, choisir **Vérifier le service**, puis **Relancer l’extraction** si l’incident est résolu.

```sh
cd /root/chat
git am /chemin/vers/chatroom-v2-diagnostic-documentaire.patch
docker compose build chat
docker compose up -d --no-deps --force-recreate chat
```

Pour diagnostiquer la VM avant ou après cette mise à jour :

```sh
docker compose ps tika
curl --fail --max-time 5 http://127.0.0.1:9998/version
docker compose logs --tail=80 tika
```

La réponse attendue à `/version` correspond à Apache Tika 4.2.0 pour l’image livrée. Si le port ne répond pas, les journaux et l’état du conteneur permettent de vérifier son démarrage. Une réponse correcte n’est pas une preuve que le PDF ou l’OCR peut être traité.
