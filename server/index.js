import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SCRIPT_DIR = path.join(ROOT_DIR, 'src', 'script');
const CONFIG_PATH = path.join(SCRIPT_DIR, 'config.json');
const NODE_EXE = path.join(SCRIPT_DIR, 'node.exe');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());

// State management for scripts
const processes = {
    dispense: { instance: null, status: 'stopped', manualStop: true, name: 'dispense.js', logs: [], timerPhase: 'Idle', timerLeft: 0 },
    watcher: { instance: null, status: 'stopped', manualStop: true, name: 'watcher.js', logs: [], timerPhase: 'Idle', timerLeft: 0 }
};

const MAX_LOG_LINES = 200;

import find from 'find-process';

// Function to scan OS processes to detect if scripts are already running
async function scanForExistingProcesses() {
    try {
        const list = await find('name', 'node');

        const isWatcherRunning = list.some(p => p.cmd.includes('watcher.js'));
        const isDispenseRunning = list.some(p => p.cmd.includes('dispense.js'));

        if (isWatcherRunning) {
            processes.watcher.status = 'running';
            processes.watcher.manualStop = false;
            appendLog('watcher', 'info', '[SERVER] Reconnected to existing watcher.js process.');
        } else {
            startScript('watcher');
        }

        if (isDispenseRunning) {
            processes.dispense.status = 'running';
            processes.dispense.manualStop = false;
            appendLog('dispense', 'info', '[SERVER] Reconnected to existing dispense.js process.');
        } else {
            startScript('dispense');
        }
    } catch (err) {
        console.error('Failed to scan for existing processes:', err);
    }
}

// Run scan on startup
scanForExistingProcesses();

function appendLog(scriptType, type, message) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        type,
        message: message.toString().trim()
    };

    if (!logEntry.message) return;

    processes[scriptType].logs.push(logEntry);
    if (processes[scriptType].logs.length > MAX_LOG_LINES) {
        processes[scriptType].logs.shift();
    }

    // Intercept the alert string and emit an audio event!
    if (logEntry.message.includes('[SYSTEM_ALERT_PLAY_SOUND]')) {
        io.emit('play_alert', { script: scriptType });
    }

    // Broadcast live log to connected clients
    io.emit('log', { script: scriptType, ...logEntry });
}

async function stopScript(scriptType, isManual = true) {
    const p = processes[scriptType];
    if (isManual) p.manualStop = true;
    p.status = 'stopped';
    io.emit('statusUpdate', { script: scriptType, status: p.status });

    if (p.instance) {
        appendLog(scriptType, 'info', `[SERVER] Sending termination signal to attached ${p.name}...`);
        p.instance.kill('SIGTERM');
        setTimeout(() => {
            if (p.instance) p.instance.kill('SIGKILL');
        }, 5000);
    } else {
        // If the process was started BEFORE the server booted up, we do not have an instance 
        // pointer. We must find the OS process and kill it directly.
        appendLog(scriptType, 'info', `[SERVER] Attempting to terminate detached ${p.name}...`);
        try {
            const list = await find('name', 'node');
            const target = list.find(proc => proc.cmd.includes(p.name));
            if (target) {
                process.kill(target.pid, 'SIGTERM');
                appendLog(scriptType, 'info', `[SERVER] Terminated detached process (PID: ${target.pid}).`);
            } else {
                appendLog(scriptType, 'info', `[SERVER] No running instance of ${p.name} found.`);
            }
        } catch (err) {
            appendLog(scriptType, 'stderr', `Failed to find and kill detached process: ${err.message}`);
        }
    }
}

function startScript(scriptType) {
    const p = processes[scriptType];
    if (p.status === 'running') return;

    p.manualStop = false;
    p.status = 'running';
    io.emit('statusUpdate', { script: scriptType, status: p.status });

    const scriptPath = path.join(SCRIPT_DIR, p.name);
    appendLog(scriptType, 'info', `[SERVER] Starting ${p.name}...`);

    try {
        // Use their specific node.exe to launch the script
        p.instance = spawn(fs.existsSync(NODE_EXE) ? NODE_EXE : 'node', [scriptPath], {
            cwd: SCRIPT_DIR
        });

        p.instance.stdout.on('data', (data) => {
            appendLog(scriptType, 'stdout', data);
        });

        p.instance.stderr.on('data', (data) => {
            appendLog(scriptType, 'stderr', data);
        });

        p.instance.on('close', (code) => {
            appendLog(scriptType, 'info', `[SERVER] ${p.name} exited with code ${code}`);
            p.instance = null;

            if (!p.manualStop && p.timerPhase !== 'Paused') {
                p.status = 'restarting';
                io.emit('statusUpdate', { script: scriptType, status: p.status });
                appendLog(scriptType, 'info', `[SERVER] Crashed or stopped unexpectedly. Auto-restarting in 5 seconds...`);

                setTimeout(() => {
                    if (!p.manualStop && p.timerPhase !== 'Paused') {
                        startScript(scriptType);
                    }
                }, 5000);
            } else {
                p.status = 'stopped';
                io.emit('statusUpdate', { script: scriptType, status: p.status });
            }
        });
    } catch (error) {
        appendLog(scriptType, 'stderr', `Failed to spawn process: ${error.message}`);
        p.status = 'stopped';
        io.emit('statusUpdate', { script: scriptType, status: p.status });
    }
}

// Timer Loop for automatic Run/Pause scheduling
setInterval(() => {
    runTimerTick('dispense');
}, 1000);

function runTimerTick(scriptType) {
    const p = processes[scriptType];

    if (p.manualStop) {
        if (p.timerPhase !== 'Idle') {
            p.timerPhase = 'Idle';
            p.timerLeft = 0;
            io.emit('timerUpdate', { script: scriptType, phase: 'Idle', timeLeft: 0 });
        }
        return;
    }

    let runTime = 0, pauseTime = 0;
    try {
        const conf = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        runTime = parseInt(conf.Run_Time) || 0;
        pauseTime = parseInt(conf.Pause_Time) || 0;
    } catch (e) { }

    if (runTime <= 0 || pauseTime <= 0) {
        if (p.timerPhase !== 'Idle') {
            p.timerPhase = 'Idle';
            p.timerLeft = 0;
            io.emit('timerUpdate', { script: scriptType, phase: 'Idle', timeLeft: 0 });
        }
        return;
    }

    if (p.timerPhase === 'Idle') {
        p.timerPhase = 'Running';
        p.timerLeft = runTime * 60;
    }

    if (p.timerLeft > 0) {
        p.timerLeft--;
        // Broadcast timer tick every second
        io.emit('timerUpdate', { script: scriptType, phase: p.timerPhase, timeLeft: p.timerLeft });
    } else {
        if (p.timerPhase === 'Running') {
            p.timerPhase = 'Paused';
            p.timerLeft = pauseTime * 60;
            io.emit('timerUpdate', { script: scriptType, phase: p.timerPhase, timeLeft: p.timerLeft });
            appendLog(scriptType, 'info', `[SERVER] Timer: Run phase ended. Pausing for ${pauseTime} minutes...`);
            stopScript(scriptType, false); // Soft stop
        } else if (p.timerPhase === 'Paused') {
            p.timerPhase = 'Running';
            p.timerLeft = runTime * 60;
            io.emit('timerUpdate', { script: scriptType, phase: p.timerPhase, timeLeft: p.timerLeft });
            appendLog(scriptType, 'info', `[SERVER] Timer: Pause phase ended. Resuming run for ${runTime} minutes...`);
            startScript(scriptType);
        }
    }
}

// Socket.io Connection Helper
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    // Send current state to new clients
    socket.emit('initialState', {
        dispense: { status: processes.dispense.status, logs: processes.dispense.logs, timerPhase: processes.dispense.timerPhase, timerLeft: processes.dispense.timerLeft },
        watcher: { status: processes.watcher.status, logs: processes.watcher.logs, timerPhase: processes.watcher.timerPhase, timerLeft: processes.watcher.timerLeft }
    });
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// APIs
app.get('/api/status', (req, res) => {
    res.json({
        dispense: processes.dispense.status,
        watcher: processes.watcher.status
    });
});

app.post('/api/:script/start', (req, res) => {
    const scriptType = req.params.script;
    if (!processes[scriptType]) return res.status(400).json({ error: 'Invalid script' });
    startScript(scriptType);
    res.json({ success: true, status: processes[scriptType].status });
});

app.post('/api/:script/stop', (req, res) => {
    const scriptType = req.params.script;
    if (!processes[scriptType]) return res.status(400).json({ error: 'Invalid script' });
    stopScript(scriptType);

    // Optimistic update
    processes[scriptType].status = 'stopped';
    io.emit('statusUpdate', { script: scriptType, status: 'stopped' });

    res.json({ success: true, status: 'stopped' });
});

app.post('/api/:script/restart', (req, res) => {
    const scriptType = req.params.script;
    if (!processes[scriptType]) return res.status(400).json({ error: 'Invalid script' });
    stopScript(scriptType);
    // Wait a moment before starting
    setTimeout(() => {
        startScript(scriptType);
    }, 2000);
    res.json({ success: true, message: 'Restarting...' });
});

app.get('/api/config', (req, res) => {
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            const configData = fs.readFileSync(CONFIG_PATH, 'utf-8');
            res.json(JSON.parse(configData));
        } catch (e) {
            res.status(500).json({ error: 'Failed to read config' });
        }
    } else {
        res.json({ username: '', password: '', location: '', Run_Time: 5, Pause_Time: 5 }); // Defaults
    }
});

app.post('/api/config', (req, res) => {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2), 'utf-8');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to write config' });
    }
});

// Serve frontend if built
app.use(express.static(path.join(ROOT_DIR, 'dist')));

// Fallback for React Router (catch-all)
app.use((req, res, next) => {
    if (req.method === 'GET') {
        const indexPath = path.join(ROOT_DIR, 'dist', 'index.html');
        if (fs.existsSync(indexPath)) {
            return res.sendFile(indexPath);
        }
    }
    res.status(404).send('Not Found');
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}. Local network access supported.`);
});

// Clean up child processes on close 
function cleanupAndExit() {
    console.log('Shutting down server. Terminating child scripts...');
    ['dispense', 'watcher'].forEach(scriptType => {
        stopScript(scriptType);
    });
    // Wait for kill signals to be sent before exiting
    setTimeout(() => {
        process.exit(0);
    }, 1000);
}

process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);
