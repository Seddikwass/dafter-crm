# Dafter — CRM pour petites entreprises tunisiennes

Suivi des clients, factures (TVA 0/7/13/19 %, timbre fiscal), alertes d'échéances, historique des paiements, tableau de bord, et gestion des abonnements mensuels des entreprises clientes.

Aucune dépendance npm : Node.js 20+ et une base PostgreSQL suffisent.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | URL PostgreSQL (fournie par Render) |
| `SESSION_SECRET` | Longue chaîne aléatoire pour signer les sessions |
| `SUPERADMIN_EMAIL` | E-mail du propriétaire de la plateforme (accès à la page « Abonnés ») |
| `PAYMENT_INFO` | Texte affiché aux entreprises pour payer leur abonnement (RIB, D17…) |
| `TRIAL_DAYS` | Durée de l'essai gratuit (14 par défaut) |

## Lancer en local

```
DATABASE_URL=postgres://user:pass@localhost:5432/crm node server.js
```

Les tables sont créées automatiquement au démarrage.

Créé par Wassim Khalfalli.
