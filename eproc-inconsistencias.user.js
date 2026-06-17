// ==UserScript==
// @name         eProc Inconsistências Automation
// @namespace    https://github.com/rsalvessap/eproc-inconsistencias
// @version      1.6
// @description  Bulk automation for "Inconsistências do Processo" - removes duplicate entries
// @author       rsalvessap
// @updateURL    https://raw.githubusercontent.com/rsalvessap/eproc-inconsistencias/master/eproc-inconsistencias.user.js
// @downloadURL  https://raw.githubusercontent.com/rsalvessap/eproc-inconsistencias/master/eproc-inconsistencias.user.js
// @include      *://eproc*.tjsp.jus.br/eproc/controlador.php*
// @include      *://*-1g-*.tjsp.jus.br/eproc/controlador.php*
// @include      *://*-2g-*.tjsp.jus.br/eproc/controlador.php*
// @include      *://sso-*.tjsc.jus.br/eproc/controlador.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @require      https://cdn.jsdelivr.net/gh/rsalvessap/eproc-scripts-gerais@master/shared/eproc-utils.js
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════
    const CONFIG = {
        STORAGE_KEY: 'eproc_inconsistencias_log',
        QUEUE_KEY: 'eproc_inconsistencias_queue',
        LOG_RETENTION_DAYS: 7,
        ACTION_DELAY_MS: 1500,
        get INCONSISTENCIAS_URL() { return `${window.location.origin}/eproc/controlador.php?acao=ProcessoInconsistente/consultar`; }
    };

    const DUPLICATE_TYPES = ['Justiça Gratuita', 'Litisconsórcio Passivo'];

    // ═══════════════════════════════════════════════════════════════════════════
    // AUTO-CONFIRM OVERRIDE (using unsafeWindow for real page context)
    // ═══════════════════════════════════════════════════════════════════════════
    const realWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const originalConfirm = realWindow.confirm.bind(realWindow);
    realWindow.confirm = function (message) {
        try {
            const queueData = GM_getValue('eproc_inconsistencias_queue', 'null');
            const queue = JSON.parse(queueData);
            if (queue) {
                console.log('[Inconsistencias] Auto-confirming:', message);
                return true;
            }
        } catch (e) { }
        return originalConfirm(message);
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // PAGE DETECTION
    // ═══════════════════════════════════════════════════════════════════════════
    function isInconsistenciasPage() {
        const params = new URLSearchParams(window.location.search);
        return params.get('acao') === 'ProcessoInconsistente/consultar';
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STORAGE MODULE
    // ═══════════════════════════════════════════════════════════════════════════
    const Storage = {
        loadLog() {
            try { return JSON.parse(GM_getValue(CONFIG.STORAGE_KEY, '[]')); }
            catch (e) { console.error('Failed to load log:', e); return []; }
        },
        saveLog(entries) { GM_setValue(CONFIG.STORAGE_KEY, JSON.stringify(entries)); },
        addEntry(entry) {
            const entries = this.loadLog();
            entries.unshift(entry);
            this.saveLog(entries);
            return entries;
        },
        cleanup() {
            const entries = this.loadLog();
            const cutoff = Date.now() - (CONFIG.LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
            const filtered = entries.filter(e => e.timestamp > cutoff);
            if (filtered.length !== entries.length) this.saveLog(filtered);
            return filtered;
        },
        clearLog() { this.saveLog([]); },
        loadQueue() {
            try { return JSON.parse(GM_getValue(CONFIG.QUEUE_KEY, 'null')); }
            catch (e) { return null; }
        },
        saveQueue(queue) { GM_setValue(CONFIG.QUEUE_KEY, JSON.stringify(queue)); },
        clearQueue() { GM_setValue(CONFIG.QUEUE_KEY, 'null'); }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // RESULT TYPES
    // ═══════════════════════════════════════════════════════════════════════════
    const ResultType = {
        FIXED:   'success',
        OK:      'info',
        ERROR:   'error',
        PENDING: 'pending'
    };

    function clickVoltar() {
        const btn = document.querySelector('button.btn-secondary');
        if (btn && btn.textContent.includes('Voltar')) {
            btn.click();
        } else {
            window.location.reload();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DUPLICATE DETECTOR
    // ═══════════════════════════════════════════════════════════════════════════
    function analyzeDuplicates() {
        const results = { hasDuplicates: false, duplicateCards: [], allGreen: true };

        document.querySelectorAll('.card-header').forEach(header => {
            if (header.textContent.trim() !== 'Informações Adicionais Duplicadas') return;

            if (header.classList.contains('bg-danger')) {
                results.allGreen = false;
                const cardBody = header.nextElementSibling;
                if (!cardBody) return;
                const table = cardBody.querySelector('table');
                if (!table) return;
                const rows = table.querySelectorAll('tbody tr');
                const dataRows = Array.from(rows).filter(row => !row.querySelector('.dataTables_empty'));
                if (dataRows.length > 1) {
                    results.hasDuplicates = true;
                    results.duplicateCards.push({ header, table, rows: dataRows });
                }
            }
        });

        return results;
    }

    function findRowToRemove(rows) {
        // Priority 1: Remove "Requerida" entries
        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 5) continue;
            const descricao = cells[0].textContent.trim();
            const valor     = cells[1].textContent.trim();
            if (!DUPLICATE_TYPES.includes(descricao)) continue;
            if (valor === 'Requerida') {
                const link = row.querySelector('a.btnDesativar');
                if (link) return { row, link, descricao, valor, usuario: cells[4].textContent.trim() };
            }
        }
        // Priority 2: Remove user (non-system) entries
        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 5) continue;
            const descricao = cells[0].textContent.trim();
            const usuario   = cells[4].textContent.trim();
            if (!DUPLICATE_TYPES.includes(descricao)) continue;
            if (!usuario.includes('SISTEMA DE PROCESSO ELETRÔNICO')) {
                const link = row.querySelector('a.btnDesativar');
                if (link) return { row, link, descricao, valor: cells[1].textContent.trim(), usuario };
            }
        }
        // Fallback: first available
        for (const row of rows) {
            const link = row.querySelector('a.btnDesativar');
            if (link) {
                const cells = row.querySelectorAll('td');
                return { row, link, descricao: cells[0]?.textContent.trim() || 'Unknown', valor: cells[1]?.textContent.trim() || 'Unknown', usuario: cells[4]?.textContent.trim() || 'Unknown' };
            }
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // AUTOMATION ENGINE
    // ═══════════════════════════════════════════════════════════════════════════
    const Automation = {
        parseInput(text) {
            return text
                .split(/\n/)
                .map(line => line.trim())
                .filter(line => line.length === 20)
                .map(d => `${d.slice(0,7)}-${d.slice(7,9)}.${d.slice(9,13)}.${d.slice(13,14)}.${d.slice(14,16)}.${d.slice(16,20)}`);
        },

        startBatch(caseNumbers) {
            const queue = {
                cases: caseNumbers,
                currentIndex: 0,
                currentStep: 'consultar',
                results: {},
                removedCount: 0,
                startedAt: Date.now()
            };
            Storage.saveQueue(queue);
            this.executeNext(queue);
        },

        stop() { Storage.clearQueue(); },

        resumeIfNeeded() {
            const queue = Storage.loadQueue();
            if (!queue) return false;
            if (!isInconsistenciasPage()) return false;

            const currentCase = queue.cases[queue.currentIndex];
            console.log('[Inconsistencias] Resuming...', { step: queue.currentStep, case: currentCase });

            if (queue.currentStep === 'consultar') {
                this.doConsultar(queue, currentCase);
            } else if (queue.currentStep === 'fixing') {
                this.checkAndFix(queue, currentCase);
            }
            return true;
        },

        doConsultar(queue, caseNumber) {
            const input = document.getElementById('NumProcesso');
            if (!input) { window.location.reload(); return; }

            input.value = caseNumber;
            input.dispatchEvent(new Event('input', { bubbles: true }));

            queue.currentStep = 'fixing';
            Storage.saveQueue(queue);

            setTimeout(() => {
                const button = document.querySelector('button.btn-primary');
                if (button && button.textContent.includes('Consultar')) {
                    if (window.eprocUpdateHUDStatus) window.eprocUpdateHUDStatus('🖱️ Consultando...');
                    button.click();
                    setTimeout(() => { this.checkAndFix(queue, caseNumber); }, 1000);
                } else {
                    window.location.reload();
                }
            }, CONFIG.ACTION_DELAY_MS);
        },

        waitForTableLoad(callback, attempt = 0) {
            if (window.eprocUpdateHUDStatus && attempt % 5 === 0) {
                window.eprocUpdateHUDStatus(`⏳ Aguardando tabela... (${attempt})`);
            }
            const processing = document.querySelector('.dataTables_processing');
            const isProcessing = processing && processing.style.display !== 'none';
            const headers  = document.querySelectorAll('.card-header');
            const rows     = document.querySelectorAll('table tbody tr');
            const isEmpty  = rows.length === 1 && rows[0].querySelector('.dataTables_empty');
            const isReady  = headers.length > 0 && !isProcessing && (rows.length > 0 || isEmpty);

            if (isReady) {
                setTimeout(callback, 200);
            } else {
                if (attempt > 40) { callback(); return; }
                setTimeout(() => { this.waitForTableLoad(callback, attempt + 1); }, 500);
            }
        },

        checkAndFix(queue, caseNumber) {
            this.waitForTableLoad(() => {
                const analysis = analyzeDuplicates();
                if (!queue.results[caseNumber]) {
                    queue.results[caseNumber] = { removed: 0, status: ResultType.PENDING };
                }
                const result = queue.results[caseNumber];
                const hasRedBanner = !analysis.allGreen;

                if (window.eprocUpdateHUDStatus) {
                    window.eprocUpdateHUDStatus(`🔍 Analisando: ${result.removed} removidos até agora...`);
                }

                if (analysis.hasDuplicates) {
                    for (const card of analysis.duplicateCards) {
                        const toRemove = findRowToRemove(card.rows);
                        if (toRemove) {
                            console.log('[Inconsistencias] Removing duplicate:', toRemove);
                            result.removed++;
                            queue.removedCount++;
                            if (window.eprocUpdateHUDStatus) {
                                window.eprocUpdateHUDStatus(`🗑️ Removendo: ${toRemove.descricao}...`);
                            }
                            toRemove.link.click();
                            setTimeout(() => { this.checkAndFix(queue, caseNumber); }, 1000);
                            return;
                        }
                    }
                    if (result.removed > 0) {
                        result.status  = ResultType.FIXED;
                        result.message = `${result.removed} duplicata(s) removida(s) (ainda restam duplicatas sem link)`;
                    } else {
                        result.status  = ResultType.ERROR;
                        result.message = 'Duplicatas encontradas, mas sem botão desativar disponível';
                    }
                    this.finalizeCase(queue, caseNumber, result);
                    return;
                }

                if (result.removed > 0) {
                    result.status  = ResultType.FIXED;
                    result.message = `${result.removed} duplicata(s) removida(s)`;
                } else if (hasRedBanner) {
                    result.status  = ResultType.ERROR;
                    result.message = 'Banner vermelho presente, mas não foi possível corrigir automaticamente';
                } else {
                    result.status  = ResultType.OK;
                    result.message = 'Sem duplicatas';
                }
                this.finalizeCase(queue, caseNumber, result);
            });
        },

        finalizeCase(queue, caseNumber, result) {
            console.log('[Inconsistencias] Finalizing case:', caseNumber, result);
            if (window.eprocUpdateHUDStatus) window.eprocUpdateHUDStatus(`✅ Finalizado: ${result.status}`);

            Storage.addEntry({
                caseNumber,
                timestamp: Date.now(),
                status:    result.status,
                message:   result.message,
                removed:   result.removed || 0
            });

            queue.currentIndex++;
            queue.currentStep = 'consultar';
            Storage.saveQueue(queue);

            if (queue.currentIndex >= queue.cases.length) {
                Storage.clearQueue();
                console.log('[Inconsistencias] Batch complete!');
                if (window.eprocUpdateHUDStatus) window.eprocUpdateHUDStatus(`🎉 Lote finalizado! Total: ${queue.cases.length}`);
                if (window.eprocRefreshHUD) window.eprocRefreshHUD();
                clickVoltar();
                return;
            }
            clickVoltar();
        },

        executeNext(queue) {
            if (window.eprocRefreshHUD) window.eprocRefreshHUD();
            if (queue.currentStep === 'consultar') {
                this.doConsultar(queue, queue.cases[queue.currentIndex]);
            } else {
                this.checkAndFix(queue, queue.cases[queue.currentIndex]);
            }
        },

        getProgress() {
            const queue = Storage.loadQueue();
            if (!queue) return null;
            return {
                current:     queue.currentIndex + 1,
                total:       queue.cases.length,
                currentCase: queue.cases[queue.currentIndex],
                step:        queue.currentStep,
                removed:     queue.removedCount
            };
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // HUD COMPONENT — usa Bootstrap nativo do eProc
    // ═══════════════════════════════════════════════════════════════════════════
    function injetarEstilosHUD() {
        if (document.getElementById('eproc-incons-styles')) return;
        const s = document.createElement('style');
        s.id = 'eproc-incons-styles';
        s.textContent = `
            #eproc-incons-hud { margin-bottom: 16px; }
            #eproc-incons-hud .incons-card-header {
                background: #0887b2;
                color: #fff;
                padding: 6px 12px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-radius: 4px 4px 0 0;
                font-weight: bold;
                font-size: 13px;
            }
            #eproc-incons-hud .incons-section-label {
                display: block;
                font-size: 11px;
                font-weight: bold;
                text-transform: uppercase;
                color: #0887b2;
                margin-bottom: 4px;
            }
            #eproc-incons-body.collapsed { display: none !important; }
            #eproc-incons-log {
                height: 100px;
                overflow-y: auto;
                font-size: 11px;
            }
            #eproc-incons-hud .incons-log-entry {
                padding: 2px 0;
                border-bottom: 1px solid #f0f0f0;
                display: flex;
                gap: 6px;
                align-items: baseline;
                font-size: 11px;
            }
            #eproc-incons-hud .incons-log-entry:last-child { border-bottom: none; }
            #eproc-incons-hud .incons-log-entry.error .incons-entry-details { color: #a94442; }
            #eproc-incons-hud .incons-entry-time    { color: #999; white-space: nowrap; }
            #eproc-incons-hud .incons-entry-case    { font-family: Consolas, monospace; font-weight: bold; color: #222; white-space: nowrap; }
            #eproc-incons-hud .incons-entry-details { color: #555; flex: 1; }
            #eproc-incons-hud .incons-log-empty     { color: #bbb; font-size: 11px; text-align: center; padding: 28px 0; }
            #eproc-incons-count { font-size: 10px; color: #888; text-align: right; margin-top: 2px; }
            #eproc-incons-hud .processing-indicator { animation: incons-pulse 1.5s infinite; }
            @keyframes incons-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    function createHUD() {
        injetarEstilosHUD();

        const wrapper = document.createElement('div');
        wrapper.id = 'eproc-incons-hud';
        wrapper.innerHTML = `
            <div class="card" style="border-color:#CBD6E5">
                <div class="incons-card-header">
                    <span>Inconsistências — Correção em Lote</span>
                    <button id="incons-toggle" class="btn btn-sm" style="color:white;border:1px solid rgba(255,255,255,0.5);padding:1px 7px;line-height:1.4">−</button>
                </div>
                <div class="card-body p-2" id="incons-body">
                    <div class="row mb-2">
                        <div class="col-6">
                            <span class="incons-section-label">Processos</span>
                            <textarea id="incons-input"
                                class="form-control form-control-sm"
                                rows="5"
                                placeholder="Cole números de processo aqui (um por linha)&#10;&#10;Ex:&#10;0000268-76.2025.8.26.0358"
                                style="font-family:Consolas,monospace;resize:vertical"></textarea>
                        </div>
                        <div class="col-6">
                            <div class="d-flex justify-content-between align-items-center mb-1">
                                <span class="incons-section-label mb-0">Histórico</span>
                                <div>
                                    <button id="incons-export" class="btn btn-sm btn-outline-secondary mr-1">↓ Exportar</button>
                                    <button id="incons-clear"  class="btn btn-sm btn-outline-secondary">🗑 Limpar</button>
                                </div>
                            </div>
                            <div id="eproc-incons-log" class="border rounded p-1 bg-white">
                                <div class="incons-log-empty">Nenhum registro ainda</div>
                            </div>
                            <div id="eproc-incons-count"></div>
                        </div>
                    </div>
                    <div class="mb-2">
                        <button id="incons-start" class="btn btn-sm btn-primary mr-2">▶ Iniciar</button>
                        <button id="incons-stop"  class="btn btn-sm btn-danger" disabled>■ Parar</button>
                    </div>
                    <div id="incons-status" class="alert alert-info p-2 mb-0" style="font-size:12px">
                        ℹ Aguardando entrada...
                    </div>
                </div>
            </div>
        `;

        const container = document.querySelector('#divInfraAreaTelaD')
            || document.querySelector('#divInfraConteudoForm')
            || document.querySelector('#divInfraConteudo')
            || document.querySelector('.infraAreaTelaD')
            || document.body;
        container.insertBefore(wrapper, container.firstChild);

        // Elementos
        const toggle    = wrapper.querySelector('#incons-toggle');
        const body      = wrapper.querySelector('#incons-body');
        const input     = wrapper.querySelector('#incons-input');
        const startBtn  = wrapper.querySelector('#incons-start');
        const stopBtn   = wrapper.querySelector('#incons-stop');
        const status    = wrapper.querySelector('#incons-status');
        const log       = wrapper.querySelector('#eproc-incons-log');
        const exportBtn = wrapper.querySelector('#incons-export');
        const clearBtn  = wrapper.querySelector('#incons-clear');
        const countDiv  = wrapper.querySelector('#eproc-incons-count');

        // Expõe callbacks globais para o engine
        window.eprocUpdateHUDStatus = (text) => { status.innerHTML = text; };
        window.eprocRefreshHUD = updateUI;

        // Toggle collapse
        toggle.addEventListener('click', () => {
            body.classList.toggle('collapsed');
            toggle.textContent = body.classList.contains('collapsed') ? '+' : '−';
        });

        // Filtro de input: apenas dígitos e quebras de linha
        input.addEventListener('input', () => {
            const pos    = input.selectionStart;
            const before = input.value.length;
            input.value  = input.value.replace(/[^\d\n]/g, '');
            const after  = input.value.length;
            input.selectionStart = input.selectionEnd = pos - (before - after);
        });

        // Renderiza log
        function renderLog() {
            const entries = Storage.cleanup();
            if (entries.length === 0) {
                log.innerHTML = '<div class="incons-log-empty">Nenhum registro ainda</div>';
                countDiv.textContent = '';
                return;
            }
            log.innerHTML = '';
            entries.slice(0, 50).forEach(entry => {
                const div  = document.createElement('div');
                div.className = `incons-log-entry ${entry.status}`;
                const date = new Date(entry.timestamp);
                const timeStr = date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
                div.innerHTML = `
                    <span class="incons-entry-time">${timeStr}</span>
                    <span class="incons-entry-case">${entry.caseNumber}</span>
                    <span class="incons-entry-details">${entry.message}</span>
                `;
                log.appendChild(div);
            });
            countDiv.textContent = `${entries.length} registro(s) nos últimos 7 dias`;
        }

        // Atualiza UI conforme estado da fila
        function updateUI() {
            const progress = Automation.getProgress();
            if (progress) {
                startBtn.disabled = true;
                stopBtn.disabled  = false;
                input.disabled    = true;
                const utils = typeof EprocUtils !== 'undefined' ? EprocUtils : null;
                const barHTML = utils
                    ? utils.progressBarHTML(progress.current, progress.total)
                    : `<span style="font-size:11px;color:#666">${progress.current}/${progress.total}</span>`;
                status.innerHTML =
                    `<span class="processing-indicator">⏳ Processando ${progress.current}/${progress.total}</span> ` +
                    barHTML +
                    `<br><strong>${progress.currentCase}</strong> — ` +
                    `Removidas: ${progress.removed} | Etapa: ${progress.step}`;
            } else {
                startBtn.disabled = false;
                stopBtn.disabled  = true;
                input.disabled    = false;
            }
        }

        // Iniciar
        startBtn.addEventListener('click', () => {
            const cases = Automation.parseInput(input.value);
            if (cases.length === 0) {
                status.textContent = '⚠️ Nenhum número válido encontrado';
                return;
            }
            status.textContent = `🚀 Iniciando ${cases.length} processo(s)...`;
            Automation.startBatch(cases);
        });

        // Parar
        stopBtn.addEventListener('click', () => {
            Automation.stop();
            startBtn.disabled = false;
            stopBtn.disabled  = true;
            input.disabled    = false;
            status.textContent = '⏹️ Interrompido pelo usuário';
        });

        // Exportar CSV
        exportBtn.addEventListener('click', () => {
            const entries = Storage.loadLog();
            if (entries.length === 0) { alert('Nenhum registro para exportar'); return; }

            const utils   = typeof EprocUtils !== 'undefined' ? EprocUtils : null;
            const dateTag = new Date().toISOString().slice(0, 10);
            const csvRows = [
                ['Processo', 'Data', 'Status', 'Mensagem', 'Removidas'],
                ...entries.map(e => [
                    e.caseNumber,
                    new Date(e.timestamp).toLocaleString('pt-BR'),
                    { success: 'CORRIGIDO', info: 'SEM DUPLICATAS', error: 'ERRO' }[e.status] || e.status,
                    e.message,
                    e.removed || 0
                ])
            ];
            if (utils) {
                utils.downloadCSV(csvRows, `inconsistencias_${dateTag}.csv`);
            } else {
                const escape  = cell => `"${String(cell).replace(/"/g, '""')}"`;
                const content = csvRows.map(r => r.map(escape).join(',')).join('\r\n');
                const blob    = new Blob([content], { type: 'text/csv;charset=utf-8' });
                const url     = URL.createObjectURL(blob);
                const a       = document.createElement('a');
                a.href = url; a.download = `inconsistencias_${dateTag}.csv`; a.click();
                URL.revokeObjectURL(url);
            }
        });

        // Limpar log
        clearBtn.addEventListener('click', () => {
            if (confirm('Limpar todos os registros?')) {
                Storage.clearLog();
                renderLog();
                status.textContent = '🗑️ Log limpo';
            }
        });

        renderLog();
        updateUI();

        return { renderLog, updateUI, status };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════════
    function init() {
        const resumed = Automation.resumeIfNeeded();

        if (isInconsistenciasPage()) {
            const hudControls = createHUD();
            hudControls.renderLog();
            hudControls.updateUI();
            console.log('[eProc Inconsistencias] HUD initialized, queue active:', resumed);
        } else {
            console.log('[eProc Inconsistencias] Not on relevant page');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
