import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const UUID = 'ccusage-panel@raphael.local';
const REFRESH_SECONDS = 5 * 60;
const COMMAND_TIMEOUT_SECONDS = 15;

const COST_KEYS = ['cost', 'totalCost', 'total_cost', 'costUSD', 'cost_usd', 'totalCostUSD', 'total_cost_usd'];
const INPUT_KEYS = ['inputTokens', 'input_tokens'];
const OUTPUT_KEYS = ['outputTokens', 'output_tokens'];
const CACHE_CREATION_KEYS = ['cacheCreationTokens', 'cache_creation_tokens', 'cacheWriteTokens', 'cache_write_tokens'];
const CACHE_READ_KEYS = ['cacheReadTokens', 'cache_read_tokens'];

function normalizeKey(key) {
    return key.replaceAll('_', '').toLowerCase();
}

function directNumber(object, aliases) {
    const wanted = new Set(aliases.map(normalizeKey));

    for (const [key, value] of Object.entries(object)) {
        if (!wanted.has(normalizeKey(key)))
            continue;

        if (typeof value === 'number' && Number.isFinite(value))
            return value;

        if (typeof value === 'string') {
            const parsed = Number(value);
            if (Number.isFinite(parsed))
                return parsed;
        }
    }

    return null;
}

function emptyStats() {
    return {
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        hasCost: false,
        hasData: false,
    };
}

function statsFromObject(object) {
    const cost = directNumber(object, COST_KEYS);
    const inputTokens = directNumber(object, INPUT_KEYS);
    const outputTokens = directNumber(object, OUTPUT_KEYS);
    const cacheCreationTokens = directNumber(object, CACHE_CREATION_KEYS);
    const cacheReadTokens = directNumber(object, CACHE_READ_KEYS);

    return {
        cost: cost ?? 0,
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        cacheCreationTokens: cacheCreationTokens ?? 0,
        cacheReadTokens: cacheReadTokens ?? 0,
        hasCost: cost !== null,
        hasData: [cost, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens].some(value => value !== null),
    };
}

function mergeStats(statsList) {
    return statsList.reduce((total, current) => {
        total.cost += current.cost;
        total.inputTokens += current.inputTokens;
        total.outputTokens += current.outputTokens;
        total.cacheCreationTokens += current.cacheCreationTokens;
        total.cacheReadTokens += current.cacheReadTokens;
        total.hasCost = total.hasCost || current.hasCost;
        total.hasData = total.hasData || current.hasData;
        return total;
    }, emptyStats());
}

function collectMetricObjects(value, found) {
    if (!value || typeof value !== 'object')
        return;

    if (Array.isArray(value)) {
        for (const item of value)
            collectMetricObjects(item, found);
        return;
    }

    const directStats = statsFromObject(value);
    if (directStats.hasData) {
        found.push(directStats);
        return;
    }

    for (const child of Object.values(value))
        collectMetricObjects(child, found);
}

function summarizeJson(json) {
    if (!json || typeof json !== 'object')
        return emptyStats();

    // ccusage commonly exposes a top-level totals object. Prefer it so nested
    // model breakdowns are not double-counted when the JSON shape changes.
    if (json.totals && typeof json.totals === 'object' && !Array.isArray(json.totals)) {
        const totals = statsFromObject(json.totals);
        if (totals.hasData)
            return totals;
    }

    const found = [];
    collectMetricObjects(json, found);
    return mergeStats(found);
}

function formatMoney(stats) {
    if (!stats.hasCost)
        return '$--';

    return `$${stats.cost.toFixed(2)}`;
}

function formatTokens(value) {
    if (!value)
        return '0';

    return Math.round(value).toLocaleString();
}

function formatStatsDetail(stats) {
    if (!stats.hasData)
        return 'No data yet';

    const cacheTotal = stats.cacheCreationTokens + stats.cacheReadTokens;
    const parts = [
        `In ${formatTokens(stats.inputTokens)}`,
        `Out ${formatTokens(stats.outputTokens)}`,
    ];

    if (cacheTotal > 0)
        parts.push(`Cache ${formatTokens(cacheTotal)}`);

    return parts.join(' | ');
}

function formatDuration(minutes) {
    if (!Number.isFinite(minutes) || minutes < 0)
        return '--';

    const rounded = Math.round(minutes);
    const hours = Math.floor(rounded / 60);
    const remainingMinutes = rounded % 60;

    if (hours <= 0)
        return `${remainingMinutes}m`;

    return `${hours}h ${remainingMinutes}m`;
}

function nowTime() {
    const date = new Date();
    return date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

function parseClaudeReset(json) {
    const blocks = Array.isArray(json?.blocks) ? json.blocks : [];
    const activeBlock = blocks.find(block => block?.isActive && block?.endTime);

    if (!activeBlock)
        return {hasData: false, label: 'Claude reset: no active block'};

    const endDate = new Date(activeBlock.endTime);
    if (Number.isNaN(endDate.getTime()))
        return {hasData: false, label: 'Claude reset: unknown'};

    const computedMinutes = (endDate.getTime() - Date.now()) / 60000;
    const remainingMinutes = typeof activeBlock.projection?.remainingMinutes === 'number'
        ? activeBlock.projection.remainingMinutes
        : computedMinutes;
    const resetTime = endDate.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});

    return {
        hasData: true,
        label: `Claude reset: ${resetTime} (in ${formatDuration(remainingMinutes)})`,
    };
}

const CcusagePanelButton = GObject.registerClass(class CcusagePanelButton extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'ccusage Panel');

        this._extension = extension;
        this._timeoutId = 0;
        this._refreshing = false;
        this._refreshAgain = false;
        this._destroyed = false;
        this._lastUpdate = null;
        this._error = null;
        this._stats = {
            claude: emptyStats(),
            codex: emptyStats(),
            weekly: emptyStats(),
            monthly: emptyStats(),
        };
        this._reset = {
            claude: {hasData: false, label: 'Claude reset: --'},
            codex: {hasData: false, label: 'Codex reset: not exposed by ccusage'},
        };

        this.add_style_class_name('ccusage-panel-button');
        this.menu.box.add_style_class_name('ccusage-menu');

        this._panelBox = new St.BoxLayout({
            style_class: 'ccusage-panel-pill',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelIcon = new St.Icon({
            icon_name: 'applications-science-symbolic',
            icon_size: 15,
            style_class: 'ccusage-panel-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._titleLabel = new St.Label({
            text: 'AI',
            style_class: 'ccusage-panel-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._amountLabel = new St.Label({
            text: '--',
            style_class: 'ccusage-panel-amount',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelBox.add_child(this._panelIcon);
        this._panelBox.add_child(this._titleLabel);
        this._panelBox.add_child(this._amountLabel);
        this.add_child(this._panelBox);

        this._rebuildMenu();
        this.refresh();

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        this._destroyed = true;

        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }

        super.destroy();
    }

    refresh() {
        if (this._refreshing) {
            this._refreshAgain = true;
            return;
        }

        this._refreshing = true;
        this._error = null;
        this._rebuildMenu('Aktualisiere ccusage...');

        this._loadAll()
            .then(result => {
                if (this._destroyed)
                    return;

                this._stats = result.stats;
                this._reset = result.reset;
                this._error = result.error;
                this._lastUpdate = nowTime();
                this._updateLabel();
                this._rebuildMenu();
            })
            .catch(error => {
                if (this._destroyed)
                    return;

                this._error = error.message || String(error);
                this._lastUpdate = nowTime();
                this._updateLabel();
                this._rebuildMenu();
            })
            .finally(() => {
                this._refreshing = false;
                if (this._refreshAgain && !this._destroyed) {
                    this._refreshAgain = false;
                    this.refresh();
                }
            });
    }

    async _loadAll() {
        const commands = {
            claude: ['claude', 'daily', '--json'],
            codex: ['codex', 'daily', '--json'],
            weekly: ['weekly', '--json'],
            monthly: ['monthly', '--json'],
            claudeBlocks: ['claude', 'blocks', '--json'],
        };

        const names = Object.keys(commands);
        const results = await Promise.all(names.map(async name => {
            try {
                const stdout = await this._runCcusage(commands[name]);
                const json = JSON.parse(stdout);
                const stats = summarizeJson(json);
                return {name, json, stats};
            } catch (error) {
                return {name, error};
            }
        }));

        const stats = {
            claude: emptyStats(),
            codex: emptyStats(),
            weekly: emptyStats(),
            monthly: emptyStats(),
        };
        const errors = [];
        const raw = {};
        const reset = {
            claude: {hasData: false, label: 'Claude reset: --'},
            codex: {hasData: false, label: 'Codex reset: not exposed by ccusage'},
        };

        for (const result of results) {
            if (result.error) {
                errors.push(`${result.name}: ${result.error.message || result.error}`);
                continue;
            }

            raw[result.name] = result.json;

            if (result.name === 'claudeBlocks') {
                reset.claude = parseClaudeReset(result.json);
                continue;
            }

            stats[result.name] = result.stats;

            if (!result.stats.hasData)
                errors.push(`${result.name}: keine auswertbaren ccusage-Felder gefunden`);
        }

        if (errors.length > 0)
            this._writeRawJson(raw);

        return {
            stats,
            reset,
            error: errors.length > 0 ? errors.join('\n') : null,
        };
    }

    _runCcusage(args) {
        return new Promise((resolve, reject) => {
            const helper = GLib.build_filenamev([
                GLib.get_home_dir(),
                '.local/share/gnome-shell/extensions',
                UUID,
                'ccusage-panel-helper.sh',
            ]);
            const cancellable = new Gio.Cancellable();
            let timedOut = false;

            let process;
            try {
                process = Gio.Subprocess.new(
                    [helper, ...args],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
            } catch (error) {
                reject(error);
                return;
            }

            let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, COMMAND_TIMEOUT_SECONDS, () => {
                timedOut = true;
                timeoutId = 0;
                cancellable.cancel();
                process.force_exit();
                return GLib.SOURCE_REMOVE;
            });

            process.communicate_utf8_async(null, cancellable, (proc, result) => {
                if (timeoutId) {
                    GLib.Source.remove(timeoutId);
                    timeoutId = 0;
                }

                try {
                    const [, stdout, stderr] = proc.communicate_utf8_finish(result);
                    const status = proc.get_exit_status();

                    if (timedOut) {
                        reject(new Error(`ccusage timeout nach ${COMMAND_TIMEOUT_SECONDS}s`));
                    } else if (status !== 0) {
                        reject(new Error((stderr || `ccusage exit ${status}`).trim()));
                    } else {
                        resolve(stdout.trim());
                    }
                } catch (error) {
                    if (timedOut)
                        reject(new Error(`ccusage timeout nach ${COMMAND_TIMEOUT_SECONDS}s`));
                    else
                        reject(error);
                }
            });
        });
    }

    _writeRawJson(raw) {
        try {
            const dir = GLib.build_filenamev([GLib.get_home_dir(), '.cache', 'ccusage-panel']);
            GLib.mkdir_with_parents(dir, 0o700);

            const file = Gio.File.new_for_path(GLib.build_filenamev([dir, 'last-raw.json']));
            file.replace_contents(
                JSON.stringify(raw, null, 2),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (error) {
            console.error(`ccusage-panel: failed to write raw JSON: ${error.message || error}`);
        }
    }

    _updateLabel() {
        const claude = this._stats.claude;
        const codex = this._stats.codex;
        const total = mergeStats([claude, codex]);

        if (!claude.hasData && !codex.hasData) {
            this._amountLabel.text = '--';
            return;
        }

        this._amountLabel.text = total.hasCost ? formatMoney(total) : '--';
    }

    _icon(iconName, styleClass = 'ccusage-row-icon') {
        return new St.Icon({
            icon_name: iconName,
            icon_size: 16,
            style_class: styleClass,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _addHeader() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('ccusage-menu-header');

        const textBox = new St.BoxLayout({vertical: true, x_expand: true});
        textBox.add_child(new St.Label({
            text: 'ccusage',
            style_class: 'ccusage-header-title',
        }));
        textBox.add_child(new St.Label({
            text: 'Claude Code and Codex usage',
            style_class: 'ccusage-header-subtitle',
        }));

        item.add_child(this._icon('applications-science-symbolic', 'ccusage-header-icon'));
        item.add_child(textBox);
        this.menu.addMenuItem(item);
        return item;
    }

    _addSectionTitle(text) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('ccusage-section-title');
        item.add_child(new St.Label({text, style_class: 'ccusage-section-label'}));
        this.menu.addMenuItem(item);
        return item;
    }

    _addMessage(text, iconName = 'dialog-information-symbolic', styleClass = '') {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('ccusage-message-row');
        if (styleClass)
            item.add_style_class_name(styleClass);

        item.add_child(this._icon(iconName));
        item.add_child(new St.Label({
            text,
            style_class: 'ccusage-message-label',
            x_expand: true,
        }));
        this.menu.addMenuItem(item);
        return item;
    }

    _addStatsCard(name, stats, iconName, accentClass) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('ccusage-stats-card');
        item.add_style_class_name(accentClass);

        item.add_child(this._icon(iconName, 'ccusage-card-icon'));

        const content = new St.BoxLayout({vertical: true, x_expand: true});
        const titleRow = new St.BoxLayout({x_expand: true});
        titleRow.add_child(new St.Label({
            text: name,
            style_class: 'ccusage-card-title',
            x_expand: true,
        }));
        titleRow.add_child(new St.Label({
            text: formatMoney(stats),
            style_class: 'ccusage-card-money',
            x_align: Clutter.ActorAlign.END,
        }));

        content.add_child(titleRow);
        content.add_child(new St.Label({
            text: formatStatsDetail(stats),
            style_class: 'ccusage-card-detail',
        }));

        item.add_child(content);
        this.menu.addMenuItem(item);
        return item;
    }

    _addTotalRow(name, stats, iconName) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('ccusage-total-row');

        item.add_child(this._icon(iconName));
        item.add_child(new St.Label({
            text: name,
            style_class: 'ccusage-total-label',
            x_expand: true,
        }));
        item.add_child(new St.Label({
            text: formatMoney(stats),
            style_class: 'ccusage-total-money',
            x_align: Clutter.ActorAlign.END,
        }));

        this.menu.addMenuItem(item);
        return item;
    }

    _rebuildMenu(statusText = null) {
        this.menu.removeAll();

        this._addHeader();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (statusText) {
            this._addMessage(statusText, 'view-refresh-symbolic');
        } else if (!this._stats.claude.hasData && !this._stats.codex.hasData) {
            this._addMessage('Keine ccusage-Daten gefunden.', 'dialog-information-symbolic');
            this._addMessage('Starte zuerst Claude Code oder Codex und nutze sie einmal.', 'utilities-terminal-symbolic');
        } else {
            this._addSectionTitle('Heute');
            this._addStatsCard('Claude', this._stats.claude, 'applications-science-symbolic', 'ccusage-accent-claude');
            this._addStatsCard('Codex', this._stats.codex, 'utilities-terminal-symbolic', 'ccusage-accent-codex');
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addSectionTitle('Limits');
            this._addMessage(this._reset.claude.label, 'alarm-symbolic', this._reset.claude.hasData ? 'ccusage-reset-row' : 'ccusage-muted-row');
            this._addMessage(this._reset.codex.label, 'dialog-information-symbolic', 'ccusage-muted-row');
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addTotalRow('Woche gesamt', this._stats.weekly, 'calendar-week-symbolic');
            this._addTotalRow('Monat gesamt', this._stats.monthly, 'calendar-month-symbolic');
        }

        if (this._lastUpdate)
            this._addMessage(`Letztes Update: ${this._lastUpdate}`, 'document-open-recent-symbolic', 'ccusage-muted-row');

        if (this._error) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            for (const line of this._error.split('\n'))
                this._addMessage(line, 'dialog-error-symbolic', 'ccusage-error-row');
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupBaseMenuItem();
        refreshItem.add_style_class_name('ccusage-refresh-row');
        refreshItem.add_child(this._icon('view-refresh-symbolic', 'ccusage-refresh-icon'));
        refreshItem.add_child(new St.Label({
            text: 'Refresh now',
            style_class: 'ccusage-refresh-label',
        }));
        refreshItem.connect('activate', () => this.refresh());
        this.menu.addMenuItem(refreshItem);

        this._addMessage('Debug: journalctl /usr/bin/gnome-shell -f', 'utilities-terminal-symbolic', 'ccusage-muted-row');
    }
});

export default class CcusagePanelExtension extends Extension {
    enable() {
        this._indicator = new CcusagePanelButton(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
