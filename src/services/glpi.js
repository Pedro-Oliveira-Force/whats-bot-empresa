const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

// =================================================================
//  CONFIGURAES DO GLPI
// =================================================================
const GLPI_URL = String(process.env.GLPI_URL || '').trim();
const APP_TOKEN = String(process.env.GLPI_APP_TOKEN || '').trim();
const USER_TOKEN = String(process.env.GLPI_USER_TOKEN || '').trim();
const MAIL_RESET_URL = String(process.env.MAIL_RESET_URL || 'https://whatsapp-email-reset.grupomns.com.br/api/mail/reset-temp').trim();
const MAIL_RESET_TOKEN = String(process.env.MAIL_RESET_TOKEN || process.env.WHATSAPP_RESET_INTERNAL_TOKEN || '').trim();
const CORPORATE_EMAIL_DOMAINS = String(
    process.env.CORPORATE_EMAIL_DOMAINS || process.env.CORPORATE_EMAIL_DOMAIN || 'grupomns.com.br'
)
    .split(',')
    .map((d) => String(d || '').trim().toLowerCase())
    .filter(Boolean);
// =================================================================

const api = axios.create({
    baseURL: GLPI_URL,
    timeout: 12000,
    headers: {
        'App-Token': APP_TOKEN,
        'Authorization': `user_token ${USER_TOKEN}`,
        'Content-Type': 'application/json'
    }
});

let sessionTokenAtual = null;

function configGLPIValida() {
    return Boolean(GLPI_URL && APP_TOKEN && USER_TOKEN);
}

function mensagemConfigGLPI() {
    return 'Configuracao GLPI ausente. Defina GLPI_URL, GLPI_APP_TOKEN e GLPI_USER_TOKEN no .env';
}

// --- FUNO DE LOGIN ---
async function loginGLPI() {
    if (!configGLPIValida()) {
        console.error(' FALHA DE CONFIGURACAO GLPI:', mensagemConfigGLPI());
        return false;
    }

    try {
        console.log(' Conectando ao GLPI...');
        const response = await api.get('/initSession');
        sessionTokenAtual = response.data.session_token;
        console.log(' GLPI Conectado! Sesso:', sessionTokenAtual);
        return true;
    } catch (error) {
        console.error(' FALHA CRTICA NO LOGIN GLPI:', error.message);
        console.error('   Verifique IP, Tokens e se o GLPI est online.');
        return false;
    }
}

// --- FUNO: AUTENTICAR USURIO GLPI COM LOGIN E SENHA ---
async function autenticarUsuarioGLPI(login, senha) {
    const loginLimpo = String(login || '').trim();
    const senhaTexto = String(senha || '');

    if (loginLimpo.length < 3 || senhaTexto.length < 3) {
        return {
            success: false,
            invalidCredentials: true,
            error: 'Login ou senha invalidos.'
        };
    }

    if (!configGLPIValida()) {
        return {
            success: false,
            error: mensagemConfigGLPI()
        };
    }

    try {
        const authBasic = Buffer.from(`${loginLimpo}:${senhaTexto}`, 'utf8').toString('base64');

        const initResp = await axios.get(`${GLPI_URL}/initSession`, {
            headers: {
                'App-Token': APP_TOKEN,
                'Authorization': `Basic ${authBasic}`,
                'Content-Type': 'application/json'
            }
        });

        const sessionTokenUsuario = initResp?.data?.session_token;
        if (!sessionTokenUsuario) {
            return {
                success: false,
                error: 'Nao foi possivel iniciar sessao do usuario no GLPI.'
            };
        }

        let idUsuario = 0;
        let nomeUsuario = '';

        try {
            const fullSessionResp = await axios.get(`${GLPI_URL}/getFullSession`, {
                headers: {
                    'App-Token': APP_TOKEN,
                    'Session-Token': sessionTokenUsuario,
                    'Content-Type': 'application/json'
                }
            });

            const sessao = fullSessionResp?.data?.session || fullSessionResp?.data || {};
            idUsuario = Number(sessao.glpiID || sessao.users_id || 0);
            nomeUsuario = `${sessao.glpifirstname || ''} ${sessao.glpirealname || ''}`.trim() || sessao.glpiname || '';
        } catch (erroSessao) {
            console.warn('Nao foi possivel obter sessao completa do usuario:', erroSessao.message);
        }

        try {
            await axios.get(`${GLPI_URL}/killSession`, {
                headers: {
                    'App-Token': APP_TOKEN,
                    'Session-Token': sessionTokenUsuario
                }
            });
        } catch (erroKill) {
            console.warn(' Falha ao encerrar sesso temporria do usurio:', erroKill.message);
        }

        if (!idUsuario) {
            const viaBusca = await buscarUsuarioPorEmail(loginLimpo);
            if (viaBusca.success) {
                idUsuario = viaBusca.id;
                if (!nomeUsuario) nomeUsuario = viaBusca.nome;
            }
        }

        if (!idUsuario) {
            return {
                success: false,
                error: 'Usurio autenticado, mas no foi possvel obter o ID no GLPI.'
            };
        }

        return {
            success: true,
            id: idUsuario,
            nome: nomeUsuario || loginLimpo
        };
    } catch (error) {
        const status = error.response?.status;
        const detalhes = JSON.stringify(error.response?.data || '');
        const invalidCredentials =
            status === 400 ||
            status === 401 ||
            /login|password|credential|unauthorized|auth/i.test(detalhes);

        return {
            success: false,
            invalidCredentials,
            error: invalidCredentials
                ? 'Login ou senha incorretos.'
                : 'Falha ao autenticar no GLPI. Tente novamente em instantes.'
        };
    }
}

// --- FUNO AUXILIAR: UPLOAD DE ARQUIVO (ETAPA 1) ---
async function uploadArquivo(buffer, nomeArquivo) {
    try {
        const formData = new FormData();

        formData.append('uploadManifest', JSON.stringify({
            input: {
                name: nomeArquivo,
                _filename: [nomeArquivo]
            }
        }));

        formData.append('filename[0]', buffer, {
            filename: nomeArquivo
        });

        const response = await api.post('/Document', formData, {
            headers: {
                'Session-Token': sessionTokenAtual,
                ...formData.getHeaders()
            }
        });

        return response.data;
    } catch (error) {
        throw error;
    }
}

// --- FUNO DE CRIAR TICKET (CORRIGIDA COM VALIDAES E ATRIBUIO DE TCNICO) ---
async function criarTicketCompleto(dados, nomeSolicitante, numeroReal) {
    //  VALIDAO 1: Verifica se dados existe
    if (!dados || typeof dados !== 'object') {
        console.error('Erro: dados invalido ou undefined');
        return null;
    }

    //  VALIDAO 2: Garante sesso ativa
    if (!sessionTokenAtual) {
        const conectado = await loginGLPI();
        if (!conectado) return null;
    }

    try {
        //  VALIDAO 3: Valores padro para campos obrigatrios
        const setor = dados.setor || 'Nao informado';
        const titulo = dados.titulo || 'Chamado sem titulo';
        const descricao = dados.descricao || 'Sem descricao';
        
        //  VALIDAO 4: id_requester com verificao de tipo
        let idRequester = 0;
        let isVIP = false;
        if (dados.id_requester && typeof dados.id_requester === 'number' && dados.id_requester > 0) {
            idRequester = dados.id_requester;
            isVIP = true;
            console.log(` Requester VIP: ${nomeSolicitante} (ID: ${idRequester})`);
        } else {
            console.log(`Requester: Nao cadastrado (ID: 0)`);
        }
        
        // Formatao da descrio (COM NOME se no for VIP)
        let descricaoFormatada;
        if (isVIP) {
            // VIP: No precisa mostrar o nome (j est no requerente)
            descricaoFormatada = 
                `WhatsApp: +${numeroReal || 'Desconhecido'}\n` +
                `Titulo: ${titulo}\n\n` +
                `Descricao do Chamado:\n` +
                `${descricao}`;
        } else {
            // NO VIP: Mostra o nome na descrio
            descricaoFormatada = 
                `Nome: ${nomeSolicitante || 'Nao informado'}\n` +
                `WhatsApp: +${numeroReal || 'Desconhecido'}\n` +
                `Titulo: ${titulo}\n\n` +
                `Descricao do Chamado:\n` +
                `${descricao}`;
        }

        // Payload para enviar ao GLPI
        const payload = {
            input: {
                name: titulo, //  S O TTULO (curto)
                content: descricaoFormatada, //  DESCRIO FORMATADA
                status: 1, // Novo
                requesttypes_id: 1, // Helpdesk
                urgency: 3 // Mdia
            }
        };

        //  Adiciona requester apenas se for VIP (ID > 0)
        if (idRequester > 0) {
            payload.input._users_id_requester = idRequester;
        }

        console.log(' Enviando ticket para GLPI...', { titulo });

        // 1. Cria o Ticket
        const response = await api.post('/Ticket', payload, {
            headers: { 'Session-Token': sessionTokenAtual }
        });

        const ticketID = response.data.id;
        console.log(` Ticket criado: #${ticketID}`);

        // 2. Upload de Anexos (udio/Foto)
        //  VALIDAO 6: Verifica se anexos existe e  array
        if (dados.anexos && Array.isArray(dados.anexos) && dados.anexos.length > 0) {
            console.log(` Subindo ${dados.anexos.length} anexos...`);
            
            for (const anexo of dados.anexos) {
                //  VALIDAO 7: Valida estrutura do anexo
                if (!anexo || !anexo.data || !anexo.name) {
                    console.warn('Anexo invalido ignorado:', anexo);
                    continue;
                }

                try {
                    //  VALIDAO 8: Tenta converter base64, com tratamento de erro
                    let buffer;
                    try {
                        buffer = Buffer.from(anexo.data, 'base64');

                        // Verifica se o buffer no est vazio
                        if (buffer.length === 0) {
                            console.warn(' Anexo vazio ignorado:', anexo.name);
                            continue;
                        }
                    } catch (bufferError) {
                        console.error(' Erro ao converter base64:', bufferError.message);
                        continue;
                    }
                    // Determina extensao e nome corretos
                    const mimetype = anexo.mimetype || 'application/octet-stream';
                    let nomeArquivo;
                    const nomeOriginal = String(anexo.name || '').trim();

                    if (mimetype.includes('audio')) {
                        nomeArquivo = `audio_${ticketID}_${Date.now()}.ogg`;
                    } else if (mimetype.includes('image')) {
                        nomeArquivo = `foto_${ticketID}_${Date.now()}.jpg`;
                    } else if (nomeOriginal && /\.[a-z0-9]{2,5}$/i.test(nomeOriginal)) {
                        const baseSeguro = nomeOriginal
                            .replace(/[^a-zA-Z0-9._-]/g, '_')
                            .replace(/_+/g, '_');
                        nomeArquivo = `${ticketID}_${Date.now()}_${baseSeguro}`;
                    } else {
                        nomeArquivo = `arquivo_${ticketID}_${Date.now()}.bin`;
                    }


                    console.log(`    Enviando anexo: ${nomeArquivo} (${buffer.length} bytes)`);

                    //  ABORDAGEM EM 2 ETAPAS
                    // ETAPA 1: Upload do arquivo bruto
                    const uploadResult = await uploadArquivo(buffer, nomeArquivo);
                    console.log(`    Upload realizado:`, uploadResult);

                    // ETAPA 2: Vincula o documento ao ticket
                    const documentId = uploadResult.id;
                    await api.post(`/Document/${documentId}/Document_Item`, {
                        input: {
                            documents_id: documentId,
                            itemtype: 'Ticket',
                            items_id: ticketID
                        }
                    }, {
                        headers: { 'Session-Token': sessionTokenAtual }
                    });

                    console.log(`    Anexo vinculado ao ticket: ${nomeArquivo}`);

                } catch (err) {
                    console.error(`    Erro ao enviar anexo "${anexo.name}":`, err.message);
                    if (err.response && err.response.data) {
                        console.error(`    Detalhes:`, JSON.stringify(err.response.data));
                    }
                    // Continua mesmo se um anexo falhar
                }
            }
        } else {
            console.log(' Nenhum anexo para enviar');
        }

        return ticketID;

    } catch (error) {
        console.error(' Erro ao criar ticket:', error.response ? error.response.data : error.message);
        
        // Tenta reconectar se o erro for de sesso expirada
        if (error.response && error.response.status === 401) {
            console.log(' Sesso expirada. Tentando reconectar...');
            await loginGLPI();
        }
        
        return null;
    }
}

// --- FUNO: BUSCAR USURIO POR EMAIL (SEM SENHA!) ---
async function buscarUsuarioPorEmail(email) {
    try {
        const emailInformado = String(email || '').trim().toLowerCase();
        console.log(`Buscando usuario por email exato: ${emailInformado}`);

        if (!emailInformado || !emailInformado.includes('@')) {
            return {
                success: false,
                error: 'Informe um email completo para vincular.'
            };
        }

        if (!sessionTokenAtual) {
            const conectado = await loginGLPI();
            if (!conectado) {
                return { success: false, error: 'Falha ao conectar no GLPI.' };
            }
        }

        // Caminho principal: mesmo mecanismo da busca da UI, no campo E-mails (field 5).
        const searchResp = await api.get('/search/User', {
            headers: { 'Session-Token': sessionTokenAtual },
            params: {
                'criteria[0][field]': 5,
                'criteria[0][searchtype]': 'contains',
                'criteria[0][value]': emailInformado,
                'forcedisplay[0]': 2,  // users_id
                'forcedisplay[1]': 9,  // firstname
                'forcedisplay[2]': 34, // realname
                range: '0-30'
            }
        });

        const linhas = normalizarLista(searchResp.data);
        for (const row of linhas) {
            const emailLinha = String(row?.[5] || row?.email || '').trim().toLowerCase();
            const id = Number(row?.[2] || row?.id || row?.users_id);

            if (emailLinha === emailInformado && Number.isFinite(id) && id > 0) {
                const nome = `${String(row?.[9] || '').trim()} ${String(row?.[34] || '').trim()}`.trim() || 'Usuario';
                return {
                    success: true,
                    id,
                    nome,
                    email: emailInformado
                };
            }
        }

        return {
            success: false,
            error: 'Email nao encontrado com correspondencia exata. Verifique o email completo.'
        };
    } catch (error) {
        console.error('Falha na busca de usuario por email:', error.message);
        if (error.code === 'ECONNABORTED') {
            return {
                success: false,
                error: 'Tempo de consulta excedido no GLPI. Tente novamente.'
            };
        }
        if (error.response) {
            console.error('Resposta do erro:', JSON.stringify(error.response.data, null, 2));
        }
        return {
            success: false,
            error: 'Erro ao buscar email no sistema'
        };
    }
}

function validarEmailCorporativo(email) {
    const valor = String(email || '').trim().toLowerCase();
    if (!valor) {
        return { ok: false, error: 'Informe seu email corporativo.' };
    }

    const formatoValido = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(valor);
    if (!formatoValido) {
        return { ok: false, error: 'Email invalido. Tente novamente.' };
    }

    const dominio = valor.split('@')[1] || '';
    if (!dominio || (CORPORATE_EMAIL_DOMAINS.length && !CORPORATE_EMAIL_DOMAINS.includes(dominio))) {
        const dominiosPermitidos = CORPORATE_EMAIL_DOMAINS.map((d) => `@${d}`).join(' ou ');
        return { ok: false, error: `Use apenas email ${dominiosPermitidos}.` };
    }

    return { ok: true, email: valor };
}

async function resetarSenhaEmailTemporaria(email) {
    const validacao = validarEmailCorporativo(email);
    if (!validacao.ok) {
        return { success: false, error: validacao.error };
    }

    if (!MAIL_RESET_URL) {
        return { success: false, error: 'Servico de reset nao configurado.' };
    }

    if (!MAIL_RESET_TOKEN) {
        return { success: false, error: 'Token interno do reset nao configurado.' };
    }

    try {
        const response = await axios.post(
            MAIL_RESET_URL,
            { email: validacao.email },
            {
                timeout: 12000,
                headers: {
                    'Authorization': `Bearer ${MAIL_RESET_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const data = response?.data || {};
        const senhaTemporaria = String(data.temp_password || '').trim();
        const expiracao = String(data.expires_at || '').trim();

        if (!senhaTemporaria || !expiracao) {
            return { success: false, error: 'Resposta invalida do servico de reset.' };
        }

        return {
            success: true,
            email: String(data.email || validacao.email),
            temp_password: senhaTemporaria,
            expires_at: expiracao,
            must_change_password: data.must_change_password !== false
        };
    } catch (error) {
        const status = Number(error?.response?.status || 0);
        const detalhesResposta = error?.response?.data;

        console.error('Falha no endpoint de reset de email:', {
            status,
            code: error?.code || '',
            message: error?.message || '',
            data: detalhesResposta || null
        });

        if (status === 429) {
            return { success: false, error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' };
        }

        if (status === 401 || status === 403) {
            return { success: false, error: 'Servico de reset nao autorizado. Avise o suporte de TI.' };
        }

        if (status === 404) {
            return { success: false, error: 'Conta de email nao encontrada ou inativa.' };
        }

        if (error?.code === 'ECONNABORTED') {
            return { success: false, error: 'Tempo de resposta excedido no reset de senha.' };
        }

        return { success: false, error: 'Falha ao gerar senha temporaria. Tente novamente.' };
    }
}

function normalizarLista(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.data)) return data.data;
    return [];
}

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function decodificarHtmlBasico(texto) {
    let saida = String(texto || '');

    // Entidades nomeadas comuns
    saida = saida
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");

    // Entidades numericas decimais: &#60;
    saida = saida.replace(/&#(\d+);/g, (_, dec) => {
        const code = Number(dec);
        if (!Number.isFinite(code)) return _;
        try {
            return String.fromCodePoint(code);
        } catch {
            return _;
        }
    });

    // Entidades numericas hexadecimais: &#x3C;
    saida = saida.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
        const code = Number.parseInt(hex, 16);
        if (!Number.isFinite(code)) return _;
        try {
            return String.fromCodePoint(code);
        } catch {
            return _;
        }
    });

    return saida;
}

function limparTextoHtml(texto) {
    const decodificado = decodificarHtmlBasico(texto);
    const semTags = decodificado
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '');

    return semTags
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function obterTextoSolucaoTicket(ticketId) {
    const idChamado = toNum(ticketId);
    if (idChamado <= 0) return '';

    if (!sessionTokenAtual) {
        const conectado = await loginGLPI();
        if (!conectado) return '';
    }

    const ordenarPorDataDesc = (itens) => {
        return [...itens].sort((a, b) => {
            const da = String(a?.date_mod || a?.date_creation || a?.date || '');
            const db = String(b?.date_mod || b?.date_creation || b?.date || '');
            if (da && db && da !== db) return da < db ? 1 : -1;
            return toNum(b?.id) - toNum(a?.id);
        });
    };

    const extrairPrimeiroTexto = (itens, apenasPublicos = false) => {
        if (!Array.isArray(itens) || !itens.length) return '';
        const ordenados = ordenarPorDataDesc(itens);

        for (const item of ordenados) {
            if (apenasPublicos) {
                const privado = toNum(item?.is_private ?? item?.private ?? 0);
                if (privado === 1) continue;
            }

            const candidato = item?.content ?? item?.answer ?? item?.solution ?? '';
            const texto = limparTextoHtml(candidato);
            if (texto) return texto.slice(0, 1500);
        }
        return '';
    };

    try {
        const resp = await api.get(`/Ticket/${idChamado}/ITILSolution`, {
            headers: { 'Session-Token': sessionTokenAtual }
        });

        const solucoes = normalizarLista(resp.data);
        const textoSolucao = extrairPrimeiroTexto(solucoes, false);
        if (textoSolucao) return textoSolucao;
    } catch (error) {
        if (error.response?.status === 401) {
            await loginGLPI();
        }
        if (error.response?.status !== 404) {
            console.warn(`Falha ao buscar ITILSolution do ticket #${idChamado}:`, error.message);
        }
    }

    // Fallback: alguns fluxos fecham sem ITILSolution preenchida.
    // Nesses casos, tenta ultimo acompanhamento publico com texto.
    const endpointsFollowup = [
        `/Ticket/${idChamado}/TicketFollowup`,
        `/Ticket/${idChamado}/ITILFollowup`
    ];

    for (const endpoint of endpointsFollowup) {
        try {
            const resp = await api.get(endpoint, {
                headers: { 'Session-Token': sessionTokenAtual }
            });
            const followups = normalizarLista(resp.data);
            const textoFollowup = extrairPrimeiroTexto(followups, true);
            if (textoFollowup) return textoFollowup;
        } catch (error) {
            if (error.response?.status === 401) {
                await loginGLPI();
            }
        }
    }

    return '';
}

function statusLabel(status) {
    const mapa = {
        1: 'Novo',
        2: 'Em atendimento',
        3: 'Planejado',
        4: 'Pendente',
        5: 'Resolvido',
        6: 'Fechado'
    };
    return mapa[toNum(status)] || `Status ${status || 'desconhecido'}`;
}

async function obterNomeUsuarioPorId(userId, cacheNomes) {
    const id = toNum(userId);
    if (id <= 0) return null;
    if (cacheNomes.has(id)) return cacheNomes.get(id);

    try {
        const resp = await api.get(`/User/${id}`, {
            headers: { 'Session-Token': sessionTokenAtual }
        });
        const user = resp.data || {};
        const nome = `${user.firstname || ''} ${user.realname || ''}`.trim() || user.name || `ID ${id}`;
        cacheNomes.set(id, nome);
        return nome;
    } catch (error) {
        console.warn(` Falha ao buscar usurio ${id}:`, error.message);
        const fallback = `ID ${id}`;
        cacheNomes.set(id, fallback);
        return fallback;
    }
}

function ticketPertenceAoRequester(detalheTicket, ticketUsers, requesterId) {
    const rid = toNum(requesterId);
    if (rid <= 0) return false;

    const requesterDireto =
        toNum(detalheTicket?._users_id_requester) ||
        toNum(detalheTicket?.users_id_requester) ||
        toNum(detalheTicket?.users_id_recipient);

    if (requesterDireto > 0) {
        return requesterDireto === rid;
    }

    for (const item of ticketUsers) {
        const tipo = toNum(item?.type ?? item?.users_type ?? item?.[3]);
        const uid = toNum(item?.users_id ?? item?.id_user ?? item?.[2]);
        if (tipo === 1 && uid === rid) return true;
    }
    return false;
}

function extrairTecnicosIds(detalheTicket, ticketUsers) {
    const ids = new Set();

    const direto = toNum(detalheTicket?.users_id_assign || detalheTicket?._users_id_assign);
    if (direto > 0) ids.add(direto);

    for (const item of ticketUsers) {
        const tipo = toNum(item?.type ?? item?.users_type ?? item?.[3]);
        const uid = toNum(item?.users_id ?? item?.id_user ?? item?.[2]);
        if (tipo === 2 && uid > 0) ids.add(uid);
    }
    return Array.from(ids);
}

// --- FUNO: CONSULTAR STATUS DOS CHAMADOS DE UM SOLICITANTE ---
async function consultarStatusChamadosRequester(idRequester, limite = 5) {
    const requesterId = toNum(idRequester);
    const limiteFinal = Math.max(1, Math.min(10, toNum(limite) || 5));

    if (requesterId <= 0) {
        return { success: false, error: 'Solicitante sem ID vinculado.' };
    }

    if (!sessionTokenAtual) {
        const conectado = await loginGLPI();
        if (!conectado) {
            return { success: false, error: 'Falha ao conectar no GLPI.' };
        }
    }

    try {
        const listaResp = await api.get('/Ticket', {
            headers: { 'Session-Token': sessionTokenAtual },
            params: { range: '0-99' }
        });

        const tickets = normalizarLista(listaResp.data);
        const cacheNomes = new Map();
        const chamados = [];

        for (const item of tickets) {
            if (chamados.length >= limiteFinal) break;

            const ticketId = toNum(item?.id ?? item?.tickets_id ?? item?.[1]);
            if (ticketId <= 0) continue;

            let detalheTicket;
            try {
                const detalheResp = await api.get(`/Ticket/${ticketId}`, {
                    headers: { 'Session-Token': sessionTokenAtual }
                });
                detalheTicket = detalheResp.data || {};
            } catch (errorDetalhe) {
                continue;
            }

            let ticketUsers = [];
            try {
                const relResp = await api.get(`/Ticket/${ticketId}/Ticket_User`, {
                    headers: { 'Session-Token': sessionTokenAtual }
                });
                ticketUsers = normalizarLista(relResp.data);
            } catch (errorRel) {
                ticketUsers = [];
            }

            if (!ticketPertenceAoRequester(detalheTicket, ticketUsers, requesterId)) {
                continue;
            }

            const tecnicosIds = extrairTecnicosIds(detalheTicket, ticketUsers);
            const tecnicosNomes = [];
            for (const tecnicoId of tecnicosIds) {
                const nome = await obterNomeUsuarioPorId(tecnicoId, cacheNomes);
                if (nome) tecnicosNomes.push(nome);
            }

            chamados.push({
                id: ticketId,
                titulo: detalheTicket?.name || 'Sem titulo',
                statusCodigo: toNum(detalheTicket?.status),
                status: statusLabel(detalheTicket?.status),
                tecnico: tecnicosNomes.length ? tecnicosNomes.join(', ') : 'Nao atribuido',
                atualizacao: detalheTicket?.date_mod || detalheTicket?.date || ''
            });
        }

        return { success: true, chamados };
    } catch (error) {
        console.error(' Erro ao consultar status de chamados:', error.response?.data || error.message);
        if (error.response?.status === 401) {
            await loginGLPI();
        }
        return { success: false, error: 'Falha ao consultar chamados no GLPI.' };
    }
}

// --- FUNO: CONSULTAR STATUS DE UM CHAMADO ESPECIFICO (COM VALIDAO DE REQUESTER) ---
async function consultarStatusChamadoPorIdRequester(idRequester, ticketId) {
    const requesterId = toNum(idRequester);
    const idChamado = toNum(ticketId);

    if (requesterId <= 0) {
        return { success: false, error: 'Solicitante sem ID vinculado.' };
    }

    if (idChamado <= 0) {
        return { success: false, error: 'ID do chamado invalido.' };
    }

    if (!sessionTokenAtual) {
        const conectado = await loginGLPI();
        if (!conectado) {
            return { success: false, error: 'Falha ao conectar no GLPI.' };
        }
    }

    try {
        const detalheResp = await api.get(`/Ticket/${idChamado}`, {
            headers: { 'Session-Token': sessionTokenAtual }
        });
        const detalheTicket = detalheResp.data || {};

        let ticketUsers = [];
        try {
            const relResp = await api.get(`/Ticket/${idChamado}/Ticket_User`, {
                headers: { 'Session-Token': sessionTokenAtual }
            });
            ticketUsers = normalizarLista(relResp.data);
        } catch (errorRel) {
            ticketUsers = [];
        }

        // Segurana: no retornar nada se o chamado no pertence ao requester.
        if (!ticketPertenceAoRequester(detalheTicket, ticketUsers, requesterId)) {
            return { success: false, error: 'Chamado nao encontrado para seu usuario.' };
        }

        const cacheNomes = new Map();
        const tecnicosIds = extrairTecnicosIds(detalheTicket, ticketUsers);
        const tecnicosNomes = [];
        for (const tecnicoId of tecnicosIds) {
            const nome = await obterNomeUsuarioPorId(tecnicoId, cacheNomes);
            if (nome) tecnicosNomes.push(nome);
        }
        const solucao = await obterTextoSolucaoTicket(idChamado);

        return {
            success: true,
            chamado: {
                id: idChamado,
                titulo: detalheTicket?.name || 'Sem titulo',
                statusCodigo: toNum(detalheTicket?.status),
                status: statusLabel(detalheTicket?.status),
                tecnico: tecnicosNomes.length ? tecnicosNomes.join(', ') : 'Nao atribuido',
                atualizacao: detalheTicket?.date_mod || detalheTicket?.date || '',
                solucao: solucao || ''
            }
        };
    } catch (error) {
        if (error.response?.status === 404) {
            return { success: false, error: 'Chamado nao encontrado para seu usuario.' };
        }
        console.error(' Erro ao consultar chamado por ID:', error.response?.data || error.message);
        if (error.response?.status === 401) {
            await loginGLPI();
        }
        return { success: false, error: 'Falha ao consultar chamado no GLPI.' };
    }
}

// --- FUNCAO: CONSULTAR STATUS DE UM CHAMADO ESPECIFICO (SEM VALIDAR REQUESTER) ---
async function consultarStatusChamadoPorId(ticketId) {
    const idChamado = toNum(ticketId);

    if (idChamado <= 0) {
        return { success: false, error: 'ID do chamado invalido.' };
    }

    if (!sessionTokenAtual) {
        const conectado = await loginGLPI();
        if (!conectado) {
            return { success: false, error: 'Falha ao conectar no GLPI.' };
        }
    }

    try {
        const detalheResp = await api.get(`/Ticket/${idChamado}`, {
            headers: { 'Session-Token': sessionTokenAtual }
        });
        const detalheTicket = detalheResp.data || {};

        let ticketUsers = [];
        try {
            const relResp = await api.get(`/Ticket/${idChamado}/Ticket_User`, {
                headers: { 'Session-Token': sessionTokenAtual }
            });
            ticketUsers = normalizarLista(relResp.data);
        } catch (errorRel) {
            ticketUsers = [];
        }

        const cacheNomes = new Map();
        const tecnicosIds = extrairTecnicosIds(detalheTicket, ticketUsers);
        const tecnicosNomes = [];
        for (const tecnicoId of tecnicosIds) {
            const nome = await obterNomeUsuarioPorId(tecnicoId, cacheNomes);
            if (nome) tecnicosNomes.push(nome);
        }
        const solucao = await obterTextoSolucaoTicket(idChamado);

        return {
            success: true,
            chamado: {
                id: idChamado,
                titulo: detalheTicket?.name || 'Sem titulo',
                statusCodigo: toNum(detalheTicket?.status),
                status: statusLabel(detalheTicket?.status),
                tecnico: tecnicosNomes.length ? tecnicosNomes.join(', ') : 'Nao atribuido',
                atualizacao: detalheTicket?.date_mod || detalheTicket?.date || '',
                solucao: solucao || ''
            }
        };
    } catch (error) {
        if (error.response?.status === 404) {
            return { success: false, error: 'Chamado nao encontrado.' };
        }
        console.error('Erro ao consultar chamado por ID (direto):', error.response?.data || error.message);
        if (error.response?.status === 401) {
            await loginGLPI();
        }
        return { success: false, error: 'Falha ao consultar chamado no GLPI.' };
    }
}

// --- FUNCAO: LISTAR DOCUMENTOS DO TICKET ---
async function listarDocumentosTicket(ticketId, ultimoDocumentoItemId = 0) {
    const idChamado = toNum(ticketId);
    const ultimoId = Math.max(0, toNum(ultimoDocumentoItemId));

    if (idChamado <= 0) {
        return { success: false, error: 'ID do chamado invalido.' };
    }

    if (!sessionTokenAtual) {
        const conectado = await loginGLPI();
        if (!conectado) {
            return { success: false, error: 'Falha ao conectar no GLPI.' };
        }
    }

    try {
        const relResp = await api.get(`/Ticket/${idChamado}/Document_Item`, {
            headers: { 'Session-Token': sessionTokenAtual }
        });
        const relacoes = normalizarLista(relResp.data);
        const documentos = [];

        for (const rel of relacoes) {
            const relId = toNum(rel?.id);
            if (relId <= ultimoId) continue;

            const documentId = toNum(rel?.documents_id);
            if (documentId <= 0) continue;

            let doc = {};
            try {
                const docResp = await api.get(`/Document/${documentId}`, {
                    headers: { 'Session-Token': sessionTokenAtual }
                });
                doc = docResp.data || {};
            } catch (_) {
                continue;
            }

            documentos.push({
                itemId: relId,
                documentId,
                fileName: String(doc?.filename || doc?.name || `arquivo_${documentId}`),
                mimeType: String(doc?.mime || 'application/octet-stream'),
                userId: toNum(doc?.users_id || rel?.users_id)
            });
        }

        documentos.sort((a, b) => a.itemId - b.itemId);
        return { success: true, documentos };
    } catch (error) {
        if (error.response?.status === 401) {
            await loginGLPI();
        }
        return { success: false, error: 'Falha ao listar documentos do chamado.' };
    }
}

// --- FUNCAO: BAIXAR DOCUMENTO DO TICKET (BUFFER) ---
async function baixarDocumentoTicketBuffer(ticketId, documentId) {
    const idChamado = toNum(ticketId);
    const idDocumento = toNum(documentId);

    if (idChamado <= 0 || idDocumento <= 0) {
        return { success: false, error: 'Ticket/documento invalido.' };
    }

    if (!sessionTokenAtual) {
        const conectado = await loginGLPI();
        if (!conectado) {
            return { success: false, error: 'Falha ao conectar no GLPI.' };
        }
    }

    const baseSemApi = String(GLPI_URL).replace(/\/apirest\.php\/?$/i, '');
    const urlDownload = `${baseSemApi}/front/document.send.php?docid=${idDocumento}&itemtype=Ticket&items_id=${idChamado}`;

    try {
        const resp = await axios.get(urlDownload, {
            responseType: 'arraybuffer',
            timeout: 20000,
            headers: {
                'App-Token': APP_TOKEN,
                'Session-Token': sessionTokenAtual
            },
            validateStatus: (status) => status >= 200 && status < 400
        });

        return {
            success: true,
            buffer: Buffer.from(resp.data),
            mimeType: String(resp?.headers?.['content-type'] || 'application/octet-stream')
        };
    } catch (error) {
        if (error.response?.status === 401) {
            await loginGLPI();
        }
        return { success: false, error: error.message || 'Falha ao baixar documento.' };
    }
}

// --- FUNCAO: ADICIONAR FOLLOW-UP NO TICKET ---
async function adicionarFollowupTicket(ticketId, conteudo, privado = false) {
    const idChamado = toNum(ticketId);
    const texto = String(conteudo || '').trim();

    if (idChamado <= 0) {
        return { success: false, error: 'ID do chamado invalido.' };
    }

    if (!texto) {
        return { success: false, error: 'Texto do follow-up vazio.' };
    }

    if (!sessionTokenAtual) {
        const conectado = await loginGLPI();
        if (!conectado) {
            return { success: false, error: 'Falha ao conectar no GLPI.' };
        }
    }

    const payload = {
        input: {
            itemtype: 'Ticket',
            items_id: idChamado,
            content: texto,
            is_private: privado ? 1 : 0
        }
    };

    try {
        await api.post('/ITILFollowup', payload, {
            headers: { 'Session-Token': sessionTokenAtual }
        });
        return { success: true };
    } catch (errorPrimario) {
        try {
            // Fallback para instancias GLPI que usam endpoint por item.
            await api.post(`/Ticket/${idChamado}/ITILFollowup`, {
                input: {
                    content: texto,
                    is_private: privado ? 1 : 0
                }
            }, {
                headers: { 'Session-Token': sessionTokenAtual }
            });
            return { success: true };
        } catch (errorFallback) {
            if (errorFallback.response?.status === 401 || errorPrimario.response?.status === 401) {
                await loginGLPI();
            }
            return {
                success: false,
                error: errorFallback.response?.data?.message || errorFallback.message || errorPrimario.message
            };
        }
    }
}

// --- FUNO: CRIAR NOVO USURIO NO GLPI ---
async function criarUsuarioGLPI(dadosUsuario) {
    try {
        console.log(` Criando usurio: ${dadosUsuario.nome}`);

        if (!sessionTokenAtual) {
            await loginGLPI();
        }

        const payload = {
            input: {
                name: dadosUsuario.nome,
                firstname: dadosUsuario.nome.split(' ')[0],
                realname: dadosUsuario.nome.split(' ').slice(1).join(' ') || dadosUsuario.nome,
                phone: dadosUsuario.telefone,
                _useremails: [dadosUsuario.email],
                comment: `Cadastrado via WhatsApp Bot em ${new Date().toLocaleString('pt-BR')}`
            }
        };

        const response = await api.post('/User', payload, {
            headers: { 'Session-Token': sessionTokenAtual }
        });

        console.log(` Usurio criado com ID: ${response.data.id}`);

        return {
            success: true,
            id: response.data.id,
            message: response.data.message
        };
    } catch (error) {
        console.error(' Erro ao criar usurio:', error.response ? error.response.data : error.message);
        return {
            success: false,
            error: error.response?.data || error.message
        };
    }
}

// --- FUNO: SALVAR USURIO VIP NO ARQUIVO ---
const fs = require('fs');
const path = require('path');

async function salvarUsuarioVIP(numeroReal, nome, id, USUARIOS_VIP) {
    try {
        const dadosPath = path.join(__dirname, '../data/dados.local.js');

        console.log(` Salvando usurio VIP: ${nome} (${numeroReal}) -> ID ${id}`);

        if (!fs.existsSync(dadosPath)) {
            fs.writeFileSync(
                dadosPath,
                "const USUARIOS_VIP = {};\n\nmodule.exports = USUARIOS_VIP;\n",
                'utf8'
            );
        }

        // L o arquivo atual
        let conteudo = fs.readFileSync(dadosPath, 'utf8');

        // Encontra a ltima linha antes de }; (usa aspas duplas para manter padro)
        const novaLinha = `    "${numeroReal}": { nome: "${nome}", id: ${id} },\n`;

        // Insere antes da ltima linha };
        conteudo = conteudo.replace(/\};?\s*\nmodule\.exports/, `${novaLinha}};\n\nmodule.exports`);

        // Salva o arquivo
        fs.writeFileSync(dadosPath, conteudo, 'utf8');
        console.log(` Arquivo dados.local.js atualizado!`);

        //  ATUALIZA A MEMRIA TAMBM (SEM PRECISAR REINICIAR!)
        if (USUARIOS_VIP) {
            USUARIOS_VIP[numeroReal] = { nome: nome, id: id };
            console.log(` Memria USUARIOS_VIP atualizada!`);
        }

        return true;
    } catch (error) {
        console.error(' Erro ao salvar usurio VIP:', error.message);
        console.error('   Stack:', error.stack);
        return false;
    }
}

// --- EXPORTAO ---
module.exports = {
    loginGLPI,
    autenticarUsuarioGLPI,
    criarTicketCompleto,
    consultarStatusChamadosRequester,
    consultarStatusChamadoPorIdRequester,
    consultarStatusChamadoPorId,
    listarDocumentosTicket,
    baixarDocumentoTicketBuffer,
    adicionarFollowupTicket,
    buscarUsuarioPorEmail,
    resetarSenhaEmailTemporaria,
    criarUsuarioGLPI,
    salvarUsuarioVIP
};


