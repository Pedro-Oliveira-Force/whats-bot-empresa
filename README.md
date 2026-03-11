# Bot de suporte de TI no WhatsApp

Bot em Node.js para atendimento de suporte de TI via WhatsApp com integracao ao GLPI.

## O que o bot faz

- Abre chamados no GLPI com setor, titulo, descricao e anexos.
- Consulta status de chamado por `ID + codigo de consulta`.
- Gera senha temporaria de email via endpoint interno.
- Notifica o usuario quando o chamado e fechado.

## Stack

- Node.js
- `@wppconnect-team/wppconnect`
- `axios`
- `dotenv`
- `form-data`

## Fluxos principais

### 1) Abrir chamado

1. Usuario digita `1`.
2. Bot coleta setor, titulo e descricao.
3. Bot aceita audio, imagem e documento como anexo.
4. Bot mostra um resumo e pede confirmacao.
5. Bot cria o ticket no GLPI.
6. Bot registra o chamado para consulta e notificacao automatica.

### 2) Consultar status

1. Usuario digita `2`.
2. Bot pede o ID do chamado.
3. Bot pede o codigo de consulta.
4. Bot valida o par `ID + codigo`.
5. Bot consulta o GLPI e retorna status, tecnico, ultima atualizacao e solucao quando houver.

### 3) Reset de senha de email

1. Usuario digita `3`.
2. Bot pede o email corporativo.
3. Bot valida dominio e vinculo do numero com o usuario GLPI.
4. Bot chama o endpoint interno de reset com bearer token.
5. Bot retorna a senha temporaria e a validade.

Observacao: o bot nao altera servidor de email diretamente. Ele apenas consome um servico interno.

## Estrutura

- `src/index.js`: fluxo principal do bot e maquina de estados.
- `src/services/glpi.js`: integracoes GLPI e endpoint de reset.
- `src/data/dados.local.js`: mapeamento privado WhatsApp -> usuario GLPI.
- `src/data/dados.example.js`: exemplo publico sem dados reais.
- `src/data/notificacoes_tickets.json`: fila local de notificacoes, nao versionada.

## Configuracao

1. Instale as dependencias:

```bash
npm install
```

2. Crie o `.env`:

```bash
copy .env.example .env
```

3. Preencha as variaveis:

```env
GLPI_URL=
GLPI_APP_TOKEN=
GLPI_USER_TOKEN=

MAIL_RESET_URL=
MAIL_RESET_TOKEN=

CORPORATE_EMAIL_DOMAINS=seudominio.com.br
RESET_EMAIL_WHATSAPP_COMPARTILHADO=
```

## Execucao

```bash
npm start
```

## Validacao rapida

```bash
npm test
```

## Boas praticas de seguranca

- Nao versionar `.env`, `tokens/`, `downloads/` ou arquivos com dados reais.
- Manter `src/data/dados.local.js` e `src/data/notificacoes_tickets.json` fora do Git.
- Limpar historico e forcar push se algum dado sensivel for exposto por engano.
- Rotacionar tokens se houver qualquer suspeita de exposicao.
