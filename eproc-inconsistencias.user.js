// ==UserScript==
// @name         eProc Inconsistências Automation
// @namespace    eproc-tjsp
// @version      1.0
// @description  Bulk automation for "Inconsistências do Processo" - removes duplicate entries
// @author       Helpdesk Automation
// @match        https://eproc1g.tjsp.jus.br/eproc/controlador.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
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
        INCONSISTENCIAS_URL: 'https://eproc1g.tjsp.jus.br/eproc/controlador.php?acao=ProcessoInconsistente/consultar'
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
        const acao = params.get('acao');
        return acao === 'ProcessoInconsistente/consultar';
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STORAGE MODULE
    // ═══════════════════════════════════════════════════════════════════════════
    const Storage = {
        loadLog() {
            try {
                const data = GM_getValue(CONFIG.STORAGE_KEY, '[]');
                return JSON.parse(data);
            } catch (e) {
                console.error('Failed to load log:', e);
                return [];
            }
        },

        saveLog(entries) {
            GM_setValue(CONFIG.STORAGE_KEY, JSON.stringify(entries));
        },

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
            if (filtered.length !== entries.length) {
                this.saveLog(filtered);
            }
            return filtered;
        },

        clearLog() {
            this.saveLog([]);
        },

        loadQueue() {
            try {
                const data = GM_getValue(CONFIG.QUEUE_KEY, 'null');
                return JSON.parse(data);
            } catch (e) {
                return null;
            }
        },

        saveQueue(queue) {
            GM_setValue(CONFIG.QUEUE_KEY, JSON.stringify(queue));
        },

        clearQueue() {
            GM_setValue(CONFIG.QUEUE_KEY, 'null');
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // RESULT TYPES
    // ═══════════════════════════════════════════════════════════════════════════
    const ResultType = {
        FIXED: 'success',      // Green - duplicates removed
        OK: 'info',            // Blue - no duplicates found
        ERROR: 'error',        // Red - case not found or error
        PENDING: 'pending'     // Still processing
    };

    // Helper: Click the Voltar button (uses the button's built-in onclick which has the correct URL with hash)
    function clickVoltar() {
        const btn = document.querySelector('button.btn-secondary');
        if (btn && btn.textContent.includes('Voltar')) {
            btn.click();
        } else {
            // Fallback: reload page
            window.location.reload();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DUPLICATE DETECTOR
    // ═══════════════════════════════════════════════════════════════════════════
    function analyzeDuplicates() {
        const results = {
            hasDuplicates: false,
            duplicateCards: [],
            allGreen: true
        };

        // Find all card headers
        const cardHeaders = document.querySelectorAll('.card-header');

        cardHeaders.forEach(header => {
            const title = header.textContent.trim();

            // Check if this is a duplicate info card
            if (title === 'Informações Adicionais Duplicadas') {
                const isDanger = header.classList.contains('bg-danger');
                const isSuccess = header.classList.contains('bg-success');

                if (isDanger) {
                    results.allGreen = false;

                    // Find the associated table
                    const cardBody = header.nextElementSibling;
                    if (cardBody) {
                        const table = cardBody.querySelector('table');
                        if (table) {
                            const rows = table.querySelectorAll('tbody tr:not(.odd):not(.even)').length === 0
                                ? table.querySelectorAll('tbody tr')
                                : table.querySelectorAll('tbody tr');

                            // Check if there are actual data rows (not "Nenhum registro")
                            const dataRows = Array.from(rows).filter(row =>
                                !row.querySelector('.dataTables_empty')
                            );

                            if (dataRows.length > 1) {
                                results.hasDuplicates = true;
                                results.duplicateCards.push({
                                    header: header,
                                    table: table,
                                    rows: dataRows
                                });
                            }
                        }
                    }
                }
            }
        });

        return results;
    }

    function findRowToRemove(rows) {
        // Priority: Remove "Requerida" entries first, keep "Deferida" or system entries
        // Also prefer removing user entries over "SISTEMA DE PROCESSO ELETRÔNICO"

        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 5) continue;

            const descricao = cells[0].textContent.trim();
            const valor = cells[1].textContent.trim();
            const usuario = cells[4].textContent.trim();

            // Check if this is a known duplicate type
            if (!DUPLICATE_TYPES.includes(descricao)) continue;

            // Prefer removing "Requerida" over "Deferida"
            if (valor === 'Requerida') {
                const desativarLink = row.querySelector('a.btnDesativar');
                if (desativarLink) {
                    return {
                        row: row,
                        link: desativarLink,
                        descricao: descricao,
                        valor: valor,
                        usuario: usuario
                    };
                }
            }
        }

        // If no "Requerida" found, look for user entries (not SISTEMA)
        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 5) continue;

            const descricao = cells[0].textContent.trim();
            const usuario = cells[4].textContent.trim();

            if (!DUPLICATE_TYPES.includes(descricao)) continue;

            // Remove user entry, keep system entry
            if (!usuario.includes('SISTEMA DE PROCESSO ELETRÔNICO')) {
                const desativarLink = row.querySelector('a.btnDesativar');
                if (desativarLink) {
                    return {
                        row: row,
                        link: desativarLink,
                        descricao: descricao,
                        valor: cells[1].textContent.trim(),
                        usuario: usuario
                    };
                }
            }
        }

        // Last resort: just remove the first one with a desativar link
        for (const row of rows) {
            const desativarLink = row.querySelector('a.btnDesativar');
            if (desativarLink) {
                const cells = row.querySelectorAll('td');
                return {
                    row: row,
                    link: desativarLink,
                    descricao: cells[0]?.textContent.trim() || 'Unknown',
                    valor: cells[1]?.textContent.trim() || 'Unknown',
                    usuario: cells[4]?.textContent.trim() || 'Unknown'
                };
            }
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // AUTOMATION ENGINE
    // ═══════════════════════════════════════════════════════════════════════════
    const Automation = {
        parseInput(text) {
            // Input is already filtered to digits + newlines
            // Split by newlines, take 20-digit lines, format them
            return text
                .split(/\n/)
                .map(line => line.trim())
                .filter(line => line.length === 20)
                .map(d => `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16, 20)}`);
        },

        startBatch(caseNumbers) {
            const queue = {
                cases: caseNumbers,
                currentIndex: 0,
                currentStep: 'consultar', // 'consultar', 'fixing', 'done'
                results: {},
                removedCount: 0,
                startedAt: Date.now()
            };
            Storage.saveQueue(queue);
            this.executeNext(queue);
        },

        stop() {
            Storage.clearQueue();
        },

        resumeIfNeeded() {
            const queue = Storage.loadQueue();
            if (!queue) return false;

            // Only process on the inconsistencias page
            if (!isInconsistenciasPage()) {
                console.log('[Inconsistencias] Not on inconsistencias page, ignoring');
                return false;
            }

            const currentCase = queue.cases[queue.currentIndex];
            console.log('[Inconsistencias] Resuming...', {
                step: queue.currentStep,
                case: currentCase
            });

            // Execute based on current step
            if (queue.currentStep === 'consultar') {
                this.doConsultar(queue, currentCase);
            } else if (queue.currentStep === 'fixing') {
                this.checkAndFix(queue, currentCase);
            }
            return true;
        },

        doConsultar(queue, caseNumber) {
            const input = document.getElementById('NumProcesso');
            if (!input) {
                console.error('[Inconsistencias] Input not found, reloading...');
                window.location.reload();
                return;
            }

            input.value = caseNumber;
            input.dispatchEvent(new Event('input', { bubbles: true }));

            queue.currentStep = 'fixing';
            Storage.saveQueue(queue);

            setTimeout(() => {
                const button = document.querySelector('button.btn-primary');
                if (button && button.textContent.includes('Consultar')) {
                    console.log('[Inconsistencias] Clicking Consultar for:', caseNumber);
                    if (window.eprocUpdateHUDStatus) window.eprocUpdateHUDStatus('🖱️ Consultando...');

                    button.click();

                    // If the page reloads (submit), this timeout dies. 
                    // If it's AJAX, we transition to fixing after a short delay to allow 'processing' to appear
                    setTimeout(() => {
                        this.checkAndFix(queue, caseNumber);
                    }, 1000);

                } else {
                    console.error('[Inconsistencias] Button not found, reloading...');
                    window.location.reload();
                }
            }, CONFIG.ACTION_DELAY_MS);
        },

        waitForTableLoad(callback, attempt = 0) {
            // Update HUD status lightly if possible
            if (window.eprocUpdateHUDStatus && attempt % 5 === 0) {
                window.eprocUpdateHUDStatus(`⏳ Aguardando tabela... (${attempt})`);
            }

            // check for processing indicator
            const processing = document.querySelector('.dataTables_processing');
            const isProcessing = processing && processing.style.display !== 'none';

            // check for headers (basic page structure)
            const headers = document.querySelectorAll('.card-header');
            const hasHeaders = headers.length > 0;

            // check for rows
            const rows = document.querySelectorAll('table tbody tr');
            const hasRows = rows.length > 0;
            const isEmpty = rows.length === 1 && rows[0].querySelector('.dataTables_empty');

            // Ready if: Has headers, NOT processing, and (Has valid rows OR Is explicitly empty)
            const isReady = hasHeaders && !isProcessing && (hasRows || isEmpty);

            if (isReady) {
                // Stabilize: wait one more tick to ensure rendering is done
                setTimeout(callback, 200);
            } else {
                if (attempt > 40) { // ~20 seconds timeout (40 * 500ms)
                    console.log('[Inconsistencias] Table wait timeout');
                    callback(); // Proceed anyway, might fail but avoids infinite hang
                    return;
                }

                setTimeout(() => {
                    this.waitForTableLoad(callback, attempt + 1);
                }, 500);
            }
        },

        checkAndFix(queue, caseNumber) {
            // Wait for table to load/stabilize first
            this.waitForTableLoad(() => {
                const analysis = analyzeDuplicates();

                // Preserve the removed count from previous iterations
                if (!queue.results[caseNumber]) {
                    queue.results[caseNumber] = { removed: 0, status: ResultType.PENDING };
                }
                const result = queue.results[caseNumber];

                // Check if there's a red banner indicating duplicates exist
                const hasRedBanner = !analysis.allGreen;

                // Update HUD with progress
                if (window.eprocUpdateHUDStatus) {
                    window.eprocUpdateHUDStatus(`🔍 Analisando: ${result.removed} removidos até agora...`);
                }

                if (analysis.hasDuplicates) {
                    // Find and click a desativar link
                    for (const card of analysis.duplicateCards) {
                        const toRemove = findRowToRemove(card.rows);
                        if (toRemove) {
                            console.log('[Inconsistencias] Removing duplicate:', toRemove);
                            result.removed++;
                            queue.removedCount++;
                            // Don't save entire queue to storage on every click to save I/O, unless critical

                            // Update HUD
                            if (window.eprocUpdateHUDStatus) {
                                window.eprocUpdateHUDStatus(`🗑️ Removendo: ${toRemove.descricao}...`);
                            }

                            // Click the desativar link (AJAX - no page reload)
                            toRemove.link.click();

                            // AJAX Handling: The table enters "processing" state.
                            // We recurse into checkAndFix, which will start with waitForTableLoad.
                            // Small delay to allow click to trigger processing state.
                            setTimeout(() => {
                                this.checkAndFix(queue, caseNumber);
                            }, 1000);
                            return;
                        }
                    }

                    // Duplicates detected but no desativar link found - can't fix automatically
                    console.log('[Inconsistencias] Duplicates found but no desativar link available');
                    if (result.removed > 0) {
                        result.status = ResultType.FIXED;
                        result.message = `${result.removed} duplicata(s) removida(s) (ainda restam duplicatas sem link)`;
                    } else {
                        result.status = ResultType.ERROR;
                        result.message = 'Duplicatas encontradas, mas sem botão desativar disponível';
                    }
                    this.finalizeCase(queue, caseNumber, result);
                    return;
                }

                // No more duplicates to remove - finalize this case
                if (result.removed > 0) {
                    result.status = ResultType.FIXED;
                    result.message = `${result.removed} duplicata(s) removida(s)`;
                } else if (hasRedBanner) {
                    result.status = ResultType.ERROR;
                    result.message = 'Banner vermelho presente, mas não foi possível corrigir automaticamente';
                } else {
                    result.status = ResultType.OK;
                    result.message = 'Sem duplicatas';
                }

                this.finalizeCase(queue, caseNumber, result);

            }); // end waitForTableLoad callback
        },

        finalizeCase(queue, caseNumber, result) {
            // Log this case
            console.log('[Inconsistencias] Finalizing case:', caseNumber, result);

            // Update HUD
            if (window.eprocUpdateHUDStatus) {
                window.eprocUpdateHUDStatus(`✅ Finalizado: ${result.status}`);
            }

            Storage.addEntry({
                caseNumber: caseNumber,
                timestamp: Date.now(),
                status: result.status,
                message: result.message,
                removed: result.removed || 0
            });

            // Move to next case
            queue.currentIndex++;
            queue.currentStep = 'consultar';

            // IMPORTANT: Save queue state now so if we reload we pick up correctly
            Storage.saveQueue(queue);

            if (queue.currentIndex >= queue.cases.length) {
                // All done!
                Storage.clearQueue();
                console.log('[Inconsistencias] Batch complete!');
                if (window.eprocUpdateHUDStatus) {
                    window.eprocUpdateHUDStatus(`🎉 Lote finalizado! Total processado: ${queue.cases.length}`);
                }
                // Force UI update to show "Finish" state (enable start button etc)
                // We need to trigger the UI update in the HUD
                if (window.eprocRefreshHUD) window.eprocRefreshHUD();

                // Click Voltar one last time to reset state
                console.log('[Inconsistencias] Batch done, resetting state with Voltar...');
                clickVoltar();
                return;
            }


            // Click Voltar for next case
            console.log('[Inconsistencias] Case done, clicking Voltar for next case...');
            clickVoltar();
        },

        executeNext(queue) {
            const currentCase = queue.cases[queue.currentIndex];
            // Also refresh HUD on start of next execution
            if (window.eprocRefreshHUD) window.eprocRefreshHUD();

            if (queue.currentStep === 'consultar') {
                this.doConsultar(queue, currentCase);
            } else {
                this.checkAndFix(queue, currentCase);
            }
        },

        getProgress() {
            const queue = Storage.loadQueue();
            if (!queue) return null;
            return {
                current: queue.currentIndex + 1,
                total: queue.cases.length,
                currentCase: queue.cases[queue.currentIndex],
                step: queue.currentStep,
                removed: queue.removedCount
            };
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // HUD COMPONENT
    // ═══════════════════════════════════════════════════════════════════════════
    function createHUD() {
        const hud = document.createElement('div');
        hud.id = 'inconsistencias-hud';
        hud.innerHTML = `
            <style>
                #inconsistencias-hud {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    width: 380px;
                    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                    border: 1px solid #4a5568;
                    border-radius: 12px;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.4);
                    font-family: 'Segoe UI', Tahoma, sans-serif;
                    font-size: 13px;
                    color: #e2e8f0;
                    z-index: 99999;
                    overflow: hidden;
                }
                #inconsistencias-hud-header {
                    background: linear-gradient(90deg, #f093fb 0%, #f5576c 100%);
                    padding: 12px 15px;
                    font-weight: 600;
                    font-size: 14px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    cursor: move;
                }
                #inconsistencias-hud-header span {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                #inconsistencias-hud-toggle {
                    background: rgba(255,255,255,0.2);
                    border: none;
                    color: white;
                    width: 24px;
                    height: 24px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 14px;
                }
                #inconsistencias-hud-body {
                    padding: 15px;
                }
                #inconsistencias-hud-body.collapsed {
                    display: none;
                }
                #inconsistencias-input {
                    width: 100%;
                    height: 80px;
                    background: #2d3748;
                    border: 1px solid #4a5568;
                    border-radius: 6px;
                    color: #e2e8f0;
                    padding: 10px;
                    font-family: 'Consolas', monospace;
                    font-size: 12px;
                    resize: vertical;
                    box-sizing: border-box;
                }
                #inconsistencias-input:focus {
                    outline: none;
                    border-color: #f5576c;
                }
                #inconsistencias-input::placeholder {
                    color: #718096;
                }
                #inconsistencias-controls {
                    display: flex;
                    gap: 8px;
                    margin-top: 10px;
                }
                .incons-btn {
                    flex: 1;
                    padding: 10px;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-weight: 600;
                    font-size: 13px;
                    transition: all 0.2s;
                }
                .incons-btn:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                .incons-btn-primary {
                    background: linear-gradient(90deg, #48bb78 0%, #38a169 100%);
                    color: white;
                }
                .incons-btn-primary:hover:not(:disabled) {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px rgba(72, 187, 120, 0.4);
                }
                .incons-btn-danger {
                    background: linear-gradient(90deg, #f56565 0%, #e53e3e 100%);
                    color: white;
                }
                .incons-btn-secondary {
                    background: #4a5568;
                    color: white;
                }
                #inconsistencias-status {
                    margin-top: 12px;
                    padding: 10px;
                    background: #2d3748;
                    border-radius: 6px;
                    text-align: center;
                    font-size: 12px;
                }
                #inconsistencias-log {
                    margin-top: 12px;
                    max-height: 200px;
                    overflow-y: auto;
                    background: #0d1117;
                    border-radius: 6px;
                    padding: 8px;
                }
                .incons-log-entry {
                    padding: 8px 10px;
                    margin-bottom: 6px;
                    border-radius: 4px;
                    font-size: 11px;
                    border-left: 3px solid;
                }
                .incons-log-entry:last-child {
                    margin-bottom: 0;
                }
                .incons-log-entry.success {
                    background: rgba(72, 187, 120, 0.15);
                    border-color: #48bb78;
                }
                .incons-log-entry.info {
                    background: rgba(66, 153, 225, 0.15);
                    border-color: #4299e1;
                }
                .incons-log-entry.error {
                    background: rgba(245, 101, 101, 0.15);
                    border-color: #f56565;
                }
                .incons-log-entry-header {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 4px;
                }
                .incons-log-entry-case {
                    font-family: 'Consolas', monospace;
                    font-weight: 600;
                }
                .incons-log-entry-time {
                    color: #718096;
                    font-size: 10px;
                }
                .incons-log-entry-details {
                    color: #a0aec0;
                }
                #inconsistencias-footer {
                    display: flex;
                    gap: 8px;
                    margin-top: 12px;
                    padding-top: 12px;
                    border-top: 1px solid #4a5568;
                }
                #inconsistencias-count {
                    color: #718096;
                    font-size: 11px;
                    margin-top: 8px;
                }
                .processing-indicator {
                    animation: pulse 1.5s infinite;
                }
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }
            </style>
            <div id="inconsistencias-hud-header">
                <span>🔧 Inconsistências Bulk</span>
                <button id="inconsistencias-hud-toggle">−</button>
            </div>
            <div id="inconsistencias-hud-body">
                <textarea id="inconsistencias-input" placeholder="Cole números de processo aqui (um por linha)&#10;Ex: 0000268-76.2025.8.26.0358"></textarea>
                <div id="inconsistencias-controls">
                    <button id="inconsistencias-start" class="incons-btn incons-btn-primary">▶ Iniciar</button>
                    <button id="inconsistencias-stop" class="incons-btn incons-btn-danger" disabled>⏹ Parar</button>
                </div>
                <div id="inconsistencias-status">Aguardando entrada...</div>
                <div id="inconsistencias-log"></div>
                <div id="inconsistencias-footer">
                    <button id="inconsistencias-export" class="incons-btn incons-btn-secondary">📥 Exportar Log</button>
                    <button id="inconsistencias-clear" class="incons-btn incons-btn-secondary">🗑️ Limpar</button>
                </div>
                <div id="inconsistencias-count"></div>
            </div>
        `;



        document.body.appendChild(hud);

        // Elements
        const toggle = hud.querySelector('#inconsistencias-hud-toggle');
        const body = hud.querySelector('#inconsistencias-hud-body');
        const input = hud.querySelector('#inconsistencias-input');
        const startBtn = hud.querySelector('#inconsistencias-start');
        const stopBtn = hud.querySelector('#inconsistencias-stop');
        const status = hud.querySelector('#inconsistencias-status');
        const log = hud.querySelector('#inconsistencias-log');
        const exportBtn = hud.querySelector('#inconsistencias-export');
        const clearBtn = hud.querySelector('#inconsistencias-clear');
        const countDiv = hud.querySelector('#inconsistencias-count');

        // Expose updateStatus globally for generic access if needed
        window.eprocUpdateHUDStatus = (text) => {
            status.innerHTML = text;
        };
        window.eprocRefreshHUD = updateUI;

        // Toggle collapse
        toggle.addEventListener('click', () => {
            body.classList.toggle('collapsed');
            toggle.textContent = body.classList.contains('collapsed') ? '+' : '−';
        });

        // Filter input: only digits and newlines allowed
        input.addEventListener('input', () => {
            const pos = input.selectionStart;
            const before = input.value.length;
            input.value = input.value.replace(/[^\d\n]/g, '');
            const after = input.value.length;
            input.selectionStart = input.selectionEnd = pos - (before - after);
        });

        // Render log
        function renderLog() {
            const entries = Storage.cleanup();
            log.innerHTML = '';

            entries.slice(0, 50).forEach(entry => {
                const div = document.createElement('div');
                div.className = `incons-log-entry ${entry.status}`;

                const date = new Date(entry.timestamp);
                const timeStr = date.toLocaleString('pt-BR', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                });

                div.innerHTML = `
                    <div class="incons-log-entry-header">
                        <span class="incons-log-entry-case">${entry.caseNumber}</span>
                        <span class="incons-log-entry-time">${timeStr}</span>
                    </div>
                    <div class="incons-log-entry-details">${entry.message}</div>
                `;
                log.appendChild(div);
            });

            countDiv.textContent = `${entries.length} registro(s) nos últimos 7 dias`;
        }

        // Update UI based on queue state
        function updateUI() {
            const progress = Automation.getProgress();
            if (progress) {
                startBtn.disabled = true;
                stopBtn.disabled = false;
                input.disabled = true;
                status.innerHTML = `<span class="processing-indicator">⏳ Processando ${progress.current}/${progress.total}</span><br>` +
                    `<strong>${progress.currentCase}</strong><br>` +
                    `Removidas: ${progress.removed} | Etapa: ${progress.step}`;
            } else {
                startBtn.disabled = false;
                stopBtn.disabled = true;
                input.disabled = false;
            }
        }

        // Start automation
        startBtn.addEventListener('click', () => {
            const cases = Automation.parseInput(input.value);
            if (cases.length === 0) {
                status.textContent = '⚠️ Nenhum número válido encontrado';
                return;
            }

            status.textContent = `🚀 Iniciando ${cases.length} processo(s)...`;
            Automation.startBatch(cases);
        });

        // Stop automation
        stopBtn.addEventListener('click', () => {
            Automation.stop();
            startBtn.disabled = false;
            stopBtn.disabled = true;
            input.disabled = false;
            status.textContent = '⏹️ Interrompido pelo usuário';
        });

        // Export log
        exportBtn.addEventListener('click', () => {
            const entries = Storage.loadLog();
            if (entries.length === 0) {
                alert('Nenhum registro para exportar');
                return;
            }

            let text = '═══════════════════════════════════════════════════════════════\n';
            text += '           RELATÓRIO DE INCONSISTÊNCIAS - eProc TJSP\n';
            text += `           Gerado em: ${new Date().toLocaleString('pt-BR')}\n`;
            text += '═══════════════════════════════════════════════════════════════\n\n';

            entries.forEach(entry => {
                const date = new Date(entry.timestamp).toLocaleString('pt-BR');
                const statusLabel = {
                    success: '✅ CORRIGIDO',
                    info: 'ℹ️ SEM DUPLICATAS',
                    error: '❌ ERRO'
                }[entry.status] || entry.status;

                text += `📋 ${entry.caseNumber}\n`;
                text += `   Data: ${date}\n`;
                text += `   Status: ${statusLabel}\n`;
                text += `   ${entry.message}\n`;
                if (entry.removed > 0) {
                    text += `   Removidas: ${entry.removed}\n`;
                }
                text += '───────────────────────────────────────────────────────────────\n';
            });

            text += `\nTotal: ${entries.length} processo(s)\n`;

            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `inconsistencias_log_${new Date().toISOString().slice(0, 10)}.txt`;
            a.click();
            URL.revokeObjectURL(url);
        });

        // Clear log
        clearBtn.addEventListener('click', () => {
            if (confirm('Limpar todos os registros?')) {
                Storage.clearLog();
                renderLog();
                status.textContent = '🗑️ Log limpo';
            }
        });

        // Initial render
        renderLog();
        updateUI();

        // Make draggable
        let isDragging = false;
        let offsetX, offsetY;
        const header = hud.querySelector('#inconsistencias-hud-header');

        header.addEventListener('mousedown', (e) => {
            if (e.target === toggle) return;
            isDragging = true;
            offsetX = e.clientX - hud.offsetLeft;
            offsetY = e.clientY - hud.offsetTop;
            hud.style.transition = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            hud.style.left = (e.clientX - offsetX) + 'px';
            hud.style.top = (e.clientY - offsetY) + 'px';
            hud.style.right = 'auto';
            hud.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });

        return { renderLog, updateUI, status };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INITIALIZATION (wait for DOM since we run at document-start)
    // ═══════════════════════════════════════════════════════════════════════════
    function init() {
        // FIRST: Check if we need to resume - this may redirect
        const resumed = Automation.resumeIfNeeded();

        // Only show HUD on the inconsistencias page
        if (isInconsistenciasPage()) {
            const hudControls = createHUD();
            hudControls.renderLog();
            hudControls.updateUI();
            console.log('[eProc Inconsistencias] HUD initialized, queue active:', resumed);
        } else if (isDesativarResultPage()) {
            console.log('[eProc Inconsistencias] On desativar result page, redirecting...');
        } else {
            console.log('[eProc Inconsistencias] Not on relevant page');
        }
    }

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
