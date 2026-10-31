# Connecter vos assistants à VantagePeers Cloud

Produit : VantagePeers Cloud (multi-tenant, hébergé). Ne s'applique pas au Self-host. English version: [connect-assistants.md](./connect-assistants.md).

<!-- Source : mesuré en direct le 2026-10-31 (mission k57d7w1348z15knbtqjkd1pvrh8hacyd, tâche k174ga37c90ajm53nq4qpaxc6h8haq8k). Les libellés d'écran français sont mesurés ; les équivalents anglais ne le sont pas, sauf mention. -->

Un seul backend, tous les clients MCP : Claude, ChatGPT, Grok, Codex, Claude Code, tout IDE parlant MCP. L'URL du serveur est la même partout :

```
https://mcp.vantagepeers.com/mcp
```

## Le modèle : un agent par assistant et par compte

Chaque assistant connecté agit comme son propre agent, avec un nom que vous choisissez. Le même email peut se connecter sur tous les assistants. Un second compte sur le même assistant (par exemple un second compte ChatGPT) est une connexion séparée avec son propre agent. Mesuré le 2026-10-31 : une personne a connecté quatre assistants (Claude, deux comptes ChatGPT, Grok), et chaque consentement a posé l'agent choisi sur le jeton.

## La page de consentement (tous les assistants)

Tous les assistants terminent sur la même page de consentement :

1. Choisissez l'organisation.
2. Choisissez l'agent que cet assistant incarne. **Connect as myself** est le choix par défaut.
   - Un membre ne voit que les agents déjà rattachés à lui.
   - Un admin d'organisation voit aussi les agents non rattachés et peut en créer un.
3. Validez.

<!-- not measured : les autres libellés de la page de consentement (sélecteur d'organisation, bouton de validation) en FR et en EN. Seul "Connect as myself" est mesuré. -->

Voir aussi [personal-agent.md](./personal-agent.md) (comment une personne est rattachée à un agent) et [agent-links.md](./agent-links.md).

## Claude (utiliser le plugin, pas un connecteur nu)

1. Ouvrez Personnalisation > Plugins > Ajouter une marketplace, saisissez `https://github.com/vantageos-agency/vantage-peers-claude`, puis installez **Vantage peers**.
2. Ouvrez Personnalisation > Plugins > Vantage peers > onglet Connecteurs > « Se connecter ». Créez votre compte ou connectez-vous, puis terminez la page de consentement.
3. Dans une conversation, cliquez « + » > Connecteurs et vérifiez que **vantage-peers** est activé.
4. Pour vous reconnecter : « Déconnecter », puis « Se connecter ».

Installer le plugin ne le connecte PAS. Si vous sautez l'étape 2, Claude répond que le connecteur n'est pas actif dans cette conversation.

## ChatGPT

1. Ouvrez Plugins, cliquez « + », choisissez « Add custom MCP server ».
2. Nom : `VantagePeers`. URL : `https://mcp.vantagepeers.com/mcp`. Authentification : OAuth.
3. Cochez l'avertissement, puis cliquez « Create as plugin ».
4. Connectez-vous et terminez la page de consentement.

<!-- not measured : libellés FR des écrans ChatGPT ; les libellés ci-dessus sont ceux relevés en anglais. -->

### ChatGPT peut-il écrire ?

L'article d'aide OpenAI 12584461 indique que les connecteurs MCP personnalisés ont un accès complet sur les forfaits Business, Enterprise et Edu, et sont en lecture seule sur Pro. C'est la déclaration d'OpenAI (paraphrasée ici, non verbatim). Nous avons aussi observé, le 2026-10-31, un forfait ChatGPT Free écrire une mémoire dans VantagePeers Cloud, 53 secondes après l'émission de son jeton (mémoire j576stz26pmrpv2b75nz5sppxx8hbqvd, createdBy « Sacha »). Les règles de forfait sont celles d'OpenAI et peuvent changer : si une écriture est refusée, vérifiez d'abord votre forfait.

<!-- not measured : comportement du forfait Plus ; texte verbatim de l'article OpenAI. -->

## Grok

1. Ouvrez Connecteurs > Nouveau connecteur > Connecteur personnalisé.
2. Nom : `VantagePeers`. URL : `https://mcp.vantagepeers.com/mcp`.
3. Ajoutez-le, puis connectez-vous, et terminez la page de consentement.

## Tester

Collez ceci juste après la connexion :

```
Appelle whoami et dis-moi le nom de l'agent et l'organisation que tu incarnes.
Désormais, enregistre automatiquement les décisions dans VantagePeers. Avant de
répondre à ce qui a été décidé ou à ce qu'il reste à faire, cherche d'abord
dans VantagePeers.
```

English version:

```
Call whoami and tell me the agent name and the organisation you act as.
From now on, record decisions automatically in VantagePeers. Before answering
what was decided or what remains to do, search VantagePeers first.
```

La réponse doit nommer l'agent choisi sur la page de consentement et votre organisation.

## Dépannage

| Symptôme | Cause et correction |
|---|---|
| Le lien de l'email d'invitation ouvre `https://mcp.vantagepeers.com/mcp` et affiche `{"error":"Missing Authorization header..."}` | Cette URL est le serveur, pas une page de connexion. Connectez-vous via le connecteur de l'assistant. Un correctif du lien est en attente (tâche k178xp66h7p0ds6vg69sqzw2vn8hbfrw). |
| Claude : plugin installé, « le connecteur n'est pas actif dans cette conversation » | Le plugin n'est pas encore connecté. Faites l'étape 2 de la section Claude. |
| Un outil manque ou se comporte comme une ancienne version | Un client connecté avant une mise à jour du serveur garde les définitions d'outils en cache. Déconnectez puis reconnectez une fois. |
| Écritures refusées avec « agents autorisés par la connexion : ... » | L'agent manque dans le roster de l'organisation. Rien à faire côté client : contactez l'opérateur VantagePeers. |
| « aucun agent ne t'est attribué » | Aucun agent n'a été choisi ou rattaché. Reconnectez-vous et choisissez l'agent sur la page de consentement. |
