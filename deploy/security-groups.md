# Security group Scaleway — deux modes (switch instantané)

La règle qui change entre les deux modes est **TCP 443**. Tout le reste est identique.
Un changement de règle s'applique **immédiatement**, sans redémarrer la VM.

## Mode A — restreint (production, téléphone via VPN WireGuard)

| Entrée | Source | Rôle |
| --- | --- | --- |
| TCP 22 | IP publique du PC `/32` | SSH |
| TCP 80 | `0.0.0.0/0` | renouvellement Let's Encrypt (HTTP-01) + redirect 301 → HTTPS (rien d'autre n'y répond, voir `deploy/Caddyfile`) |
| TCP 443 | IP publique du PC `/32` | l'app en HTTPS — le téléphone y accède **via le tunnel WireGuard** (trafic arrivé sur `wg0`, non re-filtré) |
| UDP 51820 | `0.0.0.0/0` | handshake WireGuard |
| UDP 3478 + UDP 49160-49200 | `0.0.0.0/0` | TURN coturn (appels WebRTC cross-réseaux) |
| tout le reste | DROP (default policy) | |

## Mode B — test (sans VPN : le 443 est ouvert à tous)

Identique au mode A, sauf :

| Entrée | Source |
| --- | --- |
| TCP 443 | `0.0.0.0/0` ← **seule différence** |

⚠️ En mode B, l'app est joignable en HTTPS depuis n'importe quelle IP publique (mais toujours protégée par le login + mot de passe et le chiffrement TLS). À n'utiliser que le temps des tests.

## Comment switcher (console Scaleway)

1. Console → **Compute → Instances** → ta VM → onglet **Security group**.
2. Repère la règle **TCP 443 inbound**.
3. Mode B (test) : édite la règle → source = `0.0.0.0/0` → enregistrer.
4. Mode A (prod) : réédite → source = `<IP publique de ton PC>/32` → enregistrer.

## Comment switcher (CLI scw, optionnel)

```bash
scw instance security-group list zone=fr-par-1
scw instance security-group-rule list security-group-id=<SG_ID>
# repérer l'id de la règle TCP 443, puis :
scw instance security-group-rule update <RULE_ID> source=0.0.0.0/0   # mode B (test)
scw instance security-group-rule update <RULE_ID> source=<IP_PC>/32   # mode A (prod)
# (noms d'arguments à confirmer avec : scw instance security-group-rule update --help)
```

## Piège : l'IP publique de la box change

Si la box a une IP dynamique, la règle `/32` du PC casse dès que l'IP change. Récupère l'IP courante :

```bash
curl -s ifconfig.me        # depuis le PC
```

et mets à jour les règles 22 et 443. Pour automatiser : DynDNS (DuckDNS/No-IP) + un cron sur la VM qui pousse l'IP à jour via l'API Scaleway.

## Rappel : iPhone 6 / iOS 12

Quel que soit le mode (VPN ou 443 ouvert), **Safari 12 ne chargera pas l'interface** (syntaxe JS ES2020 non supportée → page blanche). Tester les appels depuis le PC (deux comptes) ou un appareil moderne. Le téléphone en VPN ne sert que pour joindre l'URL, pas pour faire tourner l'app.
