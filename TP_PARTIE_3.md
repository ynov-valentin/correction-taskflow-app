# TaskFlow — TP Cloud & DevOps

Architecture multi-services pour apprendre Kubernetes, l'observabilité et le CI/CD.

## Partie 3 - Utiliser Kubernetes et minikube pour des déploiements locaux

- Écrire les Kubernetes manifests (module Kube)
- Créer les charts Helm (module Helm)

### Manifests Kubernetes
 
- Les manifests couvrent tous les services de l'application
- Chaque service a un `Deployment` et un `Service` correctement configurés
- Les variables d'environnement sont gérées via `ConfigMap` et `Secret`
- Les sondes `livenessProbe` et `readinessProbe` sont configurées sur les services qui le justifient
- Les `resources.requests` et `resources.limits` sont définis
- L'application est accessible via un `Ingress`
 
### Charts Helm
 
- Un chart Helm couvre l'ensemble de l'application
- Les valeurs sont externalisées dans `values.yml` — pas de valeurs hardcodées dans les templates
- Les templates sont propres et réutilisables
- Le chart se déploie sans erreur avec `helm upgrade --install`
- Des fichiers `values.staging.yml` et `values.production.yml` distincts sont présents avec des configurations différentes (replicas, ressources, domaine)
 
### Questions théoriques — Partie 2
 
- Différence entre un `Deployment` et un `StatefulSet` — dans quel cas utiliser l'un ou l'autre
- Rôle du `Service` Kubernetes vs l'`Ingress`
- Avantage de Helm sur les manifests YAML bruts — à partir de quel niveau de complexité Helm devient pertinent
