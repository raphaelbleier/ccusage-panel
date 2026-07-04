import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
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

function formatStatsLine(name, stats) {
    if (!stats.hasData)
        return `${name}: --`;

    const cacheTotal = stats.cacheCreationTokens + stats.cacheReadTokens;
    const parts = [
        `${name}: ${formatMoney(stats)}`,
        `In ${formatTokens(stats.inputTokens)}`,
        `Out ${formatTokens(stats.outputTokens)}`,
    ];

    if (cacheTotal > 0)
        parts.push(`Cache ${formatTokens(cacheTotal)}`);

    return parts.join(' | ');
}

function nowTime() {
    const date = new Date();
    return date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

class CcusagePanelButton extends PanelMenu.Button {
    constructor(extension) {
        super(0.0, 'ccusage Panel');

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

        this._label = new St.Label({
            text: 'AI --',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

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

        for (const result of results) {
            if (result.error) {
                errors.push(`${result.name}: ${result.error.message || result.error}`);
                continue;
            }

            raw[result.name] = result.json;
            stats[result.name] = result.stats;

            if (!result.stats.hasData)
                errors.push(`${result.name}: keine auswertbaren ccusage-Felder gefunden`);
        }

        if (errors.length > 0)
            this._writeRawJson(raw);

        return {
            stats,
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
            this._label.text = 'AI --';
            return;
        }

        this._label.text = total.hasCost ? `AI ${formatMoney(total)}` : 'AI --';
    }

    _addDisabledItem(text) {
        const item = new PopupMenu.PopupMenuItem(text);
        item.setSensitive(false);
        this.menu.addMenuItem(item);
        return item;
    }

    _rebuildMenu(statusText = null) {
        this.menu.removeAll();

        this._addDisabledItem('ccusage');
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (statusText) {
            this._addDisabledItem(statusText);
        } else if (!this._stats.claude.hasData && !this._stats.codex.hasData) {
            this._addDisabledItem('Keine ccusage-Daten gefunden.');
            this._addDisabledItem('Starte zuerst Claude Code oder Codex und nutze sie einmal.');
        } else {
            this._addDisabledItem('Heute');
            this._addDisabledItem(formatStatsLine('Claude', this._stats.claude));
            this._addDisabledItem(formatStatsLine('Codex', this._stats.codex));
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addDisabledItem(`Woche: ${formatMoney(this._stats.weekly)}`);
            this._addDisabledItem(`Monat: ${formatMoney(this._stats.monthly)}`);
        }

        if (this._lastUpdate)
            this._addDisabledItem(`Letztes Update: ${this._lastUpdate}`);

        if (this._error) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            for (const line of this._error.split('\n'))
                this._addDisabledItem(`Fehler: ${line}`);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this.refresh());
        this.menu.addMenuItem(refreshItem);

        this._addDisabledItem('Debug: journalctl /usr/bin/gnome-shell -f');
    }
}

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
