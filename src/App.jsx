import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import TerminalLog from './components/TerminalLog';
import './App.css';

function App() {
  const [status, setStatus] = useState({ dispense: 'stopped', watcher: 'stopped' });
  const [logs, setLogs] = useState({ dispense: [], watcher: [] });
  const [timers, setTimers] = useState({ dispense: { phase: 'Idle', timeLeft: 0 }, watcher: { phase: 'Idle', timeLeft: 0 } });
  const [config, setConfig] = useState({ username: '', password: '', location: '', Run_Time: 5, Pause_Time: 5 });
  const [savingConfig, setSavingConfig] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);

  const audioRef = useRef(null);

  useEffect(() => {
    const socket = io();

    socket.on('connect', () => setSocketConnected(true));
    socket.on('disconnect', () => setSocketConnected(false));

    socket.on('initialState', (state) => {
      setStatus({ dispense: state.dispense.status, watcher: state.watcher.status });
      setLogs({ dispense: state.dispense.logs, watcher: state.watcher.logs });
      if (state.dispense.timerPhase) {
        setTimers({
          dispense: { phase: state.dispense.timerPhase, timeLeft: state.dispense.timerLeft },
          watcher: { phase: state.watcher.timerPhase || 'Idle', timeLeft: state.watcher.timerLeft || 0 }
        });
      }
    });

    socket.on('statusUpdate', (data) => {
      setStatus(prev => ({ ...prev, [data.script]: data.status }));
    });

    socket.on('timerUpdate', (data) => {
      setTimers(prev => ({ ...prev, [data.script]: { phase: data.phase, timeLeft: data.timeLeft } }));
    });

    socket.on('log', (data) => {
      setLogs(prev => {
        const newLogs = [...prev[data.script], data];
        if (newLogs.length > 200) newLogs.shift();
        return { ...prev, [data.script]: newLogs };
      });
    });

    socket.on('play_alert', () => {
      if (audioRef.current) {
        // play() returns a promise, swallow the error if the browser still blocks it
        audioRef.current.play().catch(e => console.warn('Audio play blocked:', e));
      }
    });

    fetchConfig();

    return () => socket.disconnect();
  }, []);

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      setConfig(data);
    } catch (err) {
      console.error('Failed to fetch config', err);
    }
  };

  const handleConfigChange = (e) => {
    setConfig({ ...config, [e.target.name]: e.target.value });
  };

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      alert('Configuration saved successfully.');
      setShowConfig(false);
    } catch (err) {
      alert('Failed to save configuration.');
    }
    setSavingConfig(false);
  };

  const sendCommand = async (script, command) => {
    try {
      await fetch(`/api/${script}/${command}`, { method: 'POST' });
    } catch (err) {
      console.error(`Failed to ${command} ${script}`, err);
    }
  };

  const renderProcessControl = (id, title) => {
    const isRunning = status[id] === 'running';
    const isRestarting = status[id] === 'restarting';

    const timerState = timers[id];
    let timerText = null;
    if (timerState && timerState.phase !== 'Idle') {
      const mins = Math.floor(timerState.timeLeft / 60);
      const secs = timerState.timeLeft % 60;
      timerText = `[${timerState.phase}] ${mins}:${secs.toString().padStart(2, '0')}`;
    }

    return (
      <div className="card process-card">
        <div className="card-header">
          <h2>
            {title}
            {timerText && <span style={{ fontSize: '0.8em', marginLeft: '12px', color: '#007bff' }}>{timerText}</span>}
          </h2>
          <div className={`status-badge ${status[id]}`}>
            {status[id].toUpperCase()}
          </div>
        </div>
        <div className="card-actions">
          <button
            className="btn btn-primary"
            onClick={() => sendCommand(id, 'start')}
            disabled={isRunning || isRestarting}
          >
            Start
          </button>
          <button
            className="btn btn-danger"
            onClick={() => sendCommand(id, 'stop')}
            disabled={status[id] === 'stopped'}
          >
            Stop
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => sendCommand(id, 'restart')}
            disabled={status[id] === 'stopped'}
          >
            Restart
          </button>
        </div>
        <TerminalLog logs={logs[id]} title={`${title} console`} />
      </div>
    );
  };

  // The Full Screen Interaction Block
  if (!hasInteracted) {
    return (
      <div className="interaction-overlay" onClick={() => setHasInteracted(true)}>
        <div className="interaction-content">
          <h1>PhIS Dispenser</h1>
          <p>Click anywhere to start.</p>
          <button className="btn btn-primary btn-large">Start</button>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-container widescreen">
      {/* Hidden Audio Player */}
      <audio ref={audioRef} src="/alert.wav" preload="auto" />

      <header className="dashboard-header">
        <div className="header-left">
          <h1>PhIS Auto Dispenser Dashboard</h1>
          <div className="connection-status">
            <span className={`dot ${socketConnected ? 'green' : 'red'}`}></span>
            {socketConnected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
        <button className="btn btn-secondary" onClick={() => setShowConfig(true)}>
          ⚙️ Configuration
        </button>
      </header>

      <main className="dashboard-content grid-half">
        {renderProcessControl('dispense', 'Auto Dispenser')}
        {renderProcessControl('watcher', 'Dispensing Monitor')}
      </main>

      {/* Configuration Modal Overlay */}
      {showConfig && (
        <div className="modal-overlay" onClick={() => setShowConfig(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <h2>Credentials & Config</h2>
              <button className="btn-close" onClick={() => setShowConfig(false)}>×</button>
            </div>
            <div className="config-form">
              <div className="form-group">
                <label>Username</label>
                <input
                  type="text"
                  name="username"
                  value={config.username || ''}
                  onChange={handleConfigChange}
                />
              </div>
              <div className="form-group">
                <label>Password</label>
                <input
                  type="password"
                  name="password"
                  value={config.password || ''}
                  onChange={handleConfigChange}
                />
              </div>
              <div className="form-group">
                <label>Location</label>
                <input
                  type="text"
                  name="location"
                  value={config.location || ''}
                  onChange={handleConfigChange}
                  readOnly
                />
              </div>
              <div className="form-group">
                <label>Run Time (mins)</label>
                <input
                  type="number"
                  name="Run_Time"
                  value={config.Run_Time || ''}
                  onChange={handleConfigChange}
                />
              </div>
              <div className="form-group">
                <label>Pause Time (mins)</label>
                <input
                  type="number"
                  name="Pause_Time"
                  value={config.Pause_Time || ''}
                  onChange={handleConfigChange}
                />
              </div>
              <div className="form-actions">
                <button className="btn btn-secondary" onClick={() => setShowConfig(false)}>Cancel</button>
                <button
                  className="btn btn-success"
                  onClick={saveConfig}
                  disabled={savingConfig}
                >
                  {savingConfig ? 'Saving...' : 'Save Config'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
