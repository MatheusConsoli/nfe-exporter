# ─────────────────────────────────────────────
# Imagem base com Oracle Instant Client embutido
# ─────────────────────────────────────────────
FROM node:20-slim

# Dependências do sistema necessárias para o Oracle Instant Client
RUN apt-get update && apt-get install -y \
    libaio1 \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Baixa e instala o Oracle Instant Client Basic Light (versão 21.x)
RUN mkdir -p /opt/oracle && \
    wget -q https://download.oracle.com/otn_software/linux/instantclient/2114000/instantclient-basiclite-linux.x64-21.14.0.0.0dbru.zip \
         -O /tmp/ic.zip && \
    unzip /tmp/ic.zip -d /opt/oracle && \
    rm /tmp/ic.zip && \
    sh -c "echo /opt/oracle/instantclient_21_14 > /etc/ld.so.conf.d/oracle-instantclient.conf" && \
    ldconfig

ENV LD_LIBRARY_PATH=/opt/oracle/instantclient_21_14:$LD_LIBRARY_PATH

# Diretório de trabalho da aplicação
WORKDIR /app

# Copia dependências e instala pacotes Node
COPY package.json ./
RUN npm install --omit=dev

# Copia o código-fonte e o config
COPY src/ ./src/
COPY config.json ./

# Diretório de saída dos XMLs (será montado como volume)
RUN mkdir -p /app/output

CMD ["node", "src/index.js"]
