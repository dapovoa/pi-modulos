# pi-cursor: gestão de contexto e de falhas

## Arquitetura

```
pi-core (harness)
  └─ pi-cursor (extensão)
       └─ @cursor/sdk (Agent.create, Agent.resume, Agent.send)
            └─ Cursor API (backend)
```

- Pi-cursor registra-se como provider (`streamSimple: cursorStream`).
- O Cursor SDK gere a conversação em SQLite local (histórico completo).
- Cada `agent.send()` reenvia TODO o SQLite mais a nova mensagem.
- `cursorStream` envia apenas a última mensagem do utilizador, nunca o histórico do pi.
- Pi-core dispara compactação quando `contextTokens > ctxWindow - reserveTokens`.

## O problema

**composer-2.5 tem janela real de cerca de 200K tokens.**
Quando a conversa acumula mais de 200K, o modelo fica errático (amnésia, respostas incoerentes).

O agravante é que a compactação do pi-core, por si só, não resolvia isto.
Pi-core mede o contexto a partir do usage que pi-cursor reporta, e esse valor era o do agente Cursor, não o do pi.
Compactar o histórico do pi não baixava esse número, logo a compactação voltava a disparar no turn seguinte.
Era essa a causa das compactações a cada 2-3 mensagens observadas com `ctxWindow` = 200K.

O valor reportado estava ainda inflacionado cerca de 58x por um erro de medição, tratado na secção "Usage: faturação e contexto".

Historicamente foram tentadas três abordagens:

### Abordagem A: ctxWindow = 200K sem reciclagem de agente

- Compactação dispara perto do limite real e o modelo funciona bem.
- **Problema:** loop de compactação a cada 2-3 mensagens, pela razão acima.

### Abordagem B: ctxWindow alto (1M, depois 10M)

- A compactação praticamente nunca dispara, o que evita o loop.
- **Problema:** o contexto real excede 200K e o modelo degrada.
- Efeito secundário: o medidor de contexto no footer fica sempre perto de 0%, sem aviso prévio.

### Abordagem C: ctxWindow real + fechar agente na compactação + injetar summary

- Adotada em 2026-08-01, ver secção seguinte.

## Solução adotada (Abordagem C)

Três peças, todas em `index.ts`:

1. **`ctxWindow` reporta valores honestos.**
   Usa o valor do SDK quando existe e, quando não existe, devolve 200K em vez do antigo 10M.
   O medidor do footer volta a ser um aviso real.

2. **`session_compact` recicla o agente.**
   O handler fecha e remove os agentes Cursor da sessão, pelo que o envio seguinte cria um agente novo.
   A compactação encolhe o histórico do pi mas não toca no SQLite do Cursor, por isso reciclar é o único limite ao crescimento do agente.

3. **`buildFallbackContext` semeia o agente novo.**
   O primeiro envio a um agente fresco é prefixado com o contexto recente do pi, que depois de uma compactação é o summary.
   Pi-core injeta esse summary como uma mensagem `user` normal iniciada por `"The conversation history before this point was compacted into the following summary:"`, por isso é a primeira entrada e é preservada inteira.
   O orçamento é `FALLBACK_CONTEXT_MAX_CHARS` (60K chars), gasto nos turns mais recentes.

Verificado end-to-end com uma compactação real conduzida por `pi --mode rpc`.
O agente reciclado, tendo apenas o summary, respondeu corretamente sobre conteúdo anterior à compactação.
Nota para testes futuros: a compactação automática não corre em modo print, e recusa correr enquanto a sessão não exceder `keepRecentTokens`.

### Trade-offs aceites

- Cada compactação descarta o detalhe do SQLite do Cursor e mantém só o summary do pi, ou seja, amnésia parcial nesse ponto.
- Gerar o summary passa pelo provider ativo, logo compactar uma sessão pi-cursor custa uma chamada Cursor extra.
- Alavancas de ajuste: `FALLBACK_CONTEXT_MAX_CHARS` e o valor de fallback do `ctxWindow`.

## Usage: faturação e contexto

Depois da Abordagem C, a compactação continuou a disparar de poucos em poucos minutos.
A causa era o usage reportado, inflacionado cerca de 58x: um turn reportou 1.947.341 tokens contra uma janela de 200K, quando o pi tinha cerca de 33K.
São dois erros independentes que se multiplicavam.

**1. Convenções opostas.**
No Cursor, `inputTokens` é o prompt inteiro e já inclui `cacheReadTokens` e `cacheWriteTokens`.
O pi-ai assume o contrário e fatura `input + cacheRead + cacheWrite`, por isso somar os campos contava tudo duas vezes, com fator medido de 1.99 em 8 mensagens reais.
`applyTurnUsage` passa a subtrair a parte em cache antes de faturar.
O mesmo erro inflacionava o custo mostrado: uma sessão somava 443 dólares, com 80,5% no termo `input`.

**2. `inputTokens` não é tamanho de contexto.**
O SDK soma o prompt de cada passo interno do agent loop, ou seja, mede faturação.
O mesmo pedido trivial deu 11.262 tokens numa sondagem e 22.520 noutra, e um turn real reportou 14.241.217, impossível como prompt quando a maior janela é 1M.
O próprio SDK calcula `totalTokens` como um agregado de faturação, e copiar essa fórmula para medir contexto foi o erro de origem.
Não há alternativa limpa pelo SDK, que emite um único `turn-ended` por turn e nenhum usage por passo.

**Correção.**
`totalTokens` passa a reportar o contexto do próprio pi, calculado com `estimateTokens` do pi-core sobre `ctx.messages` mais a mensagem assistant em construção.
É esse o número que o pi-core compara com `contextWindow`, e é exatamente o que um agente reciclado recebe como seed.
Extensões podem importar de `@earendil-works/pi-coding-agent`, que o loader do pi tem no mapa de aliases, por isso o estimador é partilhado em vez de duplicado.

Verificado com envios reais em `pi --print --mode json`.
Um envio reportou `input` 3249 com `cacheRead` 8381, ou seja, `input` é agora o resto não-cached de um prompt de 11.630 tokens.
Ao longo de três turns de uma sessão, `totalTokens` deu 19, 49 e 81, coincidindo exatamente com o recálculo independente do histórico do pi a partir do ficheiro de sessão.

**Seguimento (2026-08-01): os agregados de faturação lidos como tamanho de prompt.**
Mesmo depois do split, a compactação disparou cedo: a sessão `019fbf19` compactou com `tokensBefore` 22.995, cerca de 11% da janela de 200K.
O gatilho não foi o threshold (`shouldCompact` prefere `totalTokens`, já honesto) mas o caminho de silent overflow: `isContextOverflow` do pi-ai lê `usage.input + usage.cacheRead` como o tamanho do último prompt, e o pi-cursor ainda reportava aí os agregados de faturação.
A última mensagem reportava `input` 67.988 mais `cacheRead` 1.165.888, mais de seis vezes a janela, e o pi-core compactou com razão "overflow".
Só disparou nesse turn porque `prepareCompaction` recusa compactar abaixo de `keepRecentTokens` (20.000); o contexto real do pi cruzou esse limite exatamente aí.
A troca de modelo no mesmo turn (composer-2.5 → grok-4.5) foi coincidência: os turns composer já tinham o falso overflow desde a mensagem 6.

**Correção.**
Em `applyTurnUsage`, a faturação fica num objeto scratch usado apenas para o custo (`calculateCost`), e o usage reportado passa a ter semântica de prompt: `input` é a estimativa do contexto do pi no início do turn, `cacheRead`/`cacheWrite` zero, `output` o output real acumulado, `totalTokens` o contexto pós-turn como antes.
`isContextOverflow` passa a funcionar como guarda correta: dispara só quando o contexto do pi excede mesmo a janela, e `shouldCompact` continua a disparar em `contextWindow - reserveTokens`.

Verificado com envio real (`input` 6, `cacheRead` 0, `totalTokens` 20, custo $0,0137 derivado da faturação) e com replay da decisão usando as funções compiladas do pi-core: overflow verdadeiro com a semântica antiga, falso com a nova, e um turn sintético de 199K tokens continua a disparar `shouldCompact`.

## O que já foi corrigido (funcional)

| Fix | Descrição |
|-----|-----------|
| applyTurnUsage | Separa faturação de contexto. A faturação acumula por turn num objeto scratch só para o custo. O usage reportado tem semântica de prompt: `input` = contexto do pi no início do turn, cache zero, `totalTokens` = contexto pós-turn. Sem isto, o `isContextOverflow` do pi-ai lia a faturação como tamanho de prompt e compactava prematuramente |
| Persistência agentId | Guardado em cursor-agents.json imediatamente após Agent.create() |
| Agent.resume() | Após idle expiry (>8min) ou restart do pi |
| resource_exhausted | Detetado em RunResult e exceções gRPC code 8; retry único com jitter de 10-15s; falha persistente recicla o agente e abre circuit breaker de 60s apenas para o chat/model |
| auth_error | Detectado no result e em exceção. `recoverFromAuthError` espera `AUTH_RETRY_BACKOFF_MS` (3s, depois 9s) antes de cada tentativa e resume o agente anterior para preservar o histórico. Sem o backoff o retry disparava 130ms depois e reproduzia a mesma rejeição |
| releaseAgent | Fecha o agente sem o marcar stuck nem apagar o ponteiro em disco. Os caminhos de recuperação de falhas do backend passam a libertar em vez de evictar, o que torna o branch resume-first alcançável (era código morto) |
| Output continuation | Até 3x `agent.send("")` automático, sem gate "toolWorkDone" |
| Classificação de stopReason | Falhas sintéticas (auth_error, resource_exhausted) dão `stopReason` "error" com a mensagem real do SDK, `cancelled` dá "aborted", e "length" fica reservado a status desconhecido. Antes um `else` catch-all marcava tudo como "length", o que a UI do pi mostrava como "maximum output token limit" |
| Modelo "auto" | Removido (log 2026-07-25). O Cursor Router não está disponível na API key pessoal e o auto básico otimiza para custo. `default` é registado tal como vem do SDK, sem params |
| ctxWindow | Valores do SDK quando disponíveis, fallback 200K |
| session_compact | Recicla o agente Cursor e semeia o novo com o summary do pi |

## Isolamento de chats e falhas de capacidade

O provider não impõe limite global ao número de chats, agentes Cursor ou subagentes em background.
Cada stream tem um run token e um AbortController próprio, associados ao sessionId.
O crash guard usa AsyncLocalStorage para localizar o run que originou uma rejeição detached do SDK.
Quando existem vários chats e a rejeição não pode ser associada com segurança, o provider não aborta um chat arbitrário.

Os hooks de shutdown e compactação obtêm o sessionId através de `ctx.sessionManager.getSessionId()`.
Assim, `session_shutdown`, `session_before_compact` e `session_compact` afetam apenas a sessão que emitiu o evento.

`resource_exhausted` é reconhecido tanto no resultado terminal como em exceções gRPC code 8.
A primeira falha faz um retry no mesmo agente após 10-15 segundos de jitter para preservar o histórico SQLite.
Se a segunda tentativa falhar, o agente é reciclado e abre-se um circuit breaker de 60 segundos para `cwd|sessionId|model`.
Outros chats, modelos e trabalhos em background continuam disponíveis.

## Rejeições de auth transitórias

O Cursor responde a uma API key válida com "Authentication error If you are logged in, try logging out and back in." durante alguns segundos.
A key não é a causa: com a key de `auth.json`, o `composer-2.5` com `fast=false` responde `finished` com project settings, no cwd real, com um prompt semeado de 18K chars e com quatro agentes concorrentes.
O conselho de fazer logout vem da app desktop e não se aplica a uma API key.

Duas falhas independentes transformavam essa rejeição passageira num turn morto, ambas corrigidas em 2026-08-03.

**Sem backoff.**
O `resource_exhausted` espera 10-15s e o `ENHANCE_YOUR_CALM` espera 2s/4s/8s, mas o caminho de auth retentava logo.
Nos logs o retry dispara 130-140ms depois da falha e apanha a mesma rejeição, quatro vezes em 2026-08-01 e outra em 2026-08-03.
`recoverFromAuthError` passa a esperar `AUTH_RETRY_BACKOFF_MS` (3s, depois 9s) antes de cada tentativa.

**Resume-first era código morto.**
Os três caminhos de recuperação guardavam o `savedId`, chamavam `evictAgent` e só depois testavam `!stuckAgentIds.has(savedId)`.
Como o `evictAgent` acrescenta o id a `stuckAgentIds`, o teste era sempre falso com um agente ativo.
Confirmado em todos os ficheiros de log: a linha "preserve memory" que o branch emitiria nunca apareceu.
Cada recuperação descartava o SQLite do Cursor sem necessidade.
O novo `releaseAgent` fecha o agente sem o marcar stuck nem apagar o ponteiro em disco, pelo que o retry o pode voltar a resumir.

## Contexto por modelo

Dos 34 modelos, 14 reportam contexto real e 20 não reportam nada e caem no fallback de 200K.

| Grupo | Modelos | ctxWindow |
|-------|---------|-----------|
| Real, 1M | claude-opus-5, claude-opus-4-6/4-7/4-8, claude-sonnet-5, claude-sonnet-4-6, claude-fable-5, gpt-5.4, gpt-5.5, gpt-5.6-luna/sol/terra | 1M |
| Real, 200K | claude-sonnet-4, claude-sonnet-4-5 | 200K |
| Sem dados, fallback | composer-2.5, composer-2, default, grok-4.5, kimi-k3, kimi-k2.7-code, glm-5.2, gemini-*, gpt-5.1/5.2/5.3-codex/5-mini/5.4-mini/5.4-nano, claude-opus-4-5, claude-haiku-4-5 | 200K |

Atenção ao ler `cursor-models.json` diretamente: estes modelos expõem várias variantes de contexto.
O valor que conta é o da variante default, e ler outra variante dá números errados.

## Pontos abertos

1. **Truncar o SQLite do Cursor SDK sem descartar o agente** seria melhor que reciclar, mas o SDK não expõe API para isso.
   `Agent.resume()` restaura o histórico completo e não existe equivalente com truncagem.
2. **Compressão do lado do backend:** o Cursor CLI desktop pode usar endpoint ou parâmetros que o SDK público não expõe.
   Investigar em `<cursor-inspector-dir>/` (minificado, difícil).
3. **Afinar o fallback de 200K** por família de modelo, se a medição mostrar janelas reais diferentes.
4. **Rejeição de auth mais longa que o backoff.**
   `recoverFromAuthError` cobre 12 segundos no total, o que resolve as rejeições curtas observadas.
   Em 2026-08-01 a condição persistiu das 12:10 às 12:25, e nesse caso o turn termina em erro.
   Um circuit breaker por `cwd|sessionId|model`, como o do `resource_exhausted`, encaixa melhor do que alargar o schedule.
5. **Crescimento do SQLite do Cursor não é observável.**
   O contexto do pi cresce mais devagar que o SQLite do Cursor, que guarda argumentos e resultados completos das tools.
   O agente Cursor pode chegar à janela real antes de o pi decidir compactar, e o SDK não expõe nenhum sinal do tamanho do prompt.

## Ficheiros relevantes

- Código: `<module>/index.ts` (1964 linhas)
- Extensão ativa: `<installed-extension>/index.ts` (tem de ser byte-identica ao ficheiro acima)
- Wiki: `<module>/.pi/memory/`
- Logs: `<logs>/pi-cursor-YYYY-MM-DD.log`
- Auth: `<auth.json>`, sob a chave `pi-cursor` e não `cursor`
- SDK: `@cursor/sdk@1.0.25`
- Pi: `0.83.0`
