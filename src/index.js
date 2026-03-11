const wppconnect = require('@wppconnect-team/wppconnect');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function carregarUsuariosVIP() {
    const localPath = path.resolve(__dirname, 'data', 'dados.local.js');
    if (fs.existsSync(localPath)) {
        return require('./data/dados.local');
    }

    try {
        return require('./data/dados');
    } catch {
        return {};
    }
}

const USUARIOS_VIP = carregarUsuariosVIP();
const {
    loginGLPI,
    criarTicketCompleto,
    consultarStatusChamadoPorIdRequester,
    consultarStatusChamadoPorId,
    buscarUsuarioPorEmail,
    resetarSenhaEmailTemporaria,
    criarUsuarioGLPI,
    salvarUsuarioVIP
} = require('./services/glpi');

// TRAVA DE SEGURANA REFORADA
const HORA_INICIO = Math.floor(Date.now() / 1000);
const userStages = {};
const mensagensProcessadas = new Set(); //  Impede processar mesma mensagem 2x
const SESSION_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutos sem resposta
const NOTIFICACAO_INTERVALO_MS = 60 * 1000;
const MAX_MEDIA_BYTES = Math.max(1024 * 1024, Number(process.env.WHATS_MAX_MEDIA_BYTES || 10 * 1024 * 1024));
const RESET_EMAIL_WHATSAPP_COMPARTILHADO = new Set(
    String(process.env.RESET_EMAIL_WHATSAPP_COMPARTILHADO || '')
        .split(',')
        .map((n) => String(n || '').replace(/\D/g, '').trim())
        .filter(Boolean)
);
const STATUS_FINAIS_CODIGOS = new Set([6]); // 6 = Fechado
const NOTIFICACOES_PATH = path.resolve(__dirname, 'data', 'notificacoes_tickets.json');
let monitorNotificacaoEmExecucao = false;

const SESSION_NAME = 'mns-suporte';
const SESSION_DIR = path.resolve(__dirname, '..', 'tokens', SESSION_NAME);

function limparLocksSessao() {
    const arquivosLock = [
        'DevToolsActivePort',
        'SingletonLock',
        'SingletonCookie',
        'SingletonSocket'
    ];

    for (const nomeArquivo of arquivosLock) {
        const arquivo = path.join(SESSION_DIR, nomeArquivo);
        if (fs.existsSync(arquivo)) {
            try {
                fs.unlinkSync(arquivo);
            } catch (e) {
                console.warn('Nao foi possivel remover lock ' + nomeArquivo + ': ' + e.message);
            }
        }
    }
}

async function iniciarBot() {
    limparLocksSessao();

    try {
        const client = await wppconnect.create({
            session: SESSION_NAME,
            headless: true,
            logQR: true,
            autoClose: 0,
        });
        start(client);
    } catch (error) {
        const msg = String(error?.message || '');
        if (msg.includes('already running')) {
            console.error('Sessao ja esta em uso por outro processo.');
            console.error('Feche o outro bot e execute novamente.');
            return;
        }
        console.log(error);
    }
}

iniciarBot();

function garantirArquivoNotificacoes() {
    if (!fs.existsSync(NOTIFICACOES_PATH)) {
        fs.writeFileSync(NOTIFICACOES_PATH, '[]', 'utf8');
    }
}

function lerNotificacoes() {
    try {
        garantirArquivoNotificacoes();
        const conteudo = fs.readFileSync(NOTIFICACOES_PATH, 'utf8');
        const lista = JSON.parse(conteudo);
        return Array.isArray(lista) ? lista : [];
    } catch (error) {
        console.error('Falha ao ler notificacoes:', error.message);
        return [];
    }
}

function salvarNotificacoes(lista) {
    try {
        const tempPath = `${NOTIFICACOES_PATH}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(lista, null, 2), 'utf8');
        fs.renameSync(tempPath, NOTIFICACOES_PATH);
        return true;
    } catch (error) {
        console.error('Falha ao salvar notificacoes:', error.message);
        return false;
    }
}

function normalizarChatId(chatId, numero) {
    if (typeof chatId === 'string' && chatId.includes('@')) return chatId;
    const numeroLimpo = String(numero || '').replace(/\D/g, '');
    return numeroLimpo ? `${numeroLimpo}@c.us` : '';
}

function limparNumero(valor) {
    return String(valor || '').replace(/\D/g, '').trim();
}

function numeroInternacionalValido(valor) {
    return /^\d{10,15}$/.test(String(valor || '').trim());
}

function compactarTexto(texto, limite = 700) {
    const base = String(texto || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (!base) return '';
    if (base.length <= limite) return base;
    return base.slice(0, limite - 3).trimEnd() + '...';
}

function formatarExpiracaoSenha(isoString) {
    const data = new Date(isoString);
    if (Number.isNaN(data.getTime())) return String(isoString || '');
    return data.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function normalizarCodigoConsulta(valor) {
    return String(valor || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .trim();
}

function gerarCodigoConsulta(tamanho = 6) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let codigo = '';
    for (let i = 0; i < tamanho; i++) {
        codigo += chars.charAt(crypto.randomInt(chars.length));
    }
    return codigo;
}

function extrairBase64Limpo(base64) {
    const valor = String(base64 || '');
    return valor.includes(',') ? valor.split(',')[1] : valor;
}

function estimarBytesBase64(base64) {
    const limpo = extrairBase64Limpo(base64).replace(/\s/g, '');
    if (!limpo) return 0;
    const padding = limpo.endsWith('==') ? 2 : limpo.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((limpo.length * 3) / 4) - padding);
}

function validarTamanhoMidia(base64) {
    return estimarBytesBase64(base64) <= MAX_MEDIA_BYTES;
}

function gerarCodigoConsultaUnico(lista) {
    const usados = new Set(
        (Array.isArray(lista) ? lista : [])
            .map((item) => normalizarCodigoConsulta(item?.codigoConsulta))
            .filter(Boolean)
    );

    for (let tentativa = 0; tentativa < 200; tentativa++) {
        const codigo = gerarCodigoConsulta(6);
        if (!usados.has(codigo)) return codigo;
    }

    return `${gerarCodigoConsulta(4)}${String(Date.now()).slice(-2)}`;
}

function validarCodigoConsultaTicket(ticketId, codigoInformado) {
    const idChamado = Number(ticketId);
    const codigo = normalizarCodigoConsulta(codigoInformado);
    if (!Number.isFinite(idChamado) || idChamado <= 0) return { ok: false, motivo: 'ticket_invalido' };
    if (codigo.length < 6) return { ok: false, motivo: 'codigo_invalido' };

    const lista = lerNotificacoes();
    const registro = lista.find((item) => Number(item.ticketId) === idChamado);
    if (!registro) return { ok: false, motivo: 'ticket_sem_registro' };

    const codigoSalvo = normalizarCodigoConsulta(registro.codigoConsulta);
    if (!codigoSalvo) return { ok: false, motivo: 'ticket_sem_codigo' };
    if (codigoSalvo !== codigo) return { ok: false, motivo: 'codigo_incorreto' };

    return { ok: true, registro };
}

function registrarTicketParaNotificacao({ ticketId, idRequester, whatsapp, chatId, nome, titulo }) {
    const idChamado = Number(ticketId);
    const requester = Number(idRequester);
    if (!Number.isFinite(idChamado) || idChamado <= 0) return { ok: false, codigo: '' };

    const lista = lerNotificacoes();
    const existente = lista.find((item) => Number(item.ticketId) === idChamado);
    if (existente) {
        return {
            ok: true,
            codigo: normalizarCodigoConsulta(existente.codigoConsulta)
        };
    }

    const codigoConsulta = gerarCodigoConsultaUnico(lista);

    lista.push({
        ticketId: idChamado,
        idRequester: Number.isFinite(requester) && requester > 0 ? requester : 0,
        whatsapp: String(whatsapp || ''),
        chatId: normalizarChatId(chatId, whatsapp),
        nome: String(nome || ''),
        titulo: String(titulo || ''),
        codigoConsulta,
        notificado: false,
        criadoEm: new Date().toISOString()
    });
    const salvo = salvarNotificacoes(lista);
    return {
        ok: salvo,
        codigo: salvo ? codigoConsulta : ''
    };
}

async function processarMonitorNotificacoes(client) {
    if (monitorNotificacaoEmExecucao) return;
    monitorNotificacaoEmExecucao = true;

    try {
        const lista = lerNotificacoes();
        if (!lista.length) return;

        let alterou = false;

        for (const item of lista) {
            if (item.notificado) continue;

            let consulta = await consultarStatusChamadoPorIdRequester(item.idRequester, item.ticketId);
            // Fallback para monitor: usa consulta direta do ticket caso o requester nao bata.
            if (!consulta.success || !consulta.chamado) {
                consulta = await consultarStatusChamadoPorId(item.ticketId);
            }
            if (!consulta.success || !consulta.chamado) continue;

            const statusCodigo = Number(consulta.chamado.statusCodigo || 0);
            const statusAtual = String(consulta.chamado.status || '').trim();

            // Gatilho principal por codigo do GLPI (mais confiavel que texto).
            if (!STATUS_FINAIS_CODIGOS.has(statusCodigo)) continue;

            const destino = normalizarChatId(item.chatId, item.whatsapp);
            if (!destino) continue;

            const tituloChamado = consulta.chamado.titulo || item.titulo || 'Sem titulo';
            const solucaoChamado = compactarTexto(consulta.chamado.solucao, 700);
            const mensagemNotificacao =
                `*Atualizacao do seu chamado #${item.ticketId}*\n\n` +
                `Status: ${statusAtual}\n` +
                `Titulo: ${tituloChamado}` +
                (solucaoChamado ? `\n\nSolucao:\n${solucaoChamado}` : '') +
                `\n\nSeu chamado foi finalizado pela equipe de TI.`;

            await client.sendText(destino, mensagemNotificacao);

            item.notificado = true;
            item.statusCodigoFinal = statusCodigo;
            item.statusFinal = statusAtual;
            item.notificadoEm = new Date().toISOString();
            alterou = true;
        }

        if (alterou) {
            salvarNotificacoes(lista);
        }
    } catch (error) {
        console.error('Falha no monitor de notificacoes:', error.message);
    } finally {
        monitorNotificacaoEmExecucao = false;
    }
}

function iniciarMonitorNotificacoes(client) {
    garantirArquivoNotificacoes();
    setInterval(() => {
        processarMonitorNotificacoes(client).catch(() => {});
    }, NOTIFICACAO_INTERVALO_MS);

    // Primeira varredura com pequeno atraso apos iniciar.
    setTimeout(() => {
        processarMonitorNotificacoes(client).catch(() => {});
    }, 15000);
}

async function start(client) {
  console.log(' BOT MNS: ONLINE + SISTEMA CANCELAR');
  console.log(' VIPs Carregados:', Object.keys(USUARIOS_VIP).length);
  console.log(' Hora de incio:', new Date(HORA_INICIO * 1000).toLocaleString('pt-BR'));
  await loginGLPI();
  iniciarMonitorNotificacoes(client);

  client.onMessage(async (message) => {
    let from = '';
    if (typeof message.from === 'string') {
        from = message.from;
    } else if (message?.from?._serialized && typeof message.from._serialized === 'string') {
        from = message.from._serialized;
    }
    if (!from) return;
    const bodyRaw = typeof message.body === 'string' ? message.body : '';
    const body = bodyRaw.trim();
    const bodyLower = body.toLowerCase();
    // ============================================================
    //  TRAVAS DE SEGURANA ULTRA REFORADAS
    // ============================================================
    
    // 1. TRAVA: Mensagens antigas (antes do bot ligar)
    if (message.timestamp < HORA_INICIO) return;

    // 2. TRAVA: Status do WhatsApp (CRTICO!)
    if (from === 'status@broadcast') return;

    // 3. TRAVA: Grupos
    if (message.isGroupMsg || from.includes('@g.us')) return;

    // 4. TRAVA: Newsletter e mensagens prprias
    if (from.includes('newsletter') || message.fromMe) return;

    // 5.  TRAVA: Impede processar a mesma mensagem 2x
    const msgId = message.id || `${from}_${message.timestamp}`;
    if (mensagensProcessadas.has(msgId)) return;
    mensagensProcessadas.add(msgId);

    // 6. TRAVA: Conversas arquivadas
    try {
        const chat = await client.getChatById(from);
        if (chat.archive === true) return;
    } catch (e) {
        console.error('Falha ao validar conversa arquivada. Mensagem ignorada por seguranca:', e.message);
        return;
    }

    // 7.  LIMPEZA: Cache de mensagens (a cada 1000 msgs)
    if (mensagensProcessadas.size > 1000) {
        mensagensProcessadas.clear();
        console.log(' Cache de mensagens limpo');
    }


    // (Debug removido - nmero j est funcionando corretamente)

    // ============================================================
    //  REGRA DE OURO: BOTO DE PNICO (CANCELAR)
    // ============================================================
    if (bodyLower === 'cancelar') {
        if (userStages[from]) {
            delete userStages[from];
            await client.sendText(from, "*Atendimento cancelado.*\nQuando precisar, e so chamar!");
        } else {
            await client.sendText(from, "Nada para cancelar. Digite *Oi* para comecar.");
        }
        return;
    }
    // ============================================================

    // 2. CAPTURA DE NMERO REAL (CORRIGIDO - USA FORMATTEDNAME!)
    let numeroReal = "";

    //  SOLUO: Pega de sender.formattedName (NMERO REAL!)
    if (message.sender && message.sender.formattedName) {
        // Extrai nmero de "+55 15 99804-8757"  "5515998048757"
        const numeroFormatado = limparNumero(message.sender.formattedName);
        if (numeroFormatado) {
            numeroReal = numeroFormatado;
            console.log(` Nmero extrado de formattedName: ${numeroReal}`);
        }
    }

    // Fallback: Tenta extrair de message.from
    if (!numeroInternacionalValido(numeroReal)) {
        if (message.from) {
            const numeroFrom = limparNumero(String(message.from).replace(/@c\.us|@lid|@g\.us/g, '').split(':')[0]);
            if (numeroInternacionalValido(numeroFrom)) {
                numeroReal = numeroFrom;
            }
        }
    }

    // Se ainda no for vlido, busca na API
    if (!numeroInternacionalValido(numeroReal)) {
        try {
            const contact = await client.getContact(from);

            const numeroContato = limparNumero(contact?.id?.user || contact?.number || '');
            if (numeroInternacionalValido(numeroContato)) {
                numeroReal = numeroContato;
            }
        } catch (e) {
            console.error(' Erro ao buscar contato:', e.message);
        }
    }

    console.log(` Mensagem de: ${numeroReal}`);

    // Mantem o WID original (ex.: @lid). So normaliza se vier sem sufixo.
    if (!String(from).includes('@') && numeroReal) {
        const fromPadrao = normalizarChatId('', numeroReal);
        if (fromPadrao) from = fromPadrao;
    }

    const agora = Date.now();
    if (userStages[from] && userStages[from].lastActivity && (agora - userStages[from].lastActivity > SESSION_TIMEOUT_MS)) {
        delete userStages[from];
        await client.sendText(from, "Seu atendimento anterior expirou por inatividade. Vamos comecar novamente.");
    }

    if (!userStages[from]) {
        userStages[from] = { stage: 'INICIO', dados: { anexos: [] }, lastActivity: agora };
    } else {
        userStages[from].lastActivity = agora;
    }

    const usuario = userStages[from];

    switch (usuario.stage) {
        
        case 'INICIO':
            const cadastroVIP = USUARIOS_VIP[numeroReal];
            const nomePerfil = message.notifyName || message.sender?.pushname || 'Usuario';

            if (cadastroVIP) {
                //   VIP - J CADASTRADO!
                usuario.dados.nome = cadastroVIP.nome;
                usuario.dados.whatsapp = numeroReal;
                usuario.dados.id_requester = cadastroVIP.id;
                usuario.stage = 'MENU';
                await enviarMenuPrincipal(client, from, usuario.dados.nome);

            } else {
                //  NO  VIP - IDENTIFICA USURIO NO GLPI E VINCULA AUTOMATICAMENTE
                usuario.dados.whatsapp = numeroReal;
                usuario.dados.nome = nomePerfil; // Salva o nome do WhatsApp temporariamente
                usuario.stage = 'PEGAR_EMAIL_GLPI';

                await client.sendText(
                    from,
                    `Ola, ${nomePerfil}!\n\n` +
                    `Bem-vindo ao *Suporte TI*.\n\n` +
                    `Para o primeiro acesso, digite seu e-mail corporativo para vincular seu WhatsApp com seguranca.\n\n` +
                    `Digite seu *E-MAIL CORPORATIVO* (nao sera solicitado novamente apos a vinculacao):\n\n` +
                    `_(Ou digite CANCELAR para sair)_`
                );
            }
            break;

        case 'PERGUNTA_TEM_GLPI':
            // Compatibilidade com sessoes antigas.
            usuario.stage = 'PEGAR_EMAIL_GLPI';
            await client.sendText(from, "Digite seu *EMAIL* cadastrado no GLPI:");
            break;

        case 'PEGAR_LOGIN_GLPI':
        case 'PEGAR_SENHA_GLPI':
        case 'OFERECER_ATUALIZAR_SENHA':
        case 'PEGAR_EMAIL_RECUPERACAO':
            // Compatibilidade com sessoes antigas.
            usuario.stage = 'PEGAR_EMAIL_GLPI';
            await client.sendText(from, "Digite seu *EMAIL* cadastrado no GLPI:");
            break;

        case 'PEGAR_EMAIL_GLPI':
            if (!message.body || !message.body.includes('@')) {
                await client.sendText(from, "Email invalido. Digite seu *EMAIL* cadastrado no GLPI:");
                return;
            }

            usuario.dados.email_informado = message.body.trim();
            await client.sendText(from, "Aguarde, validando seu email no GLPI...");

            const resultadoEmail = await buscarUsuarioPorEmail(usuario.dados.email_informado);

            if (!resultadoEmail.success) {
                await client.sendText(from,
                    "Nao encontrei este email no GLPI.\n" +
                    "Digite novamente seu *EMAIL* ou *CANCELAR*."
                );
                return;
            }

            usuario.dados.vinculoPendente = {
                id: resultadoEmail.id,
                nome: resultadoEmail.nome,
                email: usuario.dados.email_informado
            };
            usuario.stage = 'CONFIRMAR_VINCULO_EMAIL';

            await client.sendText(from,
                "Confirme seus dados:\n" +
                `Nome: ${resultadoEmail.nome}\n` +
                `Email: ${usuario.dados.email_informado}\n` +
                `ID: ${resultadoEmail.id}\n\n` +
                "Digite *SIM* para confirmar ou *NAO* para informar outro email."
            );
            break;

        case 'CONFIRMAR_VINCULO_EMAIL':
            const respConfirmar = (message.body || '').trim().toLowerCase();
            if (respConfirmar === 'sim') {
                const pendente = usuario.dados.vinculoPendente;
                if (!pendente || !pendente.id) {
                    usuario.stage = 'PEGAR_EMAIL_GLPI';
                    await client.sendText(from, "Nao consegui validar o vinculo. Digite seu *EMAIL* novamente:");
                    break;
                }

                await salvarUsuarioVIP(numeroReal, pendente.nome, pendente.id, USUARIOS_VIP);
                usuario.dados.nome = pendente.nome;
                usuario.dados.whatsapp = numeroReal;
                usuario.dados.id_requester = pendente.id;
                delete usuario.dados.vinculoPendente;
                delete usuario.dados.email_informado;
                usuario.stage = 'MENU';

                await client.sendText(from,
                    "Conta vinculada com sucesso!\n" +
                    `Nome: ${usuario.dados.nome}\n` +
                    `ID: ${usuario.dados.id_requester}\n\n` +
                    "Seu WhatsApp foi vinculado para os proximos atendimentos."
                );
                await enviarMenuPrincipal(client, from, usuario.dados.nome);
            } else if (respConfirmar === 'nao' || respConfirmar === 'no') {
                delete usuario.dados.vinculoPendente;
                usuario.stage = 'PEGAR_EMAIL_GLPI';
                await client.sendText(from, "Tudo bem. Digite outro *EMAIL* cadastrado no GLPI:");
            } else {
                await client.sendText(from, "Digite apenas *SIM* ou *NAO*.");
            }
            break;

        case 'PERGUNTA_CRIAR_CONTA':
            const respCriar = message.body.toLowerCase();
            if (respCriar === 'sim') {
                usuario.stage = 'PEGAR_EMAIL';
                await client.sendText(from,
                    " *Criar Conta - Passo 1/2*\n\n" +
                    "Digite seu *EMAIL*:"
                );
            } else if (respCriar === 'nao' || respCriar === 'no') {
                // Continua sem conta (id_requester = 0)
                usuario.dados.id_requester = 0;
                usuario.stage = 'MENU';
                await client.sendText(from, "Ok, vamos continuar sem vincular conta.");
                await enviarMenuPrincipal(client, from, usuario.dados.nome);
            } else {
                await client.sendText(from, "Digite apenas *SIM* ou *NAO*");
            }
            break;

        case 'PEGAR_EMAIL':
            if (!message.body.includes('@')) {
                await client.sendText(from, "Email invalido. Digite um email valido:");
                return;
            }
            usuario.dados.email = message.body;
            usuario.stage = 'PEGAR_SETOR';
            await client.sendText(from,
                " *Criar Conta - Passo 2/2*\n\n" +
                "Digite seu *SETOR*:\n" +
                "_(Ex: TI, Financeiro, RH, etc.)_"
            );
            break;

        case 'PEGAR_SETOR':
            usuario.dados.setor = message.body;
            await client.sendText(from, "Criando sua conta no sistema...");

            const dadosNovaConta = {
                nome: usuario.dados.nome,
                telefone: numeroReal,
                email: usuario.dados.email,
                setor: usuario.dados.setor
            };

            const resultadoCriacao = await criarUsuarioGLPI(dadosNovaConta);

            if (resultadoCriacao.success) {
                //  Conta criada! Salva como VIP
                await salvarUsuarioVIP(numeroReal, usuario.dados.nome, resultadoCriacao.id, USUARIOS_VIP);

                usuario.dados.id_requester = resultadoCriacao.id;
                usuario.stage = 'MENU';

                await client.sendText(from,
                    ` *Conta criada com sucesso!*\n\n` +
                    ` Nome: ${usuario.dados.nome}\n` +
                    ` Email: ${usuario.dados.email}\n` +
                    ` ID: ${resultadoCriacao.id}\n\n` +
                    ` _Instrucoes de acesso foram enviadas para seu email._\n` +
                    ` _Seu WhatsApp foi vinculado automaticamente!_`
                );

                await enviarMenuPrincipal(client, from, usuario.dados.nome);
            } else {
                await client.sendText(from,
                    ` *Erro ao criar conta*\n\n` +
                    `${resultadoCriacao.error}\n\n` +
                    `Vamos continuar sem vincular conta por enquanto.`
                );
                usuario.dados.id_requester = 0;
                usuario.stage = 'MENU';
                await enviarMenuPrincipal(client, from, usuario.dados.nome);
            }
            break;

        case 'PEGAR_NOME':
            if (message.body.length < 3) {
                await client.sendText(from, "Nome muito curto. Digite Nome e Sobrenome:");
                return;
            }
            usuario.dados.nome = message.body;
            usuario.stage = 'MENU';
            await enviarMenuPrincipal(client, from, usuario.dados.nome);
            break;

        case 'MENU':
            if (['oi', 'ola', 'olá', 'menu', 'inicio', 'iniciar'].includes(bodyLower)) {
                await enviarMenuPrincipal(client, from, usuario.dados.nome);
            } else if (body === '1') {
                usuario.stage = 'SETOR';
                await client.sendText(from, `Certo, ${usuario.dados.nome}! Qual o seu *Setor*?`);
            } else if (body === '2') {
                usuario.stage = 'CONSULTAR_ID_CHAMADO';
                await client.sendText(from,
                    "Informe o *ID do chamado* que deseja consultar.\n" +
                    "Exemplo: *12345*"
                );
            } else if (body === '3') {
                usuario.stage = 'RESET_EMAIL_CORPORATIVO';
                await client.sendText(
                    from,
                    "Informe seu *email corporativo* para gerar uma senha temporaria de 15 minutos.\n" +
                    "Exemplo: *usuario@grupomns.com.br*"
                );
            } else {
                await client.sendText(from, "Digite apenas *1*, *2* ou *3*.");
            }
            break;

        case 'RESET_EMAIL_CORPORATIVO':
            const numeroChaveReset = String(numeroReal || '').replace(/\D/g, '').trim();
            const numeroEhCompartilhado = RESET_EMAIL_WHATSAPP_COMPARTILHADO.has(numeroChaveReset);
            const requesterAtual = Number(usuario?.dados?.id_requester || 0);
            if ((!Number.isFinite(requesterAtual) || requesterAtual <= 0) && !numeroEhCompartilhado) {
                usuario.stage = 'MENU';
                await client.sendText(
                    from,
                    "Para resetar senha por WhatsApp, seu numero precisa estar vinculado ao usuario do GLPI."
                );
                await enviarMenuPrincipal(client, from, usuario.dados.nome);
                break;
            }

            const emailResetInformado = String(body || '').trim().toLowerCase();
            if (!emailResetInformado || !emailResetInformado.includes('@')) {
                await client.sendText(from, "Email invalido. Informe seu *email corporativo*.");
                return;
            }

            const validacaoEmailReset = await buscarUsuarioPorEmail(emailResetInformado);
            if (!validacaoEmailReset.success) {
                await client.sendText(
                    from,
                    "Nao consegui validar esse email para o seu usuario. Confira o email e tente novamente."
                );
                return;
            }

            const idEmailInformado = Number(validacaoEmailReset.id || 0);
            if (!numeroEhCompartilhado && idEmailInformado !== requesterAtual) {
                await client.sendText(
                    from,
                    "Nao consegui validar esse email para o seu usuario. Confira o email e tente novamente."
                );
                return;
            }
            await client.sendText(from, "Aguarde, estou gerando sua senha temporaria...");
            const resultadoResetEmail = await resetarSenhaEmailTemporaria(emailResetInformado);

            if (!resultadoResetEmail.success) {
                const erroReset = String(resultadoResetEmail.error || '').trim();
                console.warn('Reset de email recusado:', {
                    numero: numeroReal,
                    email: emailResetInformado,
                    motivo: erroReset || 'desconhecido'
                });

                usuario.stage = 'MENU';
                if (/muitas tentativas|nao autorizad|tempo de resposta|conta de email|servico de reset/i.test(erroReset)) {
                    await client.sendText(from, erroReset);
                } else {
                    await client.sendText(
                        from,
                        "Nao foi possivel concluir o reset agora. Tente novamente em alguns minutos."
                    );
                }
                await enviarMenuPrincipal(client, from, usuario.dados.nome);
                break;
            }

            const validadeFormatada = formatarExpiracaoSenha(resultadoResetEmail.expires_at);
            await client.sendText(
                from,
                `*Senha temporaria gerada com sucesso*\n\n` +
                `Email: ${resultadoResetEmail.email}\n` +
                `Senha temporaria: *${resultadoResetEmail.temp_password}*\n` +
                `Valida ate: *${validadeFormatada}*\n\n` +
                `Acesse o webmail e troque a senha em:\n` +
                `*Configuracoes > Senha*`
            );

            await client.sendText(
                from,
                "Importante: essa senha expira em 15 minutos e deve ser usada apenas para acessar e trocar a senha."
            );

            usuario.stage = 'MENU';
            await enviarMenuPrincipal(client, from, usuario.dados.nome);
            break;

        case 'CONSULTAR_ID_CHAMADO':
            const ticketIdLimpo = String(body || '').replace(/\D/g, '');
            if (!/^\d{1,10}$/.test(ticketIdLimpo)) {
                await client.sendText(from, "Digite apenas o numero do chamado. Exemplo: *12345*");
                return;
            }

            usuario.dados.ticketConsultaPendente = Number(ticketIdLimpo);
            usuario.stage = 'CONSULTAR_CODIGO_CHAMADO';
            await client.sendText(
                from,
                "Agora informe o *codigo de consulta* do chamado.\n" +
                "Exemplo: *Q7K9P2*"
            );
            break;

        case 'CONSULTAR_CODIGO_CHAMADO':
            const ticketConsulta = Number(usuario.dados.ticketConsultaPendente || 0);
            const codigoConsulta = normalizarCodigoConsulta(body);
            if (!ticketConsulta) {
                usuario.stage = 'MENU';
                await client.sendText(from, "Nao encontrei o ID da consulta. Vamos voltar ao menu.");
                await enviarMenuPrincipal(client, from, usuario.dados.nome);
                break;
            }

            if (codigoConsulta.length < 6) {
                await client.sendText(from, "Codigo invalido. Digite o codigo de 6 caracteres. Exemplo: *Q7K9P2*");
                return;
            }

            const validacaoCodigo = validarCodigoConsultaTicket(ticketConsulta, codigoConsulta);
            if (!validacaoCodigo.ok) {
                delete usuario.dados.ticketConsultaPendente;
                await client.sendText(
                    from,
                    "Codigo de consulta invalido para este chamado.\n" +
                    "Confira o codigo e tente novamente."
                );
                usuario.stage = 'MENU';
                await enviarMenuPrincipal(client, from, usuario.dados.nome);
                break;
            }

            await client.sendText(from, "Consultando chamado...");
            const consultaId = await consultarStatusChamadoPorId(ticketConsulta);

            if (!consultaId.success) {
                await client.sendText(from, `Erro: ${consultaId.error}`);
                usuario.stage = 'MENU';
                await enviarMenuPrincipal(client, from, usuario.dados.nome);
                break;
            }

            const ch = consultaId.chamado;
            const solucaoConsulta = compactarTexto(ch.solucao, 700);
            await client.sendText(from,
                `*Status do Chamado #${ch.id}*\n\n` +
                `Titulo: ${ch.titulo}\n` +
                `Status: ${ch.status}\n` +
                `Tecnico: ${ch.tecnico}\n` +
                `Ultima atualizacao: ${ch.atualizacao || 'Nao informada'}` +
                (solucaoConsulta ? `\n\nSolucao:\n${solucaoConsulta}` : '')
            );
            delete usuario.dados.ticketConsultaPendente;
            usuario.stage = 'MENU';
            await client.sendText(from, "Digite *1* para abrir chamado, *2* para consultar outro ID ou *3* para reset de email.");
            break;

        case 'SETOR':
            usuario.dados.setor = message.body;
            usuario.stage = 'TITULO';
            await client.sendText(from, `De um *Titulo curto* para o chamado:\n(Ex: Impressora parada)`);
            break;

        case 'TITULO':
            usuario.dados.titulo = message.body;
            usuario.stage = 'DESCRICAO';
            await client.sendText(from, `Descreva o problema detalhadamente:\n(Voce pode digitar ou mandar AUDIO)`);
            break;

        case 'DESCRICAO':
            if (message.type === 'ptt' || message.type === 'audio') {
                try {
                    await new Promise(r => setTimeout(r, 3000));
                    let base64 = await client.downloadMedia(message);

                    // Remove prefixo "data:audio/ogg;base64," se existir
                    if (base64.includes(',')) {
                        base64 = extrairBase64Limpo(base64);
                    }

                    console.log(`Audio baixado: ${base64.length} caracteres`);

                    if (base64.length < 100) throw new Error("Audio vazio");
                    if (!validarTamanhoMidia(base64)) throw new Error("Audio acima do limite");

                    usuario.dados.anexos.push({
                        data: base64,
                        mimetype: message.mimetype || 'audio/ogg',
                        name: 'audio_desc'
                    });
                    usuario.dados.descricao = "(Audio recebido na abertura)";
                    await client.sendText(from, `Audio recebido!`);
                } catch (e) {
                    console.error("Erro audio", e);
                    await client.sendText(
                        from,
                        e.message === "Audio acima do limite"
                            ? "O audio excede o limite permitido de 10 MB."
                            : "Falha ao baixar audio. Tente enviar novamente."
                    );
                }
            } else {
                usuario.dados.descricao = message.body;
            }
            usuario.stage = 'FOTO';
            await client.sendText(from, `Deseja enviar FOTO ou ARQUIVO (PDF/Word/Excel)? Envie agora ou digite *NAO*.`);
            break;

        case 'FOTO':
            if (message.type === 'image') {
                try {
                    // Aguarda alguns segundos para garantir que a foto est completamente carregada
                    await new Promise(r => setTimeout(r, 2000));
                    let base64 = await client.downloadMedia(message);

                    // Remove prefixo "data:image/jpeg;base64," se existir
                    if (base64.includes(',')) {
                        base64 = extrairBase64Limpo(base64);
                    }

                    console.log(` Foto baixada: ${base64.length} caracteres`);

                    if (base64.length < 100) throw new Error("Foto vazia");
                    if (!validarTamanhoMidia(base64)) throw new Error("Foto acima do limite");

                    usuario.dados.anexos.push({
                        data: base64,
                        mimetype: message.mimetype || 'image/jpeg',
                        name: 'foto_evidencia'
                    });
                    await client.sendText(from, `Foto recebida!`);
                } catch (e) {
                    console.error("Erro foto", e);
                    await client.sendText(
                        from,
                        e.message === "Foto acima do limite"
                            ? "A foto excede o limite permitido de 10 MB."
                            : "Falha ao baixar foto. Tente enviar novamente."
                    );
                }
            }
            else if (message.type === 'document') {
                try {
                    await new Promise(r => setTimeout(r, 2000));
                    let base64 = await client.downloadMedia(message);

                    if (base64.includes(',')) {
                        base64 = extrairBase64Limpo(base64);
                    }

                    console.log(`Arquivo baixado: ${base64.length} caracteres`);

                    if (base64.length < 100) throw new Error("Arquivo vazio");
                    if (!validarTamanhoMidia(base64)) throw new Error("Arquivo acima do limite");

                    const nomeArquivoOriginal = (message.filename || '').trim();
                    const nomeArquivoSeguro = nomeArquivoOriginal
                        ? nomeArquivoOriginal.replace(/[^a-zA-Z0-9._-]/g, '_')
                        : 'arquivo_enviado';

                    usuario.dados.anexos.push({
                        data: base64,
                        mimetype: message.mimetype || 'application/octet-stream',
                        name: nomeArquivoSeguro
                    });
                    await client.sendText(from, `Arquivo recebido!`);
                } catch (e) {
                    console.error("Erro arquivo", e);
                    await client.sendText(
                        from,
                        e.message === "Arquivo acima do limite"
                            ? "O arquivo excede o limite permitido de 10 MB."
                            : "Falha ao baixar arquivo. Tente enviar novamente."
                    );
                }
            }
            
            // Pula direto para confirmao (SEM escolha de tcnico)
            usuario.stage = 'CONFIRMACAO';
            await enviarResumo(client, from, usuario.dados);
            break;

        case 'CONFIRMACAO':
            const resp = message.body.toLowerCase();

            if (resp === 'sim') {
                await client.sendText(from, "Aguarde, criando chamado...");
                
                const ticketID = await criarTicketCompleto(usuario.dados, usuario.dados.nome, numeroReal);
                
                if (ticketID) {
                    await client.sendText(from, `*Chamado #${ticketID} criado com sucesso!*`);

                    const registroNotificacao = registrarTicketParaNotificacao({
                        ticketId: ticketID,
                        idRequester: usuario.dados.id_requester,
                        whatsapp: numeroReal,
                        chatId: from,
                        nome: usuario.dados.nome,
                        titulo: usuario.dados.titulo
                    });

                    if (registroNotificacao?.ok) {
                        await client.sendText(
                            from,
                            "Voce recebera uma mensagem aqui quando o chamado for resolvido ou fechado."
                        );
                        await client.sendText(
                            from,
                            `Seu codigo de consulta: *${registroNotificacao.codigo}*\n` +
                            "Guarde esse codigo. Para consultar: *ID + codigo*."
                        );
                    } else {
                        await client.sendText(
                            from,
                            "Chamado aberto, mas nao foi possivel ativar notificacao automatica neste atendimento."
                        );
                    }
                } else {
                    await client.sendText(from, `Erro ao criar chamado.`);
                }
                delete userStages[from];

            } else if (['nao', 'no'].includes(resp)) {
                usuario.stage = 'ESCOLHA_EDICAO';
                await client.sendText(from, `O que corrigir?\n1 Setor\n2 Titulo\n3 Descricao\n4 Cancelar`);
            } else {
                await client.sendText(from, "Digite *SIM* ou *NAO*.");
            }
            break;

        case 'ESCOLHA_EDICAO':
            const opcoes = {'1': 'setor', '2': 'titulo', '3': 'descricao'};
            if (opcoes[message.body]) {
                usuario.campoEdicao = opcoes[message.body];
                usuario.stage = 'CORRIGIR_CAMPO';
                await client.sendText(from, `Digite o novo valor:`);
            } else if (message.body === '4') {
                delete userStages[from];
                await client.sendText(from, "Cancelado.");
            } else {
                await client.sendText(from, "Opcao invalida.");
            }
            break;

        case 'CORRIGIR_CAMPO':
            usuario.dados[usuario.campoEdicao] = message.body;
            usuario.stage = 'CONFIRMACAO';
            await enviarResumo(client, from, usuario.dados);
            break;
    }
  });
}

async function enviarMenuPrincipal(client, from, nome) {
    const hora = new Date().getHours();
    let saudacao = "Bom dia";
    if (hora >= 12 && hora < 18) saudacao = "Boa tarde";
    if (hora >= 18 || hora < 5) saudacao = "Boa noite";

    await client.sendText(from, 
        `*Suporte TI MNS*\n\n` +
        `${saudacao}, ${nome}!\n` +
        `Sou o assistente virtual da TI.\n\n` +
        `Escolha uma opcao:\n` +
        `1 - Abrir Novo Chamado\n` +
        `2 - Consultar Status\n` +
        `3 - Reset de Senha do Email\n\n` +
        `_(Digite CANCELAR para encerrar)_`
    );
}

async function enviarResumo(client, from, dados) {
    const resumo = 
        `*RESUMO DO CHAMADO*\n\n` +
        `Solicitante: ${dados.nome}\n` +
        `Setor: ${dados.setor}\n` +
        `Titulo: ${dados.titulo}\n` +
        `Descricao: ${dados.descricao}\n` +
        `Anexos: ${dados.anexos.length}\n\n` +
        `As informacoes estao corretas?\n` +
        `Digite *SIM* para abrir ou *NAO* para corrigir.`;
    
    await client.sendText(from, resumo);
}



