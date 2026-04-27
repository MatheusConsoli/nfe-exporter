const oracledb = require('oracledb');
const fs = require('fs');
const path = require('path');

// Leitura do arquivo de configuração
const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../config.json'), 'utf8'));

// oracledb em modo thick para suporte a CLOB e Oracle Client
oracledb.initOracleClient();

// Retorna o conteúdo do CLOB como string
async function clobToString(clob) {
  if (clob === null) return null;
  return new Promise((resolve, reject) => {
    let content = '';
    clob.setEncoding('utf8');
    clob.on('data', chunk => (content += chunk));
    clob.on('end', () => resolve(content));
    clob.on('error', err => reject(err));
  });
}

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

// Instância do arquivo de log (preenchida no início do main)
let logStream = null;

// Escreve no console e no arquivo de log simultaneamente
function log(msg) {
  const line = `[${timestamp()}] ${msg}`;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}

async function main() {
  let connection;

  try {
    // Cria o diretório de output e o arquivo de log com nome baseado na data/hora
    ensureDir(config.output.dir);
    const logFileName = `execucao_${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}.log`;
    const logFilePath = path.join(config.output.dir, logFileName);
    logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });

    log('='.repeat(50));
    log('Iniciando NFe Exporter');
    log('='.repeat(50));

    log('Conectando ao banco de dados Oracle...');
    connection = await oracledb.getConnection({
      user: config.database.user,
      password: config.database.password,
      connectString: config.database.connectString,
    });
    log('Conexão estabelecida com sucesso.');

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
          await connection.execute(
            `INSERT INTO tmp_chave_acesso (chave_acesso) VALUES (:chave)`,
            { chave }
          );
          await connection.commit();
          inseridos++;
        } catch (err) {
          if (err.errorNum === 1) {
            // ORA-00001: unique constraint violated (chave já existe)
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
    const { rows: chavesPendentes } = await connection.execute(
      `SELECT chave_acesso FROM tmp_chave_acesso WHERE status = 'Pendente'`
    );

    if (!chavesPendentes || chavesPendentes.length === 0) {
      log('Nenhuma chave com status "Pendente" encontrada. Encerrando.');
      return;
    }

    log(`Total de chaves pendentes encontradas: ${chavesPendentes.length}`);

    let exportados = 0;
    let naoEncontrados = 0;
    let erros = 0;

    for (const [chaveAcesso] of chavesPendentes) {
      log(`Processando chave: ${chaveAcesso}`);

      try {
        // Busca o XML correspondente à chave de acesso
        const { rows } = await connection.execute(
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

        // Registro não encontrado no banco
        if (!rows || rows.length === 0) {
          log(`  -> Não encontrado no banco. Atualizando status...`);
          await connection.execute(
            `UPDATE tmp_chave_acesso SET status = 'Não Encontrado' WHERE chave_acesso = :chaveAcesso`,
            { chaveAcesso }
          );
          await connection.commit();
          naoEncontrados++;
          continue;
        }

        const [competencia, chave, xmlContent] = rows[0];


        if (!xmlContent) {
          log(`  -> XML vazio para a chave ${chave}. Atualizando status como Não Encontrado...`);
          await connection.execute(
            `UPDATE tmp_chave_acesso SET status = 'Não Encontrado' WHERE chave_acesso = :chaveAcesso`,
            { chaveAcesso }
          );
          await connection.commit();
          naoEncontrados++;
          continue;
        }

        // Monta o caminho de saída: output/{competencia}/{chave_acesso}.xml
        const outputDir = path.join(config.output.dir, competencia);
        ensureDir(outputDir);

        const filePath = path.join(outputDir, `${chave}.xml`);
        fs.writeFileSync(filePath, xmlContent, 'utf8');
        log(`  -> Arquivo salvo em: ${filePath}`);

        // Atualiza status para Exportado
        await connection.execute(
          `UPDATE tmp_chave_acesso SET status = 'Exportado' WHERE chave_acesso = :chaveAcesso`,
          { chaveAcesso }
        );
        await connection.commit();
        log(`  -> Status atualizado para "Exportado".`);
        exportados++;

      } catch (innerErr) {
        log(`  -> ERRO ao processar chave ${chaveAcesso}: ${innerErr.message}`);
        erros++;
        // Continua para a próxima chave sem interromper o processo
      }
    }

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
    if (connection) {
      await connection.close();
      log('Conexão encerrada.');
    }
    if (logStream) {
      logStream.end();
    }
  }
}

main();
