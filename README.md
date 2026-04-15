# NFe Exporter

Aplicação Node.js dockerizada para exportar XMLs de NF-e do banco Oracle para o sistema de arquivos.

---

## Fluxo de execução

1. Busca todas as chaves com `status = 'Pendente'` na tabela `tmp_chave_acesso`
2. Para cada chave, localiza o XML na base via join entre `nfe_emissao` e `dfe_xml_log`
3. Salva o arquivo em `output/{competencia}/{chave_acesso}.xml`
4. Atualiza o status na tabela auxiliar:
   - **Exportado** → arquivo salvo com sucesso
   - **Não Encontrado** → chave sem registro ou XML vazio no banco

---

## Publicação automática (CI/CD)

A imagem é buildada e publicada automaticamente no **GitHub Container Registry (GHCR)** via GitHub Actions sempre que houver:
- Push na branch `main` → publica como `latest`
- Push de tag `v*.*.*` → publica com a versão (ex: `v1.0.0`)

### Como criar uma nova versão

```bash
git tag v1.0.0
git push origin v1.0.0
```

---

## Instruções para o cliente

O cliente precisa apenas de dois arquivos: `docker-compose.yml` e `config.json`.

### 1. Pré-requisitos

- Docker e Docker Compose instalados
- Acesso de rede ao banco Oracle

### 2. Fazer login no registry (uma única vez)

```bash
docker login ghcr.io -u SEU_USUARIO -p TOKEN_GERADO
```

> O token deve ser gerado em: GitHub → Settings → Developer Settings → Personal Access Tokens → com permissão `read:packages`

### 3. Estrutura de arquivos no servidor do cliente

```
nfe-exporter/
├── docker-compose.yml   # fornecido por você
├── config.json          # preenchido pelo cliente
└── output/              # criado automaticamente
```

### 4. Configurar o `config.json`

```json
{
  "database": {
    "user": "SEU_USUARIO",
    "password": "SUA_SENHA",
    "connectString": "HOST:PORT/SERVICE_NAME"
  },
  "output": {
    "dir": "./output"
  },
  "query": {
    "orgId": "SYN"
  }
}
```

### 5. Executar

```bash
# Baixar a imagem mais recente
docker compose pull

# Executar
docker compose up
```

### 6. Atualizar para nova versão

```bash
docker compose pull
docker compose up
```

---

## Retomando após falha

Como o status é atualizado **um a um** após cada exportação bem-sucedida, basta reexecutar. Apenas as chaves ainda com status `Pendente` serão reprocessadas.

---

## Estrutura do repositório

```
nfe-exporter/
├── .github/
│   └── workflows/
│       └── docker-publish.yml   # CI/CD - build e publish automático
├── src/
│   └── index.js                 # Lógica principal
├── config.json                  # Exemplo de configuração
├── docker-compose.client.yml    # Arquivo entregue ao cliente
├── Dockerfile
└── README.md
```
