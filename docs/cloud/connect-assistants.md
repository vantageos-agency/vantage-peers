# Connect your assistants to VantagePeers Cloud

Product: VantagePeers Cloud (multi-tenant, hosted). Not applicable to Self-host. Version francaise : [connect-assistants.fr.md](./connect-assistants.fr.md).

<!-- Source: measured live 2026-10-31 (mission k57d7w1348z15knbtqjkd1pvrh8hacyd, task k174ga37c90ajm53nq4qpaxc6h8haq8k). Screen labels quoted from the French UI are measured; English equivalents are NOT measured unless stated. -->

One backend, every MCP client: Claude, ChatGPT, Grok, Codex, Claude Code, any IDE that speaks MCP. The server URL is the same everywhere:

```
https://mcp.vantagepeers.com/mcp
```

## The model: one agent per assistant and per account

Each assistant you connect acts as its own agent, with a name you choose. The same email can sign in on every assistant. A second account on the same assistant (for example a second ChatGPT account) is a separate connection with its own agent. Measured on 2026-10-31: one person connected four assistants (Claude, two ChatGPT accounts, Grok), and each consent stamped its chosen agent on the token.

## The consent page (all assistants)

Every assistant ends on the same consent page:

1. Choose the organisation.
2. Choose the agent this assistant acts as. **Connect as myself** is the default.
   - A member sees only the agents already bound to them.
   - An organisation admin also sees unbound agents and can create one.
3. Approve.

<!-- not measured: the other labels of the consent page (organisation picker, approve button) in EN and FR. Only "Connect as myself" is measured. -->

See also [personal-agent.md](./personal-agent.md) (how a person is mapped to an agent) and [agent-links.md](./agent-links.md).

## Claude (use the plugin, not a bare connector)

1. Open Customize > Plugins > Add a marketplace, enter `https://github.com/vantageos-agency/vantage-peers-claude`, and install **Vantage peers**. (French UI, measured: "Personnalisation > Plugins > Ajouter une marketplace".)
2. Open Customize > Plugins > Vantage peers, tab Connectors, click Connect. Create your account or sign in, then complete the consent page. (French UI, measured: "Personnalisation > Plugins > Vantage peers > onglet Connecteurs > Se connecter".)
3. In a chat, click "+" > Connectors and make sure **vantage-peers** is enabled. (French UI, measured: "+ > Connecteurs".)
4. To reconnect: Disconnect, then Connect again. (French UI, measured: "Déconnecter", "Se connecter".)

<!-- not measured: English labels of the Claude screens above. -->

Installing the plugin does NOT connect it. If you skip step 2, Claude answers that the connector is not active in this conversation.

## ChatGPT

1. Open Plugins, click "+", choose "Add custom MCP server".
2. Name: `VantagePeers`. URL: `https://mcp.vantagepeers.com/mcp`. Authentication: OAuth.
3. Tick the warning, then click "Create as plugin".
4. Sign in and complete the consent page.

<!-- not measured: FR labels of the ChatGPT screens; labels above are as recorded in English. -->

### Can ChatGPT write?

OpenAI's help article 12584461 states that custom MCP connectors have full access on Business, Enterprise and Edu plans and are read-only on Pro. That is OpenAI's statement (paraphrased here, not verbatim). We also observed, on 2026-10-31, a ChatGPT Free plan writing a memory to VantagePeers Cloud, 53 seconds after its token was issued (memory j576stz26pmrpv2b75nz5sppxx8hbqvd, createdBy "Sacha"). Plan rules are OpenAI's and can change: if a write is refused, check your plan first.

<!-- not measured: Plus plan behaviour; the verbatim text of the OpenAI article. -->

## Grok

1. Open Connectors > New connector > Custom connector. (French UI, measured: "Connecteurs > Nouveau connecteur > Connecteur personnalisé".)
2. Name: `VantagePeers`. URL: `https://mcp.vantagepeers.com/mcp`.
3. Add it, then connect, and complete the consent page.

<!-- not measured: English labels of the Grok screens. -->

## OpenCode

1. Put this in `~/.config/opencode/opencode.json` (or merge the `mcp` key into the file you already have):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "mcp": {
       "vantagepeers": {
         "type": "remote",
         "url": "https://mcp.vantagepeers.com/mcp",
         "enabled": true
       }
     }
   }
   ```

2. Run `opencode mcp auth vantagepeers`, sign in and complete the consent page.
3. Check it: `opencode mcp list` shows `vantagepeers`; if it does not connect, `opencode mcp debug vantagepeers` prints why.

<!-- source: opencode.ai/docs/mcp-servers and opencode.ai/docs/config, fetched 2026-11-01. not measured: a full OpenCode sign-in against VantagePeers Cloud. -->

## Test it

Paste this right after connecting (English):

```
Call whoami and tell me the agent name and the organisation you act as.
From now on, record decisions automatically in VantagePeers. Before answering
what was decided or what remains to do, search VantagePeers first.
```

Version française :

```
Appelle whoami et dis-moi le nom de l'agent et l'organisation que tu incarnes.
Désormais, enregistre automatiquement les décisions dans VantagePeers. Avant de
répondre à ce qui a été décidé ou à ce qu'il reste à faire, cherche d'abord
dans VantagePeers.
```

The answer must name the agent you chose on the consent page and your organisation.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The invitation email link opens `https://mcp.vantagepeers.com/mcp` and shows `{"error":"Missing Authorization header..."}` | That URL is the server, not a sign-in page. Sign in through the assistant's connector. A fix for the link is pending (task k178xp66h7p0ds6vg69sqzw2vn8hbfrw). |
| Claude: plugin installed, "le connecteur n'est pas actif dans cette conversation" | The plugin is not connected yet. Do step 2 of the Claude section. |
| A tool is missing or behaves like an old version | A client connected before a server update caches tool definitions at connect time. Disconnect and reconnect once. |
| Writes refused with "agents autorisés par la connexion : ..." | The agent is missing from the organisation's roster. Nothing to do on the client side: contact the VantagePeers operator. |
| "aucun agent ne t'est attribué" | No agent was chosen or bound. Reconnect and pick the agent on the consent page. |
