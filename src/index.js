const oracledb = require('oracledb');
const fs = require('fs');
const path = require('path');

// Leitura do arquivo de configuração
const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../config.json'), 'utf8'));

// oracledb em modo thick para suporte a CLOB e Oracle Client
oracledb.initOracleClient();

// Número de workers paralelos (ajustável no config.json)
const CONCORRENCIA = config.concorrencia || 10;

// Garante que o diretório exista, criando-o se necessário
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Formata data/hora atual para exibição no log
function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

// Instância do arquivo de log
let logStream = null;

// Escreve no console e no arquivo de log simultaneamente
function log(msg) {
  const line = `[${timestamp()}] ${msg}`;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}

// Contadores compartilhados entre workers
let exportados = 0;
let naoEncontrados = 0;
let erros = 0;
let processados = 0;
let total = 0;

// Processa uma única chave usando uma conexão do pool
async function processarChave(pool, chaveAcesso) {
  let conn;
  try {
    conn = await pool.getConnection();

    const { rows } = await conn.execute(
      `SELECT emi.competencia,
              emi.chave_acesso,
              stg.arquivo_conteudo
         FROM nfe_emissao emi
         JOIN dfe_storage stg ON emi.nfe_id = stg.documento_id
        WHERE emi.org_id = :orgId
          AND emi.chave_acesso = :chaveAcesso`,
      {
        orgId: config.query.orgId,
        chaveAcesso: chaveAcesso,
      },
      {
        fetchInfo: { ARQUIVO_CONTEUDO: { type: oracledb.STRING } },
      }
    );

    if (!rows || rows.length === 0) {
      await conn.execute(
        `UPDATE tmp_chave_acesso SET status = 'Não Encontrado', dt_atualizao = SYSDATE WHERE chave_acesso = :chaveAcesso`,
        { chaveAcesso }
      );
      await conn.commit();
      naoEncontrados++;
      return;
    }

    const [competencia, chave, xmlContent] = rows[0];

    if (!xmlContent) {
      await conn.execute(
        `UPDATE tmp_chave_acesso SET status = 'Não Encontrado', dt_atualizao = SYSDATE WHERE chave_acesso = :chaveAcesso`,
        { chaveAcesso }
      );
      await conn.commit();
      naoEncontrados++;
      return;
    }

    // Salva o arquivo XML
    const ano = competencia.substring(0, 4);
    const outputDir = path.join(config.output.dir, ano);
    ensureDir(outputDir);

    const filePath = path.join(outputDir, `${chave}.xml`);
    fs.writeFileSync(filePath, xmlContent, 'utf8');

    // Atualiza status para Exportado
    await conn.execute(
      `UPDATE tmp_chave_acesso SET status = 'Exportado', dt_atualizao = SYSDATE WHERE chave_acesso = :chaveAcesso`,
      { chaveAcesso }
    );
    await conn.commit();
    exportados++;

  } catch (err) {
    log(`  -> ERRO [${chaveAcesso}]: ${err.message}`);
    erros++;
  } finally {
    if (conn) await conn.close();
    processados++;
    if (processados % 100 === 0) {
      log(`Progresso: ${processados}/${total} | Exportados: ${exportados} | Não encontrados: ${naoEncontrados} | Erros: ${erros}`);
    }
  }
}

// Executa as tarefas em paralelo controlando a concorrência
async function executarEmParalelo(pool, chaves) {
  const queue = [...chaves];

  async function worker() {
    while (queue.length > 0) {
      const [chaveAcesso] = queue.shift();
      await processarChave(pool, chaveAcesso);
    }
  }

  const workers = Array.from({ length: CONCORRENCIA }, () => worker());
  await Promise.all(workers);
}

async function main() {
  let pool;
  let connInicial;

  try {
    // Cria o diretório de output e o arquivo de log
    ensureDir(config.output.dir);
    const logFileName = `execucao_${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}.log`;
    const logFilePath = path.join(config.output.dir, logFileName);
    logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });

    log('='.repeat(50));
    log('Iniciando NFe Exporter');
    log(`Concorrência: ${CONCORRENCIA} workers paralelos`);
    log('='.repeat(50));

    // Cria pool de conexões para processamento paralelo
    log('Criando pool de conexões Oracle...');
    pool = await oracledb.createPool({
      user: config.database.user,
      password: config.database.password,
      connectString: config.database.connectString,
      poolMin: CONCORRENCIA,
      poolMax: CONCORRENCIA,
      poolIncrement: 0,
    });
    log(`Pool criado com ${CONCORRENCIA} conexões.`);

    // Conexão dedicada para operações iniciais
    connInicial = await pool.getConnection();

    // Leitura e inserção das chaves do arquivo documentos.txt
    const documentosPath = path.resolve(__dirname, '../documentos.txt');
    if (fs.existsSync(documentosPath)) {
      log('Arquivo documentos.txt encontrado. Processando chaves...');
      const linhas = fs.readFileSync(documentosPath, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length === 44);

      log(`Total de chaves encontradas no arquivo: ${linhas.length}`);

      let inseridos = 0;
      let duplicados = 0;

      for (const chave of linhas) {
        try {
          await connInicial.execute(
            `INSERT INTO tmp_chave_acesso (chave_acesso) VALUES (:chave)`,
            { chave }
          );
          await connInicial.commit();
          inseridos++;
        } catch (err) {
          if (err.errorNum === 1) {
            duplicados++;
          } else {
            log(`  -> ERRO ao inserir chave ${chave}: ${err.message}`);
          }
        }
      }

      log(`Chaves inseridas: ${inseridos} | Duplicadas (ignoradas): ${duplicados}`);
      log('-'.repeat(50));
    } else {
      log('Arquivo documentos.txt não encontrado. Pulando importação.');
    }

    // Busca todas as chaves com status Pendente
    const { rows: chavesPendentes } = await connInicial.execute(
      `SELECT chave_acesso FROM tmp_chave_acesso WHERE status = 'Pendente'`
    );
    await connInicial.close();
    connInicial = null;

    if (!chavesPendentes || chavesPendentes.length === 0) {
      log('Nenhuma chave com status "Pendente" encontrada. Encerrando.');
      return;
    }

    total = chavesPendentes.length;
    log(`Total de chaves pendentes: ${total}`);
    log(`Iniciando processamento paralelo com ${CONCORRENCIA} workers...`);
    log('-'.repeat(50));

    await executarEmParalelo(pool, chavesPendentes);

    log('='.repeat(50));
    log('Processamento concluído.');
    log(`  Exportados     : ${exportados}`);
    log(`  Não encontrados: ${naoEncontrados}`);
    log(`  Erros          : ${erros}`);
    log('='.repeat(50));

  } catch (err) {
    log(`ERRO CRÍTICO: ${err.message}`);
    process.exit(1);
  } finally {
    if (connInicial) await connInicial.close();
    if (pool) await pool.close(0);
    if (logStream) logStream.end();
  }
}

main();
