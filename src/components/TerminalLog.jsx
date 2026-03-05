import React, { useEffect, useRef } from 'react';

const TerminalLog = ({ logs, title }) => {
    const endRef = useRef(null);

    useEffect(() => {
        endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    return (
        <div className="terminal-container">
            <div className="terminal-header">
                <div className="terminal-dots">
                    <span className="dot red"></span>
                    <span className="dot yellow"></span>
                    <span className="dot green"></span>
                </div>
                <span className="terminal-title">{title} - Live Output</span>
            </div>
            <div className="terminal-body">
                {logs.length === 0 ? (
                    <div className="log-line empty">Waiting for output...</div>
                ) : (
                    logs.map((log, index) => (
                        <div key={index} className={`log-line ${log.type}`}>
                            <span className="timestamp">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                            {' '}
                            <span className="message">{log.message}</span>
                        </div>
                    ))
                )}
                <div ref={endRef} />
            </div>
        </div>
    );
};

export default TerminalLog;
