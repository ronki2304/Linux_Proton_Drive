# Comment l'IA peut transformer des frustrations en acceleration des organisations

**Evenement :** Lead Innovation Day — Leadership Edition, MBA EDHEC
**Speaker :** Jeremy Ronk
**Format estime :** 30-40 minutes + Q&A
**Use case fil rouge :** ProtonDrive Linux Client — projet open source solo, augmente par IA

---

## Structure de la presentation

### 1. Les frustrations sont des signaux, pas du bruit (5 min)

**Ouverture interactive :**
> "Combien d'entre vous utilisent au quotidien un outil qui ne fait pas exactement ce dont vous avez besoin ?"

**Le cas Proton Drive Linux :**
- Proton : 100M d'utilisateurs, clients Windows/Mac/iOS/Android — zero client Linux desktop
- Communaute qui demande depuis 3 ans sur Reddit, forums Proton, GitHub
- Proton le sait, le reconnait, mais ne priorise pas — trop niche, pas assez de ROI apparent

**Le parallele entreprise :**
- Dans vos organisations, les frustrations clients et internes sont documentees — tickets Zendesk, retros, NPS verbatims
- Elles stagnent dans des backlogs qu'on ne priorise jamais
- On les etiquette "won't fix", "nice to have", "V2"

**These :**
> Chaque frustration non resolue est de l'energie perdue. L'IA permet enfin de la convertir.

---

### 2. De la frustration a la specification : l'IA comme catalyseur de clarte (10 min)

**Le piege classique :**
Frustration → on fonce coder / acheter un outil → on resout le mauvais probleme

**Ce que l'IA change :**
- Passage de "il n'y a pas de client Linux" a un PRD structure en quelques heures
- Product brief, user stories, architecture — le meme livrable qu'une equipe produit de 10, produit par une personne
- L'IA ne genere pas la vision — elle **compresse le temps entre l'intuition et la formalisation**

**Demo concrete (2 min max) :**
Montrer un echange reel entre le developpeur et l'IA pour cadrer le probleme — de la frustration brute au document de specification actionnable.

**Miroir entreprise :**
- Vos equipes passent 3 mois a ecrire des specs
- Pas parce que c'est complique — parce que la coordination coute cher
- L'IA elimine le cout de coordination, pas la reflexion
- Un product manager augmente par l'IA peut produire en 1 semaine ce qui prenait 6 semaines de workshops, interviews, et allers-retours

---

### 3. De la specification au produit : l'IA comme multiplicateur d'execution (10 min)

**Ce qu'un individu augmente peut produire :**
- Architecture deux processus : Python GTK4 (interface native Linux) + TypeScript/Bun (moteur de sync)
- Sync bidirectionnel avec detection de conflits
- Packaging multi-distribution Linux (Flatpak)
- Le tout livre par une seule personne

**Les roles de l'IA dans l'execution :**

| Role | Exemple concret |
|------|----------------|
| Architecte | Conception du systeme a deux processus, protocole IPC, gestion d'etat |
| Pair programmer | Implementation quotidienne, revue de code en temps reel |
| QA engineer | Generation de tests, detection de cas limites, revue de securite |
| Tech writer | Documentation technique, retrospectivedocumentation du projet existant |

**Le moment d'honnetete (crucial pour la credibilite) :**
- Sans rigueur produit en amont, l'IA accelere dans la mauvaise direction
- L'IA a des angles morts — elle ne connait pas votre contexte metier, vos contraintes politiques, votre culture
- Le jugement humain reste le volant, l'IA est le moteur
- Plusieurs echecs concrets rencontres pendant le projet : [preparer 1-2 anecdotes d'erreurs de l'IA corrigees par le jugement humain]

**Miroir entreprise :**
> Une equipe de 3 augmentee par l'IA peut aujourd'hui livrer ce qu'une equipe de 15 livrait il y a 2 ans. La question n'est pas "faut-il moins de monde" — c'est "que pourrait-on resoudre de plus avec les memes equipes ?"

---

### 4. Le framework : transformer vos frustrations en acceleration (10 min)

**Modele actionnable en 4 etapes :**

```
IDENTIFIER  →  CADRER  →  EXECUTER  →  MESURER
```

| Etape | Action | Role de l'IA | Role du leader |
|-------|--------|-------------|----------------|
| **Identifier** | Miner les frustrations (tickets, retros, forums internes) | Synthese et clustering de milliers de signaux | Decider laquelle vaut le coup |
| **Cadrer** | Transformer la frustration en spec actionnable | Compression du temps de formalisation | Valider que c'est le bon probleme |
| **Executer** | Petite equipe augmentee, cycles courts | Multiplication de la capacite d'execution | Proteger l'equipe, degager les obstacles |
| **Mesurer** | Feedback loop rapide | Analyse des retours utilisateurs | Decider : iterer, pivoter ou tuer |

**Le message cle :**
> Le role du leader n'est pas de maitriser l'IA — c'est de **choisir les bonnes frustrations a resoudre** et de donner le mandat a des petites equipes augmentees.

**Ce que ca implique pour les organisations :**
- Arreter de monter des programmes a 50 personnes pour chaque probleme
- Identifier les irritants a fort impact, donner le mandat a une petite equipe
- Mesurer en semaines, pas en trimestres
- Accepter que la solution vienne d'en bas, pas d'un comite de pilotage

---

### 5. Closing — l'appel a l'action (5 min)

> "Dans vos organisations, il y a en ce moment un 'Proton Drive Linux' — un probleme que tout le monde voit, que personne ne resout, et dont la solution accelererait tout le reste."

> "L'IA ne va pas le trouver pour vous. Mais une fois que vous l'avez identifie, elle peut transformer une equipe de 3 personnes motivees en force de frappe qui livre en semaines ce qui prenait des trimestres."

**Question de cloture :**
> "Quelle est la frustration que vous allez arreter d'ignorer lundi matin ?"

---

## Notes de mise en scene

- **Ouvrir par la frustration personnelle**, pas par l'IA — le public doit se reconnaitre avant d'entendre la solution
- **Une seule demo live** dans l'acte 2 ou 3 — 2 minutes max, montrer un echange reel avec l'IA, pas un slide
- **Le tableau du framework (acte 4) = le slide qu'ils photographient** — le rendre visuel et memorable
- **Finir sur une question, pas une conclusion** — ca provoque la discussion en Q&A
- **Eviter le jargon technique** — GTK4, Bun, TypeScript sont des details illustratifs, pas le sujet. Les nommer une fois pour la credibilite, ne pas s'y attarder
- **Preparer 2-3 anecdotes d'echec** — moments ou l'IA s'est trompee et le jugement humain a corrige. Ca construit la confiance du public et evite l'effet "publireportage IA"

---

## Slides cles a preparer

1. **Slide d'ouverture** — Titre + question interactive
2. **La frustration en chiffres** — 100M utilisateurs, 0 client Linux, 3 ans d'attente
3. **Le parcours** — Frustration → Spec → Produit (timeline visuelle)
4. **Demo** — Screenshot ou video courte d'un echange IA (cadrage ou implementation)
5. **Les roles de l'IA** — Tableau architecte/pair programmer/QA/tech writer
6. **Le moment d'honnetete** — Ce que l'IA ne fait PAS bien
7. **Le framework IDENTIFIER-CADRER-EXECUTER-MESURER** — Le slide a photographier
8. **Roles IA vs Leader** — Tableau comparatif
9. **La question de cloture** — "Quelle frustration allez-vous arreter d'ignorer ?"

---

## A preparer avant la conference

- [ ] Selectionner 1 echange IA marquant pour la demo (cadrage produit ou resolution de probleme technique)
- [ ] Preparer 2-3 anecdotes d'echec/correction de l'IA
- [ ] Adapter les exemples "miroir entreprise" au secteur dominant dans la salle (finance, industrie, tech ?)
- [ ] Chronometrer une repetition — viser 35 min pour laisser 10 min de Q&A
- [ ] Preparer 3-4 questions de rebond pour le Q&A au cas ou ca demarre lentement
