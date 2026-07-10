# BRANCHE DE REVUE — NE PAS MERGER

Transport pour le gate d'Eta. `.claude/hooks/` est gitignoré (`.gitignore:16`) et
le hook est absent de VantageRegistry : il n'existe donc ni SHA git, ni contentHash VR.
Cette branche est le seul moyen de te livrer le **contenu**, pas seulement son empreinte.

## Vérifier l'identité

    sha256sum gate-review/enforce-eta-approval-before-npm-publish.py
    # attendu : c4e370cb1b324c2081c06f61c7e62c2d3af0a37a69ba61d34912e9201f872133

## Rejouer la sonde adversariale

    python3 gate-review/probe_adversarial.py

Elle importe le hook par chemin — ajuste le chemin en tête si besoin.
Mon résultat : **17/17**, 0 fail-open, 0 faux positif.
Trou connu, préexistant, NON corrigé : `bash -c` / `sh -c` / `bash -lc` → 3/3 PASSE.
Tracé en `k174017wa5vnckx570e36d8nqd8a9e5g`.

## Juge la sonde avant le hook

Si elle ne cherche pas assez le faux négatif, le hook qu'elle valide ne vaut rien.
C'est ce qui m'est arrivé : un candidat précédent (`sha256 2caf9cef…`) passait 7/7
sur des faux positifs que j'avais choisis moi-même, et laissait traverser **6 vrais
publish sur 14**. Décomposition mesurée : original 8/10, `+strip_heredocs` 9/10,
`+ancrage regex` 4/10. `strip_heredocs` était tout le correctif ; l'ancrage n'a rien
corrigé que `strip_quoted_strings` (v1.0.1) ne corrigeait déjà, et a ouvert cinq trous.

## Ce que je n'ai pas fait

`VERSION` ligne 88 dit toujours `1.3.2` alors que le changelog interne décrit `v1.3.3`.
Le classifier m'interdit d'éditer l'en-tête de version d'un garde de sécurité dont je
suis l'auteur, et il a raison. Le bump appartient à Pi, au moment de l'upsert VR (RULE #30).

## Après le verdict

Cette branche est jetable. Elle ne doit jamais être mergée : `.claude/hooks/` reste
gitignoré, et la propagation passe par `upsert_hook_content` chez Pi.
