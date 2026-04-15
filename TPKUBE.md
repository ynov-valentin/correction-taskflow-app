# TP — Kubernetes partie 1 : les bases à la main

## Objectif

Déployer l'intégralité de la stack TaskFlow sur un cluster kind local en écrivant les manifests YAML manuellement. L'objectif est de comprendre chaque ressource Kubernetes par la pratique — et de ressentir la répétition qui motive Helm.

---

## Étape 0 - pré-requis

- Docker installé et en cours d'exécution
- `kind` installé — https://kind.sigs.k8s.io/docs/user/quick-start/#installation
- `kubectl` installé — https://kubernetes.io/docs/tasks/tools/
- Les images TaskFlow publiées sur Docker Hub (votre CI doit avoir tourné)

---

## Étape 1 — Créer le cluster kind multi-nœuds

Créez le fichier `k8s/kind-config.yaml` à la racine du projet :

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: 80
        hostPort: 80
        protocol: TCP
      - containerPort: 443
        hostPort: 443
        protocol: TCP
  - role: worker
  - role: worker
```

Créez le cluster :

```bash
kind create cluster --name taskflow --config k8s/kind-config.yaml
```

Vérifiez que le cluster est prêt :

```bash
kubectl get nodes
```

Vous devez voir 3 nœuds en état `Ready`.

Créez le namespace staging :

```bash
kubectl create namespace staging
```

---

## Étape 2 — Ouvrir les terminaux d'observation

Avant d'écrire quoi que ce soit, ouvrez 2 terminaux et gardez-les visibles.

**Terminal A — Watch Pods :**
```bash
kubectl get pods -n staging -o wide -w
```

**Terminal B — Events :**
```bash
kubectl get events -n staging --sort-by=.lastTimestamp -w
```

Ces deux fenêtres restent ouvertes pendant tout le TP.

---

## Étape 3 — Déployer PostgreSQL (StatefulSet)

Créez le fichier `k8s/base/postgres/secret.yaml` :

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: postgres-secret
  namespace: staging
type: Opaque
stringData:
  POSTGRES_USER: taskflow
  POSTGRES_PASSWORD: taskflow
  POSTGRES_DB: taskflow
```

Créez `k8s/base/postgres/statefulset.yaml` :

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: staging
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          envFrom:
            - secretRef:
                name: postgres-secret
          ports:
            - containerPort: 5432
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "taskflow"]
            initialDelaySeconds: 5
            periodSeconds: 5
          volumeMounts:
            - name: postgres-data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: postgres-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
```

Créez `k8s/base/postgres/service.yaml` :

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: staging
spec:
  selector:
    app: postgres
  ports:
    - port: 5432
      targetPort: 5432
  clusterIP: None   # Headless service pour StatefulSet
```

Appliquez :

```bash
kubectl apply -f k8s/base/postgres/
```

Attendez que le Pod soit prêt :

```bash
kubectl get pods -n staging -w
```

---

> ### Pause réflexion — Deployment vs StatefulSet
>
> Vous venez de déployer PostgreSQL avec un **StatefulSet**. Vous utiliserez des **Deployments** pour les services applicatifs à partir de l'étape suivante.
>
> Répondez dans votre `REPORT.md` :
>
> 1. Quelle propriété du StatefulSet garantit que chaque Pod conserve toujours le même volume de stockage, même après un redémarrage ou un rescheduling sur un autre nœud ?
> 2. Pourquoi un Deployment serait-il inadapté pour PostgreSQL, même si techniquement on peut lui attacher un volume ?
> 3. Parmi les services restants de la stack TaskFlow (Redis, notification-service, api-gateway, frontend), lequel mériterait potentiellement un StatefulSet plutôt qu'un Deployment en production ? Justifiez votre choix.

---

## Étape 4 — Déployer Redis (Deployment)

Redis est utilisé comme bus de messages entre le task-service et le notification-service. Contrairement à PostgreSQL, une perte des données Redis au redémarrage est acceptable en environnement de développement — un Deployment suffit ici.

Créez `k8s/base/redis/deployment.yaml` :

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: staging
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            requests:
              memory: "32Mi"
              cpu: "50m"
            limits:
              memory: "64Mi"
              cpu: "100m"
```

Créez `k8s/base/redis/service.yaml` :

```yaml
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: staging
spec:
  selector:
    app: redis
  ports:
    - port: 6379
      targetPort: 6379
```

Appliquez :

```bash
kubectl apply -f k8s/base/redis/
```

---

## Étape 5 — Déployer le user-service

Créez `k8s/base/user-service/configmap.yaml` :

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: user-service-config
  namespace: staging
data:
  PORT: "3001"
  DATABASE_URL: postgresql://taskflow:taskflow@postgres:5432/taskflow
  OTEL_SERVICE_NAME: user-service
  OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
```

Créez `k8s/base/user-service/deployment.yaml` :

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-service
  namespace: staging
spec:
  replicas: 2
  selector:
    matchLabels:
      app: user-service
  template:
    metadata:
      labels:
        app: user-service
    spec:
      containers:
        - name: user-service
          image: <votre-dockerhub>/taskflow-user-service:latest
          envFrom:
            - configMapRef:
                name: user-service-config
          ports:
            - containerPort: 3001
          readinessProbe:
            httpGet:
              path: /health
              port: 3001
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: 3001
            initialDelaySeconds: 15
            periodSeconds: 10
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "200m"
```

Créez `k8s/base/user-service/service.yaml` :

```yaml
apiVersion: v1
kind: Service
metadata:
  name: user-service
  namespace: staging
spec:
  selector:
    app: user-service
  ports:
    - port: 3001
      targetPort: 3001
```

Appliquez :

```bash
kubectl apply -f k8s/base/user-service/
```

---

## Étape 6 — Déployer le task-service

Créez `k8s/base/task-service/configmap.yaml` :

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: task-service-config
  namespace: staging
data:
  PORT: "3002"
  DATABASE_URL: postgresql://taskflow:taskflow@postgres:5432/taskflow
  REDIS_URL: redis://redis:6379
  OTEL_SERVICE_NAME: task-service
  OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
```

Créez `k8s/base/task-service/deployment.yaml` :

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: task-service
  namespace: staging
spec:
  replicas: 2
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
          image: <votre-dockerhub>/taskflow-task-service:latest
          envFrom:
            - configMapRef:
                name: task-service-config
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
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "200m"
```

Créez `k8s/base/task-service/service.yaml` :

```yaml
apiVersion: v1
kind: Service
metadata:
  name: task-service
  namespace: staging
spec:
  selector:
    app: task-service
  ports:
    - port: 3002
      targetPort: 3002
```

Appliquez :

```bash
kubectl apply -f k8s/base/task-service/
```

---

## Étape 7 — Déployer le notification-service

Le notification-service s'abonne aux événements Redis publiés par le task-service.

Créez les 3 fichiers dans `k8s/base/notification-service/` en vous basant sur le pattern des étapes précédentes :

- **ConfigMap** : variables `PORT` (3003), `REDIS_URL` (redis://redis:6379), `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`
- **Deployment** : image `taskflow-notification-service`, 1 replica, readinessProbe sur `/health:3003`
- **Service** : port 3003

Appliquez et vérifiez que le Pod passe en `1/1 Running`.

---

## Étape 8 — Déployer l'api-gateway

L'api-gateway est le point d'entrée unique pour les clients. Il reçoit les requêtes et les proxy vers les services internes.

Créez `k8s/base/api-gateway/configmap.yaml` :

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-gateway-config
  namespace: staging
data:
  PORT: "3004"
  USER_SERVICE_URL: http://user-service:3001
  TASK_SERVICE_URL: http://task-service:3002
  NOTIFICATION_SERVICE_URL: http://notification-service:3003
  OTEL_SERVICE_NAME: api-gateway
  OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
```

Créez `k8s/base/api-gateway/deployment.yaml` :

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: staging
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api-gateway
  template:
    metadata:
      labels:
        app: api-gateway
    spec:
      containers:
        - name: api-gateway
          image: <votre-dockerhub>/taskflow-api-gateway:latest
          envFrom:
            - configMapRef:
                name: api-gateway-config
          ports:
            - containerPort: 3004
          readinessProbe:
            httpGet:
              path: /health
              port: 3004
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: 3004
            initialDelaySeconds: 15
            periodSeconds: 10
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "200m"
```

Créez `k8s/base/api-gateway/service.yaml` :

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-gateway
  namespace: staging
spec:
  selector:
    app: api-gateway
  ports:
    - port: 3004
      targetPort: 3004
```

Appliquez :

```bash
kubectl apply -f k8s/base/api-gateway/
```

---

## Étape 9 — Déployer le frontend

Le frontend est une application React compilée et servie par nginx. L'image embarque une configuration nginx qui proxie les requêtes `/api` vers l'api-gateway — ce nom DNS est résolu automatiquement grâce au Service Kubernetes créé à l'étape précédente.

Créez `k8s/base/frontend/deployment.yaml` :

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: staging
spec:
  replicas: 1
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
        - name: frontend
          image: <votre-dockerhub>/taskflow-frontend:latest
          ports:
            - containerPort: 80
          readinessProbe:
            httpGet:
              path: /
              port: 80
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            requests:
              memory: "32Mi"
              cpu: "50m"
            limits:
              memory: "64Mi"
              cpu: "100m"
```

Créez `k8s/base/frontend/service.yaml` :

```yaml
apiVersion: v1
kind: Service
metadata:
  name: frontend
  namespace: staging
spec:
  selector:
    app: frontend
  ports:
    - port: 80
      targetPort: 80
```

Appliquez :

```bash
kubectl apply -f k8s/base/frontend/
```

---

## Étape 10 — Vérifier que tout tourne

```bash
kubectl get all -n staging
```

Tous les Pods doivent être en `1/1 Running`. Si un Pod reste en `0/1` ou `CrashLoopBackOff` :

```bash
kubectl describe pod <nom-du-pod> -n staging
kubectl logs <nom-du-pod> -n staging
```

Vérifiez les logs des services principaux :

```bash
kubectl logs -n staging deployment/task-service
kubectl logs -n staging deployment/user-service
kubectl logs -n staging deployment/notification-service
kubectl logs -n staging deployment/api-gateway
```

> **Note :** vous pouvez voir des erreurs de connexion vers `otel-collector` dans les logs. C'est normal — le collecteur OpenTelemetry fait partie de la stack d'observabilité (voir `docker-compose.infra.yml`) qui n'est pas déployée dans ce TP. Ces erreurs sont sans impact sur le fonctionnement applicatif.

---

## Étape 11 — Exercice de débogage

Les deux manifests ci-dessous contiennent chacun une erreur. Appliquez-les, observez ce qui se passe, diagnostiquez et corrigez.

**Règle : aucun indice n'est fourni ici. Utilisez uniquement `kubectl`.**

---

**Manifest A** — appliquez avec `kubectl apply -f` et observez le Terminal A :

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: debug-worker
  namespace: staging
spec:
  replicas: 1
  selector:
    matchLabels:
      app: debug-worker
  template:
    metadata:
      labels:
        app: debug-worker
    spec:
      containers:
        - name: task-worker
          image: <votre-dockerhub>/taskflow-task-services:latest
          envFrom:
            - configMapRef:
                name: task-service-config
          ports:
            - containerPort: 3002
          readinessProbe:
            httpGet:
              path: /health
              port: 3002
            initialDelaySeconds: 10
            periodSeconds: 5
```

**Manifest B** — appliquez avec `kubectl apply -f` et vérifiez que le service atteint bien les pods :

```yaml
apiVersion: v1
kind: Service
metadata:
  name: debug-frontend-svc
  namespace: staging
spec:
  selector:
    app: taskflow-frontend
  ports:
    - port: 80
      targetPort: 80
```

Pour chaque manifest, documentez dans votre `REPORT.md` :
- Quelle commande `kubectl` vous a permis d'identifier le problème
- Ce que vous avez vu dans la sortie de cette commande
- La correction appliquée et pourquoi elle résout le problème

---

## Étape 12 — Exposer avec un Ingress

Activez l'addon Ingress de kind :

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
```

Attendez que l'Ingress controller soit prêt :

```bash
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=90s
```

Créez `k8s/base/ingress.yaml` :

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: taskflow-ingress
  namespace: staging
spec:
  ingressClassName: nginx
  rules:
    - http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api-gateway
                port:
                  number: 3004
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend
                port:
                  number: 80
```

Appliquez et testez :

```bash
kubectl apply -f k8s/base/ingress.yaml
curl http://localhost/api/health
```

Ouvrez http://localhost dans votre navigateur — vous devez voir l'interface TaskFlow.

---

> ### Pause réflexion — Service vs Ingress
>
> Vous avez maintenant des **Services** (ClusterIP) et un **Ingress** dans votre cluster. Ces deux ressources exposent du trafic, mais à des niveaux et avec des responsabilités différentes.
>
> Répondez dans votre `REPORT.md` :
>
> 1. Un Service de type `ClusterIP` peut-il être atteint directement depuis votre machine locale (sans `kubectl port-forward`) ? Expliquez pourquoi.
> 2. Quel composant du cluster fait réellement le routage HTTP que vous avez décrit dans votre `Ingress` ? Comment est-il apparu dans le cluster ?
> 3. Dans quel cas utiliseriez-vous un Service de type `LoadBalancer` plutôt qu'un Ingress ? Donnez un exemple concret.

---

## Étape 13 — Scénarios d'observation (live)

Ces scénarios se font en gardant les terminaux A et B ouverts.

### Scénario 1 — Self-healing

```bash
kubectl delete pod -n staging -l app=task-service
```

Observez le Terminal A. Décrivez dans votre `REPORT.md` ce que vous voyez et pourquoi Kubernetes recrée les Pods.

### Scénario 2 — Readiness probe

```bash
kubectl patch deployment task-service -n staging --type='json' \
  -p='[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/does-not-exist"}]'
```

Observez la colonne READY dans le Terminal A. Testez que le service ne répond plus via l'Ingress. Remettez à la normale :

```bash
kubectl patch deployment task-service -n staging --type='json' \
  -p='[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/health"}]'
```

Expliquez dans votre `REPORT.md` la différence entre une readiness probe et une liveness probe, et ce qui se serait passé si vous aviez cassé la liveness probe à la place.

### Scénario 3 — Rolling update

Modifiez le tag de l'image dans le deployment task-service et appliquez. Observez la cohabitation des deux versions dans Terminal A.

```bash
kubectl rollout status -n staging deployment/task-service
kubectl rollout history -n staging deployment/task-service
```

### Scénario 4 — Node crash

```bash
docker stop taskflow-worker2
```

Observez Terminal A. Quand Kubernetes réagit-il ? Sur quel nœud les Pods sont-ils reschedules ?

```bash
docker start taskflow-worker2
```

---

> ### Pause réflexion — Helm vs YAML brut
>
> Vous venez d'écrire environ 20 fichiers YAML pour déployer cette stack en staging.
>
> Répondez dans votre `REPORT.md` :
>
> 1. Identifiez au moins 3 valeurs que vous avez répétées dans plusieurs fichiers (namespace, nom d'image, URL de service...). Que se passe-t-il concrètement si vous devez changer l'une d'elles pour un déploiement en production ?
> 2. Comment Helm résout-il ce problème de répétition ? Quel fichier joue le rôle central dans un chart Helm ?
> 3. À partir de quel niveau de complexité (nombre de services, nombre d'environnements) estimez-vous que Helm devient indispensable plutôt que simplement utile ? Justifiez.

---

## Livrable

- Dossier `k8s/base/` avec tous les manifests versionnés (postgres, redis, user-service, task-service, notification-service, api-gateway, frontend, ingress)
- L'interface TaskFlow accessible sur http://localhost
- `REPORT.md` avec :
  - Réponses aux 3 questions théoriques
  - Diagnostic et correction des manifests A et B (étape 11)
  - Observations des 4 scénarios (étape 13)
