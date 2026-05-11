# eProc — Correção de Inconsistências em Lote

Userscript para automação em lote da correção de inconsistências duplicadas nos processos do eProc do TJSP. Detecta e remove automaticamente entradas duplicadas de **Justiça Gratuita** e **Litisconsórcio Passivo** na tela de "Inconsistências do Processo".

---

## Pré-requisitos

### 1. Instalar o Tampermonkey

Abra a loja de extensões do seu navegador (Chrome, Edge ou Firefox), procure por **Tampermonkey** e instale a extensão. Após instalar, confirme que o ícone do Tampermonkey apareceu próximo à barra de endereço.

### 2. Ativar o modo desenvolvedor no navegador

Isso é necessário para o Tampermonkey rodar o script sem bloqueio.

- Vá em **Configurações → Extensões**
- No canto superior direito, ative **Modo do desenvolvedor**

### 3. Configurações do Tampermonkey

- Clique no ícone do Tampermonkey → **Painel** → **Configurações**
- Confirme que estas opções estão ativas:
  - Permitir scripts de usuário
  - Permitir acesso a abas
  - Permitir requisições remotas
  - Modo estrito desativado *(se existir no seu navegador)*

---

## Instalação

1. Clique no ícone do Tampermonkey → **Criar novo script**
2. Apague o conteúdo padrão e cole o conteúdo do arquivo `eproc-inconsistencias.user.js`
3. Salve com **Ctrl + S**
4. Acesse: `https://eproc1g.tjsp.jus.br/eproc/controlador.php?acao=ProcessoInconsistente/consultar`
5. A HUD aparecerá automaticamente no canto inferior direito da tela

---

## Como usar

### Preparar a lista de processos

Cole os números de processo na área de texto da HUD, um por linha. Apenas dígitos são aceitos — o script ignora automaticamente qualquer caractere que não seja número:

```
00002687620258260358
00012345620248260001
```

### Executar

1. Cole os números na HUD
2. Clique em **Iniciar**
3. O script processa cada processo automaticamente:
   - Consulta a tela de inconsistências
   - Identifica duplicatas (cards com indicador vermelho)
   - Remove a entrada redundante
   - Avança para o próximo processo

Não é necessário interagir com a página durante o processamento.

### Controles disponíveis

| Botão | Ação |
|---|---|
| Iniciar | Inicia o processamento em lote |
| Parar | Interrompe o processamento |
| Exportar Log | Baixa o relatório em `.txt` |
| Limpar | Remove os registros do log local |

---

## Lógica de remoção de duplicatas

Quando há mais de uma entrada duplicada, o script prioriza qual remover na seguinte ordem:

1. Entradas com valor **"Requerida"** são removidas primeiro
2. Se não houver "Requerida", remove entradas de **usuários** (mantém entradas do SISTEMA)
3. Como último recurso, remove a primeira entrada com botão de desativar disponível

---

## Resultados

Cada processo processado é registrado no log com um dos seguintes status:

| Status | Descrição |
|---|---|
| ✅ Corrigido | Duplicatas encontradas e removidas |
| ℹ️ Sem duplicatas | Processo sem inconsistências detectadas |
| ❌ Erro | Duplicata encontrada, mas sem botão de desativar disponível |

O log é exportado em formato `.txt` com o relatório completo:

```
inconsistencias_log_2025-05-11.txt
```

Os registros são mantidos por **7 dias** automaticamente.

---

## Observações

- O script sobrescreve `window.confirm` durante o processamento para confirmar automaticamente os diálogos do eProc
- O estado da fila é salvo entre recarregamentos de página — se a aba fechar durante o processamento, o script retoma do ponto onde parou ao retornar à página
- Tipos de inconsistência tratados: **Justiça Gratuita** e **Litisconsórcio Passivo**
