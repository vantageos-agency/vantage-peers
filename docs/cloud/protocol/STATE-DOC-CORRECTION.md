# State-doc correction — R2 (housekeeping)

Target file (ElPi-Corp repo, not edited here): `analysis/le-cap/etat-vantagepeers-vs-cap.md`. This file only PRODUCES the patch; apply it in a separate ElPi-Corp PR. Change ONLY the two quotations below — the surrounding finding text is unchanged.

Source of the CURRENT cap wording: `git -C /root/coding/elpi-corp show e3c1ffd605af22adcdd7b8a225b4d57462ecebe3:analysis/le-cap/le-cap.md`, line 218 (§6, item "VP.1" — "Joignable sans rien construire — sous une condition").

Source of the STALE quotations: `git -C /root/coding/elpi-corp show origin/main:analysis/le-cap/etat-vantagepeers-vs-cap.md`, lines 120 and 123.

## Quotation 1 — line 120 (§4 "Le différenciant")

**Old (verbatim, stale):**
> "VP ajoute un lieu partagé — mémoire, notes, missions, tâches, messages — accessible à **tout agent qui déclare la connexion** : les connexions sont disponibles aux sous-agents. C'est ce qui fait une organisation plutôt qu'un arbre."

**New (verbatim, current cap wording):**
> "VP ajoute un lieu partagé — mémoire, notes, missions, tâches, messages — accessible à **tout agent qui déclare la connexion**. Chaque agent porte son propre `connections/`, et c'est la fabrique qui le lui écrit. C'est ce qui fait une organisation plutôt qu'un arbre."

(Current cap source for the replacement clause: `le-cap.md` §4 "Le différenciant", the paragraph beginning "VP ajoute un lieu partagé" — verified present in the `e3c1ffd6` cap text fetched for this task, which reads: "VP ajoute un lieu partagé — mémoire, notes, missions, tâches, messages — accessible à **tout agent qui déclare la connexion**. Chaque agent porte son propre `connections/`, et c'est la fabrique qui le lui écrit. C'est ce qui fait une organisation plutôt qu'un arbre.")

## Quotation 2 — line 123 (§6, item 1)

**Old (verbatim, stale):**
> 1. "**Rien à construire pour être joignable.** Les connexions étant disponibles aux sous-agents, un spécialiste atteint VP comme son orchestrateur."

**New (verbatim, current cap wording — cap §6 VP.1, `le-cap.md` line 218):**
> 1. "**Joignable sans rien construire — sous une condition.** Chaque agent atteint VP si, et seulement si, la fabrique écrit son `connections/vantage-peers.ts` dans son propre arbre. Rien ne s'hérite : ce fichier est émis autant de fois qu'il y a d'agents."

## What does NOT change

The finding text in both §2 (item 1: "Reachable, nothing to build") and §4 (the correction paragraph "The correction that matters most — §6.1 vs the Eve isolation boundary", lines 141-145 of the state doc) stays exactly as written — it already correctly states that a declared sub-agent does NOT inherit the orchestrator's VP connection and needs its own `connections/vantage-peers.ts` emitted by the factory. That finding is what the cap's OWN wording now says too (VP.1's "si, et seulement si, la fabrique écrit son `connections/vantage-peers.ts`" — the corrected cap agrees with the state doc's finding); only the QUOTED cap text was stale, not the conclusion drawn from it.

## Proof this closes R2

After the patch: `grep -c "les connexions sont disponibles aux sous-agents" analysis/le-cap/etat-vantagepeers-vs-cap.md` → expected `0`. The current-cap phrasing ("si, et seulement si, la fabrique écrit son `connections/vantage-peers.ts`") is present in its place. `git diff` on that file shows only the two quotations changed.
