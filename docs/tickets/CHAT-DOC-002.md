# CHAT-DOC-002 — analyse documentaire V2

Demande : permettre à LinGuard de contrôler le texte issu des documents de la chatroom, avec extraction locale Tika/Tesseract et des limites adaptées à une VM de 2 CPU et 8 Go de RAM.

Critères : PDF texte/scannés, images et bureautique ; une extraction globale avec reprise persistée ; refus des résultats partiels ; quotas de fichiers et de ressources ; état et reprise visibles ; contrôle LinGuard avant le fournisseur IA ; guide de migration.

Suivi : identifiant local au dépôt. La création du ticket GitHub n’était pas disponible avec les droits de connexion de cette session.

Validation : build web/serveur et tests serveur ; tests d’intégration avec Tika 4.2.0 et Tesseract réels sur les fixtures synthétiques. Les tests navigateur nécessitent un environnement autorisant les sockets Unix de Chromium. L’image Docker doit être démarrée sur la VM pour confirmer ses limites effectives ; aucun déploiement de la VM n’a été effectué depuis cette session.

Livraison : commits liés à cet identifiant et patch de mise à jour. Voir [le guide](../chatroom-v2-documents.md).
