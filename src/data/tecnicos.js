// =================================================================
// 👨‍💻 LISTA DE TÉCNICOS DO SUPORTE TI
// =================================================================
// Estrutura: { nome: 'Nome do Técnico', id_glpi: ID_NO_GLPI }
// 
// O id_glpi é usado para atribuir automaticamente o ticket ao técnico
// escolhido pelo usuário no WhatsApp.
//
// id_glpi: 0 = Sem atribuição automática (vai para a fila geral)
// =================================================================

module.exports = {
    '1': { nome: 'Pedro', id_glpi: 676 }, 
    '2': { nome: 'Guilherme Oliveira', id_glpi: 656 },
    '3': { nome: 'Gabriel Dias', id_glpi: 657 },
    '4': { nome: 'Guilherme Diniz', id_glpi: 401 },
    '5': { nome: 'Qualquer um', id_glpi: 0 } // 0 = Sem técnico específico (fila geral)
};