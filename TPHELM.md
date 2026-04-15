# TP — Kubernetes partie 2 : Helm

## Objectif

Packager l'ensemble de TaskFlow dans un chart Helm, déployer la stack d'observabilité via les charts officiels, et brancher le déploiement automatique dans GitHub Actions.

---

## Prérequis

- TP partie 1 complété — le cluster kind tourne, les manifests YAML existent
- Helm installé — https://helm.sh/docs/intro/install/
- Le cluster kind `taskflow` toujours actif

---

## Étape 1 — Constater le problème

Comptez le nombre de fichiers YAML que vous avez écrits dans `k8s/base/`.

> **Question** : si vous deviez déployer en production avec `replicas: 3` et des limites de ressources différentes, combien de fichiers devriez-vous modifier ?

C'est le problème que Helm résout.

---

## Étape 2 — Créer la structure du chart

```bash
mkdir -p helm/taskflow/templates
```

Créez `helm/taskflow/Chart.yaml` :

```yaml
apiVersion: v2
name: taskflow
description: TaskFlow — application multi-services
type: application
version: 0.1.0
appVersion: "1.0.0"
```

Créez `helm/taskflow/values.yaml` — les valeurs par défaut :

```yaml
image:
  prefix: <votre-dockerhub>/taskflow
  tag: latest
  pullPolicy: IfNotPresent

replicaCount: 1

resources:
  requests:
    memory: "128Mi"
    cpu: "100m"
  limits:
    memory: "256Mi"
    cpu: "200m"

postgres:
  user: taskflow
  password: taskflow
  db: taskflow

jwt:
  secret: change-in-production

otel:
  endpoint: http://otel-collector:4318
```

---

## Étape 3 — Créer les templates

Créez `helm/taskflow/templates/task-service.yaml` :

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: task-service
  namespace: {{ .Release.Namespace }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app: task-service
  template:
    metadata:
      labels:
        app: task-service
    spec:
      containers:
        - name: task-service
          image: {{ .Values.image.prefix }}-task-service:{{ .Values.image.tag }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          env:
            - name: PORT
              value: "3002"
            - name: DATABASE_URL
              value: postgresql://{{ .Values.postgres.user }}:{{ .Values.postgres.password }}@postgres:5432/{{ .Values.postgres.db }}
            - name: OTEL_SERVICE_NAME
              value: task-service
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: {{ .Values.otel.endpoint }}
          ports:
            - containerPort: 3002
          readinessProbe:
            httpGet:
              path: /health
              port: 3002
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: 3002
            initialDelaySeconds: 15
            periodSeconds: 10
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
---
apiVersion: v1
kind: Service
metadata:
  name: task-service
  namespace: {{ .Release.Namespace }}
spec:
  selector:
    app: task-service
  ports:
    - port: 3002
      targetPort: 3002
```

Faites de même pour les autres services en adaptant le template.

---

## Étape 4 — Values par environnement

Créez `helm/taskflow/values.staging.yaml` :

```yaml
replicaCount: 1
resources:
  limits:
    memory: 256Mi
```

Créez `helm/taskflow/values.production.yaml` :

```yaml
replicaCount: 3
resources:
  limits:
    memory: 512Mi
jwt:
  secret: REMPLACER_PAR_SECRET_REEL
```

---

## Étape 5 — Installer le chart

```bash
# Désinstaller ce qui tourne déjà en staging
kubectl delete namespace staging
kubectl create namespace staging

# Installer via Helm
helm upgrade --install taskflow ./helm/taskflow \
  --namespace staging \
  --values ./helm/taskflow/values.staging.yaml
```

Vérifiez :

```bash
helm list -n staging
kubectl get all -n staging
```

---

## Étape 6 — Tester une mise à jour

Changez `replicaCount: 2` dans `values.staging.yaml` et appliquez :

```bash
helm upgrade taskflow ./helm/taskflow \
  --namespace staging \
  --values ./helm/taskflow/values.staging.yaml
```

Observez le rolling update dans Terminal A.

Testez le rollback :

```bash
helm rollback taskflow 1 -n staging
helm history taskflow -n staging
```

---

## Étape 7 — Stack d'observabilité via chart officiel

```bash
# Ajouter le repo
helm repo add prometheus-community \
  https://prometheus-community.github.io/helm-charts
helm repo update

# Installer
helm upgrade --install monitoring \
  prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set grafana.adminPassword=admin
```

Attendez que les Pods soient prêts :

```bash
kubectl get pods -n monitoring -w
```

Accédez à Grafana :

```bash
kubectl port-forward -n monitoring svc/monitoring-grafana 3100:80
```

> Grafana est disponible sur http://localhost:3100 (admin/admin)

> **Question** : combien de fichiers avez-vous écrits pour installer cette stack complète ? Comparez avec ce que vous avez fait en partie 1.

---

## Étape 8 — Brancher GitHub Actions

Créez le fichier `.github/workflows/deploy-staging.yml` :

```yaml
name: Deploy to Staging

on:
  push:
    branches: [main]

jobs:
  deploy:
    name: Deploy
    runs-on: ubuntu-latest
    needs: build   # attend que le build soit terminé

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Install Helm
        uses: azure/setup-helm@v3

      - name: Configure kubectl
        run: |
          mkdir -p ~/.kube
          echo "${{ secrets.KUBECONFIG_B64 }}" | base64 -d > ~/.kube/config

      - name: Deploy to staging
        run: |
          helm upgrade --install taskflow ./helm/taskflow \
            --namespace staging \
            --create-namespace \
            --values ./helm/taskflow/values.staging.yaml \
            --set image.tag=${{ github.sha }}
```

> **Note** : `KUBECONFIG_B64` est le kubeconfig encodé en base64.
> Pour kind en local, ce workflow ne peut pas atteindre votre cluster.
> Il sera pleinement fonctionnel lors du module Cloud (partie 3) avec un vrai cluster accessible depuis internet.
> Pour l'instant, vérifiez que le YAML est valide et que `helm upgrade` fonctionne en local.

---

## Étape 9 — Exercice debugging Helm

Le chart suivant contient des erreurs. Identifiez-les et corrigez-les.

```yaml
# values.yaml cassé
image:
  prefix: monuser/taskflow
  tag: latest

replicaCount: "2"        # ← erreur de type
```

```yaml
# template cassé
replicas: {{ .Values.replicaCount }}
image: {{ .Values.image.prefix }}-task-service:{{ .Values.image.Tag }}  # ← erreur de casse
```

Utilisez `helm template` pour déboguer sans appliquer :

```bash
helm template taskflow ./helm/taskflow --values ./helm/taskflow/values.staging.yaml
```

Documentez dans votre REPORT.md comment vous avez trouvé et corrigé les erreurs.

---

## Livrable

- Dossier `helm/taskflow/` versionné avec chart complet
- `values.staging.yaml` et `values.production.yaml` présents
- Stack d'observabilité installée via Helm et accessible
- Workflow GitHub Actions `deploy-staging.yml` présent et documenté dans le README
- Correction des erreurs de debugging dans `REPORT.md`
- Réponse aux deux questions encadrées dans `REPORT.md`